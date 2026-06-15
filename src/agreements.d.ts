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
