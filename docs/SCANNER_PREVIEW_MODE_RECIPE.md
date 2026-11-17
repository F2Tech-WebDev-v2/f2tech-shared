# Scanner preview mode recipe (CCO per-PR previews)

**When to read this:** you're wiring up (or auditing) the per-PR preview URL system for a scanner SPA so that an admin / client reviewer can click a Preview pill on the members tile and land on a specific pull-request's build — same F2 SID auth as prod, no Vercel SSO wall, no cross-origin redirect loop. Walk this door-by-door once; don't invent the sequence per scanner. Written 2026-11-17 after IT-F2-475 shipped the hr-rsi proof of concept end-to-end.

**What this is NOT:** a replacement for your scanner's prod deploy flow. The preview surfaces an *in-flight PR* on the branded host for the dev loop, strictly additive. Prod routing (`/scans/:slug` → `Scanner.AppUrl`) is unchanged.

Parent arc: IT-F2-205 Phase 9 (CCO per-PR previews infrastructure) + Phase 10 (fleet-agnostic preview surface, Mike c/ddfe1078 "this preview feature will be scanner/customer agnostic going forward").

---

## Why this exists

A per-PR preview deploy on raw `*.vercel.app` is unreachable to customers in three stacked ways:

1. **Vercel Deployment Protection throws a login wall** — anonymous visitors hit `vercel.com/login?next=/sso-api?...`.
2. **F2 SID cookies are scoped to the branded host**, not `*.vercel.app` — so even logged-in customers' `f2_access` / `f2_id` / `f2_refresh` cookies don't travel there.
3. **A cross-origin click bounces into a `/login?next=/login?next=...` recursive redirect** — the SPA interprets the missing cookie as "not logged in" and sends the user to its own login, which re-interprets, which re-redirects. Hits Firefox's 4096-byte Referer strip around nesting level ~70.

This recipe keeps the browser on the customer-branded origin the entire way. The pill opens `scanners.<brand>/scans-preview/<slug>` (same-origin to the gallery), f2-members' Edge Middleware proxies that to the Vercel preview URL recorded on `Scanner.<slug>.PreviewUrl`, and the same SID cookie jar that gates prod gates the preview. The CCO workflow owns the `PreviewUrl` write; everything else is dumb infrastructure.

---

## Six coordinated layers

Four shared layers (adopt once per fleet) + two per-scanner adoptions.

| # | Layer | Owner | One-time or per-scanner |
|---|---|---|---|
| 1 | Scanner SOT — `Scanner.<id>.PreviewUrl` field + CRUD passthrough | f2-session (f2-admin-service) | one-time |
| 2 | Scoped PATCH endpoint `/rest/admin/scanners/:id/preview-url` | f2-session (f2-admin-service) | one-time |
| 3 | f2-members Edge Middleware `/scans-preview/:slug` branch | f2-session (f2-members `middleware.ts`) | one-time |
| 4 | f2-members Preview pill in tile cluster | f2-session (`src/pages/Scanners.tsx`) | one-time |
| 5 | CCO workflow `sync-pr-preview-branch.yml` | hima-reddy pattern — adopt per paired backend repo | **per scanner** |
| 6 | Admin UI PreviewUrl input + Preview anchor | admin-client-app | one-time (fleet-wide editor) |

Any single layer missing closes the chain. The combination is overdetermined on purpose — the pill is a view predicate, the middleware is the proxy, the workflow is the writer, the SPA stays dumb.

---

## Architecture overview

Admin / client / client_admin viewer clicks the Preview pill in the tile cluster on the members gallery (`scanners.<brand>/` or `members.f2-tech.<tld>/`). One click runs this chain:

```
f2-members Scanners.tsx (tile gallery)
  → previewSameOriginUrl(scanner):
       new URL("/scans-preview/" + scanner._id, scanner.Url).toString()
  → window.location.assign(url)       // in-place nav, same-origin

Browser hits scanners.<brand>/scans-preview/<slug>
  F2 SID cookies (f2_access, f2_id, f2_refresh) travel on request
  because it's same-origin to the gallery.

f2-members Edge Middleware (f2-members/middleware.ts)
  matcher includes '/scans-preview/:path*'
  Job 1 preview branch (BEFORE the per-scanner /scans/* loop):
    → resolveScannersForHost(host)    // /api/scanners-by-host, 60s cache
    → row = scanners.find(r => r.scanner_id === slug)
    → row.preview_url populated?  yes → rewrite to preview_url + tail
                                   no  → next() (pill was hidden anyway)
    → Set-Cookie f2_scanner=<slug>    // Phase 1b asset-rewrite origin cache

Vercel preview build (hima-v2-git-preview-customer-pr-<N>-...)
  → serves the preview SPA bundle via edge proxy from the branded host
  → SPA boots; auth resolves via existing branded-host SID cookies

CCO sync-pr-preview-branch.yml (hima-v2 repo workflow)
  On customer PR open/sync → PATCH /rest/admin/scanners/<slug>/preview-url
    { PreviewUrl: "https://hima-v2-git-preview-customer-pr-<N>-...vercel.app/scans/<slug>" }
  On customer PR close     → PATCH same endpoint with { PreviewUrl: null }
    (clear-on-close per IT-F2-475 clar b355de03 — pill hides between PRs)
```

---

## Prerequisites

Before you adopt this for a new scanner, confirm:

- **Scanner row exists** in `F2-ADMIN.Scanners` with `Url` (branded host path, e.g. `https://scanners.<brand>/scans/<slug>`) + `AppUrl` (prod Vercel alias, e.g. `https://<project>.vercel.app/scans/<slug>`) populated. These drive both prod routing and the pill's URL derivation.
- **Customer's branded host is aliased on the f2-members Vercel project** (`prj_Z11YFxlAAN3juVlfwDwXfQwUvsVz`), NOT on the scanner's own project. The middleware lives in `f2-members/middleware.ts`; an alias on the wrong project routes traffic to a middleware that never fires. hima-reddy discovered this on IT-F2-475 c/8e55b6c7 2026-11-17 after a wrong-project ship on hima-v2 — their revert was PR #11 on hima-v2. Check with:
  ```
  curl -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v9/projects/<project-name>" \
    | jq '.targets.production.alias'
  ```
- **Customer frontend repo has `notify-f2-sync.yml`** that dispatches `sync-pr-branch` / `cleanup-pr-branch` events to the paired backend repo (hima-v2 pattern) on PR open/sync/close. Pattern from IT-F2-205 Phase 9 (2026-08-08).
- **f2-admin-service2 has `SESSION_BEARER_SECRET`** set in prod `.env` and the service has been restarted with `--update-env`. Without it `SessionBearerService.verify()` returns null on every bearer and the CCO PATCH call 401s.
- **CI bearer JWT minted + stored as repo secret `F2_ADMIN_SERVICE_TOKEN`** on the CCO workflow repo (hima-v2 or equivalent). Token specs below.

---

## Layer 1 — Scanner SOT `PreviewUrl` field

`F2-ADMIN.Scanners.<id>.PreviewUrl` is a top-level optional string. Three code paths in `f2-admin-service` handle it (one-time fleet change):

- `ScannersService.add_new_scanner()` — accepts `data.PreviewUrl` on POST, defaults to `''`.
- `ScannersService.update_scanner()` — accepts `data.PreviewUrl` on PUT; `null` / `''` routes to `$unset`.
- `ScannersService.parse_scanner_data()` — whitelist passthrough so `GET /admin/scanners` and `/scanners-by-id/:id` return the field. Pre-existing rows return `""`; **no mongo migration needed**.

Reference ship: f2-admin-service **PR #372** (master `09f1a8b`) — IT-F2-475 item 85ed235d.

