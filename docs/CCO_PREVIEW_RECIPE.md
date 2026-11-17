# CCO Preview recipe

**When to read this:** you're wiring per-PR Vercel preview URLs for a CCO-adopted scanner so customers can click a Preview button in f2-members and land on their open PR's preview build — on the customer-branded origin, with F2 SID auth intact. Written 2026-11-17 after IT-F2-475 shipped the proof-of-concept on hr-rsi; Mike: *"this is the proof of concept for future preview development of existing scanners"*.

Prereq: the scanner is already CCO-adopted (customer collab repo + F2 overlay repo + `sync-from-collab.yml`). If not, run [`runbook:customer-collab-overlay-cco-pattern`](ai-srvr KG) first.

---

## Why the branded origin matters

The raw Vercel preview alias — `<project>-git-preview-customer-pr-<N>-f2technologys-projects.vercel.app` — is a different origin from `scanners.<customer>.com`. The F2 SID cookie is scoped to the branded host, so if the Preview button opens the raw alias:

1. SPA boots, `POST /rest/auth/mint-sid-from-cookies` → **401** (no cookie attaches cross-origin)
2. SPA interprets 401 as "not logged in" → navigates to `/login?next=/scans/<slug>`
3. Login page boots → mint-sid 401 again → `/login?next=/login?next=...` (nests recursively, 4096-byte Referer strip warnings in console)

This was the IT-F2-475 c/7eb654f0 original bug. Fix: route the Preview URL through the customer-branded origin so the F2 SID cookie jar aligns. The preview SPA then auths exactly like prod.

---

## The four primitives

| # | Primitive | Where it lives | What it does |
|---|---|---|---|
| 1 | **Scanner SOT field** `Scanner.<id>.PreviewUrl` | `F2-ADMIN.Scanners` (mongo) | String; empty/missing = no preview active. CCO workflow populates. |
| 2 | **Scoped PATCH endpoint** `PATCH /rest/admin/scanners/:id/preview-url` | `f2-admin-service2` (`scanners.service.ts update_scanner_preview_url`) | Admin-gated write; `{PreviewUrl: null}` → `$unset`. Scoped so CI tokens can only touch this one field. |
| 3 | **CCO sync-pr-preview-branch workflow** | overlay repo `.github/workflows/sync-pr-preview-branch.yml` | On PR open/push: overlay Tier A → preview branch → PATCH PreviewUrl. On PR close: delete preview branch → PATCH null. |
| 4 | **f2-members edge middleware** `/scans-preview/:path*` branch | `f2-members/middleware.ts` | Intercepts branded-host `/scans-preview/<slug>` → resolves `preview_url` from `/api/scanners-by-host` cache → `rewrite()` to preview build. Also **sets the `f2_preview=1` cookie** so the asset-passthrough branch knows to route follow-up `/main-*.js`/`/styles-*.css` requests to `preview_url` instead of `app_url`. Browser stays on branded origin. |
| 5 | **f2-members scanner-asset-preview branch** (Phase 1b cookie check) | `f2-members/middleware.ts` | When the `f2_preview=1` cookie is set AND the resolved row has `preview_url`, the asset matcher rewrites `/main-HASH.js` etc. to the **preview origin**, not the prod AppUrl. Response header `x-f2-mw: scanner-asset-preview:<slug>` for diag. Without this, bundle hashes mismatch (prod has `main-ABC.js`, preview has `main-XYZ.js`) and Vercel's SPA fallback serves HTML as the JS module → **white screen** (MIME type blocked). |
| 6 | **SPA explicit `/scans-preview/:slug` route** | customer repo `src/app/app.routes.ts` | The Angular SPA must have an explicit `scans-preview/:slug` route that renders the same component as `scans/:slug`. Without this, the SPA wildcard `**` catches the unknown path and client-side redirects back to `/scans/<default>` → middleware proxies to AppUrl → **prod SPA served from the preview URL**. No wildcard sub-pattern; mirror the `scans` subtree explicitly. |

Plus the f2-members Preview pill UI itself (`src/pages/Scanners.tsx`) which derives the pill URL from `new URL("/scans-preview/" + id, Scanner.Url)` and navigates in-place (`window.location.assign`, not `window.open`).

---

## End-to-end flow

