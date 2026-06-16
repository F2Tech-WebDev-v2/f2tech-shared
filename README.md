# f2tech-shared

Cross-project helpers for the F2 Tech web stack. **Single source of truth** for TLD detection, per-TLD URL handling, toast/error-report wiring, SID handoff, data-tier banner, and exchange-agreements popup.

Anything that is a cross-SPA pattern (toast wiring, error reports, banners, popups, sid redemption, country flags) **MUST** come from this package. Do not copy-paste the pattern locally. Each SPA is a thin shim around the shared components.

---

# New Scanner Onboarding SOP

This section is the **single canonical reference** for everything a new scanner SPA (e.g. the upcoming `quant-pivot-pro`) MUST include. Walk every item before opening a PR. The fleet has been bitten too many times by "we forgot to wire the agreements banner" / "we forgot to redeem `?sid=`" / "we shipped with a floating dep range."

Target reader: a developer building `quant-pivot-pro` who has never set up an F2 scanner before.

---

## 1. Pin `f2tech-shared` at the CURRENT canonical SHA

Every SPA pins an **EXACT** SHA. Never `^`, `~`, `latest`, `main`, or a tag range. Floating ranges silently fan a breaking change across every consumer at the next install — same class as a D1 accident.

`package.json`:

```json
{
  "dependencies": {
    "f2tech-shared": "git+https://github.com/F2Tech-WebDev-v2/f2tech-shared.git#a5f868d"
  }
}
```

Current canonical SHA: **`a5f868d`** (v0.12.0+).

When you bump the pin in a consumer SPA:

1. Update the SHA in `package.json` (exact, no prefix).
2. `npm install` locally to refresh `package-lock.json` if the repo commits its lockfile (check `git ls-tree -r origin/main --name-only | grep lock` — policy varies per repo).
3. Adopt new modules **per-consumer**, in the slice that actually uses them. Do not fan a shared bump across every SPA in one PR.

See also: `feedback_f2tech_shared_exact_pin`.

---

## 2. Toast / error-report wiring (required)

Every user-facing error MUST be reportable. A bare "Session expired" tells support nothing. The error report payload becomes a **Support ID** the user can copy and paste — viewable by ops in `/admin/error-reports`.

### Angular SPAs

Thin shim in `src/app/@services/toast.service.ts` delegating to `errorWithSupportId` from `f2tech-shared/support-toast`.

Reference: `/mnt/c/AI_Dev/F2Tech-WebDev-v2/alpha-shark/src/app/@services/toast.service.ts`

```ts
import { Injectable } from '@angular/core';
import { errorWithSupportId } from 'f2tech-shared/support-toast';

@Injectable({ providedIn: 'root' })
export class ToastService {
  error(message: string, diagnostics: ErrorDiagnostics) {
    return errorWithSupportId(message, diagnostics, { apiBase: environment.f2ApiUrl });
  }
}
```

### React SPAs

Inline error block component using `reportError` from `f2tech-shared/error-reports`.

Reference: `/mnt/c/AI_Dev/F2Tech-WebDev-v2/f2-members/src/shared/ErrorBox.tsx`

```tsx
import { reportError } from 'f2tech-shared/error-reports';

export function ErrorBox({ message, diagnostics }: Props) {
  const [supportId, setSupportId] = useState<string | null>(null);
  useEffect(() => {
    reportError(diagnostics, F2_API_BASE).then(r => setSupportId(r.supportId));
  }, []);
  return (
    <div className="error-box">
      <p>{message}</p>
      {supportId && <button onClick={() => navigator.clipboard.writeText(supportId)}>Copy Support ID: {supportId}</button>}
    </div>
  );
}
```

### Diagnostics payload (mandatory fields)

Every error MUST pass:

```ts
{
  error_code:          string;  // e.g. "QP_AUTH_REDEEM_FAIL"
  customer:            string;  // e.g. "quant-pivot-pro"
  scanner_path:        string;  // window.location.pathname
  http_status:         number;  // 401, 500, ...
  f2_response_body:    string;  // truncated to 2KB
  f2_response_message: string;  // top-level msg field if present
}
```

### Error code prefix

Two-letter prefix per scanner, applied to **every** `error_code` value:

| Scanner          | Prefix |
| ---------------- | ------ |
| option-pit       | `OP_`  |
| hima             | `HM_`  |
| quant-pivot-pro  | `QP_`  |
| alpha-shark      | `AS_`  |
| ...              | pick 2 letters that don't collide |

See also: `feedback_error_toasts_have_copy_button`.

