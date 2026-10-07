# Scanner Tracking Recipe

Fleet-wide, scanner-agnostic recipe covering **everything we record
about a scanner over its lifecycle**:

- **Entitlement tracking** (§2-3) — who holds the scanner (Cognito
  `custom:scanners` + `F2-ADMIN.UserTracking` activate / deactivate
  events + billing report supplement gate).
- **Access-route tracking** (§2.3-2.4) — how a holder reaches the SPA
  (scanner-side `/rest/auth/validate-token` → `allowed_routes` → SPA
  `has_route_access`).
- **Exchange-agreement tracking** (§4) — per-customer agreement
  coverage gating live-data display
  (`/rest/user/data-agreements?customer=<slug>` sanitize probe →
  `data_tier` + chip subdoc).
- **Live-vs-delayed usage tracking** (§7a) — which tier a user
  actually consumed. Partially recorded today (login events +
  entitlement attributes); full per-session tier log is a gap.
- **Scanner view tracking** (§7b) — which scanner the user actually
  opened. **Unimplemented today.** Shape documented so adopters agree
  before anyone ships.

Sibling of the other scanner recipes:

- `SNAPSHOT_DATE_PICKER_RECIPE.md` — snapshot-vs-live row sourcing
- `LIVE_DATA_SCANNER_RECIPE.md` — tier + displacement + chip
- `SCANNER_DATA_WIRING_RECIPE.md` — producer → f2-api → SPA data path
- `AG_GRID_INFINITE_SCROLL_RECIPE.md` — paginated row delivery

Target reader: a backend / `f2-session` agent landing a new scanner
who needs the lifecycle recorded correctly across billing, agreements,
usage, and (future) view instrumentation — without re-deriving from
fleet code.

---

## 1. The two F2-ADMIN.Scanners field groups

A `Scanners` doc carries two unrelated groups of fields. They look
like one object but serve different consumers:

### 1.1 Catalog surface — Url + AppUrl + Name + Client

Consumed by **everything user-facing + commerce**:

- `members.f2-tech.ai` scanner tile grid
- `admin.f2-tech.ai/admin/scanners` grid + edit modal
- SamCart / Kartra / WooCommerce product-mapping dropdowns
- Cognito `custom:scanners` → `allowed_routes` derivation (scanner-side
  `auth.service.ts validate_token` walks every scanner the user holds,
  resolves its `Url` pathname, and populates `allowed_routes` for the SPA)
- Billing reports — Scanner.Id ↔ Scanner.Client join against UserTracking

Required for a scanner to be **visible / purchaseable / billable**.

### 1.2 Stream subdoc — f2-api wiring

Consumed by **`f2-api/server.js loadStreamViewsFromScanners`** only:

```js
{
  Enabled, Channel, WsPath, RestPath, SourceDbPattern,
  DelayedDbPattern?,  // NO-OP in f2-api/server.js — field is read in
                      // op-rr but never consumed; the actual tier
                      // routing uses applyTierToPattern regex at
                      // L2246 which handles F2_LIVE- and OS_LIVE-
                      // only. For other prefixes, extend regex OR
                      // add scanner-row flag + plumb through.
  Collection, Append, KeyField, Legacy,
  SymbolListName?,    // optional server-side symbol-list filter
  SkipPremiumFloor?,  // IT-F2-287 — opt out of the default $10K
                      // TradePremium floor for scanners whose docs
                      // don't carry that field (percentile-based
                      // schemas like op-zeta)
}
```

Required for the scanner to **serve WS + REST data at
`/ws/<WsPath>` + `/rest/<RestPath>`**.

### 1.3 The trap — Stream-only rows

A `Scanners` row with ONLY the `Stream` subdoc (no Url / AppUrl /
Name / Client) can **route data** but can't:

- Appear in member-facing catalog tiles
- Be mapped by SamCart / Kartra / WooCommerce product_map
- Resolve `allowed_routes` for the SPA (`custom:scanners`=`<id>` won't
  match any Scanner.Url pathname)
- Join against UserTracking in billing reports (no `Client` →
  no customer attribution)

Rule: **every Scanner doc needs BOTH groups filled**. The one
exception is sub-tab scanners that share a canonical SPA route with
another scanner (see §6 Merged-view attribution).

---

## 2. Cognito `custom:scanners` → `allowed_routes` flow

End-to-end flow for how a user's scanner entitlements become a SPA
route gate:

### 2.1 Entitlement write

