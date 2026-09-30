# Live Data Scanner Recipe

Canonical recipe for adding **live / delayed market-data handling** — Exchange
Agreements, session displacement, WS-driven status changes, and the DataTier
chip / ExchangeAgreements banner — to any customer-facing F2 scanner SPA.

Core4 (`alpha-pivot-frontend`) is the reference implementation. Every state,
copy string, and behavior below was Mike-approved on IT-F2-391 and is now
being rolled to the fleet under IT-F2-413.

---

## 1. What the SPA renders

Two coordinated UI elements per SPA:

1. **DataTier chip** — pill in the SPA header. One of seven states.
2. **ExchangeAgreements banner** — dismissible top-of-page strip when the
   user needs to fill out or resubmit an agreement.
3. (Contextual) **SessionDisplaced banner** — pulsing top-of-page strip when
   another window / session took this user's live-data seat.

### 1.1 DataTier chip states

Copy strings are **verbatim**. Do not paraphrase.

| State | Trigger | Label | Class | Click |
|---|---|---|---|---|
| **Live** | `data_tier: "realtime"` | `● Live Data` | `dtc-chip live` (green) | Open Exchange Agreements modal |
| **Displaced** | `data_tier: "delayed_displaced"` OR legacy `displaced === true` | `● Another window is live — click to reload` | `dtc-chip displaced` (orange) | Clear `sessionStorage.f2_session_id` + reload; new mount reclaims via `X-F2-Claim-Slot: reclaim` |
| **Pro gate** | `data_tier: "delayed_pro_gate"` | `● Pro — 15-min delayed` | `dtc-chip pro` (blue) | Open Exchange Agreements modal |
| **Under Review** | `data_tier: "delayed_by_agreement"` + `review_status: "pending"` | `● 15-min Delayed Data · Non Pro · Agreement Under Review` | `dtc-chip pending` (light blue) | Open Exchange Agreements modal (status view) |
| **Declined** | `data_tier: "delayed_by_agreement"` + `review_status: "declined"` | `● 15-Min Delayed Data (Live Declined) ↗` | `dtc-chip declined` (red) | Open Exchange Agreements modal (resubmit view) |
| **Delayed - default** | `data_tier: "delayed_by_agreement"` + no `review_status` | `● 15-min Delayed Data ↗` | `dtc-chip` (amber) | Open Exchange Agreements modal (fill-out view) |
| **Denied / null** | `data_tier: "denied"` OR `null` (probe not yet returned) | *(nothing rendered)* | — | n/a |

### 1.2 ExchangeAgreements banner states

Backend now derives the banner payload on the sanitize probe response as
`banner: { visible, label, message, kind }` (f2-admin-service PR #178,
IT-F2-413 clar `21ff819a` Mike answer A). SPA prefers backend values when
present; falls back to the local switch when the response predates PR #178.

Local-fallback rules:

- `visible = bannerVisible && !displaced && dataTier !== "delayed_pro_gate"`
- Label / message vary on `reviewStatus`:
  - `"pending"` → `AGREEMENT UNDER REVIEW` / "Your Exchange Agreement is with the compliance team. Realtime data unlocks after approval."
  - `"declined"` → `SWITCHED TO DELAYED DATA` / "You're now on 15-minute delayed data (…). Update your Exchange Agreement and resubmit for realtime access."
  - `null` → `DELAYED DATA MODE` / "Data is delayed 15 minutes. Fill out Exchange Agreement to access realtime data."

Dismissal is per-session per-customer, keyed by
`AGREEMENT_CUSTOMER:${reviewStatus ?? "none"}` so state flips re-arm the
banner without carrying over a stale dismiss.

### 1.3 SessionDisplaced banner

Pulsing red strip that appears above ExchangeAgreements banner when
`displaced === true`. Copy: "Another session has taken your realtime data".
Click "Reclaim" → clears session_id and reloads.

---

## 2. Load-order contract

> Mike IT-F2-391 c/6e4a9ab8:
> *"that initial live shouldn't be there until you've checked the status of
> the user, no live data no delayed data etc when you get the status you
> load the correct version"*

**The chip MUST return `null` when `data_tier === null`.** No flash of "Live
Data" while the sanitize probe is in flight. Same rule for the banner —
render nothing until the probe has landed.

**Consumer-side rule that follows from this:** initialize your
`dataTier` state to `null` (NOT to `"realtime"` or any other truthy
value). The shared `DataTierChip` component returns `null` when its
prop is `null`, so a null initial state → nothing visible → probe
completes → real value rendered. Initializing to `"realtime"` will
render a Live chip on first paint and flash to the correct state
after the probe roundtrip — a specific violation of this contract
that has surfaced on multiple adopter smokes (Mike c/7fb410f0
"the delayed/real time chip doesn't showup right away" report).

```tsx
// ✅ Correct
const [dataTier, setDataTier] = useState<DataTier>(null);

// ❌ Wrong — flashes Live until probe completes
const [dataTier, setDataTier] = useState<DataTier>("realtime");
```

Same rule for `bannerVisible` (init `false` — the probe will set it
true if needed) and every other `data.banner`-derived state.

### 2.1 Fire the probe FIRST, before any other data fetch

The chip is invisible until `data_tier` arrives. So the perceived
"time to chip" is entirely the sanitize probe's roundtrip. If the
probe fires late — after your scanner-data fetches — the chip appears
long after the rest of the UI, which looks broken to users (Mike
IT-F2-391 c/1cbacfeb: "the live/delayed chip [doesn't] load first").

**Prescription:** the sanitize probe MUST be the FIRST authenticated
fetch on mount. Don't await your rows / signals / options / alerts
before starting it. Concretely:

```tsx
useEffect(() => {
  // Fire the probe IMMEDIATELY — no `await` before this call.
  probeAgreements();           // ← §3.4 trigger 1: mount
  probeMe();                   // identity (parallel is fine)
  // Only THEN kick off scanner-data fetches:
  fetchLatestSignals();
}, []);
```

Common anti-patterns that push chip render late:

- **Awaiting identity before probing agreements** — `await probeMe();
  then probeAgreements();` doubles the perceived chip latency. Fire
  both in parallel; neither depends on the other.
- **Gating probe on user-triggered action** — probe should be
  unconditional on mount, not deferred until the user clicks a
  header button.
- **Wrapping the probe in a `useEffect` that depends on other state**
  — the probe useEffect should have `[]` deps so it fires on the
  first render, not after some other state has settled.
- **Rendering the chip inside a lazy-loaded route** — the chip
  should render at the App root, not deep inside a page that hasn't
  been mounted yet.
- **Slow probe endpoint** — if your `/rest/user/data-agreements?sanitize=1`
  routinely takes > 500 ms, the chip WILL feel late. Check
  f2-admin-service2's Redis cache warmth for that user; a cold cache
  read from Cognito can take 1-2 s. Warm-cache probes should return
  < 100 ms.

Verify in DevTools: filter Network by `data-agreements`, sort by
Time. The probe should be one of the first ~3 requests on mount
(after the SPA bundle itself + any auth handshakes).

---

## 3. Sanitize-probe protocol

### 3.1 Endpoint

```
GET /rest/user/data-agreements?customer=<slug>&sanitize=1&_ts=<ms>
```

