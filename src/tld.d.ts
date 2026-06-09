/**
 * The TLD of the running page: "ai" if the hostname ends in .f2-tech.ai,
 * "com" otherwise. Cached at module load (window.location.hostname is
 * fixed for the page lifetime).
 */
export declare const TLD: "com" | "ai";

/**
 * Build a fully-qualified F2 Tech URL on the running TLD.
 *
 *   svcUrl("f2-api")              // https://f2-api.f2-tech.<TLD>
 *   svcUrl("hima-svc2", "/rest")  // https://hima-svc2.f2-tech.<TLD>/rest
 *
 * Pass an explicit `tld` to override (rare).
 */
export declare function svcUrl(
  subdomain: string,
  pathOrSuffix?: string,
  tld?: "com" | "ai"
): string;

/**
 * Substitute the literal `{tld}` placeholder in a stored URL string
 * with the running TLD. Returns the input unchanged if no placeholder
 * is present (so legacy data with hardcoded `.f2-tech.com` passes
 * through untouched).
 */
export declare function expandTld(url: string): string;