A user's scanner access is a comma-separated list in the Cognito
`custom:scanners` attribute. Written by:

- `user-management.service.ts client_activate_user(apiKey, {email,
  scanners:[...]})` — adds a scanner, cache-invalidates
- `admin.f2-tech.ai` Edit User → Scanners editor
- SamCart / Kartra / WooCommerce webhook handlers (via
  `client_activate_user` after product_map lookup)
- Direct Cognito console write (last-resort)

### 2.2 UserTracking write (billing side)

The activation **also** writes to `F2-ADMIN.UserTracking`:

```js
db.UserTracking.insertOne({
  email, customer, scanner,
  start_date: new Date(), active: true,
  events: [{ type: 'add_scanner', scanner, date }]
})
```

Written from `user-management.service.ts upsert_tracking` at
~L6772-6848. The UserTracking collection is the **authoritative
history** for billing — Cognito's `custom:scanners` is the live state
but doesn't carry when-granted or who-triggered-it. Billing walks
UserTracking.

### 2.3 Validate-token derivation

When the SPA calls `POST /rest/auth/validate-token { token, sanitize }`:

1. Scanner-side `theo-trade-service` / `option-pit-service` / etc. runs
   its own `auth.service.ts validate_token` (per-scanner-backend copy
   of the fleet pattern — e.g.
   `/home/ubuntu/theo-trade-service/src/services/auth.service.ts:280`
   log line: `validate_token: ok email=X is_admin=Y
   allowed_routes=[...] ...`).
2. The service reads the user's `custom:scanners` CSV from the id_token.
3. For each scanner id, it looks up `Scanners.<id>.Url`, extracts the
   pathname (`/scans/<slug>`), and appends to `allowed_routes`.
4. Returns `{ allowed_routes: ['/scans/A', '/scans/B', ...], ... }`.

### 2.4 SPA consumer

The SPA's `has_route_access('/scans/X')` checks `allowed_routes`
membership. For a brand-new scanner:

- If `Scanners.<id>.Url` is empty → `allowed_routes` won't include
  the scanner's route → users with the claim still can't reach the
  SPA page.
- If the SPA route is `/scans/<slug>` but `Scanners.<id>.Url` ends in
  `/scans/<other-slug>` → gate blocks the real route.

**Fix pattern**: set `Scanners.<id>.Url =
'https://<customer-host>/scans/<slug>'` to match the SPA's actual
mount path. The hostname doesn't participate in `has_route_access` —
only the pathname does — but members-portal + admin-console use the
full URL as the clickable link.

---

## 3. UserTracking activations + deactivations

Backing collection for all billing-report attribution.

### 3.1 Document shape

```
F2-ADMIN.UserTracking (one doc per (email, customer) relationship):
{
  _id: ObjectId,
  email: 'user@example.com',
  customer: 'theo-trade',          // customer slug (not display name)
  scanners: ['tt-mti', 'tt-leap'], // currently-held scanners
  start_date: <customer activation date>,
  end_date: <deactivation date> | null,
  active: true | false,
  events: [
    { type:'add_scanner', scanner:'tt-mti', date: <ISO> },
    { type:'remove_scanner', scanner:'tt-leap', date: <ISO> },
    ...
  ]
}
```

### 3.2 Fleet-standard write path

Writes land via `user-management.service.ts`:

- `client_activate_user` (webhook / admin-UI trigger)
- `client_deactivate_user` (webhook / admin-UI trigger)
- Edit User → Scanners editor PUT

Direct Mongo writes bypass the Cognito cache + UserTracking supplement.
Avoid unless you also do `redisService.client.hDel(userCacheKey(pool),
email)` + a `pm2 restart f2-admin-service2` for the 60s customer-doc
cache.

### 3.3 Billing report consumption

`billing.service.ts get_billing_report`:

1. Query `UserTracking` for the report window.
2. For every row: emit per-month logs for each held scanner.
3. **Supplement from Cognito** when UserTracking is missing a row but
   `custom:scanners` has the claim (per-(email, customer, scanner)
   gate — IT-F2-157). This covers users granted the scanner directly
   in Cognito without a UserTracking write (SamCart bulk-package
   activations pre-IT-F2-136, direct-Cognito retro-grants).
4. Dedupe per month across sources.

**Confirming your new scanner shows up:**

```
# admin.f2-tech.ai/admin/billing-reports → set month, filter by
# scanner_id → the new scanner should appear in the dropdown + the
# count column should be non-zero after the first activation.
```

