# Scanner paywall + live-delivery recipe

**When to read this:** you're wiring (or auditing) a paid customer scanner SPA that needs to be behind the entitlement system AND deliver live data over WebSockets. Walk this door-by-door once; don't invent the sequence per scanner. Written 2026-10-09 after IT-F2-406 iterated the full path in production.

A scanner is "paywalled" when **every** data surface — HTML, REST snapshot, WebSocket — is unreachable without (a) a valid session, AND (b) the user's `custom:scanners` CSV includes the scanner's slug. Any single open door is a hole; a direct `curl` to a backend endpoint must be as useless as hitting the SPA with no auth.

---

## The four doors

Every scanner has four surfaces that need the same gate. Audit each.

| # | Surface | Correct gate | Anti-pattern |
|---|---|---|---|
| 1 | **SPA data effect** (`useEffect` that fetches snapshot + opens WS) | Early-return if `!idToken \|\| !hasScannerEntitlement(idToken, slug)` | Fetching snapshot regardless, then rendering what came back |
| 2 | **REST snapshot endpoint** on `f2-admin-service` (or wherever) | `@UseBefore(F2AuthMiddleware)` + scanner-slug entitlement check in-handler | `@Get` with no middleware — "temporary, SPA has no auth yet" ends up permanent |
| 3 | **f2-api WS route** `/ws/<cust>/<scanner>/<view>` | Session-gated via the normal `preHandler` Bearer check; SPA passes `?ticket=<minted>` | `preHandler` carve-out that early-`return`s on `/ws/<cust>/*` to make a specific SPA work |
| 4 | **f2-api REST snapshot** `/rest/<cust>/<scanner>/<view>` | Same session gate as the WS twin | Same carve-out trap as door 3 |

If you're adding a scanner, all four doors go in together. If you inherit one that was previously anon ("just make it work for now") you MUST close all four before shipping.

---

## SPA bootstrap ladder (door 1 — the only one your lane owns on scanner SPAs)

Scanner SPAs don't speak Cognito directly. They speak **sid → f2-admin-service redeem → f2-admin-service mint-ws-ticket → f2-api WS**. Full ladder on mount:

```
1. ?sid=<opaque> in URL
     → POST /rest/auth/redeem-session { sid } (credentials:'include')
     → stash body.id_token in localStorage.f2_auth_token + setIdToken
     → strip ?sid from URL via history.replaceState (one-use credential;
       a page refresh must not retry a now-consumed sid, and the sid
       must not leak via Referer / history / bookmarks)

2. no sid
     → POST /rest/auth/mint-sid-from-cookies (credentials:'include')
       — reads the httpOnly f2_access / f2_id / f2_refresh cookies that
       the FIRST successful redeem-session set on the branded host
     → 200 { sid } → redeem it (loop back to step 1's redeem call)
     → 401 → fall through

3. no cookies either
     → use whatever's in localStorage.f2_auth_token as-is
     → do NOT POST /rest/auth/validate-token first — some pools (new
       customer pools, pre-launch pools) aren't in the validator's
       issuer allowlist, so a known-good token will come back
       { valid:false, err:"Token issuer not recognized..." } and your
       code will purge a working token, de-authenticating the user
       for no reason. The real check is at WS handshake time:
       mint-ws-ticket signature-verifies, and f2-api 1008-closes on
       a bad token — that's your "token is actually dead" signal.

4. still no idToken
     → render the empty / "please sign in" state. No snapshot, no WS.
```

**Credentials matter.** `fetch(REDEEM_URL, { ..., credentials: 'include' })` is non-negotiable. Without it the browser silently drops the `Set-Cookie` on the response and step 2's cookie-recovery has nothing to recover from. Same for `mint-sid-from-cookies`.

---

## Entitlement check (door 1, part 2)

Having an idToken proves identity, not entitlement. The user has to also hold `custom:scanners` with the scanner's slug. Minimal implementation (no AuthContext required for a small SPA):