Path is Vercel-proxied to `f2-admin-service2`. `sanitize=1` strips
identifying fields; `_ts` defeats intermediary caches.

### 3.2 Response shape

```jsonc
{
  "data_tier": "realtime" | "delayed_by_agreement"
              | "delayed_pro_gate" | "delayed_displaced" | "denied",
  "data_tier_reason": "<stable key>",
  "live_data_access": boolean,        // legacy — derive from data_tier
  "review_status": "pending" | "approved" | "declined" | null,
  "review_reason": string | null,
  "pro": boolean,
  "displaced": boolean,               // legacy — prefer data_tier === "delayed_displaced"
  "banner": {                          // PR #178
    "visible": boolean,
    "label": string,
    "message": string,
    "kind": "delayed" | "pending" | "declined" | null
  }
}
```

### 3.3 401 Displaced handling

When `status === 401` and `X-F2-Reject-Reason: displaced`, the backend
gates on displacement BEFORE evaluating entitlement. A follow-up read
with `X-F2-Iframe-Context: 1` triggers the backend's iframe carve-out
and returns the true entitlement state:

- If real state = `realtime` → user IS displaced (was entitled). Render
  displaced chip + banner.
- If real state = anything else → user was never entitled anyway.
  Render their true state (`delayed_by_agreement` / `pro_gate` / etc.)
  instead of over-signaling displaced.

Follow-up fetch failure → fall back to conservative "displaced" state
(safer than misrendering as LIVE).

**Wire format** (IT-F2-421 c/d2908178 addendum, observed in gap-up-down
HAR 2026-09-23):

- Rejected response body: `{name:"UNAUTHORIZED",message:"session_displaced",status:401,errors:[]}`
- Follow-up iframe-context response body already contains a fully-
  populated `chip` subdoc for the displaced state (label / title /
  aria_label set by `data-agreements.service.ts` — no need to compose
  the copy on the SPA side). Pass the subdoc through to `DataTierChip`
  as `chip={...}` instead of nulling it. Nulling forces the shared
  component into its hardcoded fallback branch; the fallback branch is
  correct today but leaves the SPA one refactor away from a text-less
  chip if the copy ever drifts.
- Backend also returns `data_tier: "delayed_displaced"` directly in the
  iframe-context response (not `realtime`), so the "if real state =
  realtime" branch is the safety-net path for future changes — the
  active path is "backend already labelled it displaced, trust it".

### 3.4 Triggers to re-probe

Fire `probeAgreements()` on every one of these:

1. Mount
2. Window `focus` event
3. Every 60 s (fallback poll)
4. WS `live_access_changed` (legacy; f2-admin-service Redis
   `ea:live_access_changed`)
5. WS `entitlement_changed` (current; Redis `F2:USER_UPDATES`)
6. WS `session_displaced` (Redis `F2:LIVE_SESSIONS_UPDATES`)
7. WS `session_reclaimed` (same channel)
8. BroadcastChannel `slot_claimed` message from a sibling tab

---

## 4. Displacement handling

### 4.1 Same-user duplicate-tab problem

Chrome/Firefox copy sessionStorage into duplicated tabs, so N dup tabs
share one `f2_session_id` → backend sees one session → no displacement
fires → all N tabs report LIVE. Fix: **session_id dedup handshake** on
mount.

- On mount, generate a per-mount nonce + `mountTs`.
- Broadcast `session_id_hello { id, mountTs, nonce }` on the
  `f2_live_slot` BroadcastChannel.
- If a sibling replies with the SAME id + different nonce, whichever
  mounted later regenerates the session_id and reclaims. Tie-break:
  earlier `mountTs` wins.

### 4.2 Cross-user / cross-window displacement

`session_displaced` WS event fires on the losing side. Options:

- **Chip-only handling (current default):** flip chip to displaced state;
  user clicks to reclaim.
- **Auto-reload (IT-F2-413 c/9489623 + c/f71dfdd guard):** SPA reloads
  itself once, guarded against loops via `suppressNextClaim()` on the
  first fetch of the reload cycle. Prevents the just-reloaded tab from
  immediately re-claiming the slot it just displaced someone from
  (c/e192b7e / c/f816b700).

### 4.3 Same-tab focus-back

When the user returns focus after filling the agreement in another tab,
the `focus` handler re-probes and updates chip/banner. Also detects
`live_data_access` flipping false → true and pops the "sign in again"
modal (see §5).

---

## 5. Post-approve live-flip: token refresh + re-login modal

### 5.1 Silent token refresh

When admin approves a delayed user, Cognito flips
`custom:live_data_access`. But the SPA's cookie carries the OLD claim
until a fresh id_token mint. Silent refresh path (`refreshTokens()`
in `httpClient`) re-mints and drops fresh cookies before the next
authenticated fetch runs.

**Stale-claim gate** — must be resettable:

```ts
const staleClaim = { refreshed: false };

// In probeAgreements:
if (!live && rs === "approved" && !staleClaim.refreshed) {
  staleClaim.refreshed = true;
  const ok = await refreshTokens();
  // re-probe with fresh cookie ...
}

// In WS handlers:
const onEntitlementFlip = () => { staleClaim.refreshed = false; probeAgreements(); };
socket.on("live_access_changed", onEntitlementFlip);
socket.on("entitlement_changed", onEntitlementFlip);
socket.on("session_reclaimed", onEntitlementFlip);
// session_displaced does NOT reset — displacement doesn't change the
// Cognito attribute, only slot ownership.
```

Reason: without the reset, only the FIRST post-approve flip refreshes
the token. Mid-session decline+re-approve leaves the chip frozen on the
pre-flip tier (Mike fc7560e1 2026-09-17 report; fixed on
IT-F2-391 c/ed7e536).

### 5.2 Re-login modal fallback

If `refreshTokens()` fails AND the new state IS live (`live === true`),
pop a non-blocking modal:

> Sign in again to activate realtime data
> Your Exchange Agreement is on file. Your current session still
> carries the delayed-data claims — sign out and sign back in for the
> realtime upgrade to take effect.

Buttons: "Later" (dismiss) / "Sign in again" (POST `/rest/auth/logout`
+ wipe cookies + redirect to `members.f2-tech.ai/login`).

### 5.3 Decline-after-approve

