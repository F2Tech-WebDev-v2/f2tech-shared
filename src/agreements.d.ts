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

/**
 * Per-customer data-tier override mode (set by F2 admin on the customer's
 * own Customer doc). Middle-priority layer.
 *
 * @param host Hostname to look up. Defaults to window.location.host.
 */
export function customerDataTier(host?: string): Promise<DataTierMode | null>;

export type DataTierSource = 'company' | 'customer' | 'user';

export interface ResolvedDataTier {
  /** Effective data tier the user gets (use for feed routing). */
  tier: DataTierMode;
  /** Which layer decided the tier. */
  source: DataTierSource;
  /**
   * Mode to render in the override banner, or null when no banner
   * should show. Null when source==='user', and null when tier==='realtime'
   * + source!=='user' + !isAdmin (don't advertise realtime override to
   * non-admin users). Otherwise same as `tier`.
   */
  bannerMode: DataTierMode | null;
}

/**
 * Single entry-point for SPAs to determine the user's effective data tier.
 * Applies the 3-layer rule (company > customer > user). Library is
 * auth-free; caller passes userLiveAccess + isAdmin from its own auth state.
 *
 * Standard SPA banner pattern: bind `*ngIf="r.bannerMode"` and let the
 * library decide whether to surface the banner. Realtime overrides are
 * admin-only by default (the realtime mode is an admin-side toggle and
 * shouldn't be advertised to customers who may be on delayed entitlements).
 */
export function resolveDataTier(opts: { userLiveAccess?: boolean; isAdmin?: boolean; isClient?: boolean; host?: string }): Promise<ResolvedDataTier>;
