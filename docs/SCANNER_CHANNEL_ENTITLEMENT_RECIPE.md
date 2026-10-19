# Scanner Channel Entitlement Recipe

Fleet-wide, scanner-agnostic recipe for **per-user per-channel entitlement inside a single scanner SPA**. Pattern first iterated on IT-F2-406 (OS Tape) in October 2026; this doc captures it so the next scanner adopter inherits the SOT, claim, admin UI, backend endpoints, SSE propagation, and WS gate in one read.

**When to use**: your scanner has sub-tabs / sub-tapes / sub-sections that different users should see different subsets of (e.g. a tiered-subscription product where "basic" users see 4 of 13 tabs, "premium" see all 13). Fine-grained inside one scanner — complementary to `custom:scanners` which is coarse per-scanner.

**When NOT to use**: all users of your scanner see the same tabs → you don't need this; `custom:scanners` entitlement alone is enough.

Siblings:

- `LIVE_DATA_SCANNER_RECIPE.md` — tier + displacement + chip
- `SCANNER_AUTH_RECIPE.md` — paywall gating (session + custom:scanners)
- `SCANNER_TRACKING_RECIPE.md` — DAU + per-scanner access history
- `SCANNER_DATA_WIRING_RECIPE.md` — producer → f2-api → SPA data path
- `SNAPSHOT_DATE_PICKER_RECIPE.md` — snapshot-vs-live row sourcing

---

## 1. The two field groups you already know

The channel-entitlement pattern reuses the EXISTING push-notification channel SOT (`Scanners.<id>.channels[]` + `custom:notify_channels` claim) rather than introducing a parallel entitlement-specific one. Mike's directive on IT-F2-406 c/f09a42e4 after f2-session's initial parallel-field ship: *"channel select is a standard feature and shouldn't require rewriting that UI it works fine for scanner as-os"*. One field, one claim, one editor — used for BOTH push-notification routing AND SPA entitlement gating.

### 1.1 SOT — `Scanners.<id>.channels[]` (lowercase c)

Mongo shape (lowercase `channels`):

```js
{
  _id: "<slug>",         // scanner slug — e.g. "os-osv2", "as-push"
  Client: "<customer>",
  Url: "https://...",
  AppUrl: "https://...",
  Stream: { ... },        // see SCANNER_TRACKING_RECIPE §1.2

  channels: [
    { id: "<slug>.<number>", slug: "<channel-slug>", title: "<display name>",
      visible_to_roles: ["admin", "client", ...] }, // optional
    // e.g. { id: "os-osv2.1", slug: "lottery", title: "Lottery" }
    // ...
  ]
}
```

**`id` is the composite** — `<scanner-slug>.<channel-number>`. This is the string that lands in the user's `custom:notify_channels` CSV. Numbers are 1-indexed in the order channels were added.

**`slug` + `title`** are display-only. `slug` matches whatever the SPA uses as its internal tab id. `title` is what renders in both the admin editor + the SPA sidebar.

**`visible_to_roles`** (optional) — IT-F2-406 cid 2a461bc5 2026-10-17: when present + non-empty, only users whose `custom:role` is in the array see this channel. Absent / empty → visible to all entitled users (backwards-compat). Admins bypass regardless. The gate is enforced by f2-api on BOTH the WS fanout (close code 4403 with `code:'channel_role_not_visible'`) and the REST handler (returns `{rows:[], channel_role_not_visible:true, required_roles:[...]}`). Role strings are lowercased for comparison; common values: `admin`, `client`, `client_admin`, `member`.

### 1.2 User claim — `custom:notify_channels` (Cognito custom attribute)

CSV of composite ids, scoped across all scanners the user has:

```
custom:notify_channels: "os-osv2.1,os-osv2.3,os-osv2.5,as-push.2,as-push.4"
```

Set on the Cognito user record. Stamped onto the id_token at mint time. Admin writes via the standard `PUT /rest/admin/users/:username` endpoint.

