// Opaque-SID handoff helper — single source of truth for the
// `?sid=<43char>` → Cognito bundle exchange that every v2 consumer SPA
// performs on landing. Replaces the per-SPA copies of `_redeem_sid` that
// drifted across theo-trade, MTA, simpler-trading, hima, etc.
//
// The library is framework-agnostic: it uses native `fetch`, doesn't touch
// the URL bar or DOM, and returns a structured result. The CALLER decides
// how to stash the returned bundle (in-memory variable / Angular service /
// React context / etc.) and how to handle the navigation strip.
//
// Standard adoption pattern (Angular):
//
//   import { redeemSid } from 'f2tech-shared/sid-handoff';
//
//   private async _redeem_sid(sid: string): Promise<boolean> {
//     const result = await redeemSid(sid, env.f2ApiUrl);
//     if ('error' in result) {
//       this.toast.error('Session expired', result.message, {
//         error_code: 'AS_AUTH_SID_REDEEM_FAIL_E01',
//         http_status: result.status,
//         f2_response_body: JSON.stringify(result.body).slice(0, 300),
//       });
//       return false;
//     }
//     this._set_tokens(result.bundle);
//     return true;
//   }
//
// Standard adoption pattern (React):
//
//   const { redeemSid } = await import('f2tech-shared/sid-handoff');
//   const r = await redeemSid(sid, FILES.f2ApiUrl);
//   if ('bundle' in r) authCtx.setBundle(r.bundle);
//   else setErrorToast(/* render with r.status + r.body + r.message */);
//
// The endpoint contract (POST /rest/auth/redeem-session, body {sid}) is
// stable — owned by f2-admin-service. The library trusts that contract;
// it does NOT validate the bundle's individual JWTs (caller's job if it
// cares).

/**
 * Redeem an opaque sid for the Cognito token bundle stashed in Redis at
 * mint time.
 *
 * @param {string} sid - The 43-char base64url opaque session id from the URL.
 * @param {string} apiBase - The f2 admin service URL. Typically
 *   `env.f2ApiUrl` ('https://f2-admin-service2.f2-tech.ai' in production).
 *   The trailing slash is optional; the library strips it.
 * @returns {Promise<
 *   | { bundle: { access_token: string, id_token: string, refresh_token: string, user: any } }
 *   | { error: true, status: number | null, body: any, message: string }
 * >}
 *   On success: `{ bundle: <Cognito bundle> }`.
 *   On any failure (network, non-2xx, malformed body): a structured error
 *   shape with the HTTP status, the parsed response body (or null when
 *   unparseable), and a human-readable message. Callers wrap this in a
 *   diagnostic toast per the feedback_error_toasts_have_copy_button pattern.
 */
export async function redeemSid(sid, apiBase) {
  if (!sid || typeof sid !== "string") {
    return { error: true, status: null, body: null, message: "redeemSid: missing or non-string sid" };
  }
  if (!apiBase || typeof apiBase !== "string") {
    return { error: true, status: null, body: null, message: "redeemSid: missing apiBase" };
  }
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  let res;
  try {
    res = await fetch(base + "/rest/auth/redeem-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid }),
    });
  } catch (e) {
    return {
      error: true,
      status: null,
      body: null,
      message: "network error: " + (e && e.message ? e.message : "fetch threw"),
    };
  }
  let body = null;
  try { body = await res.json(); } catch { /* leave null */ }
  if (!res.ok) {
    return {
      error: true,
      status: res.status,
      body,
      message: (body && body.message) || ("redeem-session HTTP " + res.status),
    };
  }
  if (!body || typeof body !== "object" || !body.access_token || !body.id_token) {
    return {
      error: true,
      status: res.status,
      body,
      message: "redeem-session returned an incomplete bundle (no access_token/id_token)",
    };
  }
  return {
    bundle: {
      access_token: body.access_token,
      id_token: body.id_token,
      refresh_token: body.refresh_token || "",
      user: body.user || {},
      // Per-session origin metadata (added 2026-06-30, f2-admin-service
      // 05df315). Sticky on the bundle so SPAs can persist them and
      // bounce SSO-only customers (e.g. theo-trade) to their portal on
      // logout / session expiry. Absent on legacy mints predating the
      // backend change — SPAs treat undefined as "use /login".
      sso_origin: body.sso_origin === true,
      external_login_url: body.external_login_url ?? null,
    },
  };
}

/**
 * Extract the `sid` query value from a URL string. Tiny helper so consumer
 * SPAs don't each reimplement it. Returns "" when the URL doesn't parse or
 * the parameter is absent.
 *
 * @param {string} url
 * @returns {string}
 */
export function extractSidFromUrl(url) {
  if (!url || typeof url !== "string") return "";
  try {
    const u = new URL(url);
    return u.searchParams.get("sid") || "";
  } catch {
    const m = url.match(/[?&]sid=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }
}