```
Customer opens PR on F2-<Customer>/<customer-repo> with Tier A changes
  → notify-f2-sync.yml fires repository_dispatch(sync-pr-branch)
  → overlay repo's sync-pr-preview-branch.yml:
      - overlays Tier A onto master
      - force-pushes preview/customer-pr-<N>
      - Vercel auto-builds <project>-git-preview-customer-pr-<N>-f2technologys-projects.vercel.app
      - PATCH Scanner.<slug>.PreviewUrl = that alias + /scans/<slug>
      - comments URL on customer PR

Admin / client viewer loads scanners.<customer>.com (f2-members gallery)
  → Preview pill renders on tile (PreviewUrl non-empty + role ∈ admin|client|client_admin)
  → Click → window.location.assign("/scans-preview/<slug>") on branded host
  → f2-members Edge Middleware matcher /scans-preview/:path* fires
  → resolveScannersForHost cache → row.preview_url
  → rewrite(preview_url + tail) → browser stays on branded origin
  → preview SPA assets fetched via same-origin passthrough
  → F2 SID cookie attaches on /rest/* → auth works like prod

Customer closes PR
  → notify-f2-sync.yml fires repository_dispatch(cleanup-pr-branch)
  → overlay workflow:
      - deletes preview/customer-pr-<N> branch
      - PATCH Scanner.<slug>.PreviewUrl = null → $unset
  → Preview pill hides on next scanners-catalog cache TTL flip (~30s)
```

---

## ⚠ Trap: branded hosts live on f2-members, NOT on the per-customer SPA

`scanners.<customer>.com` (and every other branded alias) is served by the **f2-members** Vercel project — not the per-customer SPA project. The per-customer project (`hima-v2`, `thestrat-frontend`, etc.) only owns its raw `<project>.vercel.app` host.

**Pre-flight before shipping any middleware:**

```bash
curl -sS -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v9/projects/<prj>/domains?teamId=<team>" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);[print(x['name']) for x in d.get('domains',[])]"
```

