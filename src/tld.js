// Cached TLD ("com" or "ai") derived once at module load from the
// running host. window.location.hostname is fixed for the page lifetime,
// so a const computed at import time is correct and avoids re-evaluating
// the same hostname check at every URL-building call site.
//
// Single source of truth across every F2 Tech frontend. Change the
// detection rule here once (e.g. adding a third TLD, or tightening the
// match) and every consumer picks it up on next deploy.

function detect() {
  if (typeof window === "undefined") return "com";
  return window.location.hostname.toLowerCase().endsWith(".f2-tech.ai") ? "ai" : "com";
}

/**
 * The TLD of the running page: "ai" if the hostname ends in .f2-tech.ai,
 * "com" otherwise (including localhost, *.vercel.app previews, etc.).
 *
 * Cached at module load. Use this everywhere you'd otherwise inline a
 * `window.location.hostname.endsWith(".f2-tech.ai") ? "ai" : "com"`
 * ternary.
 */
export const TLD = detect();

/**
 * Build a fully-qualified F2 Tech URL on the running TLD.
 *
 * Example:
 *   svcUrl("f2-api")            -> "https://f2-api.f2-tech.ai"  (when running on .ai)
 *   svcUrl("hima-svc2", "/rest") -> "https://hima-svc2.f2-tech.ai/rest"
 *
 * Pass an explicit `tld` to override (rare — only for server-side use
 * or testing).
 */
export function svcUrl(subdomain, pathOrSuffix, tld) {
  const t = tld || TLD;
  const suffix = pathOrSuffix || "";
  return "https://" + subdomain + ".f2-tech." + t + suffix;
}

/**
 * Substitute the literal `{tld}` placeholder in a stored URL string
 * with the running TLD. Returns the input unchanged if no placeholder
 * is present (so legacy data with hardcoded `.f2-tech.com` passes
 * through untouched).
 */
export function expandTld(url) {
  if (typeof url !== "string") return url;
  return url.replace(/\{tld\}/g, TLD);
}

/**
 * Attach a Cognito idToken to a redirect URL using per-TLD delivery:
 *   .f2-tech.ai targets   -> URL fragment (#token=)
 *   anything else (.com,  -> query string (?token=)
 *   .netlify.app, etc.)
 *
 * .ai apps are born clean — fragment delivery means the token does not
 * appear in nginx access logs, Referer headers, or Google's URL index.
 * .com apps continue to use the legacy query-string contract until each
 * scanner's AuthContext is updated to read from window.location.hash.
 */
export function attachToken(urlString, idToken) {
  let url;
  try {
    url = new URL(urlString);
  } catch (_e) {
    return urlString;
  }
  if (url.hostname.toLowerCase().endsWith(".f2-tech.ai")) {
    url.hash = "token=" + encodeURIComponent(idToken);
  } else {
    url.searchParams.set("token", idToken);
  }
  return url.toString();
}