Symmetric flip handling: `true → false` = post-approve decline
(Mike c/89f57e72: "I need to be able to decline the user after they
have been approved"). Same silent-refresh path applies so downstream
fetches see the demoted claims.

---

## 6. Live-slot claim shape

**Open decision** (IT-F2-413 clar `910138be`, awaiting Mike answer):

- **A. Path-scoped** — backend claims ONLY when the request path is
  `/rest/user/data-agreements?sanitize=1`. Zero SPA changes.
- **B. Header-scoped opt-in** — SPA sends
  `X-F2-Claims-Live-Slot: 1` on the ONE fetch per mount it wants to
  claim. Non-live pages don't send it.
- **AB.** Default to path-scoped; SPAs may opt in via header for
  edge cases.
- **no-op.** Keep the current claim-by-default + piecemeal carve-outs
  (admin, iframe).

Recipe recommendation once Mike answers: mirror the answer here and add
the one-line SPA change (if B/AB) to the adoption checklist below.

---

## 7. Cross-tab / cross-origin broadcast

`BroadcastChannel("f2_live_slot")` message types:

- `session_id_hello { id, mountTs, nonce }` — dedup handshake (§4.1).
- `slot_claimed { at }` — sent by whichever tab lands `live=true` first.
  Sibling tabs re-probe within ~100 ms — closes the WS-fanout latency
  gap.

Falls back gracefully when BroadcastChannel is unavailable (Safari
private mode, some iframe embeds) — the WS + focus + 60 s poll still
cover the state.

---

## 8. WS transport pattern

Same-origin `socket.io` polling transport, path `/socket.io/`, routed
through the SPA's own `alpha-pivot-service`-style backend via Vercel
rewrites. Cross-origin WSS to `f2-backend-srvr2` doesn't work when
cookies are bound to the branded-domain host (they arrive with
`cookieLen=0` and auth fails).

Events subscribed:

| Event | Fired by | Handler |
|---|---|---|
| `live_access_changed` | `f2-admin-service` (Redis `ea:live_access_changed`, legacy) | reset staleClaim + `probeAgreements()` |
| `entitlement_changed` | `f2-session` admin-review (Redis `F2:USER_UPDATES`) | reset staleClaim + `probeAgreements()` |
| `session_displaced` | Same-scanner slot loss (Redis `F2:LIVE_SESSIONS_UPDATES`) | `probeAgreements()` (do NOT reset staleClaim) |
| `session_reclaimed` | Same-scanner slot reclaim | reset staleClaim + `probeAgreements()` |

### 8.1 Member-scope SSE alternative

`f2-gap-up-down` (IT-F2-421) uses the fleet's members-scope Server-Sent
Events endpoint instead of socket.io, since gap-up-down has no
`alpha-pivot-service`-style backend of its own:

```
POST /rest/admin/users-live/stream-token → {token}
GET  /rest/admin/users-live/stream?token=<t>  (EventSource)
```

The token minter now accepts `member` role in addition to `admin` /
`client_admin` (f2-admin-service commit `0836619`). Member scope carries
BOTH `username` and `email` — envelope-side `username` can be sub OR
email depending on the call site (`LiveSessionService` uses sub;
`validate-portal-token` uses email), so filter must match either.

`LiveSessionService.updateLiveSessionSlot` publishes displacement on
both `F2:USER_UPDATES` (with `op:'entitlement_changed', reason:
'displaced_by_other_session'`) AND `F2:LIVE_SESSIONS_UPDATES` (with
`op:'session_displaced'` / `session_reclaimed`). The stream service
that fans `F2:USER_UPDATES` to member SSE consumers must:

- Preserve `op:'entitlement_changed'` (do NOT rewrite to `'upsert'`).
- Allow envelopes with null `pool_id` (`LiveSessionService`'s
  displacement envelope carries `pool_id: null` legitimately).

Otherwise displacement pings never reach the SPA — the F2:USER_UPDATES
belt-and-suspenders path silently drops (fixed in `f2-admin-service`
commit `4ea2e79`).

---

## 9. Adoption checklist for a new SPA

Copy this section into each fleet-adopter PR:

- [ ] Import `DataTierChip` from `f2tech-shared/data-tier-chip`.
- [ ] Import `ExchangeAgreementsBanner` from `f2tech-shared/exchange-agreements-banner`.
- [ ] Import `SessionDisplacedBanner` from `f2tech-shared/session-displaced-banner`.
- [ ] Import `useExchangeAgreementsPopup` from `f2tech-shared/exchange-agreements-popup` (see §12.0 for the one-import wire-up).
- [ ] Set an `AGREEMENT_CUSTOMER` slug matching your product's key in `f2-admin-service2`. Threaded through sanitize probe, popup URL, banner dismiss key.
- [ ] Wire the sanitize probe on mount (§3).
- [ ] Subscribe to all four WS events (§8) via same-origin socket.io polling.
- [ ] Wire BroadcastChannel dedup handshake (§4.1).
- [ ] Guard the chip with the load-order contract (§2). No flash of Live Data.
- [ ] Add the silent-refresh path with a resettable staleClaim gate (§5.1).
- [ ] Wire the re-login modal fallback (§5.2).
- [ ] Wrap `<ExchangeAgreementsBanner>` in the `onClickCapture` interceptor (§12.2) so the built-in CTA link opens the popup instead of navigating out.
- [ ] Pass the hook's `openAgreements` to your account menu / coin's `onAgreementsClick` AND to `<DataTierChip>`'s `onAgreementsClick` (§12.6). Same reference, three triggers → one popup.
- [ ] Verify the seven chip states render with the EXACT copy in §1.1 (grep-diffable regression check).
- [ ] Smoke: probe hits exactly once on mount; zero flash of Live Data for delayed users; displaced state reload clears session_id; **clicking the banner, the coin, and the chip all open the SAME popup, and the popup URL contains `/<slug>/` (not `?customer=`)**.

---

## 10. Reference implementations

- **Component library (canonical):** `f2tech-shared` — this repo. See
  `src/data-tier-chip.tsx`, `src/data-tier-banner.tsx`,
  `src/session-displaced-banner.tsx`, `src/exchange-agreements-banner.tsx`,
  `src/exchange-agreements-popup.tsx` (modal + `useExchangeAgreementsPopup` hook, §12.0),
  `src/agreements.js`.
- **Socket.io consumer wire-up:** `alpha-pivot-frontend`
  (Core4 SPA) — `src/App.tsx`. Probe useEffect around line 200;
  socket.io WS handlers around line 500; iframe modal around line 615.
  Backend adapter: `alpha-pivot-service` fans `entitlement_changed`
  / `session_displaced` / `session_reclaimed` from Redis to the
  per-user socket.
- **Member-scope SSE consumer wire-up:** `f2-gap-up-down` (IT-F2-421)
  — `src/api/dataTier.ts` (probe + BroadcastChannel dedup + SSE
  reconnect) and `src/App.tsx` (chip + banner + re-login modal +
  displaced banner). For SPAs without an
  `alpha-pivot-service`-style backend of their own.

---

## 11. Common services + endpoints reference

Every SPA adopting this recipe touches the same fleet services. Copy
this section into your SPA's onboarding wiki as-is.

### 11.1 Backend services (pm2 on `web-backend-srvr-1`)

| Service | Role | Owns |
|---|---|---|
| `f2-admin-service2` | Identity, entitlements, agreements review | Cognito claim writes, sanitize probe, admin approve/decline, agreement submissions |
| `f2-auth-service2` | Redeem-session + token refresh | `/rest/auth/redeem-session`, `/rest/auth/refresh`, `/rest/auth/logout` |
| `alpha-pivot-service` *(or your SPA's per-scanner backend)* | Per-SPA data + Redis→socket fan-out | `/api/*` REST endpoints, `/socket.io/` transport, subscribes to `F2:USER_UPDATES` + `F2:LIVE_SESSIONS_UPDATES` |
| `f2-api` | Fleet /api aggregator | Live-slot claim gating (path- or header-scoped per IT-F2-413 clar `910138be`) |
| `f2-tracker-service` | Ticket + WS event stream | Only relevant if the SPA surfaces ticket state; not part of the live-data flow |

### 11.2 REST endpoints (SPA → backend, via Vercel `/rest/*` proxy)

All endpoints route through the SPA's `vercel.json` rewrites →
`f2-admin-service2` or the per-scanner backend. Cookies are
`HttpOnly` and `SameSite=None; Secure; Partitioned` (per iframe
compatibility contract on `feedback_iframe_context_needs_explicit_x_f2_header_for_setcookie_partitioned`).

| Method | Path | Owner | Purpose |
|---|---|---|---|
| `GET` | `/rest/user/data-agreements?customer=<slug>&sanitize=1&_ts=<ms>` | `f2-admin-service2` | **The sanitize probe.** Returns `data_tier` + `review_status` + `pro` + `displaced` + `banner` payload. Sole source of chip state. |
| `GET` | `/rest/user/data-agreements?...` + `X-F2-Iframe-Context: 1` | `f2-admin-service2` | Iframe carve-out — bypass displaced gate to read true entitlement (see §3.3). |
| `GET` | `/rest/api/me` | `f2-admin-service2` | Identity for banner CTA (email/first/last pre-fill the agreement form). |
| `POST` | `/rest/auth/refresh` | `f2-auth-service2` | Silent token refresh — mints fresh id_token from Cognito after admin claim flip. |
| `POST` | `/rest/auth/logout` | `f2-auth-service2` | Full sign-out. Used by re-login modal "Sign in again". |
| `POST` | `/rest/auth/redeem-session?sid=<one-time-id>` | `f2-auth-service2` | SSO redeem — customer-branded domain lands here after Cognito → plants cookies scoped to the branded host. |
| `GET` | `/api/*` (per-scanner) | your SPA backend | Data endpoints. Claim-by-default vs opt-in per IT-F2-413 clar `910138be`. |
| `GET` | `/socket.io/*` | your SPA backend | Same-origin polling transport (see §8). |

**Iframe-context header:** any auth-cookie-planting response landing
in an iframe browsing context (Firefox / Safari 3rd-party cookie
policy) needs `X-F2-Iframe-Context: 1` on the request so the backend
forces `SameSite=None; Secure; Partitioned` on Set-Cookie.

### 11.3 WebSocket events (backend → SPA, via socket.io)

Same-origin `/socket.io/` polling transport. Server-side push, no
client polling. All events target the affected user's socket only
(gated by `userData.sub` on the backend side).

| Event | Emitter | Redis channel | SPA handler |
|---|---|---|---|
| `live_access_changed` | `f2-admin-service2` (legacy path) | `ea:live_access_changed` | reset staleClaim + `probeAgreements()` |
| `entitlement_changed` | `f2-session` admin-review approve/decline | `F2:USER_UPDATES` | reset staleClaim + `probeAgreements()` |
| `session_displaced` | Backend on new session claiming the slot | `F2:LIVE_SESSIONS_UPDATES` | `probeAgreements()` (do NOT reset staleClaim) |
| `session_reclaimed` | Backend on this session reclaiming | `F2:LIVE_SESSIONS_UPDATES` | reset staleClaim + `probeAgreements()` |

Subscribe on the same `io()` handle right after mount; unsubscribe in
the effect cleanup. `entitlement_changed` supersedes
`live_access_changed`; both are subscribed for backward compatibility
with older admin flips still going through the legacy channel.

### 11.4 Redis channels (for backend teams adopting the fan-out)

| Channel | Publisher | Payload key |
|---|---|---|
| `F2:USER_UPDATES` | `f2-admin-service2.update_user_live_access` + `f2-session.review_user_data_agreement` (per f2-session c/86fe29f4) | `{ userSub, dataTier, reviewStatus }` |
| `F2:LIVE_SESSIONS_UPDATES` | Per-scanner backend on slot ownership change | `{ userSub, scanner, op: "displaced"\|"reclaimed" }` |
| `ea:live_access_changed` *(legacy)* | `f2-admin-service.update_user_live_access` | `{ userSub, live }` |

Per-scanner backends must subscribe to both `F2:USER_UPDATES` and
`F2:LIVE_SESSIONS_UPDATES` and fan out to `userSub`-matched sockets.

### 11.5 Cookie contract

Set by `f2-auth-service2.redeem-session` on the SPA's origin.

| Cookie | Contents | Attributes |
|---|---|---|
| `f2_id` | Cognito id_token (carries `custom:live_data_access` claim) | `HttpOnly; SameSite=None; Secure; Partitioned` |
| `f2_access` | Cognito access_token | same |
| `f2_refresh` | Cognito refresh_token (only path `/rest/auth/refresh`) | same, path-scoped |
| `f2_session_id` | Per-tab live-slot claim id | `sessionStorage`-only — NOT a cookie. Copied into duplicate tabs; use dedup handshake (§4.1). |

### 11.6 Header contract

| Header | Direction | Meaning |
|---|---|---|
| `X-F2-Iframe-Context: 1` | request | Force Set-Cookie `SameSite=None; Secure; Partitioned` (Firefox/Safari iframe compatibility). |
| `X-F2-Claim-Slot: reclaim` | request | Reclaim intent on the next probe. Sent from displaced-chip reload path. |
| `X-F2-Claims-Live-Slot: 1` | request | Header-scoped live-slot claim opt-in (IT-F2-413 clar `910138be` option B/AB). Pending Mike's answer. |
| `X-F2-Reject-Reason: displaced` | response | 401 gate reason. SPA re-probes with iframe-context header (§3.3). |

### 11.7 Vercel rewrites (SPA `vercel.json`)

Every fleet-adopter SPA needs at least:

```jsonc
{
  "rewrites": [
    { "source": "/rest/auth/:path*",       "destination": "https://f2-admin-service2.f2-tech.ai/rest/auth/:path*" },
    { "source": "/rest/:path*",            "destination": "https://f2-admin-service2.f2-tech.ai/rest/:path*" },
    { "source": "/api/:path*",             "destination": "https://f2-backend-srvr2.f2-tech.ai/<your-scanner>/api/:path*" },
    { "source": "/socket.io",              "destination": "https://f2-backend-srvr2.f2-tech.ai/<your-scanner>/socket.io" },
    { "source": "/socket.io/",             "destination": "https://f2-backend-srvr2.f2-tech.ai/<your-scanner>/socket.io/" },
    { "source": "/socket.io/:path+",       "destination": "https://f2-backend-srvr2.f2-tech.ai/<your-scanner>/socket.io/:path+" },
    { "source": "/data-agreements",        "destination": "https://admin.f2-tech.ai/data-agreements" },
    { "source": "/data-agreements/:path*", "destination": "https://admin.f2-tech.ai/data-agreements/:path*" }
  ]
}
```

The `/data-agreements` proxy is what lets the iframe modal keep the URL
bar on the customer-branded host end-to-end.

---

## 12. SPA wire-up — banner render, popup, account menu

The §1 rendering description tells you *what* the three UI elements
look like. This section is *how* to wire them into your SPA — every
piece another adopter needs to make Live/Delayed actually work
end-to-end. All examples lifted from the Core4 reference implementation
(`t3-core4-frontend/src/App.tsx`).

> **Fast path for new adopters:** import
> `useExchangeAgreementsPopup` from `f2tech-shared/exchange-agreements-popup`
> and skip §12.3, §12.4, §12.5 below — the hook bundles URL construction,
> mint-sid flow, and iframe modal into one call. See §12.0 for the
> one-import pattern. The subsections below are for adopters who need
> to understand what the hook does (troubleshooting, or if you need to
> customize a piece).

### 12.0 One-import pattern (recommended)

> **Wrong-popup canary.** If clicking your banner or coin opens a
> small centered white modal that says "Real-Time Market Data" with
> a green "View Agreements" button that opens the form in a new tab,
> you're consuming the pre-2026-09-30 stub version of
> `ExchangeAgreementsPopup`. The correct popup is a dark full-height
> iframe modal titled "Exchange Agreements" that renders the
> per-customer form INLINE (no new tab). Fix: upgrade your
> `f2tech-shared` dependency past 2026-09-30 and switch to the hook
> below — do NOT import `ExchangeAgreementsPopup` alone; use
> `useExchangeAgreementsPopup` so URL construction + mint-sid +
> modal mount all match Core4's reference behavior.

> **Empty-iframe canary.** If the popup shell opens (dark bar,
> "Exchange Agreements" title, Close button) but the iframe body is
> blank / white / a members login page, one of three prerequisites
> is missing:
>
> 1. **`/rest/auth/mint-sid-from-cookies` isn't reachable** — the
>    scanner's `vercel.json` must proxy `/rest/*` to
>    `f2-admin-service2.f2-tech.ai/rest/*`. Without this the mint
>    step 404s, the hook falls back to the identity-only URL, and
>    `members.f2-tech.ai` can't authenticate the iframe embed. Check
>    the Network tab for the mint POST — it should be 200 with
>    `{ sid: "…" }`.
> 2. **`guardedFetch` isn't wired** — if your SPA uses raw `fetch`,
>    a stale scanner `f2_id` cookie 401s the mint POST silently.
>    Import your local `httpClient.ts` `guardedFetch` (or write the
>    minimal wrapper — see §12.4) and pass it to the hook.
> 3. **Members doesn't have this customer's form** — every product
>    slug needs a per-customer Exchange Agreements form set up in
>    `f2-admin-service2`. If the mint POST returns 200 AND the URL
>    is `https://members.f2-tech.ai/<slug>/data-agreements?sid=…`
>    but the iframe is still blank, load the URL directly in a new
>    tab: if you see "Customer not found" or a bare login page,
>    file a fleet ticket to add `<slug>` to members' config.
>
> Symptoms map: 404 in Network on mint → prereq 1. 401 in Network
> on mint → prereq 2. Both green but iframe still blank → prereq 3.

```tsx
import {
  useExchangeAgreementsPopup,
} from "f2tech-shared/exchange-agreements-popup";
import { ExchangeAgreementsBanner } from "f2tech-shared/exchange-agreements-banner";
import { DataTierChip } from "f2tech-shared/data-tier-chip";
import { guardedFetch } from "./api/httpClient";

const AGREEMENT_CUSTOMER = "t3";   // ← your product slug

function App() {
  // ... probe state per §3, identity per §12.4 ...
  const { openAgreements, popupNode } = useExchangeAgreementsPopup({
    customerSlug: AGREEMENT_CUSTOMER,
    identity: { email: meEmail, first: meFirst, last: meLast },
    guardedFetch,
  });

  return (
    <>
      {popupNode}
      <div onClickCapture={(e) => {
        const el = e.target as HTMLElement;
        if (el && el.closest("a")) {
          e.preventDefault(); e.stopPropagation();
          openAgreements();
        }
      }}>
        <ExchangeAgreementsBanner ... agreementUrl={buildAgreementUrl(...)} />
      </div>
      <TopMenu   onAgreementsClick={openAgreements} ... />
      <DataTierChip onAgreementsClick={openAgreements} ... />
    </>
  );
}
```

That's the full pattern. Same `openAgreements` reference is passed to
banner's click-interceptor, account menu, and DataTier chip — one
popup, three triggers.

If you need to customize a piece (different modal styling, different
URL host, no mint-sid), read on. Otherwise §12.0 is enough.

### 12.0.1 Complete working App.tsx skeleton (copy-paste starting point)

Adopters keep reporting "recipe still empty" — usually because
fragments across §12.1-§12.6 don't glue together obviously. This
skeleton is the smallest working App that renders the chip, banner,
popup, and coin all wired to one hook. Copy it, add your product-
specific bits (main content, other menus), and the Live/Delayed
plumbing is done.

```tsx
import { useEffect, useState } from "react";
import { DataTierChip } from "f2tech-shared/data-tier-chip";
import { ExchangeAgreementsBanner } from "f2tech-shared/exchange-agreements-banner";
import { SessionDisplacedBanner } from "f2tech-shared/session-displaced-banner";
import { useExchangeAgreementsPopup } from "f2tech-shared/exchange-agreements-popup";
import { guardedFetch } from "./api/httpClient";   // your SPA's authed-fetch

const AGREEMENT_CUSTOMER = "your-slug";            // matches f2-admin-service2 customer key

type DataTier =
  | "realtime" | "delayed_by_agreement" | "delayed_pro_gate"
  | "delayed_displaced" | "denied" | null;
type ReviewStatus = "pending" | "approved" | "declined" | null;
type BannerFromBackend = { visible: boolean; label: string; message: string; kind: string | null } | null;

export default function App() {
  // ============================================================
  // §2 Load-order contract: EVERY state that shapes chip/banner
  // visibility MUST initialize to a falsy/null value so nothing
  // renders until the probe returns.
  // ============================================================
  const [dataTier, setDataTier] = useState<DataTier>(null);
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>(null);
  const [reviewReason, setReviewReason] = useState<string | null>(null);
  const [displaced, setDisplaced] = useState(false);
  const [isPro, setIsPro] = useState(false);
  const [bannerVisible, setBannerVisible] = useState(false);
  const [bannerFromBackend, setBannerFromBackend] = useState<BannerFromBackend>(null);
  const [meEmail, setMeEmail] = useState<string | null>(null);
  const [meFirst, setMeFirst] = useState<string | null>(null);
  const [meLast,  setMeLast]  = useState<string | null>(null);

  // ============================================================
  // §12 Popup hook — bundles mint-sid + URL construction + iframe.
  // Same `openAgreements` reference is passed to banner interceptor,
  // account menu, AND DataTierChip below.
  // ============================================================
  const { openAgreements, popupNode } = useExchangeAgreementsPopup({
    customerSlug: AGREEMENT_CUSTOMER,
    identity: { email: meEmail, first: meFirst, last: meLast },
    guardedFetch,
  });

  // ============================================================
  // §2.1 Fire the probe FIRST — before any scanner-data fetch.
  // No `await` before probeAgreements(). Identity runs in parallel.
  // ============================================================
  useEffect(() => {
    let cancelled = false;
    const probeAgreements = async () => { /* … see §3.4 … */ };
    const probeMe         = async () => { /* … GET /rest/api/me … */ };

    probeAgreements();                 // ← FIRST
    probeMe();                         // ← parallel, no await
    // Only NOW start scanner-data:
    // fetchLatestSignals();

    // §3.4 re-probe triggers (focus / poll / BroadcastChannel / WS)
    const onFocus = () => probeAgreements();
    window.addEventListener("focus", onFocus);
    const pollTimer = window.setInterval(probeAgreements, 60_000);
    // … BroadcastChannel + socket.io setup per §7, §8 …

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(pollTimer);
    };
  }, []);   // ← [] deps: mount-only. Non-empty deps push probe late.

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* 1. Popup — mount ONCE, anywhere. Content is null until
             openAgreements() flips it visible. */}
      {popupNode}

      {/* 2. SessionDisplaced banner — rendered first so it wins if
             the user is displaced (banner below is guarded off). */}
      <SessionDisplacedBanner
        visible={displaced}
        onReclaim={() => {
          try { sessionStorage.removeItem("f2_session_id"); } catch { /* ignore */ }
          window.location.reload();
        }}
      />

      {/* 3. ExchangeAgreements banner — wrapped in onClickCapture
             so the built-in CTA link opens the popup INSTEAD of
             navigating to admin.f2-tech.ai. */}
      <div onClickCapture={(e) => {
        const el = e.target as HTMLElement;
        if (el && el.closest("a")) {
          e.preventDefault();
          e.stopPropagation();
          openAgreements();
        }
      }}>
        <ExchangeAgreementsBanner
          visible={
            bannerFromBackend
              ? bannerFromBackend.visible
              : (bannerVisible
                 && !displaced
                 && dataTier !== "delayed_pro_gate"
                 && dataTier !== "delayed_displaced"
                 && reviewStatus !== "approved")
          }
          dismissible
          dismissKey={`${AGREEMENT_CUSTOMER}:${bannerFromBackend?.kind ?? reviewStatus ?? "none"}`}
          label={bannerFromBackend?.label ?? "DELAYED DATA MODE"}
          message={bannerFromBackend?.message ?? "Data is delayed 15 minutes. Fill out Exchange Agreement to access realtime data."}
          agreementUrl={`https://members.f2-tech.ai/${AGREEMENT_CUSTOMER}/data-agreements`}
        />
      </div>

      {/* 4. Header row with chip + coin. `openAgreements` is the
             SAME REFERENCE the banner interceptor uses above. */}
      <header style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px" }}>
        <DataTierChip
          dataTier={dataTier}
          reviewStatus={reviewStatus}
          displaced={displaced}
          isPro={isPro}
          isDelayed={bannerVisible}
          onAgreementsClick={openAgreements}
        />
        {/* Your account menu / coin passes the same handler: */}
        {/* <TopMenu onAgreementsClick={openAgreements} … /> */}
      </header>

      {/* 5. Your product's main content below. */}
      <main style={{ flex: 1, overflow: "auto" }}>{/* … */}</main>
    </div>
  );
}
```

**vercel.json must include (§11.7):**

```jsonc
{
  "rewrites": [
    { "source": "/rest/auth/:path*", "destination": "https://f2-admin-service2.f2-tech.ai/rest/auth/:path*" },
    { "source": "/rest/:path*",      "destination": "https://f2-admin-service2.f2-tech.ai/rest/:path*" }
  ]
}
```

Without the `/rest/*` rewrite, the mint-sid POST 404s, the hook
falls back to identity-only URL, and the iframe shows blank content
even though the shell renders. This is the #1 cause of the
"popup still empty" report.

**If the skeleton is complete and you still see empty content:**
walk the §12.0 Empty-iframe canary — Network-tab diagnostics for
mint-sid 404 vs 401 vs 200-but-blank-iframe map to specific
prereqs.

### 12.0.2 End-to-end trace — how the iframe actually renders content

Adopter reports of "popup is empty" keep coming. Every one has been
a specific step in the chain below returning the wrong thing. Walk
this trace ticking off each step; whichever step fails is where your
SPA is stuck.

The correct rendered result is a members-side dashboard with:
"T3 Market Data Dashboard" header + "Reviewing as: <email>" +
Live Data pill + Data Agreements table with Modify / Download
buttons per row.

If you don't see that, one of these steps failed:

**Step 1 — User clicks banner / coin / chip.**
Handler fires: `openAgreements()`. Confirm your handler is the
`openAgreements` returned by `useExchangeAgreementsPopup`. Debug:
`console.log("openAgreements called")` at the top of your handler.

**Step 2 — Hook fires `POST /rest/auth/mint-sid-from-cookies`.**
This is the LOAD-BEARING call. It must reach `f2-admin-service2`.
Debug:

```
DevTools Network → filter "mint-sid" → click the row → Headers tab
```

- **Status 200 with body `{ sid: "…" }`** → move to step 3.
- **Status 404** → your `vercel.json` is missing the `/rest/*`
  rewrite. Add both entries from §11.7 (`/rest/auth/:path*` AND
  `/rest/:path*`). Redeploy. Retest.
- **Status 401** → your SPA session cookies (`f2_id`, `f2_access`)
  are expired or missing. Verify by logging out + back in. If it
  works fresh but 401s after a while, your SPA is using raw `fetch`
  instead of `guardedFetch` — the latter refreshes the id_token
  before retry.
- **Request never fires** → the hook didn't run. Check your handler
  isn't swallowing the click before `openAgreements` runs (e.g.
  `<button onClick={(e) => { e.preventDefault(); }}>` without calling
  the handler).

**Step 3 — Hook sets popup URL to
`https://members.f2-tech.ai/<slug>/data-agreements?sid=<sid>&email=&first=&last=`.**
Debug: add `console.log(url)` inside `setUrl(...)` in the hook (or
inspect the iframe's `src` attribute in Elements). Verify:

- `<slug>` is your customer key (e.g. `t3`, `oxc`). Wrong slug →
  members returns "customer not found" or blank.
- `sid=` value looks like a JWT / opaque token (not empty).
- `email` / `first` / `last` reflect what your `/rest/api/me` returned
  (not `undefined`).

**Step 4 — Browser loads the iframe against members.**
The iframe should show a T3-branded / customer-branded dashboard
after ~200 ms. Debug: right-click the iframe → "Inspect" → look at
the `<iframe>` element's Network activity, OR copy the URL and open
in a new tab.

- **Members returns the Live Data pill + agreements table** →
  success. If popup body is still blank, check for a CSS z-index
  issue on the iframe (should be visible above the shell).
- **Members shows a login page or "Please sign in"** → sid was
  invalid. Likely: mint returned 200 but with an empty / bad sid,
  or the sid expired between mint and iframe load (rare, but sids
  are short-lived).
- **Members shows "Customer not found" or "Unknown customer"** →
  the `<slug>` in the URL doesn't have a customer record in
  f2-admin-service2. This is a fleet-config task, not a SPA task.
  File a ticket to add the slug to f2-admin-service2's customer
  registry.
- **Members shows a blank white page (no server-rendered content)** →
  members.f2-tech.ai itself is 500-ing. Check members' health / pm2
  logs on the deploy target.

**Step 5 — User interacts with the iframe.**
Members submits its own network requests to admin.f2-tech.ai (via
its own auth). Not your SPA's concern — but if the iframe form
submits and gets "no access cookie" errors, your sid mint used the
wrong cookies or members' cookie-forwarding is broken. See feedback
memory `iframe_context_needs_explicit_x_f2_header_for_setcookie_partitioned`.

**Verification harness (curl-based):**

```bash
# Step 2: mint should return 200 + a sid.
curl -sS -c /tmp/cj.txt -b /tmp/cj.txt \
     -X POST "https://<your-spa-host>/rest/auth/mint-sid-from-cookies" \
     -H "content-type: application/json" -d '{}' \
     -H "Cookie: <paste your f2_id + f2_access cookies here>"
# Expected: {"sid":"…"}

# Step 4: iframe URL should return HTML (not "customer not found").
curl -sS "https://members.f2-tech.ai/<slug>/data-agreements?sid=<sid>&email=you%40example.com&first=You&last=Test" \
     | head -c 500
# Expected: HTML starting with <!DOCTYPE html> including "T3 Market Data" or your customer's branding.
```

If both curls return the expected result and the SPA still shows an
empty iframe, the failure is in the browser (CSP, X-Frame-Options,
Vercel-level middleware). Grep the response headers on step 4's URL
for `X-Frame-Options` and `Content-Security-Policy` — if either
blocks iframe embedding from your SPA's origin, coordinate with
members' owner to allow the origin.


### 12.1 Customer-slug plumbing

One constant used in **three** places. Slug must match your product's
`customer` key in `f2-admin-service2`.

```ts
const AGREEMENT_CUSTOMER = "t3";   // ← your product slug
```

Consumed by:

1. Sanitize probe URL — `?customer=<slug>` query param (§3.1).
2. Popup URL path segment — `https://members.f2-tech.ai/<slug>/data-agreements` (§12.4).
3. Banner dismiss key — `${AGREEMENT_CUSTOMER}:${kind ?? reviewStatus}`
   so a stale dismissed state from one customer doesn't suppress
   another customer's banner if a user logs into both.

### 12.2 Rendering the ExchangeAgreements banner

The banner is a shared component from `f2tech-shared`. Backend PR #178
now derives `data.banner` on the sanitize probe (`{visible, label,
message, kind}`); prefer that when present, fall back to the local
switch for older probe responses.

**Critical: wrap the banner in a click-interceptor.** The banner's
built-in CTA link points at `agreementUrl` (a real
`members.f2-tech.ai/<slug>/data-agreements` URL). If the user clicks
that raw link, the browser navigates out to a different origin
(`members.f2-tech.ai` vs the branded scanner host), which bounces the
user through non-customer-branded Cognito login and breaks the
end-to-end branded experience. Mike 2026-09-15 c/8e1d3753 called this
out. Intercept every anchor click inside the banner and route it to
your in-app popup instead.

```tsx
import { ExchangeAgreementsBanner } from "f2tech-shared/exchange-agreements-banner";

const agreementUrl = buildAgreementUrl(meEmail, meFirst, meLast);
                    // members.f2-tech.ai/<slug>/data-agreements?email=&first=&last=

<div
  onClickCapture={(e) => {
    const el = e.target as HTMLElement;
    if (el && el.closest("a")) {
      e.preventDefault();
      e.stopPropagation();
      openAgreements();   // opens the in-app iframe popup instead
    }
  }}
>
  <ExchangeAgreementsBanner
    visible={
      bannerFromBackend
        ? bannerFromBackend.visible
        : (bannerVisible
           && !displaced
           && dataTier !== "delayed_pro_gate"
           && dataTier !== "delayed_displaced"
           && reviewStatus !== "approved")
    }
    dismissible
    dismissKey={`${AGREEMENT_CUSTOMER}:${bannerFromBackend?.kind ?? reviewStatus ?? "none"}`}
    label={ bannerFromBackend?.label ?? /* fallback per §1.2 */ }
    message={ bannerFromBackend?.message ?? /* fallback per §1.2 */ }
    agreementUrl={agreementUrl}
  />