If the scanner is in the dropdown but counts are zero:

- Check `UserTracking.scanners` contains `<slug>` (activation wrote
  correctly).
- Check `custom:scanners` on an activated user carries the slug
  (Cognito supplement path works).
- Check `Scanners.<id>.Client` matches the customer slug UserTracking
  uses — join key is `scanner.Client ↔ UserTracking.customer`.

---

## 4. Exchange-agreement scope — per-customer, not per-scanner

Every scanner serving **live** market data must gate on a signed
exchange agreement for its customer. The agreement is scoped to the
**customer slug**, not the individual scanner.

### 4.1 Sanitize probe

The SPA polls:

```
GET /rest/user/data-agreements?sanitize=1&customer=<slug>
Authorization: Bearer <id_token>
X-F2-Session-ID: <per-tab UUID>
```

Returns:

```json
{
  "data_tier": "realtime" | "delayed_by_agreement" | "delayed_pro_gate"
             | "delayed_displaced" | "denied",
  "review_status": "pending" | "approved" | "declined" | null,
  "chip": { "variant": "...", "label": "...", "title": "...",
            "aria_label": "..." }
}
```

Precedence ladder (highest wins) per `data-agreements.service.ts
get_user_data_agreements`:

```
denied > delayed_pro_gate > delayed_by_agreement > delayed_displaced > realtime
```

### 4.2 Scanner-side consumption

SPA renders a `DataTierChip` driven by `data_tier`:

- `realtime` — green "Live"
- `delayed_by_agreement` — amber "15-min Delayed Data"
- `delayed_pro_gate` — amber "Pro Access Required"
- `delayed_displaced` — amber "Another window is live"
- `denied` — red "Access denied"

The scanner-side data feed (REST + WS from f2-api) is gated at WS
connect time by `authenticate_socket` reading `live_data_access` from
the id_token (admin bypass = always live; non-admin = per the
exchange-agreement sanitize result).

### 4.3 ExchangeAgreementsPopup

The members-portal popup iframe at
`https://<customer-host>/data-agreements/<customer-slug>` lets a user
accept the agreement in-flow. Iframe-embedded fetches must stamp
`X-F2-Iframe-Context: 1` so `_claimLiveSlot` in `auth.service.ts`
skips the parent-tab-displacement path.

### 4.4 When your new scanner needs an agreement

- Scanner serves exchange market data (quotes / trades / level-2 /
  options chains with price data) → **required**.
- Scanner serves derived signals / scanner-engine output with NO raw
  exchange data → **not required** (op-fingerprints percentile view,
  op-mti alerts, etc.).

If required: no scanner-side wiring beyond the shared `DataTierChip`
+ `ExchangeAgreementsPopup` components. The customer-wide agreement
covers all scanners under that `Client`.

---

## 5. Admin flow for granting access

Direct-grant paths (operator action, no webhook):

- `admin.f2-tech.ai/admin/users` → row click → Edit User → Scanners
  editor (claims by scanner). Writes Cognito + UserTracking.
- `admin.f2-tech.ai/admin/customers/<slug>` → SamCart section →
  product_map editor → maps SamCart product_id → scanner_id. Future
  SamCart deliveries auto-activate the mapped scanner via the webhook.
- `POST /rest/admin/customer-directory/<slug>/commerce/samcart/
  remap-product/<product_id>` — retroactive sweep for an existing
  mapping that was previously `unassigned`. Walks past
  CommerceEvents + activates each buyer. See
  `outcome:it-f2-104-samcart-auto-remap-on-categorization-shipped-2026-08-03`.

---

## 6. Merged-scanner attribution

When two scanner concepts share a single SPA route (sub-tabs inside
one component), the catalog shape needs explicit intent. Pattern from
IT-F2-287 (op-rr + op-zeta → `/scans/zeta` with RR | Zeta sub-tabs):

### 6.1 Three shapes to choose from

**A. One canonical scanner, one SPA route** — collapse one scanner
doc entirely. Billing shows one row.

- `Scanners.op-rr` deleted / archived.
- `Scanners.op-zeta.Url = /scans/zeta`.
- SamCart product_map's RR product id re-maps to `op-zeta`.
- UserTracking write path: all existing `op-rr` activations stay
  (historical), new activations write `op-zeta`.