If the target branded host isn't in the list, you're on the wrong project. Burned 30min on IT-F2-475 2026-11-17 shipping `middleware.ts` on hima-v2 before discovering `scanners.himareddy.com` is f2-members (reverted on PR #11).

---

## Opting a new CCO scanner in

Follow this checklist for each new CCO scanner that needs preview routing. Steps 1–3 run per overlay repo; steps 4–6 are either already in place fleet-wide or require no code change.

### 1. Verify the notify-f2-sync.yml trigger covers PR events

In the customer collab repo (`F2-<Customer>/<customer-repo>/.github/workflows/notify-f2-sync.yml`):

```yaml
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed]
```

The `pull_request` branch dispatches `event_type: sync-pr-branch` on open/synchronize/reopen and `cleanup-pr-branch` on close. If this is missing (overlay bootstrapped before IT-F2-205 Phase 9, 2026-08-08), add it.

### 2. Add sync-pr-preview-branch.yml on the overlay repo

Copy from `F2Tech-WebDev-v2/hima-v2/.github/workflows/sync-pr-preview-branch.yml` (IT-F2-205 reference ship). Swap the overlay path list for your scanner's Tier A files — see `runbook:customer-collab-overlay-cco-pattern` KG for which paths are Tier A vs Tier B.

Append these two steps (sync path adds preview URL; cleanup path clears it):

```yaml
- name: PATCH Scanner.<slug>.PreviewUrl with preview alias
  if: github.event.action == 'sync-pr-branch'
  env:
    F2_ADMIN_SERVICE_TOKEN: ${{ secrets.F2_ADMIN_SERVICE_TOKEN }}
  run: |
    PREVIEW_URL="https://<project>-git-${VERCEL_BRANCH_SLUG}-f2technologys-projects.vercel.app/scans/<slug>"
    curl --fail -X PATCH \
      -H "Authorization: Bearer ${F2_ADMIN_SERVICE_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"PreviewUrl\":\"${PREVIEW_URL}\"}" \
      https://f2-admin-service2.f2-tech.ai/rest/admin/scanners/<slug>/preview-url

- name: Clear Scanner.<slug>.PreviewUrl (cleanup)
  if: github.event.action == 'cleanup-pr-branch'
  env:
    F2_ADMIN_SERVICE_TOKEN: ${{ secrets.F2_ADMIN_SERVICE_TOKEN }}
  run: |
    curl --fail -X PATCH \
      -H "Authorization: Bearer ${F2_ADMIN_SERVICE_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"PreviewUrl":null}' \
      https://f2-admin-service2.f2-tech.ai/rest/admin/scanners/<slug>/preview-url
```

Placement: the sync PATCH goes AFTER the force-push preview-branch step; the cleanup PATCH goes AFTER the branch-delete step. `--fail` ensures the workflow surfaces 4xx/5xx instead of silently succeeding.

### 3. Store F2_ADMIN_SERVICE_TOKEN as a repo secret

```bash
gh secret set F2_ADMIN_SERVICE_TOKEN \
  --repo F2Tech-WebDev-v2/<overlay-repo> \
  --body "<token>"
gh secret list --repo F2Tech-WebDev-v2/<overlay-repo> | grep F2_ADMIN_SERVICE_TOKEN
```

The token is the fleet-shared `f2-ci-sync` long-lived admin bearer (session-bearer JWT, 10-year exp, `custom:role:admin` payload). If you don't have it, request a one-shot EPHEMERAL-ATTACHED hand-off from f2-session on the engagement ticket.

Mint recipe (f2-session lane, IT-F2-475 c/3187f201):

```javascript
// On web-backend-srvr-1, after SESSION_BEARER_SECRET is restored in .env + pm2 restart:
node -e 'require("dotenv").config();
  const jwt = require("jsonwebtoken");
  const now = Math.floor(Date.now()/1000);
  console.log(jwt.sign({
    sub: "f2-ci-sync",
    email: "f2-ci-sync@f2-tech.ai",
    "custom:role": "admin",
    iat: now,
    exp: now + 10*365*24*3600,
    iss: "f2-admin-service",
    aud: "f2-session-bearer"
  }, process.env.SESSION_BEARER_SECRET, {algorithm:"HS256"}));'
```

The `custom:role: "admin"` payload is required — `F2AuthMiddleware` re-derives `ctx.userData.is_admin` from this claim (not from a bare `is_admin:true`), so without it the PATCH endpoint returns Unauthorized.

### 4. Vercel Deployment Protection must be OFF on the overlay project

Per Mike IT-F2-475 c/264bd980: *"vercel preview shouldn't require a vercel login, the preview is gated by our sid just like the regular app nothing special"*. Fleet standard matches f2-admin, f2-members, f2-tracker, t3-app (none run Vercel Deployment Protection; auth is the F2 SID).

```bash
curl -X PATCH "https://api.vercel.com/v9/projects/<prj>?teamId=<team>" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ssoProtection":null}'
# Expected: response shows ssoProtection: null, deploymentProtection: null
```

### 5. Nothing to change on f2-members middleware

The `/scans-preview/:path*` matcher + branch is customer-agnostic (IT-F2-475 f2-members PR #110). It resolves `preview_url` per-request from `/api/scanners-by-host` by branded host, so adding a new customer is zero-code-change on f2-members — as long as the branded host is in the Scanner.Url and already mapped to that customer in `F2-ADMIN.Customers.<slug>.domains[]`. Scanner-asset-preview branch (f2-members PR #111) cookie-gates asset routing so preview bundles load from `preview_url` once the user has entered scans-preview mode; also customer-agnostic.

### 6. Nothing to change on the Scanner editor

`admin.f2-tech.ai` already shows the `Preview URL` input + inline Preview-link anchor for any scanner (f2-admin PR #295 / #296 / #297). CCO-populated scanners auto-flow into the input value; admins can also edit manually.

### 7. Add explicit `/scans-preview/:slug` route in the SPA (**Tier A**, per-scanner)

The Angular SPA's router must recognize `/scans-preview/:slug` or it will wildcard-redirect to the default route (`/scans/<default>`) on bootstrap — the preview URL briefly flashes in the URL bar, then the SPA client-side-navigates back to a `/scans/*` path, f2-members middleware prefix-matches that against the production `pathname`, and the user sees **prod**. This is **not** a server-side issue — the HTML and assets are served from preview correctly; the SPA's own router does the bounce.

Mirror the `scans` subtree explicitly (per Mike IT-F2-475 2026-11-17: *"please no wild card"*):

```ts
// src/app/app.routes.ts
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'scans/<default-slug>' },
  {
    path: 'scans',
    children: [
      { path: '<slug>', component: <ScannerComponent>, title: '<Name>', canActivate: [AuthService] },
      // ... one entry per real scanner slug in this SPA
    ]
  },
  // IT-F2-475: /scans-preview/:slug mirror — explicit, no wildcard
  {
    path: 'scans-preview',
    children: [
      { path: '<slug>', component: <ScannerComponent>, title: '<Name> (preview)', canActivate: [AuthService] },
      // ... one entry per real scanner slug, matching the scans subtree
    ]
  },
  { path: '**', redirectTo: 'scans/<default-slug>' }
];
```

Reference ship: `F2-HimaReddy/hr-rsi-frontend` PR #3 (merged 2026-11-17, sha `d7eeeaa`). Title suffix `(preview)` is a quick visual distinguisher so testers know they're on the preview build.

**Chicken-and-egg caveat**: the PR that adds this route can't preview itself cleanly (its own preview build won't have the route on top of master until the sync-pr-branch overlay runs with the PR head). First ship this route to customer main via normal push → prod gets it → subsequent customer PRs inherit the route in their preview overlays. Second-order gotcha: if you're bootstrapping preview flow on a NEW CCO scanner, do the route-add as the FIRST customer PR, merge it once prod validates, THEN start iterating on feature PRs.

---

## Smoke test

Walks the full chain end-to-end. Run after every new CCO scanner opt-in.

### 1. Trigger — open a trivial PR with a **visible Tier A** diff

```bash
cd /tmp && git clone https://github.com/F2-<Customer>/<customer-repo>.git /tmp/<repo>-smoke
cd /tmp/<repo>-smoke
git checkout -b smoke/preview-recipe-sanity
# Tier A visible change — e.g. a title string in src/app/app.component.ts
# README-only edits are NOT in the overlay path list; preview build will be
# bit-identical to prod and looks like "preview isn't working" (IT-F2-475 c/80be98ae).
sed -i 's/<CustomerName>/<CustomerName> — preview/' src/app/app.component.ts
git -c user.email=noreply@f2-tech.com -c user.name=F2Technology commit -am "smoke: preview recipe sanity"
git push -u origin smoke/preview-recipe-sanity
gh pr create --repo F2-<Customer>/<customer-repo> --title "smoke: preview recipe" --body "trivial Tier A diff"
```

### 2. Verify workflow runs

```bash
gh run list --repo F2-<Customer>/<customer-repo> --workflow "Notify F2 to sync" --limit 1
gh run list --repo F2Tech-WebDev-v2/<overlay-repo> --workflow "Sync PR preview branch from <customer-repo>" --limit 1
# Both: status=completed conclusion=success within ~60s of PR open.
```

### 3. Verify Scanner SOT updated

```bash
ssh web-backend-srvr-1 'mongosh --quiet "mongodb://..." --eval \
  "JSON.stringify(db.Scanners.findOne({_id:\"<slug>\"},{PreviewUrl:1}))"'
# Expect: {"_id":"<slug>","PreviewUrl":"https://<project>-git-preview-customer-pr-<N>-f2technologys-projects.vercel.app/scans/<slug>"}

curl -sS "https://f2-admin-service2.f2-tech.ai/rest/api/scanners-by-host?host=scanners.<customer>.com" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);[print(r['scanner_id'],r.get('preview_url')) for r in d.get('scanners',[])]"
# Expect: <slug> https://<project>-git-preview-customer-pr-<N>-....vercel.app/scans/<slug>
```

### 4. Verify branded host serves preview

```bash
curl -sI "https://scanners.<customer>.com/scans-preview/<slug>" | head -15
# Expect: HTTP/2 200, content-type: text/html,
#         x-f2-mw: scans-preview:<slug>,
#         Set-Cookie: f2_scanner=<slug>

# Compare md5: preview-via-branded should equal preview-target-direct
curl -sS "https://scanners.<customer>.com/scans-preview/<slug>" | md5sum
curl -sS "<preview_url value>" | md5sum
# Equal md5 = middleware proxy is byte-transparent
```

### 5. Verify SPA auth passthrough (no redirect loop)

```bash
curl -sI -X POST "https://scanners.<customer>.com/rest/auth/mint-sid-from-cookies" | head -5
# Expect: HTTP/2 401 content-type: application/json
# CRITICAL: NOT text/html. If HTML returned, the preview SPA treats it as
# "not logged in" and recursively redirects to /login — the IT-F2-475 c/7eb654f0
# original bug. HTML response here = branded-host routing isn't firing.
```

### 6. Human verification — click the Preview pill

Log into `scanners.<customer>.com` as admin / client / client_admin. Confirm:

- Preview pill renders on the scanner tile.
- Click → browser URL reads `scanners.<customer>.com/scans-preview/<slug>` (no bounce to a vercel.app host, no new tab).
- SPA loads with the visible Tier A diff from step 1.
- SPA auths without a manual login prompt.

### 7. Close + verify cleanup

```bash
gh pr close <N> --repo F2-<Customer>/<customer-repo> --delete-branch
sleep 30  # notify + overlay workflow + scanners-catalog cache
ssh web-backend-srvr-1 'mongosh --quiet "mongodb://..." --eval \
  "JSON.stringify(db.Scanners.findOne({_id:\"<slug>\"},{PreviewUrl:1}))"'
# Expect: {"_id":"<slug>"}  (PreviewUrl field $unset)
```

Preview pill should hide on next gallery hard-refresh.

---

## Troubleshooting

### Symptom: Preview pill opens `vercel.com/sso-api?url=...`
Vercel Deployment Protection is still on for the overlay project. Flip `ssoProtection:null` per opt-in step 4. IT-F2-475 c/1f563a1e.

### Symptom: Browser lands on `/login?next=/login?next=/login?next=...` recursive URL
Preview is being served from the raw Vercel alias instead of the branded origin — F2 SID cookie jar misses, `mint-sid-from-cookies` 401s into a loop. Check that the Preview pill URL derives from branded host (f2-members `Scanners.tsx previewSameOriginUrl(scanner)`), not from `Scanner.PreviewUrl` directly. IT-F2-475 c/7eb654f0 original bug.

### Symptom: Preview URL returns f2-members shell (not the per-scanner SPA)
f2-members middleware for `/scans-preview/:path*` isn't firing. Check `x-f2-mw` response header on `curl -sI scanners.<customer>.com/scans-preview/<slug>` — should read `scans-preview:<slug>`. If absent, ensure f2-members' `middleware.ts` matcher array contains `/scans-preview/:path*` AND `Scanner.<slug>.PreviewUrl` is non-empty (empty → branch falls through to `next()`).

### Symptom: Preview looks bit-identical to prod (no visible diff)
The customer PR's Tier A overlay produced the same build output as master. Only paths in the overlay list (`src/app/scans`, `src/app/@shared`, `src/app/app.routes.ts`, `src/index.html`, `angular.json`, etc. — scanner-specific) affect the preview; README-only or Tier B edits produce a bit-identical build. Open a PR that changes a visible Tier A string. IT-F2-475 c/80be98ae.

### Symptom: URL bar briefly shows `/scans-preview/<slug>` then flips to `/scans/<default>` → prod SPA
Angular SPA wildcard router caught the unknown `/scans-preview/<slug>` path and redirected. Missing explicit route per opt-in step 7. IT-F2-475 c/a3e3d569 (HAR page_title confirms the flip). Fix: add the `scans-preview` subtree to `app.routes.ts` per step 7.

### Symptom: URL stable on `/scans-preview/<slug>` but screen is white
Assets are routing to prod (wrong bundle hashes), Vercel's SPA fallback serves HTML for the missing hashes, browser blocks them as MIME-mismatched modules. Check `x-f2-mw` on a `/main-HASH.js` request from the preview context — should read `scanner-asset-preview:<slug>` (not `scanner-asset:<slug>`). If absent, the `f2_preview=1` cookie isn't being set by the scans-preview branch or the asset branch isn't reading it. Confirm f2-members PR #111 (scanner-asset-preview branch) is deployed; this is a one-time fleet change, not per-customer. IT-F2-475 c/de6028a6.

### Symptom: PREVIEW pill renders on a deprecated `-v2` tile instead of the live scanner
Legacy per-scanner preview rows (e.g. `hr-rsi-v2`) sometimes linger in the Scanners catalog after the CCO flow retires them. Mike on IT-F2-475 2026-11-17 clicked a `-v2` tile thinking it was "the preview", and because the middleware's `/scans/*` loop prefix-matches `/scans/hr-rsi-v2` against the live scanner's `pathname` (`/scans/hr-rsi`), the request routed to the live scanner's prod AppUrl — looked like a bounce. Delete the deprecated row via `F2-ADMIN.Scanners.deleteOne({_id:'<legacy-id>'})` so the tile disappears from galleries. The `-v2` suffix on CCO-adopted scanners is specifically retired by this preview flow — there's one canonical scanner row per scanner, and the Preview pill on IT lives next to Copy-URL.

### Symptom: Workflow fails with `Unauthorized` on the PATCH step
`F2_ADMIN_SERVICE_TOKEN` secret on the overlay repo is missing, expired, or doesn't carry `custom:role:admin`.

```bash
gh secret list --repo F2Tech-WebDev-v2/<overlay-repo>
# Expect F2_ADMIN_SERVICE_TOKEN present.

curl -sI -H "Authorization: Bearer <token>" https://f2-admin-service2.f2-tech.ai/rest/admin/scanners
# Expect 200. 401 = token invalid / SESSION_BEARER_SECRET rotated — contact f2-session to re-mint.
```

### Symptom: Vercel deploy fails ERESOLVE after adding `middleware.ts` to a per-customer SPA project
You're adding middleware to the wrong project (see the trap section above — branded routing goes on f2-members). If you proceed anyway, Vercel's edge-middleware-detect runs a second `npm install` without `--legacy-peer-deps`. Workaround: `.npmrc` with `legacy-peer-deps=true` at project root. Real fix: don't ship middleware on the per-customer SPA; the f2-members middleware already handles it.

---

## What's NOT in this recipe

- **Long-lived dev PR vs per-feature PR shape.** Per-customer workflow preference — file a scope-confirm clar before deciding. Deferred on IT-F2-475 per c/47efb525 as premature.
- **Keep-last-url after PR close.** Default is clear-on-close (IT-F2-475 clar `b355de03`); if a customer wants the pill lit between PRs, re-clar and change the cleanup-pr-branch step to a last-known-preview rotation.
- **Multiple concurrent preview PRs.** `Scanner.<id>.PreviewUrl` is a single string, latest-push wins across concurrent PRs. Rotating to the oldest-open PR on close isn't implemented; file a clar if needed.
- **Preview for non-CCO scanners.** Recipe assumes the scanner is CCO-adopted. For non-CCO scanners, admins paste a preview URL manually into the Scanner editor; pill still works but auto-sync pipeline isn't available.
- **Preview for scanners that bundle assets under `/assets/*`.** f2-members middleware `/assets/*` branch is cookie-gated to `scannerProxyTargets`. Vite/React builds (`assets/index-HASH.js`) may need a per-slug entry in `Customers.<slug>.vercel.scanner_proxy_target_urls`. Not relevant for Angular-at-root-bundles (hr-rsi, strat-alerts).

---

## References

- **IT-F2-475** (umbrella: preview-mode POC for hr-rsi, 2026-11-17)
- **IT-F2-205 Phase 9** (per-PR Vercel previews wired for hima-reddy CCO, 2026-08-08)
- **f2-admin-service2 PR #373** (scoped `preview-url` PATCH endpoint)
- **f2-admin-service2 PR #378** (`preview_url` field on `/api/scanners-by-host`)
- **f2-admin-service2 PR #369** (`SsoController.redeemSession` mint-bug fix — prereq for session-bearer secret restore)
- **f2-admin PR #295 / #296 / #297** (Scanner editor PreviewUrl input + preview-link button + hide-when-empty)
- **f2-members PR #107 / #108 / #109 / #110 / #111** (Preview pill render / branded-host URL derive / in-place nav / `/scans-preview/:path*` middleware branch / `f2_preview=1` cookie + scanner-asset-preview branch)
- **F2-HimaReddy/hr-rsi-frontend PR #3** (reference: SPA explicit `/scans-preview/:slug` route — no wildcard)
- **hima-v2 PR #8** (CCO `sync-pr-preview-branch.yml` PATCHes `Scanner.hr-rsi.PreviewUrl`)
- Memory `feedback_branded_host_middleware_lives_on_f2_members.md` (pre-flight before writing branded-host middleware)
- Memory `feedback_review_request_direction_still_needs_scope_confirm_clar.md` (scope-confirm clar protocol)
- Runbook (KG) `customer-collab-overlay-cco-pattern` (CCO adoption procedure — prerequisite)