```js
function decodeJwtClaims(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    return JSON.parse(atob(padded + pad));
  } catch { return null; }
}

function tokenIsAdmin(token) {
  const c = decodeJwtClaims(token);
  if (!c) return false;
  if (c.is_admin === true) return true;
  const role = typeof c['custom:role'] === 'string' ? c['custom:role'].toLowerCase() : '';
  if (role === 'admin') return true;
  const g = c['cognito:groups'];
  return Array.isArray(g) && g.map(String).map((s) => s.toLowerCase()).includes('admin');
}

function hasScannerEntitlement(token, slug) {
  // Admins bypass per-scanner entitlement — role is a global 'see
  // everything' grant across the fleet. Without this, admin-dashboard
  // sid handoffs loop to /login because admin tokens carry
  // custom:role=admin but typically not scanner-specific
  // custom:scanners entries. Mirrors alpha-shark-flow isAdmin + f2-admin.
  if (tokenIsAdmin(token)) return true;
  const c = decodeJwtClaims(token);
  if (!c) return false;
  const raw = c['custom:scanners'] ?? c.scanners;
  const list = Array.isArray(raw)
    ? raw.map((s) => String(s).trim()).filter(Boolean)
    : typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  if (list.includes(slug)) return true;
  // Wildcard entries from admin bulk grants ('os-*', 'tt-*')
  return list.some((s) => s.endsWith('*') && slug.startsWith(s.slice(0, -1)));
}
```

Then your data effect:

```js
useEffect(() => {
  if (!idToken || !hasScannerEntitlement(idToken, SCANNER_SLUG)) return;
  // snapshot fetch + WS open
}, [idToken]);
```