</div>
```

Visibility guards on the local-fallback branch (all must hold):

- `bannerVisible` (set true when the sanitize probe returned non-live).
- Not `displaced` (the SessionDisplaced banner takes over).
- Not `delayed_pro_gate` (Pro-gate has its own copy, no CTA banner).
- Not `delayed_displaced` (see displaced).
- Not `reviewStatus === "approved"` (they're approved, don't nag).

Skipping any of these guards is the #1 "why is my banner showing when
it shouldn't" ticket.

### 12.3 Building the popup URL (customer-slug filtered)

The popup shows the Exchange Agreements form scoped to a single
customer. The URL segment tells `members.f2-tech.ai` which product's
form + branding to serve.

```ts
function buildAgreementUrl(
  email: string | null, first: string | null, last: string | null
): string {
  const p = new URLSearchParams();
  if (email) p.set("email", email);
  if (first) p.set("first", first);
  if (last)  p.set("last", last);
  const qs = p.toString();
  return `https://members.f2-tech.ai/${AGREEMENT_CUSTOMER}/data-agreements${qs ? "?" + qs : ""}`;
}
```

URL shape history (all deprecated except the current one — use the
current form, do NOT copy the older shapes from any older docs):

- `admin.f2-tech.ai/data-agreements?customer=<slug>` — original,
  killed by Firefox 3rd-party cookie block on iframe.
- `members.f2-tech.ai/data-agreements?customer=<slug>` — replaced
  because `?customer` is easier to lose on middleware rewrites and
  doesn't reach the branded-domain logic path.
- `members.f2-tech.ai/<slug>/data-agreements` ← **current**, from
  `f2-session` PR #42 (2026-09-15). Slug resolves from path segment
  first, then falls back to `getBrandByHost()` on customer-branded
  domains.

Email / first / last query params pre-fill the "who are you?"
identity step. `members.f2-tech.ai` cannot re-fetch this itself when
loaded in a 3rd-party iframe (Firefox strict tracking protection kills
its own /me cookies). Pass what your scanner already has from
`/rest/api/me`.

### 12.4 The `openAgreements()` mint-sid + popup flow

Two-step: mint a session id from the scanner's cookies, hand it to the
popup URL. If the mint fails (401 / stale token), fall through to the
bare identity-only URL so the popup still opens with a login CTA
rather than blank.

```ts
const buildPopupParams = (sid?: string) => {
  const p = new URLSearchParams();
  if (sid) p.set("sid", sid);
  if (meEmail) p.set("email", meEmail);
  if (meFirst) p.set("first", meFirst);
  if (meLast) p.set("last", meLast);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
};

