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
    { id: "<slug>.<number>", slug: "<channel-slug>", title: "<display name>" },
    // e.g. { id: "os-osv2.1", slug: "lottery", title: "Lottery" }
    // ...
  ]
}
```

**`id` is the composite** — `<scanner-slug>.<channel-number>`. This is the string that lands in the user's `custom:notify_channels` CSV. Numbers are 1-indexed in the order channels were added.

**`slug` + `title`** are display-only. `slug` matches whatever the SPA uses as its internal tab id. `title` is what renders in both the admin editor + the SPA sidebar.

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

**Open question** (TBD f2-session): should this endpoint read from the id_token's claim (fast, no Cognito round-trip) or from `AdminGetUser` server-side (always current, no stale-token caching)? Current implementation reads from id_token. On IT-F2-406 c/101c47fc Mike reported hard-refresh doesn't pick up admin changes because the refresh_token re-mints with stale claims — an `AdminGetUser` read would bypass that. Decision pending; this section will update.

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

Writes land in `AuditEntitlementChanges` via the `ENTITLEMENT_ATTRS` set in `UsersController.updateUserAttributes` (f2-admin-service c/e1f41de added `custom:channels`; verify `custom:notify_channels` is in the set too).

### 2.4 Pool-mismatch gotcha

QA identities (like `member-support@f2-tech.com`) exist across multiple Cognito pools. The admin app's channels editor only renders the scanner card when the user row is sourced from the pool that owns the scanner. For OS Tape, the pool is `us-east-1_g37WPaiar`. Picking the "wrong" member-support row in the admin grid → empty-state message, which is correct behavior, not a bug. (f2-session cid aa528d2e 2026-10-17.)

---

## 3. WebSocket gate — f2-api 4403 close code

f2-api closes the WS with code **4403** when the user's `custom:notify_channels` doesn't include `<scannerId>.<channel-number>` for the sub-tape they're trying to subscribe to. Distinct from `1008` (auth dead) so the SPA can render a padlock + "contact admin / subscribe" affordance instead of a sign-in prompt.

Payload:

```json
{"error": "channel_not_entitled", "code": "channel_not_entitled", "required_channel": "os-osv2.5"}
```

**Backend mechanism** (f2-session c/537adca / b053cc9):
1. `Scanners.<id>.channels[]` captured on each view at `loadStreamViewsFromScanners` time (`scannerChannels` field on the view). No second mongo read at handshake.
2. At WS connect, after `verifyWsTicket` + admin-role resolution, resolve `v.collection` → channel entry → required `<slug>.<number>` composite.
3. If the user's `custom:notify_channels` doesn't include the composite + user isn't admin, send the error envelope + close 4403.

**Backwards compat**: scanners whose Scanner doc has no `channels[]` skip the gate entirely.

---

## 4. Live propagation — SSE `/rest/admin/users-live/stream`

### 4.1 Redis channel

Admin writes to `custom:notify_channels` publish on the fleet `F2:USER_UPDATES` redis channel:

```json
{"op": "entitlement_changed", "user_id": "<sub>", "changed_attrs": {"custom:notify_channels": "..."}, "at": "<iso>"}
```

### 4.2 SSE stream

`GET /rest/admin/users-live/stream?token=<short-lived-mint>` on `f2-admin-service` forwards the envelope to the authenticated user. Mint via `POST /rest/admin/users-live/stream-token` first (TTL 60s; re-mint every 55s).

### 4.3 SPA SSE handler — four-step reaction

On receive of an `entitlement_changed` envelope whose `changed_attrs.custom:notify_channels` is set:

```js
eventSource.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg?.op === 'entitlement_changed') {
    (async () => {
      const refreshed = await forceRefreshBundle();      // 1. silent id-token refresh
      if (refreshed) {
        const fresh = getIdToken();
        if (fresh) setIdToken(fresh);                     // 2. triggers sockets effect
      }
      window.dispatchEvent(new CustomEvent('f2:entitlement-changed'));  // 3. refetch entitled-channels
    })();
  }
};
```

Why four steps:

1. **forceRefreshBundle** — swaps the in-memory id_token for a fresh one. **Open gotcha**: on standard Cognito, the refresh_token re-mints id_tokens with the claim snapshot taken at mint time, NOT current user attributes. If this is still happening after f2-session's resolution, step 1 is a no-op for the claim and only steps 2-4 matter. See §2.2 TBD.
2. **setIdToken(fresh)** — React state change triggers any socket-opening effect to tear down + reconnect with new mint-ws-ticket calls. f2-api's 4403 gate at WS connect-time reads the new claim and admits the now-entitled channels.
3. **f2:entitlement-changed CustomEvent** — the entitled-channels effect listens for this and refetches `/api/scanners/:slug/entitled-channels` → sidebar padlock state updates.
4. **(implicit) `focus` listener** on the entitled-channels effect — backgrounded tabs refetch on next focus so they're not forever stale.

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