- **Risk**: breaks RR entitlement audit trail; users with
  `custom:scanners=op-rr` lose SPA access unless the scanner-side
  `allowed_routes` derivation includes a fallback.

**B. Two canonical scanners, same SPA route** (what IT-F2-287 landed)
— both docs survive, both carry `Url=/scans/zeta`. Billing shows two
rows. SPA access gates on either claim (sub-tab visibility can gate
further per-claim).

- `Scanners.op-rr.Url = /scans/zeta`
- `Scanners.op-zeta.Url = /scans/zeta`
- Both carry their own `Client` for billing attribution.
- SamCart mappings stay distinct (one maps to op-rr, one to op-zeta).
- UserTracking rows stay distinct — billing reports show both
  scanners under the same customer.
- **Risk**: catalog surfaces (members-portal tile grid) may render
  two tiles that both lead to `/scans/zeta`. Deduplicate at the
  catalog layer OR give one scanner a lower `Order` and hide it with
  a `Hidden:true` flag.

**C. One canonical scanner, one archived** — one scanner becomes
read-only / display-only. Billing stops counting the archived one.

- `Scanners.op-rr.Enabled = false` (or `Status: 'archived'`).
- New SamCart activations auto-migrate to the canonical scanner.
- Historical UserTracking preserved.

### 6.2 Decision scaffolding

Pick based on:

- **Preserve existing-buyer entitlements?** → B keeps them, A requires
  SPA-side fallback, C requires auto-migration.
- **Billing granularity needed?** → B gives per-sub-tab counts, A/C
  collapse.
- **SamCart product mapping stability?** → A/C force re-mapping, B
  stays stable.

### 6.3 Catalog gap

A Scanner doc with Stream + no catalog surface = stream serves fine
but no catalog tile, no SamCart dropdown entry, no `allowed_routes`
match. If merging under shape B, verify BOTH docs carry Url + AppUrl
+ Name + Client. Shape A/C can tolerate the archived doc's catalog
fields being empty.

---

## 7. Usage tracking — current state + planned shape

### 7.0 What's recorded today vs. what isn't

| Signal | Collection | Grain | Notes |
|---|---|---|---|
| Entitlement grant / revoke | `F2-ADMIN.UserTracking` | per (email, customer) with `events[]` of `add_scanner` / `remove_scanner` | Authoritative for billing. Written from `user-management.service.ts upsert_tracking` (L6772-6848). Only 2 event types in use. |
| Login / session created | `F2-ADMIN.AuthLogins` | one doc per login (customer + date, nothing scanner-specific) | 157k+ rows; used by billing reports to attribute monthly actives. |
| Login event with Cognito user snapshot | `F2-ADMIN.LoginEvents` | per login (user_id, customer, sub, host, user_status, enabled, user_create_date, user_last_modified_date) | 60k+ rows; richer identity snapshot but still no scanner-level breakdown. |
| Entitlement attribute mutation (admin audit) | `F2-ADMIN.EntitlementAudit` | one doc per Cognito attribute write (changed_by + old/new attrs + reason + ip + ua) | 33 rows; audit-only, not for billing. |
| Legacy per-scanner access history (import) | `F2-ADMIN.AuthLogins_Graphem` | per (user, scanner) with First/Last Access Date + Live Eligible + Agreement Status | 7k+ rows, historical import, not live-written. Rich shape worth mirroring for the new live tracker (§7b). |
| Live-session slot ownership | Redis `F2:LIVE_SESSIONS_SLOT:<user>:<scanner>` + `F2:LIVE_SESSIONS_DISPLACED:<user>` | one record per user+scanner slot; TTL 60s | Serves single-window enforcement + displacement broadcast. Not persisted for retro usage. |
| Scanner-view impression (user opened scanner X) | — | — | **Unimplemented.** |
| Per-session tier (live vs delayed) consumed | — | — | **Unimplemented** as a dedicated row. Derivable from LiveSessionService slot history IF persisted (currently only Redis + ephemeral). |

**Mike's prior framing** (IT-F2-439 c/8a9aefac): &ldquo;we already have
some of this [information] fo the billing.&rdquo; True for *entitlement*
+ *per-customer login counts*; false for *per-scanner view* +
*per-session tier*. Those are the two gaps §7a + §7b fill.

### 7a. Live-vs-delayed usage tracking — proposed shape

Needed because today the fleet knows **which users have live_data_access
in their Cognito claim** but not **which users actually consumed live
data on day D for scanner S**. Compliance audits (NYSE, OPRA) want the
second — a per-session log that proves a specific user received live
ticks at a specific timestamp for a specific scanner.