const openAgreements = async () => {
  const bare = `https://members.f2-tech.ai/${AGREEMENT_CUSTOMER}/data-agreements`;
  try {
    // guardedFetch (not raw fetch) — a stale scanner id_token triggers
    // /rest/auth/refresh + retry before mint-sid runs. Without this,
    // an hour-old scanner session 401s on mint, we fall through to
    // the bare URL, members has nothing to redeem, and any authed
    // action inside the iframe 401s downstream (Mike HAR 2026-09-15
    // c/245e0bc1 — "no access cookie" on send-code, "no refresh
    // cookie" on /api/refresh — members had never received a redeem
    // call because our sid never got minted).
    const r = await guardedFetch("/rest/auth/mint-sid-from-cookies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (r.ok) {
      const body = await r.json();
      if (body?.sid) {
        setPopupUrl(`${bare}${buildPopupParams(body.sid)}`);
        setPopupVisible(true);
        return;
      }
    }
  } catch { /* fall through */ }
  setPopupUrl(`${bare}${buildPopupParams()}`);
  setPopupVisible(true);
};
```

### 12.5 The iframe popup mount

**Why an iframe** (not a new tab or full navigation): the URL bar
must stay on the branded scanner host end-to-end. Full-page navigation
to `members.f2-tech.ai` shows the wrong host in the address bar and
loses branding. Iframe keeps the URL bar on `scanners.<brand>.dev`
throughout.

```tsx
{popupVisible && (
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="ea-iframe-title"
    className="fixed inset-0 z-[10001] bg-black/70 flex items-center justify-center p-4"
    onClick={(e) => { if (e.target === e.currentTarget) setPopupVisible(false); }}
  >
    <div className="bg-white dark:bg-slate-900 rounded-lg shadow-2xl w-full max-w-[1100px] h-[85vh] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-slate-50 dark:bg-slate-800">
        <h2 id="ea-iframe-title" className="text-[14px] font-semibold">Exchange Agreements</h2>
        <button type="button" onClick={() => setPopupVisible(false)} aria-label="Close">Close</button>
      </div>
      <iframe src={popupUrl} title="Exchange Agreements" className="flex-1 w-full border-0" />
    </div>
  </div>
)}
```

State two variables:

```ts
const [popupVisible, setPopupVisible] = useState(false);
const [popupUrl, setPopupUrl] = useState("");
```

The `popupUrl` set by `openAgreements()` is the absolute
`members.f2-tech.ai/<slug>/data-agreements?sid=&email=&first=&last=`
URL. The scanner window's URL bar stays on the branded host because
only the iframe navigates — the outer window doesn't change location.

Vercel rewrite for legacy `/data-agreements` same-origin paths (kept
for adopters using the older stub URL shape):

```jsonc
{ "source": "/data-agreements",        "destination": "https://admin.f2-tech.ai/data-agreements" },
{ "source": "/data-agreements/:path*", "destination": "https://admin.f2-tech.ai/data-agreements/:path*" }
```

### 12.6 Account menu / coin — "View exchange agreements" item

Every place that renders an account menu (top-right coin, drawer,
whatever) passes `onAgreementsClick={openAgreements}` so its "View
exchange agreements" (or similar) item calls the same popup opener.
Also pass it to the DataTierChip so clicking the chip opens the
popup:

```tsx
<TopMenu
  theme={theme}
  setTheme={setTheme}
  onNavigate={onNavigate}
  onAgreementsClick={openAgreements}      // ← coin menu wire-up
  email={meEmail} firstName={meFirst} lastName={meLast}
