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
