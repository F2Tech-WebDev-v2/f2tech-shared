/**
 * The Cognito token bundle stashed in Redis at sid-mint time and returned
 * by `POST /rest/auth/redeem-session`. Shape is stable across every v2 SPA.
 */
export interface SsoTokenBundle {
  access_token: string;
  id_token: string;
  refresh_token: string;
  user: {
    email?: string;
    sub?: string;
    customer?: string;
    scanner?: string;
    scanners?: string;
    [k: string]: any;
  };
}

export type SidRedeemResult =
  | { bundle: SsoTokenBundle }
  | { error: true; status: number | null; body: any; message: string };

/**
 * Redeem an opaque sid for the Cognito token bundle that was stashed in
 * Redis at mint time. Framework-agnostic — uses native fetch; the caller
 * decides where to stash the returned bundle.
 *
 * Failure shape carries the actual HTTP status + parsed response body so
 * the caller's error toast can surface real diagnostics (per memory
 * feedback_error_toasts_have_copy_button) instead of a generic "Session
 * expired".
 *
 * @param sid The 43-char base64url opaque session id from the URL.
 * @param apiBase The f2-admin-service URL (e.g. env.f2ApiUrl). Trailing
 *   slash is optional; the library strips it.
 */
export function redeemSid(sid: string, apiBase: string): Promise<SidRedeemResult>;

/**
 * Extract the `sid` query value from a URL string. Returns "" when the
 * URL doesn't parse or the parameter is absent.
 */
export function extractSidFromUrl(url: string): string;