The fleet admin "Edit Channels" dialog (`f2-admin/src/app/admin/shared/channels-editor/channels-editor.component.ts`) reads this claim + renders one card per entitled scanner (user has `<slug>` in `custom:scanners`) + saves the deduped CSV union across cards. Zero per-scanner code change in the admin app — scanner just needs `channels[]` on its Scanners doc.

### 1.3 Why NOT a separate claim

An earlier draft on IT-F2-406 introduced parallel `Scanners.<id>.Channels[]` (capital) + `custom:channels` claim. The admin UI knew nothing about the new fields → Edit Channels dialog showed empty for any scanner that only had the new field populated. f2-session's pivot (c/d9d6cc0f + b0f194c) collapsed to the existing SOT + claim; the parallel fields were left in place for a transition window but have no readers.

**Rule**: don't invent a new claim namespace for "entitlement channels". Use `custom:notify_channels`. Push-notification routing + SPA entitlement gating both read it; what differs is what they do with the ids.

---

## 2. Backend endpoints

### 2.1 Public catalog — `GET /api/scanners-by-host?host=<host>`

Already present on `f2-admin-service`. Returns per-scanner shape including the lowercase `channels` field:

```json
{
  "host": "alerts.theoptionsniper.com",
  "scanners": [
    {
      "scanner_id": "os-osv2",
      "pathname": "/scans/tape",
      "app_url": "https://option-sniper-tape.vercel.app/scans/tape",
      "channels": [
        {"id": "os-osv2.1", "slug": "lottery", "title": "Lottery"},
        {"id": "os-osv2.2", "slug": "hedge-fund", "title": "Hedge Fund Traded"}
      ],
      "...": "..."
    }
  ]
}
```

SPA uses this at mount to render the sub-tape catalog (every channel defined, regardless of entitlement). Padlocks go on the ones the user doesn't hold.

### 2.2 Per-user entitlement — `GET /api/scanners/:slug/entitled-channels`

Authenticated. Returns the parsed `custom:notify_channels` filtered to the requested scanner slug:

```json
{"channels": [1, 3, 5]}
```

Numbers only (parsed off the `<slug>.<number>` composites). SPA diffs this against the catalog's channel numbers to decide which tabs render locked.

**Resolved** (f2-session IT-F2-406 c/101c47fc 2026-10-17): endpoint resolves against the **authoritative source** via `get_user_details(username, pool_id)` — Redis-first with Cognito `AdminGetUser` fallback. The id_token's claim is NOT the source of truth here; Cognito's `refresh_token` flow re-issues id_tokens with the claim snapshot from mint-time (not current attributes), so reading off the token stays stale across hard refreshes until the user signs out. Reading from the Redis cache (populated by every admin write via `cache_cognito_users` + Redis-first write path) gives live-ish propagation in &lt;1s typical. Fail-safe falls through to `userData.channels` only if the authoritative read throws (Redis blip, Cognito 429) — stale beats 500.

### 2.3 Admin write — `PUT /rest/admin/users/:username`

Standard existing admin-write endpoint:

```http
PUT /rest/admin/users/<username>
{
  "attributes": [
    {"Name": "custom:notify_channels", "Value": "os-osv2.1,os-osv2.3,os-osv2.5"}
  ],
  "pool_id": "<cognito-pool-id>"
}
```

Writes land in `AuditEntitlementChanges` via the `ENTITLEMENT_ATTRS` set in `UsersController.updateUserAttributes` (f2-admin-service c/e1f41de + c/b0f194c include both `custom:channels` and `custom:notify_channels`). Writes also publish `op=entitlement_changed` on the fleet `F2:USER_UPDATES` redis channel with `changed_attrs.custom:notify_channels` → downstream SSE subscribers at `/rest/admin/users-live/stream` + scanner-side WS consumers (`f2-api`, `chart-service`, `alpha-pivot-service`) see the change in real time. SPA half: on `entitlement_changed` with `changed_attrs['custom:notify_channels']` present → re-probe `/api/scanners/:slug/entitled-channels` (resolves live state per §2.2) + reconnect WS. End-to-end latency admin-click → user-UI is typically 1-3s.