#### 7a.1 Collection: `F2-ADMIN.LiveSessionLog`

Append-only. One doc per live-session slot open/close event. Writer:
`f2-admin-service/src/services/live-session.service.ts
updateLiveSessionSlot` extended to persist (currently only publishes
to Redis + fire-and-forget `recordSessionEndEvent`).

```
{
  _id: ObjectId,
  user_id: '<cognito-sub>',       // not email — email dupes across pools
  user_email: '<denormalized for billing-report joins>',
  customer: 'option-pit',
  scanner: 'op-rr',               // ← per-scanner, unlike LoginEvents
  session_id: '<uuid-from-SPA-sessionStorage>',
  pool_id: 'us-east-1_GHFRDfwAo',

  op: 'opened'                     // first slot claim
    | 'displaced_by_new_session'   // another tab took the slot
    | 'displaced_by_reclaim'       // user clicked reclaim on another tab
    | 'closed_by_logout',

  tier: 'live' | 'delayed',        // what tier was being served
  live_data_access_at_write: true | false,  // Cognito claim snapshot
  review_status_at_write: 'approved' | 'pending' | 'declined' | null,
                                    // exchange-agreement snapshot

  started_at: <ISO>,                // slot opened (null on open row — self)
  ended_at: <ISO>,                  // slot closed (null on open row)
  duration_ms: <number>,            // ended_at - started_at (null on open)

  ip: '<from X-Forwarded-For>',
  user_agent: '<from request header>',
  source: 'live_session_service',
  envelope_id: '<matches Redis publish envelope>',
  at: <ISO>                         // when THIS row was written
}
```

Indexes: `{user_id:1, scanner:1, started_at:-1}` for per-user audit,
`{customer:1, started_at:-1}` for per-customer reports,
`{started_at:1}` TTL = 395 days (NYSE audit retention).

#### 7a.2 Write path

Extend `live-session.service.ts updateLiveSessionSlot` + the existing
`recordSessionEndEvent` fire-and-forget. On every slot transition:

```
transition               → LiveSessionLog write
─────────────────────────────────────────────────────────
empty → claimed          → {op:'opened', started_at: now}
claimed → displaced      → {op:'displaced_by_new_session',
                            ended_at: now, duration_ms: now - started}
claimed → reclaimed      → {op:'displaced_by_reclaim', ...}
claimed → explicit-close → {op:'closed_by_logout', ...}
```

Fire-and-forget via `void` — must not add latency to the user-facing
request path.

#### 7a.3 Read path

New admin endpoint:

```
GET /rest/admin/live-sessions/report?customer=<slug>&from=<ISO>&to=<ISO>
```

Returns per-(email, scanner, day) aggregation: total live-session
minutes, number of distinct sessions, number of displacements. Feeds
a compliance audit CSV + a &ldquo;live users per scanner&rdquo; column
on the existing billing grid.

#### 7a.4 Backfill from LiveSessionsAudit

If a per-event audit was already being written (per the KG runbook
`live-session-slot-tracking-2026-09-xx` — check first), backfill a
single-pass transform script to seed `LiveSessionLog` from the first
observed slot ownership. Otherwise start fresh — the collection grows
with new activity.

### 7b. Scanner view tracking — proposed shape

Needed because today the fleet knows **which scanners a user is
entitled to** but not **which scanners the user actually looked at
this month**. Product + marketing + usage-based pricing all want the
second.

#### 7b.1 Collection: `F2-ADMIN.ScannerViews`

Append-only. One doc per view-mount event. Writer: SPA-side
instrumentation (not scanner-backend) because the backend only sees
the ping-polls, not the actual tab focus.

```
{
  _id: ObjectId,
  user_id: '<cognito-sub>',
  user_email: '<denormalized>',
  customer: 'option-pit',
  scanner: 'op-rr',

  op: 'mounted'            // user navigated INTO the scanner view
    | 'unmounted'          // navigated AWAY (route change / tab close)
    | 'heartbeat',         // every 5 min while mounted (keeps dwell live)

  mounted_at: <ISO>,
  unmounted_at: <ISO>,
  dwell_ms: <number>,       // null on mounted/heartbeat; set on unmounted

  // Context snapshot — matches what SPA was showing
  tier: 'live' | 'delayed',
  symbol_list_filter: '<name>' | null,
  tab_sub_route: '<sub-slug>' | null,  // e.g. 'risk-reversal' vs 'zeta'

  session_id: '<matches LiveSessionLog.session_id>',  // join key
  ip, user_agent, source: 'spa_view_tracker',
  at: <ISO>
}
```

