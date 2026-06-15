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
const _configCache = new Map();

/**
 * Read the per-customer exchange-agreements config from the brand-config
 * endpoint (host-keyed; backend resolves to a Customer row via domains[]).
 *
 * @param {string} [host] - Hostname to look up. Defaults to window.location.host.
 * @returns {Promise<{enforced: boolean, required: boolean}>}
 */
export async function agreementsConfig(host) {
  const h = String(host || (typeof window !== "undefined" ? window.location.host : "")).trim().toLowerCase();
  const cached = _configCache.get(h);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) return cached.cfg;
  try {
    const res = await fetch(BRAND_CONFIG_ORIGIN + "/rest/api/brand-config?host=" + encodeURIComponent(h));
    if (!res.ok) throw new Error("brand-config " + res.status);
    const body = await res.json();
    const ea = body?.brand?.exchange_agreements ?? body?.exchange_agreements;
    const cfg = {
      enforced: ea?.enforced ?? true,
      required: ea?.required ?? true,
    };
    _configCache.set(h, { at: Date.now(), cfg });
    return cfg;
  } catch {
    return { enforced: true, required: true };
  }
}