---

## 3. SID handoff (required for scanners launched from `members.f2-tech.ai`)

Members mints a short-lived `sid` and bounces the browser to the scanner with `?sid=<sid>`. The scanner redeems the sid against f2-admin-service for a JWT bundle, then strips the sid from the URL so a refresh doesn't try to redeem twice.

Use `redeemSid` from `f2tech-shared/sid-handoff` in the SPA's auth-guard / canActivate.

Reference: `/mnt/c/AI_Dev/F2Tech-WebDev-v2/alpha-shark/src/app/@services/auth.service.ts`

```ts
import { redeemSid } from 'f2tech-shared/sid-handoff';

async canActivate(route: ActivatedRouteSnapshot): Promise<boolean> {
  const sid = route.queryParamMap.get('sid');
  if (sid) {
    const result = await redeemSid(sid, environment.f2AdminApiUrl);
    if ('bundle' in result) {
      this.session.set(result.bundle);                  // stash in memory
      this.router.navigate([], {                        // strip ?sid= from URL
        queryParams: { sid: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
      return true;
    }
    this.toast.error('Sign-in failed', {
      error_code: 'QP_AUTH_REDEEM_FAIL',
      http_status: result.status,
      f2_response_body: result.body,
      f2_response_message: result.message,
      customer: 'quant-pivot-pro',
      scanner_path: window.location.pathname,
    });
    return false;
  }
  return this.hasValidSession();
}
```

`redeemSid` returns `{ bundle }` on success or `{ error, status, body, message }` on failure — narrow with `'bundle' in result`.

See also: `project_f2tech_shared_sid_handoff_v090`.

---

## 4. Data-tier banner (required)

The data-tier banner tells the user whether they're seeing realtime, delayed, or disabled data. It MUST be present on every scanner SPA — even if the scanner is realtime-only, an admin override or company override can flip the tier at runtime.

### Angular

```html
<!-- app.component.html — FIRST CHILD of the app shell -->
<f2-data-tier-banner [mode]="dataTierMode"></f2-data-tier-banner>
<router-outlet></router-outlet>
```

```ts
// app.component.ts
import { resolveDataTier } from 'f2tech-shared/agreements';
import { DataTierBannerComponent } from 'f2tech-shared/data-tier-banner.component';

export class AppComponent implements OnInit {
  dataTierMode: DataTierMode = 'realtime';

  ngOnInit() {
    this.recompute();
    window.addEventListener('auth_token_changed', () => this.recompute());
  }

  private recompute() {
    this.dataTierMode = resolveDataTier({
      userLiveAccess: this.session.userLiveAccess(),
      isAdmin:        this.session.isAdmin(),
    });
  }
}
```

### React

```tsx
// App.tsx — first child of the app shell
import { DataTierBanner } from 'f2tech-shared/data-tier-banner';

<>
  <DataTierBanner isAdmin={session.isAdmin} userLiveAccess={session.userLiveAccess} />
  <Routes>{/* ... */}</Routes>
</>
```

### Layout rule