`/rest/api/scanners-by-host` ALSO carries `preview_url: string` on every row shape (that's what the Edge Middleware reads at request time). Added in **PR #378** (master `cac6fbf`).

---

## Layer 2 — Scoped PATCH endpoint

The CCO workflow writes `PreviewUrl` via a dedicated PATCH endpoint, NOT the full-replace `PUT /rest/admin/scanners/:id`. Three reasons:

1. The PUT requires `Name` and rewrites `Url` / `AppUrl` / `Client` / `RoleAccess` — a workflow body with only `{PreviewUrl}` would 400.
2. A GET + PUT round-trip would race admin SPA edits made mid-workflow (operator edits `Name` at second 2, workflow replays old doc at second 3 → stomp).
3. The CI token's blast radius shrinks from "full scanner doc write" to "one field".

```
PATCH /rest/admin/scanners/:scanner_id/preview-url
  Authorization: Bearer <F2_ADMIN_SERVICE_TOKEN>
  Content-Type: application/json
  Body: { "PreviewUrl": <string|null> }

  → null / '' routes to $unset (clears the field)
  → otherwise $set to the string value
  → also fires _invalidate_scanner_cache(id) so the next
    scanners-catalog read sees the fresh value within TTL
  → returns { success: true, modified: <0|1> }
```

Admin-gated via F2AuthMiddleware — the CI token must carry `"custom:role": "admin"` in its JWT payload for `ctx.userData.is_admin` to flip true.

Reference ship: f2-admin-service **PR #373** (master `8cfd805`) — IT-F2-475 c/be727731.

---

## Layer 3 — f2-members Edge Middleware

The branded host alias lives on the f2-members Vercel project, so `f2-members/middleware.ts` owns `/scans-preview/*` for every branded scanner. Three edits:

1. **`ScannerRow` type** gains `preview_url?: string`.
2. **Matcher array** adds `'/scans-preview/:path*'`.
3. **Job 1 preview branch** inserted BEFORE the existing `/scans/*` per-scanner loop:
   ```ts
   const previewMatch = pathname.match(/^\/scans-preview\/([^/]+)(\/.*)?$/);
   if (previewMatch) {
     const slug = previewMatch[1];
     const tail = previewMatch[2] || '';
     const row = scanners.find((r) => r.scanner_id === slug);
     const previewUrl = row?.preview_url ? String(row.preview_url).trim() : '';
     if (previewUrl) {
       let dest: URL;
       try { dest = new URL(previewUrl); } catch { dest = null as any; }
       if (dest) {
         const appBase = dest.pathname.endsWith('/')
           ? dest.pathname.slice(0, -1) : dest.pathname;
         dest.pathname = appBase + tail;
         dest.search = url.search;
         dest.hash = url.hash;
         const r = rewrite(dest.toString());
         r.headers.set('x-f2-mw', `scans-preview:${slug}`);
         setScannerCookie(r, slug);
         return r;
       }
     }
   }
   ```

Empty `preview_url` → `next()` fall-through (the pill's visibility predicate keeps that case off-screen in practice). `x-f2-mw: scans-preview:<slug>` diagnostic header appears on every successful proxy — useful for curl smoke tests.

Reference ship: f2-members **PR #110** (main `b14461c`) — IT-F2-475 c/3bec41e9.

---

## Layer 4 — Preview pill (gallery UX)

Inline `<span role="button">` pill rendered in the scanner tile cluster alongside `CopyUrlButton` / `NcPill` / `RoleAccessBadge`. Rules:

| Rule | Why |
|---|---|
| Role gate: admin / client / client_admin only (member excluded) | Previews are a dev / review surface, not end-user content |
| Visibility: `Scanner.PreviewUrl` non-empty AND `previewSameOriginUrl(scanner)` returns a valid URL | Hidden when there's nothing to click. No orphan dead buttons |
| URL derivation: `new URL("/scans-preview/" + scanner._id, scanner.Url).toString()` | Keeps click on branded origin. NEVER use raw `scanner.PreviewUrl` — that's the cross-origin Vercel alias that triggers the redirect loop |
| Navigation: `window.location.assign(url)` | In-place nav, no new tab. Mike direction via hima-reddy c/eefb097c 2026-11-17 |
| Click handler: `stopPropagation` on both the click and the keyDown | The tile itself is a button with `openScanner`; the pill must not fire it |

Reference ships: f2-members **PR #107** (initial pill, `028806f`), **PR #108** (same-origin URL derivation, `d3ddfae`), **PR #109** (in-place nav, `cf418fc`).

---

## Layer 5 — CCO `sync-pr-preview-branch.yml` (per-scanner adoption)

Lives in the customer-frontend-backend paired repo (`hima-v2` is the reference impl; mirror for each new CCO-adopted scanner). Fires on `repository_dispatch` events from the customer frontend's `notify-f2-sync.yml`:

**`event: sync-pr-branch` (PR open or sync):** overlay Tier A files (`src/app/scans`, `@shared`, `app.routes.ts`, `rsi-div.component.ts`, etc.) onto a `preview/customer-pr-<N>` branch, force-push, let Vercel auto-build the per-PR alias, then PATCH the Scanner SOT:

```bash
curl -X PATCH \
  -H "Authorization: Bearer ${{ secrets.F2_ADMIN_SERVICE_TOKEN }}" \
  -H "Content-Type: application/json" \
  -d "{\"PreviewUrl\":\"https://<project>-git-preview-customer-pr-${PR_NUM}-<team>.vercel.app/scans/<slug>\"}" \
  https://f2-admin-service2.f2-tech.ai/rest/admin/scanners/<slug>/preview-url
```

**`event: cleanup-pr-branch` (PR close/merge):** delete the preview branch (Vercel purges the deployment) and PATCH back to `null`:

```bash
curl -X PATCH \
  -H "Authorization: Bearer ${{ secrets.F2_ADMIN_SERVICE_TOKEN }}" \
  -H "Content-Type: application/json" \
  -d '{"PreviewUrl":null}' \
  https://f2-admin-service2.f2-tech.ai/rest/admin/scanners/<slug>/preview-url
```

Reference impl: `F2Tech-WebDev-v2/hima-v2/.github/workflows/sync-pr-preview-branch.yml` (master `8b460e9`). Cleanup semantic (clear-on-close) locked by Mike on IT-F2-475 clar b355de03.

**Adopting for a new scanner:**

1. Fork the hima-v2 workflow pattern into the paired customer backend repo.
2. Edit the Tier A overlay paths, the scanner slug used in the PATCH URL, and the Vercel preview alias format for the new project.
3. Grant the repo `F2_ADMIN_SERVICE_TOKEN` as a secret (see "Auth" section below).
4. Open a smoke-test PR on the customer frontend with a small visible diff (e.g. edit a visible string in `src/app/scans/<slug>/` or `app.component.ts`). The workflow should fire, `Scanner.<slug>.PreviewUrl` should flip to the new per-PR alias in mongo, the Preview pill should light up on the members tile.
5. Close the smoke-test PR. Verify `Scanner.<slug>.PreviewUrl` is `$unset` and the pill hides.

---

## Layer 6 — Admin UI editor (manual override)

admin-client-app shipped a `PreviewUrl` input field + in-editor Preview anchor on `admin.f2-tech.ai`'s Scanner editor (Add Scanner modal, Edit Scanner drawer, ag-grid column). Use cases:

- Scanner not yet wired to a CCO workflow — hand-seed a URL for a long-lived dev branch.
- One-off testing — point at a specific preview alias without going through PR dance.
- Bootstrap before the first customer PR runs.

Rules:

- The in-editor Preview anchor is **hidden entirely** when `PreviewUrl` is empty (not disabled). Locked by Mike clar 7d87151f.
- Edits via the admin UI are **stomped by the next CCO workflow run** on a customer PR event. The workflow is the writer when it's active; the editor is the override when it isn't.

Reference ships: admin-client-app **PR #295** (initial editor, `966e555`), **PR #296** (Preview anchor, `c4b4acf`), **PR #297** (hide-when-empty, `bf78fac`).

---

## Auth — `SESSION_BEARER_SECRET` + `F2_ADMIN_SERVICE_TOKEN`

The CCO workflow authenticates against f2-admin-service2 as a service principal.

### Set `SESSION_BEARER_SECRET` on prod (one-shot)

```bash
ssh ubuntu@web-backend-srvr-1
cd /home/ubuntu/f2-admin-service2
echo "SESSION_BEARER_SECRET=$(openssl rand -hex 32)" >> .env
pm2 restart f2-admin-service2 --update-env
# verify stable: uptime > 15s, unstable_restarts: 0
```

Without this, `SessionBearerService.verify()` returns null on every bearer, the Cognito fallback also fails (iss=`f2-admin-service` is not a Cognito pool), and the CI PATCH 401s.

### Mint the CI bearer (on the backend box, after secret is set)

```bash
cd /home/ubuntu/f2-admin-service2
node -e '
  require("dotenv").config();
  const jwt = require("jsonwebtoken");
  const now = Math.floor(Date.now()/1000);
  console.log(jwt.sign({
    sub: "f2-ci-sync",
    email: "f2-ci-sync@f2-tech.ai",
    "custom:role": "admin",
    iat: now,
    exp: now + 10*365*24*3600,     // 10yr
    iss: "f2-admin-service",
    aud: "f2-session-bearer"
  }, process.env.SESSION_BEARER_SECRET, {algorithm: "HS256"}));'
```

**Do NOT mint via `SsoController.redeemSession` for the CI token.** That path pulls claims from the id_token of a real logged-in user; CI has no such session. Sign directly on the backend box with the `jsonwebtoken` package + the `.env` secret. The resulting token verifies through `SessionBearerService.verify()` exactly the same way redeem-session-minted bearers do.

### Hand off + store as repo secret

Attach the token to the owning ticket via a one-shot EPHEMERAL-ATTACHED comment (never paste in chat). The recipient consumes it:

```bash
TOKEN=$(~/bin/f2-tracker-get-attachment <uuid>)
gh secret set F2_ADMIN_SERVICE_TOKEN \
  --repo F2Tech-WebDev-v2/<cco-repo> --body "$TOKEN"
unset TOKEN
```

Reference ships: f2-admin-service **PR #369** (SessionBearer mint claim-source fix, `a8d522c`), **PR #374** (custom:* prefixed claim keys, `e27d0ba`), **PR #375** (cognito:username + custom:notify_channels, `43cc260`). Token handoff on IT-F2-475 c/3187f201.

---

## Vercel considerations

### Project ownership (which Vercel project owns the host?)

Already covered in Prerequisites. Mistake mode: shipping `middleware.ts` to the scanner's OWN project (e.g. `hima-v2`) — it never fires for the branded host because traffic routes to the aliased project first. **The branch lives in f2-members' middleware.ts, always.**

### Deployment Protection — keep it OFF on CCO projects

Per Mike IT-F2-475 clar 94d93b91 2026-11-17: Vercel Deployment Protection stays **off** on CCO-adopted scanner projects. Previews are gated by F2 SID (same as prod), not by Vercel's own SSO wall. Matches the existing fleet default (f2-admin, f2-members, f2-tracker, t3-app all run without Deployment Protection).

```bash
curl -X PATCH \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ssoProtection":null,"deploymentProtection":null,"passwordProtection":null}' \
  "https://api.vercel.com/v9/projects/<project-name>"

# verify:
curl -I https://<project>-git-preview-...-<team>.vercel.app/scans/<slug>
# expected: HTTP/2 200
# NOT: HTTP/2 302 → location: https://vercel.com/sso-api?...
```

If protection stays on, the pill click 302s to `vercel.com/login` and Mike (or any non-team visitor) sees the wall. Confirmed symptom: IT-F2-475 c/1f563a1e "asking me to log in".

### ERESOLVE `ngx-toastr` peer conflict (if adding a root `middleware.ts` on an Angular project)

Vercel's detection of the new middleware triggers a second `npm install` at build time, without the `--legacy-peer-deps` flag from `vercel.json`'s `installCommand`. Commit a `.npmrc` at project root with `legacy-peer-deps=true`. hima-reddy hit this on IT-F2-475 hima-v2 PR #10 before the lane pivoted to f2-members (which already has the `.npmrc`).

---

## Troubleshooting

### Pill doesn't appear on the tile

- Viewer role: member sees no pill by design. Must be admin / client / client_admin.
- `Scanner.<slug>.PreviewUrl` in mongo: empty string / absent → pill hidden. CCO workflow writes it on PR open; cleanup clears it on close.
- Scanner-catalog cache TTL (30s). First read after a PATCH may serve the pre-write snapshot. Hard-refresh after 30s.
- `Scanner.<slug>.Url` is a valid URL (`previewSameOriginUrl` returns null when `new URL()` throws).

### Click opens the Vercel SSO login wall

Deployment Protection is still on for the scanner's Vercel project. Disable per the Vercel considerations section above. Verify with `curl -I` — should return `HTTP/2 200`, not `302 → vercel.com/sso-api`.

### Click triggers a `/login?next=/login?next=...` redirect loop

The pill is pointing at a cross-origin URL. Usually because the pill's URL was derived from raw `Scanner.PreviewUrl` instead of `previewSameOriginUrl(scanner)`. Fix: the pill MUST use the branded-host `/scans-preview/:slug` path. IT-F2-475 c/1c7a1973 HAR diagnosis.

### Preview loads but shows prod-identical content

Expected when the customer PR's diff doesn't touch any Tier A file — the preview branch's build output matches master's. Not a bug. Smoke test with a visible-diff PR (edit a visible string in `src/app/scans/<slug>/` or `app.component.ts`). hima-reddy confirmed with md5 comparison on IT-F2-475 c/80be98ae for a README.md no-op PR.

### CCO workflow PATCH returns 401

- `SESSION_BEARER_SECRET` is set in prod `.env` and pm2 has been restarted since (`pm2 restart --update-env`).
- CI token has `"custom:role": "admin"` in its payload (NOT `"role": "admin"`). F2AuthMiddleware reads the Cognito-shaped prefixed key.
- Token's `iss` / `aud` match the `SessionBearerService` constants (`f2-admin-service` / `f2-session-bearer`).
- Repo secret `F2_ADMIN_SERVICE_TOKEN` isn't expired. Default mint is 10 years; re-mint if it was shortened.
- Decode the token with `jwt.io` or `node -e 'console.log(require("jsonwebtoken").decode(process.argv[1]))' <token>` and verify the claims match what the backend expects.

### Middleware branch doesn't fire

- Matcher. New routes must be added to the `config.matcher` array at the top of `middleware.ts`.
- Branded-host alias ownership. The alias must be on f2-members' Vercel project, not the scanner's own.
- `x-f2-mw` response header via `curl -I`. Value `scans-preview:<slug>` means the branch fired correctly; absence means the matcher didn't catch the request or the branch hit `next()`.

### Scanner.hr-rsi.PreviewUrl is set but pill still 404s

Likely stale preview — the per-PR Vercel deployment was deleted (PR closed, cleanup ran but mongo PATCH failed and left the field populated). Re-run the cleanup PATCH manually with the CI token or wait for the next PR open to overwrite.

---

## References

- **Origin ticket:** IT-F2-475 — Scanner SOT: add PreviewUrl field + f2-members Preview sub-button. hima-reddy-assigned, cross-lane (f2-session backend, admin-client-app editor, hima-reddy workflow).
- **Parent arc:** IT-F2-205 Phase 9/10 — CCO per-PR previews infra + fleet-agnostic preview surface. Mike direction c/ddfe1078.
- **Design-locked clars on IT-F2-475:** b355de03 (clear-on-close), 94d93b91 (Deployment Protection off), 5f6e86d1 (edge-middleware-dynamic-lookup routing), 7d87151f (hide-when-empty editor anchor).
- **Reference scanner (first consumer):** hr-rsi (hima-reddy/hima-v2 pair).
- **Related recipes:** `SCANNER_AUTH_RECIPE.md` (SID handoff + entitlement gates), `LIVE_DATA_SCANNER_RECIPE.md` (live-data streaming + entitlement claims), `SCANNER_DATA_WIRING_RECIPE.md` (snapshot + WS wiring).
