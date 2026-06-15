/**
 * Build the customer-scoped exchange-agreements iframe URL. Always
 * targets admin.f2-tech.ai (hardcoded — F2 owns the agreements UI;
 * customer-owned hosts have no .com counterpart). Token in URL
 * fragment so it doesn't leak into Referer / access logs.
 *
 * @param customerSlug F2-ADMIN.Customers._id value (e.g. "delphi-sig").
 * @param idToken Cognito idToken; encodeURIComponent'd into the fragment.
 * @returns The fully-qualified iframe URL.
 */
export function exchAgreementsUrl(customerSlug: string, idToken: string): string;

export interface AgreementsConfig {
  enforced: boolean;
  required: boolean;
}

/**
 * Per-customer agreements gating, sourced from
 * F2-ADMIN.Customers.exchange_agreements via /rest/api/brand-config.
 * Fail-safe default {enforced:true, required:true} on network/parse error.
 * Cached in-module per host for 60 seconds.
 *
 * @param host Hostname to look up. Defaults to window.location.host.
 */
export function agreementsConfig(host?: string): Promise<AgreementsConfig>;

export type DataTierMode = 'delayed' | 'realtime' | 'disabled';

/**
 * Read the company-wide data-tier override mode from /rest/api/brand-config.
 * Returns null when no override is active (per-customer settings apply).
 * Consumer SPAs use this to render a banner / state indicator.
 * Cached in-module per host for 60 seconds (shared cache with agreementsConfig).
 *
 * @param host Hostname to look up. Defaults to window.location.host.
 */
export function dataTierOverride(host?: string): Promise<DataTierMode | null>;