/>

<DataTierChip
  dataTier={dataTier}
  reviewStatus={reviewStatus}
  displaced={displaced}
  isPro={isPro}
  isDelayed={bannerVisible}
  onAgreementsClick={openAgreements}      // ← chip click wire-up
/>
```

If your account menu component doesn't already have an
`onAgreementsClick` prop, add one and render a "View exchange
agreements" item that calls it. The Core4 `TopMenu` at
`t3-core4-frontend/src/shared/TopMenu.tsx` is the reference.

### 12.7 Common gaps other adopters hit

Traced from Mike's IT-F2-391 adopter reports (c/26aa77c0, c/0e07f80b,
c/7fb410f0). Every item below is a specific gap that isn't obvious
from §1's rendering description alone.

- **Banner not rendered at all** — check the visibility guards in
  §12.2. Most common: the SPA sets `bannerVisible` from the probe
  but never checks `!displaced`, so a displaced user sees BOTH
  banners stacked, then dismisses ExchangeAgreements which stays
  dismissed and hides the CTA even after `!displaced` becomes true.
- **Coin "View exchange agreements" doesn't open the popup** —
  `onAgreementsClick` wasn't passed to the menu. See §12.6.
- **Popup opens but shows the wrong customer (no filter)** — the
  URL is missing the `/<slug>/` path segment. Check `AGREEMENT_CUSTOMER`
  is threaded through `openAgreements()` and `buildAgreementUrl()`
  (§12.1, §12.3).
- **Popup opens but 401s on send-code / any authed action** — the
  mint-sid step failed silently. The bare-URL fallback opens the
  popup but members has no sid to redeem. Verify `guardedFetch`
  refreshes the scanner id_token before mint. See §12.4.
- **Banner CTA link opens a new tab instead of the in-app popup** —
  missing `onClickCapture` interceptor. See §12.2.
- **Popup renders "unknown user" or asks for identity again** —
  `email` / `first` / `last` query params weren't threaded from
  `/rest/api/me`. See §12.4.
- **Popup is the wrong shape** (small white centered modal saying
  "Real-Time Market Data" with a "View Agreements" button that opens
  a new tab instead of the branded iframe form) — the SPA is
  consuming the pre-2026-09-30 stub of `ExchangeAgreementsPopup`.
  Upgrade `f2tech-shared` and switch to
  `useExchangeAgreementsPopup` per §12.0.
- **Chip doesn't render right away** (blank space where the chip
  should be for several seconds after mount) — expected during the
  sanitize probe roundtrip (§2 load-order contract: chip is null
  until `data_tier` arrives). If the wait is longer than ~500ms:
  check `/rest/user/data-agreements?sanitize=1` latency in the
  Network tab. If the chip flashes as Live for a split-second then
  switches to delayed: your SPA is initializing `dataTier` to
  `"realtime"` instead of `null` — set the initial state to `null`
  so the chip stays hidden until the real value arrives.
- **Chip renders and then disappears after probe completes** — the
  SPA initialized `dataTier` to a truthy default and the real probe
  returned `null` / `denied`. Same fix as above: initial state MUST
  be `null`.

---

## 13. Origin

Filed at Mike's request:

- IT-F2-391 comment `37f96bac-5f20-4185-b3d9-b929878c5970` — full recipe.
- IT-F2-391 comment `49f92c26-8d76-4283-8598-cff3ca19c952` — services + endpoints section (§11).
- IT-F2-391 comment `26aa77c0-4650-486f-8268-dbefd7b018b9` — SPA wire-up section (§12), covering banner render + popup + account-menu wire gaps another adopter hit trying to follow the earlier version.
- IT-F2-391 comments `0e07f80b-b99d-459a-ade7-4ffde2addf57` + `7fb410f0-0b57-451b-8066-b48c94f4edf9` — the `useExchangeAgreementsPopup` hook + §12.0 fast path + the wrong-popup canary + the "chip doesn't render right away" troubleshoot entry.
- IT-F2-391 comments `1750fccb-56e0-4882-996f-a4ab4c5a538f` + `1cbacfeb-03de-4f06-9223-ee7d371ab84f` — §12.0 empty-iframe canary (three prereqs mapped to Network-tab signatures) + §2.1 fire-probe-first prescription with five anti-patterns.

> Take everything you learned about how to make a scanner handle
> live/delayed data exchange agreements/displacement live websockets
> for status changed and displacement for the next window and put it
> into a common .md file — what the chip looks like, what the banner
> looks like, etc. I need requirements and directions for the next
> scanner to follow.
> …
> Did you detail the common services and endpoints used in that .md
> as well?
> …
> I had another spa agent use your LIVE_DATA_SCANNER_RECIPE.md and it
> fell short. There's no banner at the top, it doesn't bring up the
> same exchange agreement page filtered for the customer slug, the
> exchange agreement on the account coin doesn't work either. Can you
> update that file with how you learned during this work — those
> should since it doesn't have your evolution knowledge.