The banner MUST be in **normal document flow**. No `position: fixed`, `absolute`, or `sticky`. It pushes content down rather than overlaying — overlay positioning has bitten us twice (banner covered the scanner's symbol picker on mobile).

---

## 5. Exchange-agreements popup + banner (required if the SPA serves real-time market data)

If the scanner streams any real-time market data feed, the user MUST sign the current exchange agreements before they see live ticks. The popup blocks until signed; the banner shows the signed-status while they're using the scanner.

### Angular

```html
<f2-exchange-agreements-popup></f2-exchange-agreements-popup>
<f2-exchange-agreements-banner></f2-exchange-agreements-banner>
```

```ts
// import from f2tech-shared
import { ExchangeAgreementsPopupComponent } from 'f2tech-shared/exchange-agreements-popup.component';
import { ExchangeAgreementsBannerComponent } from 'f2tech-shared/exchange-agreements-banner.component';
```

### React

```tsx
import { ExchangeAgreementsPopup, ExchangeAgreementsBanner } from 'f2tech-shared/exchange-agreements-popup';

<ExchangeAgreementsPopup visible={daService.visible} agreementUrl={agreementUrl} />
<ExchangeAgreementsBanner signed={daService.signed} />
```

### Wiring

- Caller owns a local `DataAgreementsService` (same shape as `alpha-shark`'s).
- `visible` is driven by the service's "needs to sign" state.
- `agreementUrl` comes from `daService.get_exch_agreements_url()`, which itself calls `exchAgreementsUrl(...)` from `f2tech-shared/agreements`.

### When to skip

PUSH-only / notification-only scanners that do not serve market data MAY skip this section. If you skip, **document why in the SPA's own README** (one sentence: "quant-pivot-pro emits push notifications only; no realtime quote stream; exchange agreements not required").

---

## 6. Customer registration in F2-Admin

Before the scanner can serve users, it must exist in the shared admin DB.

In `F2-ADMIN` (Mongo on `web-backend-srvr-1`):

### `Customers` collection

- Add a doc with the scanner's slug (`quant-pivot-pro`).
- Set `sso_portal.enabled = true` if the scanner is launched via members SID-mint.
- Set `sso_portal.default_scanners` to the wildcard pattern for the scanner suite (e.g. `qp-*`) — see `feedback_sso_default_scanners_no_hardwire`.
- Configure `exchange_agreements.enforced` per market-data needs (true if realtime, false if push-only).
- Optional `company_override.mode` / `customer_override.mode` — `realtime` | `delayed` | `disabled`.
- Optional `endpoints` — live login/landing/scan routes. Keep current per `feedback_keep_customer_endpoints_current`.

### `Scanners` collection

- Add a row whose `Url` points at the **customer-facing canonical** (`quant-pivot-pro.f2-tech.ai`).
- Use `AppUrl` for the `*.vercel.app` alias; never put `vercel.app` in `Url` (see `feedback_vercel_app_url_goes_in_appurl`).
- `Client` = the customer slug; `ScannerId` = the routing key the SPA uses internally.

---

## 7. Vercel deploy hygiene

- Pin **EXACT SHA** for `f2tech-shared` (no floating refs — repeated for emphasis).
- After bumping the pin, trigger a Vercel rebuild with `forceNew=1` if the build cache might have stale `node_modules` from the prior SHA. Prior incident: alpha-shark served a stale bundle for hours because Vercel reused the cached install.
- Verify the build state after every UI PR — hit the Vercel deployments API; "auto-built" is not verification. A failed earlier build silently blocks every later PR on the branch. (See `feedback_verify_vercel_build_after_push`.)
- Backend-host flips for one scanner **NEVER** generalize to siblings. Each producer-data migration is independent. Touch only the named SPA; ask before patterning. (See `feedback_per_product_apiurl_is_site_specific`.)
- Do not launch multi-minute foreground polls after pushes. One-shot verify only. (See `feedback_no_vercel_polling_loops`.)

---

## 8. Common-code rule

Anything that is a cross-SPA pattern MUST come from `f2tech-shared`. This includes (non-exhaustive):

- Toast / support-ID wiring
- Error report submission
- SID redemption
- Data-tier banner
- Exchange-agreements popup + banner
- Country flag rendering
- TLD detection / per-TLD URL helpers (`svcUrl`, `expandTld`, `attachToken`)

If you find yourself reimplementing one of these locally, stop and add (or update) the shared module instead. Each SPA is a **thin shim** around shared components. "Common code as much as possible" is a directive, not a suggestion.

---

## 9. See also (memory references)

Context lives under `/home/webdev/.claude/projects/-mnt-c-AI-Dev-F2Tech-WebDev-v2/memory/`:

- `feedback_f2tech_shared_exact_pin` — why the SHA pin is non-negotiable.
- `feedback_error_toasts_have_copy_button` — diagnostics payload contract.
- `project_f2tech_shared_sid_handoff_v090` — `redeemSid` shape + apiBase.
- `project_alpha_shark_repo_is_option_sniper` — which repo is which SPA (avoid the alpha-shark / option-sniper / alpha-shark-{flow,push,service} mixup).

---

## 10. Quick-start checklist for a new scanner repo

Walk every box before opening a PR.

- [ ] `package.json`: `f2tech-shared` pinned at `a5f868d` (or newer canonical SHA)
- [ ] `toast.service` shim using `errorWithSupportId` (Angular) / `ErrorBox` using `reportError` (React)
- [ ] Two-letter error_code prefix chosen and applied consistently
- [ ] `auth.service` canActivate using `redeemSid` (if launched from members)
- [ ] `?sid=` stripped from URL via `router.navigate({ replaceUrl: true })` after redemption
- [ ] `app.component.ts`: `dataTierMode` wired via `resolveDataTier({ userLiveAccess, isAdmin })`
- [ ] `dataTierMode` re-resolved on `auth_token_changed` event
- [ ] `app.component.html`: `<f2-data-tier-banner [mode]="dataTierMode">` as **first child**, in normal document flow
- [ ] If real-time market data: `<f2-exchange-agreements-popup>` + `<f2-exchange-agreements-banner>` + local `DataAgreementsService`
- [ ] If no real-time market data: documented why in the SPA's own README
- [ ] F2-Admin: `Customers` doc + `Scanners` row (canonical `Url`, vercel.app in `AppUrl`)
- [ ] F2-Admin: `sso_portal.enabled` + `sso_portal.default_scanners` wildcard set if SSO-onboarded
- [ ] Vercel project linked to repo; production branch set to `main`
- [ ] Smoke test: load with `?sid=<test>` and verify redemption, then verify banner renders when an admin override is toggled
- [ ] Vercel build verified green after the first deploy

---

# Library API (existing exports)

## Install

Each consumer pins to a git SHA (no npm registry needed):

```json
{
  "dependencies": {
    "f2tech-shared": "git+https://github.com/F2Tech-WebDev-v2/f2tech-shared.git#a5f868d"
  }
}
```

For Vercel-hosted apps: the project's existing GitHub integration covers this. No extra auth setup.

## TLD / URL helpers

```ts
import { TLD, svcUrl, expandTld, attachToken } from "f2tech-shared";

TLD                                       // "com" | "ai" — cached at module load from window.location.hostname

svcUrl("f2-api")                          // "https://f2-api.f2-tech.<TLD>"
svcUrl("hima-svc2", "/rest")              // "https://hima-svc2.f2-tech.<TLD>/rest"

expandTld("https://x.f2-tech.{tld}/y")    // substitutes {tld} placeholder; legacy URLs (with hardcoded .com) pass through

attachToken(url, idToken)                 // per-TLD token delivery: #token= on .ai, ?token= on .com / external
```

## Same-TLD constraint

The whole point of derive-once-at-module-load is: a user on `.com` stays on `.com`; a user on `.ai` stays on `.ai`. No cross-TLD redirects. Reasons:

1. Reputation isolation — redirecting from a flagged domain to a clean one propagates the classifier signal.
2. Browser block resilience — `.ai`-only users (whose browser blocks `.com`) can't be bounced to `.com` mid-flow.

`isAllowedNext()` / `buildRedirectUrl()` in `f2-login` enforce this at the gateway. Consumer apps trust the gateway and just call `expandTld()` / `attachToken()` on stored or returned URLs.

## Other modules

| Module                                            | Purpose                                                |
| ------------------------------------------------- | ------------------------------------------------------ |
| `f2tech-shared/support-toast`                     | `errorWithSupportId` — Angular toast w/ Support ID copy |
| `f2tech-shared/error-reports`                     | `reportError` — POST diagnostics, returns Support ID    |
| `f2tech-shared/sid-handoff`                       | `redeemSid` — members `?sid=` → JWT bundle              |
| `f2tech-shared/agreements`                        | `resolveDataTier`, `exchAgreementsUrl`                  |
| `f2tech-shared/data-tier-banner`                  | React banner                                            |
| `f2tech-shared/data-tier-banner.component`        | Angular banner                                          |
| `f2tech-shared/exchange-agreements-popup`         | React popup + banner                                    |
| `f2tech-shared/exchange-agreements-popup.component`  | Angular popup                                       |
| `f2tech-shared/exchange-agreements-banner.component` | Angular banner                                      |

---

## Release

```
git tag v0.13.0
git push --tags
```

Then bump the SHA (not the tag — exact SHA per `feedback_f2tech_shared_exact_pin`) in each consumer's `package.json` and redeploy. Adopt per-consumer in the slice that uses the new module.

## Why git ref instead of npm?

- Zero infra (no private registry, no GitHub Packages auth).
- Vercel/Angular/Vite already authenticate to GitHub via the connected integration.
- Pinning to a specific SHA is reproducible; consumers update intentionally.
- Trade-off accepted: `npm install` is slightly slower (git clone) than registry fetch. Negligible for the size of this package.

## Backend equivalent

Backends derive TLD from the incoming HTTP request, not from `window`. They use a separate, file-local `tldFromHost(host)` helper (see `f2-admin-service` and `f2-auth-service`). Not bundled into this library — keeping browser globals out of Node-side imports.

Note: `tldFromHost` defaults to `'com'` on unknown hosts. Correct today; silent landmine when `.com` is retired. Flip to `'ai'` or throw **before** killing `.com` infra. (See `feedback_tld_default_com_teardown_landmine`.)
