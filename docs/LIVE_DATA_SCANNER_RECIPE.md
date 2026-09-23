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
- [ ] Wire the sanitize probe on mount (§3). Set an `AGREEMENT_CUSTOMER` slug for your product.
- [ ] Subscribe to all four WS events (§8) via same-origin socket.io polling.
- [ ] Wire BroadcastChannel dedup handshake (§4.1).
- [ ] Guard the chip with the load-order contract (§2). No flash of Live Data.
- [ ] Add the silent-refresh path with a resettable staleClaim gate (§5.1).
- [ ] Wire the re-login modal fallback (§5.2).
- [ ] Add the iframe modal for `/data-agreements` (vercel.json rewrite to `admin.f2-tech.ai`).
- [ ] Verify the seven chip states render with the EXACT copy in §1.1 (grep-diffable regression check).
- [ ] Smoke: probe hits exactly once on mount; zero flash of Live Data for delayed users; displaced state reload clears session_id.

---

## 10. Reference implementations

- **Component library (canonical):** `f2tech-shared` — this repo. See
  `src/data-tier-chip.tsx`, `src/data-tier-banner.tsx`,
  `src/session-displaced-banner.tsx`, `src/exchange-agreements-banner.tsx`,
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

## 12. Origin

Filed at Mike's request:

- IT-F2-391 comment `37f96bac-5f20-4185-b3d9-b929878c5970` — full recipe.
- IT-F2-391 comment `49f92c26-8d76-4283-8598-cff3ca19c952` — services + endpoints section (§11).

> Take everything you learned about how to make a scanner handle
> live/delayed data exchange agreements/displacement live websockets
> for status changed and displacement for the next window and put it
> into a common .md file — what the chip looks like, what the banner
> looks like, etc. I need requirements and directions for the next
> scanner to follow.
> …
> Did you detail the common services and endpoints used in that .md
> as well?
