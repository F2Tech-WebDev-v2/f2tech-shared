/**
 * Fleet-standard sign-out helper.
 *
 * Every F2 scanner SPA that embeds the shared AccountMenu needs the
 * same two-step on Sign Out click:
 *
 *   1. POST /rest/api/logout — f2-admin-service SessionController clears
 *      the branded-host httpOnly f2_access/f2_id/f2_refresh cookies.
 *      (Note: /rest/auth/logout 404s on f2-admin-service; the real path
 *      lives on SessionController @Controller("/api") + @Post("/logout").)
 *   2. Hard-nav to /?signout=1 — f2-members Edge Middleware + dashboard
 *      SPA honor the signout=1 flag to suppress ?next= population from
 *      the pre-logout URL / f2_scanner cookie / Referer, so the user
 *      lands on the brand's scanner picker instead of bouncing right
 *      back to the scanner they just signed out of.
 *
 * Mike IT-F2-406 cid d071d36e 2026-10-21: this process must be customer-
 * and SPA-agnostic across every members-page scanner usage. Previously
 * every SPA kept its own duplicate copy of the fetch + nav pair
 * (option-sniper-tape OptionSniperTape.jsx onSignOut; f2-gap-up-down
 * App.tsx :191; etc.) — hoisting here so one future change (new honor
 * flag, new logout URL, …) propagates on the next pin bump instead of
 * requiring a sweep across N SPAs.
 *
 * Consumers still own their per-SPA pre-logout cleanup (in-memory
 * bundle reset, localStorage auth-key removal, sessionStorage.clear(),
 * etc.) — those live in-SPA because the storage keys are SPA-specific.
 * Call this helper AFTER your local cleanup; it does the shared bits.
 *
 * Example (option-sniper-tape OptionSniperTape.jsx):
 *
 *   import { signOutAndRedirect } from 'f2tech-shared/sign-out';
 *   const onSignOut = () => {
 *     try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
 *     setTokenBundle(null);
 *     try { sessionStorage.clear(); } catch {}
 *     void signOutAndRedirect();
 *   };
 */

export interface SignOutAndRedirectOptions {
  /**
   * The branded-host logout POST endpoint. Default `/rest/api/logout`
   * (SessionController on f2-admin-service, proxied by f2-members Edge
   * Middleware to the branded host so cookies land same-origin).
   */
  logoutUrl?: string;
  /**
   * The post-logout landing URL on the branded host. Default
   * `/?signout=1`. The signout=1 flag is required for the dashboard
   * SPA / Edge Middleware ?next= suppression; override only if you
   * know your branded host serves a different landing surface.
   */
  landingUrl?: string;
}

export async function signOutAndRedirect(
  opts: SignOutAndRedirectOptions = {},
): Promise<void> {
  const {
    logoutUrl = '/rest/api/logout',
    landingUrl = '/?signout=1',
  } = opts;
  try {
    await fetch(logoutUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  } catch { /* best-effort — proceed to nav regardless of server-side result */ }
  if (typeof window !== 'undefined') {
    window.location.href = landingUrl;
  }
}
