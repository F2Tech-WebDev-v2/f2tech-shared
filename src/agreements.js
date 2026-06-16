// Exchange-agreements iframe URL — single source of truth across every
// F2 Tech frontend.
//
// The exchange-agreements popup ALWAYS targets F2's admin app
// (`admin.f2-tech.ai`), regardless of which customer SPA opens it.
// Customer-owned hosts (e.g. `scanners.theotrade.com`) cannot
// host this view — F2 owns the data agreements UI. So this URL is
// HARDCODED to `.ai`, not derived from the running host's TLD.
//
// Why hardcoded rather than `admin.f2-tech.${TLD}`:
//   - `${TLD}` resolves to "com" on customer-owned hosts (the
//     TLD-default-com landmine fixed in 2026-06). Sending a token
//     to `admin.f2-tech.com` lands on dead DNS (-105
//     ERR_NAME_NOT_RESOLVED) since that infra was retired in the
//     phoenix5 cert cleanup 2026-06-09.
//   - The exchange-agreements UI is admin-owned, single-instance,
//     no per-customer fork. There is no `.com` version to honor.
//
// Token in URL fragment (#token=), not query (?token=):
//   - Fragments are NEVER sent in HTTP Referer headers, nginx access
//     logs, or analytics — token stays local to the browser. Same
//     pattern as f2tech-shared's attachToken() for .ai targets.
//   - encodeURIComponent because JWT base64url is "URL-safe enough"
//     but the `=` padding and similar can still surprise some
//     servers.
//
// Consumers replace their per-SPA `get_exch_agreements_url()`
// implementations with a single call to this helper, so future host
// or URL-shape changes land in one place.

const ADMIN_HOST = "admin.f2-tech.ai";

/**
 * Build the customer-scoped exchange-agreements iframe URL.
 *
 * @param {string} customerSlug - F2-ADMIN.Customers._id value (e.g. "delphi-sig", "theo-trade")
 * @param {string} idToken - Cognito idToken (will be encodeURIComponent'd into the fragment)
 * @returns {string} - https://admin.f2-tech.ai/data-agreements?customer=<slug>#token=<encoded-jwt>
 */
export function exchAgreementsUrl(customerSlug, idToken) {
  const slug = encodeURIComponent(String(customerSlug || ""));
  const token = encodeURIComponent(String(idToken || ""));
  return "https://" + ADMIN_HOST + "/data-agreements?customer=" + slug + "#token=" + token;
}

// Per-customer agreements gating, sourced from F2-ADMIN.Customers.exchange_agreements.
// Consumers wrap their existing get_exchange_agreements() flow with this:
//   const cfg = await agreementsConfig();
//   if (!cfg.enforced) { /* skip popup + don't gate scanner */ return; }
// Fail-safe default ({enforced: true, required: true}) if the backend is
// unreachable or the Customer doc lacks the field — preserves the historical
// default of "agreements gate is on" rather than silently disabling it.
//
// Cross-origin: relies on @koa/cors being wide-open on f2-admin-service2
// (current state). If CORS is ever tightened to an allowlist (see memory
// feedback_cors_before_samesite_none.md), /rest/api/brand-config MUST stay
// reachable from every customer SPA origin or this gate breaks.

const BRAND_CONFIG_ORIGIN = "https://f2-admin-service2.f2-tech.ai";
const CACHE_TTL_MS = 60 * 1000;
const _brandCache = new Map();

// Single shared fetch of /rest/api/brand-config per host (60s TTL).
// Both agreementsConfig() and dataTierOverride() consume from this so a
// scanner SPA does one cross-origin request per minute, not two.
async function _getBrand(host) {
  const h = String(host || (typeof window !== "undefined" ? window.location.host : "")).trim().toLowerCase();
  const cached = _brandCache.get(h);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) return cached.body;
  try {
    const res = await fetch(BRAND_CONFIG_ORIGIN + "/rest/api/brand-config?host=" + encodeURIComponent(h));
    if (!res.ok) throw new Error("brand-config " + res.status);
    const body = await res.json();
    _brandCache.set(h, { at: Date.now(), body });
    return body;
  } catch {
    return null;
  }
}

/**
 * Read the per-customer exchange-agreements config from the brand-config
 * endpoint (host-keyed; backend resolves to a Customer row via domains[]).
 *
 * @param {string} [host] - Hostname to look up. Defaults to window.location.host.
 * @returns {Promise<{enforced: boolean, required: boolean}>}
 */
