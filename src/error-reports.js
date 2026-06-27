// Short-ID error reporting — the user-facing half of the system whose
// backend lives in f2-admin-service ErrorReportsService.
//
// The new pattern (replacing the verbose tap-to-copy diagnostics bundle):
//   1. Consumer SPA hits an error; collects diagnostics into an object
//   2. Calls reportError(diagnostics, apiBase) which POSTs to
//      /rest/api/error-report and returns { id: 'ER-7M4QPK3' }
//   3. SPA's toast shows a friendly message + a copy button bound to
//      the short ID
//   4. User pastes the ID to support; support looks it up via
//      f2-admin at /admin/error-reports/<id>
//
// Records auto-evict after 24h on the backend so the system is
// self-bounded; this helper has no client-side state.
//
// Why a separate module from sid-handoff: any failure surface across
// the SPA family uses this (login network errors, validate_token failures,
// scanner data load failures, ...). It's not handoff-specific.

/**
 * Submit an error report and receive the short ID to display in the toast.
 *
 * @param {object} diagnostics - Free-form object with the context support
 *   needs to debug. Standard fields the admin viewer surfaces directly:
 *   `error_code`, `customer`, `scanner_path`, `url`, `user_agent`,
 *   `http_status`, `f2_response_body`, `f2_response_message`. Anything
 *   else goes into the `extra` map. The backend caps each string and
 *   evicts the record after 24h.
 * @param {string} apiBase - The f2-admin-service URL (e.g. env.f2ApiUrl).
 * @returns {Promise<{ id: string } | { error: true, status: number | null, body: any, message: string }>}
 *   On success: `{ id: 'ER-XXXXXXX' }`. On any failure: a structured error
 *   shape so the SPA can degrade gracefully (e.g. show a local-only toast
 *   with the diagnostics inline when the report endpoint is unreachable).
 */
/**
 * Submit an error diagnostic bundle to f2-admin-service2's public
 * error-report endpoint. Returns { id: 'ER-XXXXXXX' } on success.
 *
 * @param {Object} diagnostics - the error payload shape (error_code,
 *                               customer, scanner_path, http_status,
 *                               f2_response_body, etc.).
 * @param {string} apiBase     - backend base URL (e.g. env.f2ApiUrl).
 * @param {Object} [opts]      - optional config.
 * @param {string} [opts.authToken] - signed-in user's id_token. When
 *   provided, sent as `Authorization: Bearer <token>` so the backend can
 *   opportunistically decode the JWT claims (email, custom:role,
 *   custom:customers, iss, iat, exp, etc.) and stamp them into the ER
 *   without the caller having to populate user_email/role itself. Safe
 *   for the public submit endpoint — the backend does NOT verify the
 *   signature, it just reads claims for diagnostic surface. The wrong-
 *   pool/expired-token cases (exactly when we want identity visible)
 *   still produce enrichment because we don't reject based on claim
 *   validity. Mike 2026-06-27 (ER-HKE8RBM).
 */
export async function reportError(diagnostics, apiBase, opts) {
  if (!apiBase || typeof apiBase !== 'string') {
    return { error: true, status: null, body: null, message: 'reportError: missing apiBase' };
  }
  const base = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
  // Auto-inject the standard environment fields if the caller didn't.
  const payload = { ...(diagnostics || {}) };
  if (typeof window !== 'undefined') {
    if (!payload.url) payload.url = window.location.href;
    if (!payload.user_agent && window.navigator) payload.user_agent = window.navigator.userAgent || undefined;
  }
  const headers = { 'Content-Type': 'application/json' };
  const authToken = opts && opts.authToken;
  if (authToken && typeof authToken === 'string') {
    headers['Authorization'] = 'Bearer ' + authToken;
  }
  let res;
  try {
    res = await fetch(base + '/rest/api/error-report', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return {
      error: true,
      status: null,
      body: null,
      message: 'network error: ' + (e && e.message ? e.message : 'fetch threw'),
    };
  }
  let body = null;
  try { body = await res.json(); } catch { /* leave null */ }
  if (!res.ok) {
    return {
      error: true,
      status: res.status,
      body,
      message: (body && body.message) || ('error-report HTTP ' + res.status),
    };
  }
  if (!body || typeof body.id !== 'string') {
    return {
      error: true,
      status: res.status,
      body,
      message: 'error-report returned no id',
    };
  }
  return { id: body.id };
}