### 2.4 Pool-mismatch gotcha

QA identities (like `member-support@f2-tech.com`) exist across multiple Cognito pools. The admin app's channels editor only renders the scanner card when the user row is sourced from the pool that owns the scanner. For OS Tape, the pool is `us-east-1_g37WPaiar`. Picking the "wrong" member-support row in the admin grid → empty-state message, which is correct behavior, not a bug. (f2-session cid aa528d2e 2026-10-17.)

---

## 3. WebSocket gate — f2-api 4403 close code

f2-api closes the WS with code **4403** when the user's `custom:notify_channels` doesn't include `<scannerId>.<channel-number>` for the sub-tape they're trying to subscribe to. Distinct from `1008` (auth dead) so the SPA can render a padlock + "contact admin / subscribe" affordance instead of a sign-in prompt.

Payload:

```json
{"error": "channel_not_entitled", "code": "channel_not_entitled", "required_channel": "os-osv2.5"}
```

**Backend mechanism** (f2-session c/537adca → b053cc9 → **0d4af52**):
1. `Scanners.<id>.channels[]` captured on each view at `loadStreamViewsFromScanners` time (`scannerChannels` field on the view). No second mongo read at handshake.
2. At WS connect, after `verifyWsTicket` + admin-role resolution, resolve `v.collection` → channel entry → required `<slug>.<number>` composite.
3. **Resolve the user's `custom:notify_channels` LIVE** via `resolveLiveNotifyChannels(user, token)` helper — Redis-first against `F2:USER_CACHE:<pool_id>` (admin writes populate synchronously via `cache_cognito_users`), Cognito `AdminGetUser` fallback on cache miss, email reverse-lookup via `F2:USER_INDEX_BY_EMAIL` for legacy-pool UUID usernames. Fail-safe falls through to the id_token's embedded claim if the live resolve throws (Redis blip, Cognito 429) — stale beats 500.
4. If the live-resolved claim doesn't include the composite + user isn't admin, send the error envelope + close 4403.

**Why live resolve** (f2-session c/0d4af52 2026-10-19, IT-F2-406): Cognito's `refresh_token` flow re-issues id_tokens with the claim snapshot from mint-time (NOT current user attributes). An embedded-claim read at WS handshake stays stale after an admin channel grant until the user signs out + back in — observed on `thebugger2000@yahoo.com` with all 13 channels entitled per the `/entitled-channels` REST endpoint but every WS 4403'ing. Live resolve mirrors the Redis-first + AdminGetUser pattern the entitled-channels REST endpoint already uses.

**Backwards compat**: scanners whose Scanner doc has no `channels[]` skip the gate entirely. REST `/trades` + `/count` also live-resolve via the same helper for parity.

---

## 4. Live propagation — SSE `/rest/admin/users-live/stream`

### 4.1 Redis channel

Admin writes to `custom:notify_channels` publish on the fleet `F2:USER_UPDATES` redis channel:

```json
{"op": "entitlement_changed", "user_id": "<sub>", "changed_attrs": {"custom:notify_channels": "..."}, "at": "<iso>"}
```

### 4.2 SSE stream

`GET /rest/admin/users-live/stream?token=<short-lived-mint>` on `f2-admin-service` forwards the envelope to the authenticated user. Mint via `POST /rest/admin/users-live/stream-token` first (TTL 60s; re-mint every 55s).

### 4.3 SPA SSE handler — three-step reaction

On receive of an `entitlement_changed` envelope whose `changed_attrs.custom:notify_channels` is set:

```js
eventSource.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg?.op !== 'entitlement_changed') return;
  // 1. Mint a fresh sid from the httpOnly cookies + redeem it, so the
  //    new id_token carries LIVE Cognito claims (refresh_token flow
  //    returns stale claims — see note below).
  try {
    const mintRes = await fetch('/rest/auth/mint-sid-from-cookies', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: '{}',
    });
    if (mintRes.ok) {
      const { sid } = await mintRes.json();
      if (sid) {
        const redeemRes = await fetch('/rest/auth/redeem-session', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sid }),
        });
        if (redeemRes.ok) {
          const bundle = await redeemRes.json();
          if (bundle?.id_token) {
            setTokenBundle(bundle);               // in-memory stash
            localStorage.setItem(AUTH_TOKEN_KEY, bundle.id_token);
            setIdToken(bundle.id_token);          // 2. triggers sockets effect
          }
        }
      }
    }
  } catch { /* fall through to #3 */ }
  // 3. Refetch /api/scanners/:slug/entitled-channels for sidebar padlock state.
  window.dispatchEvent(new CustomEvent('f2:entitlement-changed'));
};
```

Why three steps:

1. **mint-sid-from-cookies → redeem-session** — re-reads live Cognito attrs via the branded-host httpOnly cookies and mints a fresh id_token with current `custom:notify_channels`. **Do NOT use `forceRefreshBundle` here**: Cognito's `refresh_token` flow re-issues id_tokens with the claim snapshot from mint-time (NOT current attributes), so the "fresh" token stays stale and the subsequent `mint-ws-ticket` embeds the stale claim too. The mint-sid-from-cookies path is the same one hard-refresh uses and is the only in-session way to get live claims. (Mike IT-F2-406 c/xxx.har 2026-10-19 observed WS 4403 persistence until the SPA switched to this path.)
2. **setIdToken(fresh)** — React state change triggers any socket-opening effect to tear down + reconnect with new mint-ws-ticket calls. f2-api's 4403 gate at WS connect-time now reads live claims (per §3's `resolveLiveNotifyChannels`, since c/0d4af52) so either the fresh-token path OR the backend live-resolve covers it; two defenses in depth.
3. **f2:entitlement-changed CustomEvent** — the entitled-channels effect listens for this and refetches `/api/scanners/:slug/entitled-channels` → sidebar padlock state updates. Backgrounded tabs catch up on next `focus`.

End-to-end latency: ~1-3s per f2-session's measurement (admin save → F2:USER_UPDATES → SSE → SPA chain).

---

## 5. SPA adoption checklist for a new scanner