export async function agreementsConfig(host) {
  const body = await _getBrand(host);
  if (!body) return { enforced: true, required: true };
  const ea = body?.brand?.exchange_agreements ?? body?.exchange_agreements;
  return {
    enforced: ea?.enforced ?? true,
    required: ea?.required ?? true,
  };
}

/**
 * Read the company-wide data-tier override mode from the brand-config
 * endpoint (set by F2 admin on the 'f2' Customer doc). Highest-priority
 * layer — overrides per-customer + per-user.
 *
 * @param {string} [host] - Hostname to look up. Defaults to window.location.host.
 * @returns {Promise<'delayed' | 'realtime' | 'disabled' | null>}
 */
export async function dataTierOverride(host) {
  const body = await _getBrand(host);
  if (!body) return null;
  const co = body?.brand?.company_override ?? body?.company_override;
  const m = co?.mode;
  return (m === "delayed" || m === "realtime" || m === "disabled") ? m : null;
}

/**
 * Read the per-customer data-tier override mode from the brand-config
 * endpoint (set by F2 admin on the customer's Customer doc — e.g. forcing
 * 'delayed' for all of MTA's users). Middle-priority layer — overridden
 * by company-wide, overrides per-user entitlement.
 *
 * @param {string} [host] - Hostname to look up. Defaults to window.location.host.
 * @returns {Promise<'delayed' | 'realtime' | 'disabled' | null>}
 */
export async function customerDataTier(host) {
  const body = await _getBrand(host);
  if (!body) return null;
  const co = body?.brand?.customer_override ?? body?.customer_override;
  const m = co?.mode;
  return (m === "delayed" || m === "realtime" || m === "disabled") ? m : null;
}

/**
 * Single entry-point each scanner SPA uses to determine the user's
 * effective data tier. Applies the 3-layer rule:
 *
 *   1. company override (F2 admin)   — highest priority
 *   2. customer override (per-customer admin)
 *   3. user entitlement (caller-supplied userLiveAccess boolean)
 *
 * Library stays auth-free: the caller computes userLiveAccess + isAdmin
 * from its own auth flow (typically authService.has_live_data_access()
 * and authService.is_admin()).
 *
 * Returns three fields:
 *   tier        — the EFFECTIVE data tier the user gets. Use for data
 *                 feed routing (live vs delayed WebSocket etc.).
 *   source      — which layer decided the tier (company | customer | user).
 *   bannerMode  — what mode to RENDER in the override banner, or null
 *                 when no banner should show. The standard SPA pattern:
 *                 <div *ngIf="bannerMode">...</div> and the library
 *                 decides when to surface it. Rules:
 *                   - source === 'user' → null (no override active, no
 *                     banner needed)
 *                   - source !== 'user' → same as tier (show to ALL
 *                     users when an admin override is active — the
 *                     realtime banner literally says "all users serving
 *                     live data", so it must be visible to all users)
 *
 * @param {object} opts
 * @param {boolean} [opts.userLiveAccess] - Caller's resolved user-entitlement boolean.
 * @param {boolean} [opts.isAdmin] - Caller's admin-role boolean. Defaults false.
 * @param {string} [opts.host] - Hostname; defaults to window.location.host.
 * @returns {Promise<{tier: 'realtime' | 'delayed' | 'disabled', source: 'company' | 'customer' | 'user', bannerMode: 'realtime' | 'delayed' | 'disabled' | null}>}
 */
export async function resolveDataTier(opts) {
  const host = opts && opts.host;
  const userLiveAccess = !!(opts && opts.userLiveAccess);
  const isAdmin = !!(opts && opts.isAdmin);
  const body = await _getBrand(host);
  const companyMode = (() => {
    const m = (body?.brand?.company_override ?? body?.company_override)?.mode;
    return (m === "delayed" || m === "realtime" || m === "disabled") ? m : null;
  })();
  const customerMode = (() => {
    const m = (body?.brand?.customer_override ?? body?.customer_override)?.mode;
    return (m === "delayed" || m === "realtime" || m === "disabled") ? m : null;
  })();
  let tier, source;
  if (companyMode) { tier = companyMode; source = "company"; }
  else if (customerMode) { tier = customerMode; source = "customer"; }
  else { tier = userLiveAccess ? "realtime" : "delayed"; source = "user"; }
  // Banner display rule — see jsdoc above. ANY active override surfaces
  // to all users; the realtime banner text explicitly says "all users".
  void isAdmin; // retained in the signature for future per-role banners
  const bannerMode = (source !== "user") ? tier : null;
  return { tier, source, bannerMode };
}