Indexes: `{user_id:1, scanner:1, at:-1}`,
`{customer:1, scanner:1, at:-1}`, TTL = 180 days.

#### 7b.2 SPA write path

Shared f2tech-shared component `useScannerViewTracker(scanner_id)`
hook that:

1. On mount: POST
   `/rest/user/scanner-views { scanner, op:'mounted' }`.
2. Every 5 min while mounted: POST `{ scanner, op:'heartbeat' }`.
3. On unmount / `visibilitychange: hidden` / `beforeunload`: POST
   `{ scanner, op:'unmounted', dwell_ms }` with `keepalive:true`
   (standard pattern per `feedback_keepalive_on_tab_close_fetches`).

Reference consumers:

- `t3-core4-frontend/src/scanner/ScannerView.protected.tsx` — one
  mount point for every T3 scanner view; wrap with the hook.
- Per-customer SPAs each adopt via f2tech-shared import; same hook
  signature + no scanner-specific coupling.

#### 7b.3 Backend endpoint

```
POST /rest/user/scanner-views
Body: { scanner, op, session_id?, dwell_ms? }
Headers: Authorization: Bearer <id_token>, X-F2-Session-ID
```

Writes to `F2-ADMIN.ScannerViews`. Writer: a new slim controller
`ScannerViewsController` on `f2-admin-service`. Auth: standard
`F2AuthMiddleware` (Bearer id_token). No admin role required — any
authenticated user can log their own view (user_id derived from
token, not from body).

Rate-limit: client-side 1 req per view-mount + 1 per 5-min
heartbeat is already low enough. Backend soft-cap at 10 req/min per
user_id as DOS defense.

#### 7b.4 Read path

New admin endpoint:

```
GET /rest/admin/scanner-views/report?customer=<slug>&from=<ISO>&to=<ISO>
```

Returns per-(email, scanner, day) aggregation: distinct view
sessions, total dwell minutes, avg sessions per day. Feeds a
&ldquo;scanner engagement&rdquo; column alongside billing +
LiveSessionLog on the admin reports grid.

#### 7b.5 Why SPA-side, not scanner-backend

- A user with the WS socket open but tab in background isn't
  really &ldquo;viewing&rdquo; the scanner. Backend sees the socket;
  only the SPA knows the tab-focus state.
- Backend-only tracking would double-count users with multiple tabs
  on the same scanner.
- `visibilitychange` + `beforeunload` + `keepalive:true` is the
  fleet pattern for durable client-side signal delivery (see
  f2tech-shared `reportError` for the precedent).

#### 7b.6 Adoption plan

Rollout in two phases, non-blocking:

1. **Phase 1 — collection + endpoint only.** Ship `ScannerViews`
   collection + `POST /rest/user/scanner-views` + the admin read
   endpoint. SPA opt-in per scanner — no fleet-wide requirement.
2. **Phase 2 — SPA f2tech-shared hook.** Reference-impl in
   t3-core4-frontend (`ScannerView.protected.tsx` wrapper), then
   roll out across other per-product SPAs as they adopt the hook on
   their own schedule. Billing reports show &ldquo;engagement&rdquo;
   column only for scanners that have the hook wired.

---

## 8. Adoption checklist for a new scanner

Walk this top-to-bottom when standing up `<new-scanner-slug>`:

- [ ] `F2-ADMIN.Scanners._id='<slug>'` doc created with:
  - `Name` (display label — e.g. "Option Pit - Zeta")
  - `Client` (customer slug — e.g. "option-pit")
  - `Url` (canonical member-facing URL — e.g.
    "https://ai.optionpit.com/scans/zeta")
  - `AppUrl` (per-product Vercel fallback — e.g.
    "https://optionpit.vercel.app/scans/zeta")
  - `Enabled: true`
  - `RoleAccess` ("member" | "client" | "admin")
  - `Stream` subdoc (if the scanner serves data) — see §1.2 for shape
- [ ] If scanner serves data via f2-api: `pm2 restart f2-api` on
  web-backend-srvr-1 (`loadStreamViewsFromScanners` is boot-only).
