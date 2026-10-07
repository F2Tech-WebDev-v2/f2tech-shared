# Scanner Billing + Exchange-Agreement Attribution Recipe

Fleet-wide, scanner-agnostic recipe for standing up a new scanner so
that:

- Members **can access it** (Cognito `custom:scanners` → scanner-side
  `/rest/auth/validate-token` → `allowed_routes` → SPA `has_route_access`).
- Billing **attributes it correctly** (`F2-ADMIN.UserTracking` activate /
  deactivate events + the per-(email, customer, scanner) supplement
  gate in `billing.service.ts get_billing_report`).
- Exchange-agreement coverage **gates its live-data display** per
  customer (`/rest/user/data-agreements?customer=<slug>` sanitize probe
  → `data_tier` + chip subdoc).

Sibling of the other scanner recipes:

- `SNAPSHOT_DATE_PICKER_RECIPE.md` — snapshot-vs-live row sourcing
- `LIVE_DATA_SCANNER_RECIPE.md` — tier + displacement + chip
- `SCANNER_DATA_WIRING_RECIPE.md` — producer → f2-api → SPA data path
- `AG_GRID_INFINITE_SCROLL_RECIPE.md` — paginated row delivery

This one is about **identity + money**, not data. Target reader: a
backend / `f2-session` agent landing a new scanner who needs to make
it billable + agreement-gated without re-deriving the fleet code.

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

## 7. Per-view usage tracking — current gap

Fleet does NOT currently log per-view scanner impressions (which
scanner a user actually opened on a given day, vs. just holding the
claim). UserTracking records **entitlement** events, not **use**.

If a product needs usage tracking:

- Document the shape here before implementing (new section) so
  consumers across the fleet agree on event shape + collection name.
- Candidate shapes: `F2-ADMIN.ScannerImpressions` (per view-mount
  event), `F2-ADMIN.ScannerSessions` (per connected-WS window).

**Current state: unimplemented.** Don't assume it exists; don't rely
on it for billing.

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