Backend (f2-session's lane, usually):

- [ ] `Scanners.<slug>.channels[]` populated with `{id: "<slug>.<n>", slug, title}` entries. Numbers 1-indexed by insertion order.
- [ ] `scanners-by-host` surfaces the `channels` field (already does — zero scanner-specific work).
- [ ] `/api/scanners/<slug>/entitled-channels` returns `{channels: number[]}` for the authed user (one endpoint fleet-wide; one line to add to the handler's whitelist if it's slug-filtered).
- [ ] f2-api `loadStreamViewsFromScanners` captures `channels[]` on each view (`scannerChannels` field) — already does for scanners that have the field.
- [ ] WS gate rejects un-entitled subscribes with code 4403 — fleet-standard, no per-scanner config.

SPA:

- [ ] Fetch `channels` from `scanners-by-host` on mount (same effect that already pulls `presets` / `rank_views` for this scanner). Each entry carries `{id, slug, title}` — read `title` for the sidebar label.
- [ ] Fetch `/api/scanners/<slug>/entitled-channels` via `guardedFetch` (Bearer + X-F2-Session-Id); normalize response's `number[]` into a `Set<number>` in state. Null state = no gating (safe default when backend data is absent or the user has all channels).
- [ ] `isScanEntitled(scan)` helper: null entitledChannels OR scan has no `number` → entitled; else `.has(scan.number)`.
- [ ] Sidebar renders un-entitled tabs grayed + 🔒 icon + onClick fires "Subscribe to unlock" modal.
- [ ] Purchase modal with scan label + CTA → customer purchase URL (SOT field name is per-customer; `Customers.<slug>.purchase_url` or similar — confirm with Mike per scanner).
- [ ] (Optional) WS skip in sockets effect: build `skipSlugs` from un-entitled scans + pass to the socket opener so SPA doesn't open sockets it knows will 4403. Defense-in-depth; backend 4403 is authoritative.
- [ ] SSE wire to `/rest/admin/users-live/stream` per §4 — on `entitlement_changed`: `forceRefreshBundle()` + `setIdToken(fresh)` (triggers socket reconnect) + `dispatchEvent('f2:entitlement-changed')` (triggers entitled-channels refetch).
- [ ] Entitled-channels effect also listens on `window` `focus` so backgrounded tabs catch up.
- [ ] WS close handler reads `ev.code === 4403` → stop retrying that socket (reconnect would just 4403 again; auth token is still valid; next sanitize probe + entitled-channels refetch catches the state).

Admin app:

- [ ] No work needed on the admin frontend — the existing scanner-driven channels editor (`f2-admin/src/app/admin/shared/channels-editor/channels-editor.component.ts`) reads the lowercase `channels[]` + writes `custom:notify_channels`. Any scanner that populates `channels[]` gets the editor UI for free.

---

## 6. Anti-patterns

- **Parallel entitlement SOT alongside push-notification SOT**. Had this on IT-F2-406 initial ships (f2-session c/354268b introduced `Channels[]` + `custom:channels` separate from `channels[]` + `custom:notify_channels`). Mike c/f09a42e4 overruled: *"shouldn't require rewriting that UI"*. Collapsed to one SOT. Don't re-split.
- **SPA-only skipSlugs with no backend 4403**. Backend MUST be the authoritative gate. SPA skip is defense-in-depth; a tampered SPA that opens all WS without respecting the SPA state must still get 4403'd.
- **`admin-update-user-attributes` without a propagation path**. If the SPA has no way to pick up the change short of sign-out+sign-in, admin edits don't reach the UI. SSE wire + forceRefreshBundle + socket reconnect is the recipe; skipping any one of those leaves a UX gap.
- **Reading `custom:channels` instead of `custom:notify_channels`**. The former was retired in f2-session's pivot. Belt-and-suspenders fallback decoders can keep reading it as a legacy path during the transition, but the authoritative claim is `custom:notify_channels`.

---

## 7. Reference implementations

- **SPA (React, single-file)**: `option-sniper-tape/src/OptionSniperTape.jsx`
  - Catalog fetch via `fetchScannerRow('os-osv2')` → `row.channels` normalization
  - `useEffect` on `/api/scanners/os-osv2/entitled-channels` + id_token fallback decoder
  - `isScanEntitled(s)` useMemo helper
  - Sidebar padlock render in `Sidebar` component
  - Purchase modal (`lockedScanOpen` state)
  - SSE handler inside the sanitize-probe effect (dispatches `f2:entitlement-changed`)
  - WS 4403 close handler in `openOptionSniperSockets`

- **Backend (f2-admin-service)**: `src/controllers/rest/ApiController.ts` (scanners-by-host, entitled-channels) + `src/services/scanners.service.ts` (channels mutation path) + f2-admin-service PRs #233 → #236 for the current contract.

- **Backend (f2-api)**: WS 4403 gate in `loadStreamViewsFromScanners` + ticket-verify path (f2-api PR #7 → #8).

- **Admin UI**: `f2-admin/src/app/admin/shared/channels-editor/channels-editor.component.ts` — unchanged, works for any scanner that populates `channels[]`.

---

## 8. Origin

Filed on IT-F2-406 (Option Sniper Tape v2 ship) at Mike's request c/ca92ded0 2026-10-17 after the end-to-end pattern landed via a series of back-and-forth ships between f2-session (backend) + alpha-shark-ux (SPA) + Mike's reviews. Captures the final architecture so the next adopter inherits it without reconstructing it from the chat archaeology.