- [ ] SamCart / Kartra / WooCommerce (if applicable):
  - Add the scanner to the customer's `samcart.product_map` on
    `Customers.<slug>` for every product_id that grants it.
  - Fire the retroactive sweep for past buyers of each mapped
    product.
- [ ] First activation smoke:
  - Activate one real user via `admin.f2-tech.ai/admin/users` →
    Scanners editor OR via a SamCart test order.
  - Verify Cognito `custom:scanners` contains `<slug>`.
  - Verify `UserTracking` row for `(email, customer)` has `<slug>`
    in `scanners[]` + an `add_scanner` event.
  - Verify `admin.f2-tech.ai/admin/billing-reports` shows the
    scanner in the dropdown + the activation in the current month.
- [ ] SPA route smoke:
  - User opens `https://<customer-host>/scans/<slug>` → page loads
    (not 403, not redirect to home).
  - DevTools: `/rest/auth/validate-token` response includes
    `/scans/<slug>` in `allowed_routes`.
- [ ] If scanner needs exchange-agreement gating:
  - Verify `DataTierChip` renders with the right `data_tier` for a
    pre-agreement user (expect `delayed_by_agreement`) and a
    post-signature user (expect `realtime`).
  - Verify data feed delivers delayed vs. live based on the chip.
- [ ] If merging with an existing scanner under shape B: BOTH scanner
      docs carry Url + AppUrl + Name + Client.
- [ ] Ship-note on the parent ticket citing: Scanner doc id, member
      activation smoke user, billing-report screenshot showing the
      new row.

---

## 9. Anti-patterns

Caught in the wild on IT-F2-287 + predecessors:

- **Stream-only scanner row** — serves data but no catalog surface.
  Users granted the claim can't reach the page because
  `allowed_routes` doesn't include the pathname. See §1.3.
- **Hardcoded tier-swap regex** (`applyTierToPattern`) extended per
  prefix instead of a per-row flag. Fine for `F2_LIVE-` + `OS_LIVE-`
  prefixes that cover most of the fleet; a per-row flag or an
  explicit `DelayedDbPattern` would be cleaner — but the
  `DelayedDbPattern` field in op-rr is currently a **no-op** (f2-api
  doesn't read it; the regex is the only mechanism).
  (option-pit, IT-F2-287 2026-10-07.)
- **TradePremium floor applied to percentile-schema scanners** — the
  default $10K floor in `buildFlowMatchStage` matches zero docs when
  the schema has no `TradePremium` field. Opt out via
  `Stream.SkipPremiumFloor:true` on the Scanner row. (IT-F2-287
  2026-10-07.)
- **Direct-Cognito grants without UserTracking write** — the user
  can access the scanner but the activation is invisible to billing
  until the per-(email, customer, scanner) supplement gate catches
  up on the next report run. Prefer `client_activate_user` which
  writes both.
- **SymbolList reuse without a product decision** — IT-F2-287
  reused `option-pit-risk-reversal` as Zeta's SymbolListName. Works
  today because the 27 symbols overlap; drifts silently when RR adds
  a symbol Zeta shouldn't track. Document the shared-list intent OR
  mint a separate list per scanner.

---

## 10. References

- `outcome:it-f2-157-billing-report-consolidation-and-supplement-gate-per-scanner-2026-08-03`
  — per-(email, customer, scanner) Cognito supplement gate, canonical
  slug resolution via F2-ADMIN.Customers aliases.
- `outcome:it-f2-104-samcart-auto-remap-on-categorization-shipped-2026-08-03`
  — auto-remap on product_map save + retroactive sweep.
- `runbook:customers-as-source-of-truth-2026-06-13` — Customer doc
  shape; brand-config endpoint; domain reverse-lookup.
- `runbook:scanner-doc-source-of-truth-for-claims-and-channels-2026-06-28`
  — claims_schema + channels[] on Scanner (not Customer).
- `runbook:per-customer-cognito-pool-onboarding-recipe-v1` — pool
  provisioning (POC-first pattern).
- `IT-F2-287` — op-rr + op-zeta merge; TradePremium floor opt-out;
  SymbolListName reuse case study.
- `IT-F2-429` — reconciliation CSV export (per-customer roster shape).
- `IT-F2-437` — displacement wiring + entitlement-change WS fanout.
- Code: `f2-admin-service/src/services/{billing,data-agreements,user-management,auth}.service.ts`;
  `f2-api/server.js` (loadStreamViewsFromScanners +
  buildFlowMatchStage).
