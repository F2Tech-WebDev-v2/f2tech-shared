# f2tech-shared

Cross-project helpers for the F2 Tech web stack. **Single source of truth** for TLD detection and per-TLD URL handling — change the rule here once, every consumer picks it up on next deploy.

## Install

Each consumer pins to a git ref (no npm registry needed):

```json
{
  "dependencies": {
    "f2tech-shared": "github:F2Tech-WebDev-v2/f2tech-shared#v0.1.0"
  }
}
```

For Vercel-hosted apps: the project's existing GitHub integration covers this. No extra auth setup.

## API

```ts
import { TLD, svcUrl, expandTld, attachToken } from "f2tech-shared";

TLD                                  // "com" | "ai" — cached at module load from window.location.hostname

svcUrl("f2-api")                     // "https://f2-api.f2-tech.<TLD>"
svcUrl("hima-svc2", "/rest")         // "https://hima-svc2.f2-tech.<TLD>/rest"

expandTld("https://x.f2-tech.{tld}/y") // substitutes {tld} placeholder; legacy URLs (with hardcoded .com) pass through

attachToken(url, idToken)            // per-TLD token delivery: #token= on .ai, ?token= on .com / external
```

## Same-TLD constraint

The whole point of derive-once-at-module-load is: a user on `.com` stays on `.com`; a user on `.ai` stays on `.ai`. No cross-TLD redirects. Reasons:

1. Reputation isolation — redirecting from a flagged domain to a clean one propagates the classifier signal.
2. Browser block resilience — `.ai`-only users (whose browser blocks `.com`) can't be bounced to `.com` mid-flow.

`isAllowedNext()` / `buildRedirectUrl()` in `f2-login` enforce this at the gateway. Consumer apps trust the gateway and just call `expandTld()` / `attachToken()` on stored or returned URLs.

## Release

```
git tag v0.2.0
git push --tags
```

Then bump the `#v0.2.0` ref in each consumer's `package.json` and redeploy.

## Why git ref instead of npm?

- Zero infra (no private registry, no GitHub Packages auth).
- Vercel/Angular/Vite already authenticate to GitHub via the connected integration.
- Pinning to a specific tag (vs `main`) is reproducible; consumers update intentionally.
- Trade-off accepted: `npm install` is slightly slower (git clone) than registry fetch. Negligible for a 4-export package.

## Backend equivalent

Backends derive TLD from the incoming HTTP request, not from `window`. They use a separate, file-local `tldFromHost(host)` helper (see `f2-admin-service` and `f2-auth-service`). Not bundled into this library — keeping browser globals out of Node-side imports.