**No signature verification on the SPA side.** The claims are read-only for UI gating; every actual data call hits a server that verifies the signature. Trusting unverified claims client-side is fine — a tampered token still gets rejected by the backend. (If you don't trust that, see "backend doors" below — the fix is backend, not SPA-side JWT libs.)

---

## WebSocket ticket mint

The WS URL must not carry a raw JWT. Pattern:

```js
async function mintWsTicket(idToken) {
  const res = await fetch('/rest/auth/mint-ws-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: idToken }),
  });
  if (!res.ok) throw new Error(`mint-ws-ticket ${res.status}`);
  const body = await res.json();
  if (!body?.ticket) throw new Error('no ticket');
  return body.ticket;
}

// per-socket connect():
const ticket = await mintWsTicket(idToken);
const ws = new WebSocket(`wss://f2-api.f2-tech.ai/ws/${wsPath}?ticket=${encodeURIComponent(ticket)}`);
```

f2-api redeems the ticket against the redis session on handshake. The ticket is single-use + short-TTL so it doesn't matter that it ends up in nginx access logs / Referer.

### Subscribe on open — do not skip

f2-api's push pipeline closes any WS that doesn't send a subscribe message within ~a few seconds. The SPA MUST send one on `ws.onopen`:

```js
ws.onopen = () => {
  retries = 0;
  try { ws.send(JSON.stringify({ type: 'subscribe', filter: {} })); }
  catch { /* already closed */ }
};
```

Empty `filter: {}` = "every doc on this channel." For scanners with per-view filtering (preset, rank), send the full FilterSpec here. See `alpha-shark-flow/src/ws/flowSocket.ts` for the full pattern incl. collection + postFilter.

### Reconnect backoff

Floor the first retry at **2s**, not 0 or 500ms. A close-on-no-subscribe fires almost immediately; a tight-loop reconnect at 500ms will burn through the browser's socket pool in a few seconds. 2s → cap 30s.

### 1008 close means the token is dead

```js
ws.onclose = (ev) => {
  ws = null;
  if (ev.code === 1008) {
    localStorage.removeItem('f2_auth_token');  // Cognito token no longer good
    stopped = true;                             // don't retry this socket
    return;
  }
  schedule(); // normal backoff reconnect
};
```

Clear the stored token and stop reconnecting that socket. The user needs a fresh sid handoff; retrying with the same dead token will 1008-close again instantly.

---

## When the bootstrap ladder resolves to "no auth" — redirect, don't just show a message

If every step of the ladder (§1-§4) fell through, the user is unauthenticated. Don't just render a "please sign in" message — hard-redirect them to wherever they need to go. The redirect target comes from `GET /api/brand-config?host=<window.location.host>` (same-origin, no auth required, that endpoint is public by design — it's the SPA's bootstrap). Response:

```json
{
  "slug": "option-sniper",
  "loginPath": "local",
  "auth": {
    "external_login_url": null,       // or "https://members.theotrade.com/login"
    "forgot_password_enabled": true,
    "forgot_password_mode": "magic_link"
  },
  "isCustomerBrand": true,
  // ... branding, exchange_agreements, etc.
}
```

Redirect ladder, in order:

1. **Customer-controlled login** (`auth.external_login_url` is truthy) — hard-nav to that URL. The customer owns the identity flow; they'll handle sign-in and hand the user back with a fresh `?sid=` once auth completes. Example: TheoTrade users bounce to `members.theotrade.com/login`.

2. **F2-local login** (`loginPath === "local"`) — the customer uses the F2 fleet members login. Hard-nav to `/login` on the same host; f2-members' Edge Middleware serves the fleet login shell at that path. On success, the shell returns the user to the branded host with a `?sid=` the SPA then redeems.

3. **Fallback** — if `brand-config` fetch fails or the shape is unexpected, hard-nav to `https://members.f2-tech.ai/login?next=<encoded return URL>`. This is the universal entry point; the shell figures out branding from the referrer / return URL.

Pattern:

```js
async function signInRedirect(returnUrl) {
  try {
    const res = await fetch(`/api/brand-config?host=${encodeURIComponent(window.location.host)}`);
    if (res.ok) {
      const cfg = await res.json();
      const ext = cfg?.auth?.external_login_url;
      if (ext) { window.location.replace(ext); return; }
      if (cfg?.loginPath === 'local') {
        window.location.replace(`/login?next=${encodeURIComponent(returnUrl)}`);
        return;
      }
    }
  } catch { /* fall through to fleet default */ }
  window.location.replace(
    `https://members.f2-tech.ai/login?next=${encodeURIComponent(returnUrl)}`,
  );
}
```

**Guard against the sign-in / landing-page loop.** On a user who just bounced back from /login (because they haven't completed auth yet), the Tape mounts and immediately bounces them back to /login. Infinite loop. Simple guard: track whether a bootstrap attempt has already fired this session (ref flag), and only redirect once per mount. Rely on /login to hand the user back with a fresh `?sid=` which breaks the loop at step §1 of the bootstrap ladder.

**Only redirect when idToken is ABSENT, not when entitlement check fails.** The two states look similar but demand different responses:

- `!idToken` → user never completed sign-in. Redirect to the login surface via the ladder above. The user signs in and comes back with a fresh `?sid=` that redeems to a token.
- `idToken && !hasScannerEntitlement(idToken, slug)` → user IS signed in; they just lack the scanner. Redirecting here would mint the same identity again and infinite-loop. Render the gate copy ("contact support to review your entitlements") instead; the fix is admin granting the scanner, not another sign-in cycle.

The one trap this closes: admin-dashboard sid handoffs. Admin tokens typically carry `custom:role=admin` but not per-scanner `custom:scanners` entries, so without the admin bypass in `hasScannerEntitlement` (above) the gate fires false-positive AND without the "only redirect on !idToken" guard the SPA loops. Both are needed together.

**Also wait for the auth bootstrap to resolve before firing the redirect.** The data effect runs on mount with `idToken=null` (initial state); a slow sid-redeem (admin dashboard handoff takes a round-trip) would race to /login before the redeem populates. Track with an `authResolved` state (false until every branch of the bootstrap effect sets it true in its own `finally`), and gate the redirect on `authResolved && !idToken`. Render a neutral "Signing you in…" placeholder for the window before `authResolved` so users don't flash the sign-in gate during a valid handoff.

**Why cache login_url/logout_url from the first redeem** (per `alpha-shark-flow`'s `asf_login_url` / `asf_logout_url` localStorage keys): once a user has successfully redeemed, the server stamps `login_url` and `logout_url` into `bundle.user`. Cache those; use them for logout + session-expiry hard-navs without a second brand-config roundtrip. Absent on older mints — cache is best-effort, callers fall back to the ladder above.

---

## Backend doors (2, 3, 4)

These are not SPA-side. If you own them, pattern:

- **f2-admin-service REST** — `@UseBefore(F2AuthMiddleware)` + in-handler check that `ctx.userData.scanners` contains the scanner slug. Rejecting unauthorized reads is more valuable than a 404 — a 401 tells the SPA to re-handoff.
- **f2-api `preHandler`** — leave the Bearer / ticket check in place. Any `startsWith('/ws/<cust>/<scanner>/')` carve-out "to make it work" IS the paywall hole; file a revert immediately.

If a stop-gap anon route was added during an iteration (and this will happen — scanners often ship REST before auth is wired), file it as a red/BLOCKED checklist item on the scanner's ticket when you ship the SPA auth. Don't let "temporary" become permanent.

---

## Common failure modes (worked through on IT-F2-406)

| Symptom | Likely cause |
|---|---|
| "WS works on first visit but not on reload" | No cookie-recovery wired. `redeem-session` sets cookies but a sid-less reload has no path to use them. |
| "WS handshake 101 but no messages ever flow" | SPA forgot to send `{type:'subscribe',filter:{}}` on open. Server closed on timeout. |
| "Private browser can see the data" | Backend door 2, 3, or 4 is anon-open. SPA gating alone doesn't paywall anything — direct curl bypasses the SPA. |
| "Stored token is purged on every reload" | SPA calls `validate-token` eagerly and the scanner's Cognito pool isn't in the validator's issuer allowlist. Drop the pre-validate step; let `mint-ws-ticket` be the authoritative check. |
| "WS reconnect storm — 15+ handshakes per socket per minute" | Reconnect backoff is too tight AND no subscribe-on-open. Fix both. |
| "User authenticates but Tape is empty" | Entitlement check fails — token's `custom:scanners` doesn't include the slug. Admin needs to grant. |
| "Admin-dashboard sid handoff loops to /login" | Admin token has `custom:role=admin` but no per-scanner `custom:scanners`. Entitlement fails → redirect fires → sign-in mints same identity → loop. Fix: admin bypass in `hasScannerEntitlement` (see `tokenIsAdmin`) + only-redirect-on-`!idToken` (not on no-entitlement). |
| "WS handshake 101, subscribe sent, zero messages received" | f2-api `matchesFilterSpec` is silently dropping docs. Default `FLOW_DEFAULT_MIN_PREMIUM = $10,000` computed from `TradeSize * TradePrice * 100` — if the producer uses `Quantity` for size and `TradeSize` for per-print, the computed total is below the floor and every doc drops. Fix either (a) SPA sends `{filter:{minPremium:0}}` on subscribe (override floor per-connection), or (b) `F2-ADMIN.Scanners.<id>.Stream[*].SkipPremiumFloor:true` server-side (data-driven, data-correct). |

---

## Reference impls

- **`alpha-shark-flow/src/auth/AuthContext.tsx`** — full React-Router + AuthContext pattern with Login.tsx, useRequireAuth, logout URL caching. Use this when the SPA has multiple routes and a real login UI.
- **`alpha-shark-flow/src/ws/flowSocket.ts`** — ticket mint + subscribe-on-open + exponential backoff + FilterSpec plumbing. Lift directly.
- **`option-sniper-tape/src/OptionSniperTape.jsx`** — compact single-file version of the pattern (no react-router, no AuthContext — just an auth-bootstrap `useEffect` + an entitlement helper + the socket pool). Appropriate when the SPA is one route.

---

## KG cross-refs

- `runbook:sid-and-token-handoff-always-wins-standard-2026-06-16` — the sid-handoff invariant (fresh sid wins over stored token)
- `runbook:vite-react-scanner-spa-auth-gate-same-origin-2026-09-18` — same-origin F2_API_URL default + CORS pitfall for branded hosts
- `runbook:stream-watcher-and-scanners-streaming-routes` — the data-driven stream-watcher + f2-api fanout the WS routes consume
- `runbook:f2-api-push-pipeline-generic-pattern` — channel/path naming + FilterSpec contract
