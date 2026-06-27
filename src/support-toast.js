// Shared toast-with-support-id wiring for every consumer SPA.
//
// Each SPA's local ToastService becomes a 5-line shim that delegates
// .error(title, message, diagnostics) to this helper. Centralizing it
// here means the placeholder→reportError→swap→onTap-copy flow lives in
// ONE place — drift between SPAs (different timeouts, different copy
// text, missing onTap, missing fallback) is no longer possible.
//
// The helper is framework-agnostic: it duck-types ngx-toastr's surface
// (error(msg, title, opts) returning {toastId, onTap}; remove(id)) so
// every Angular SPA using ngx-toastr works without changes. Any other
// toast lib that conforms to that shape works too.
//
// IP capture: server-side. f2-admin's POST /rest/api/error-report
// reads koa-ctx.ip (app.proxy=true) and X-Forwarded-For when the report
// lands; no client-side IP probing is wired in (clients can't see their
// public IP reliably and could spoof). See
// f2-admin-service/src/controllers/rest/ErrorReportsController.ts.

import { reportError } from './error-reports.js';

/**
 * Show a user-facing error toast and (if diagnostics provided) mint a
 * short Support ID via /rest/api/error-report, then swap the toast to
 * carry the ID + tap-to-copy affordance.
 *
 * @param {object} toastr  ngx-toastr-like instance.
 *   Must implement:
 *     .error(message: string, title: string, options?: object): { toastId, onTap? }
 *     .remove(toastId): void
 *   `onTap` (when present) is duck-typed as { subscribe(cb): void } — the
 *   shape ngx-toastr's ActiveToast exposes via rxjs Subject.
 * @param {string} title       Bold title line on the toast.
 * @param {string} [message]   Detail message under the title.
 * @param {object} [diagnostics] When provided, mints a Support ID.
 *   Should carry `error_code` + any backend response context the admin
 *   viewer will display. `url`, `user_agent` are auto-injected by
 *   reportError; `user_ip`, `x_forwarded_for`, `remote_addr` are
 *   captured server-side from the request.
 * @param {string} apiBase    f2-admin-service host (no trailing /rest);
 *   /rest/api/error-report is appended internally.
 * @param {object} [opts]     optional config forwarded to reportError.
 * @param {string} [opts.authToken] signed-in user's id_token. When provided,
 *   the backend opportunistically decodes claims (email, role, customers,
 *   iss, iat, exp) and stamps them into the ER so support sees who hit the
 *   error without each SPA having to populate user_email itself. Backend
 *   does NOT verify the signature — purely a diagnostic surface.
 */
export function errorWithSupportId(toastr, title, message, diagnostics, apiBase, opts) {
  if (!diagnostics) {
    toastr.error(message, title);
    return;
  }
  // Placeholder toast so the user gets immediate feedback. We swap it
  // for the ID-bearing toast once reportError resolves.
  const placeholderRef = toastr.error(
    (message || '') + (message ? '\n' : '') + 'Reporting issue…',
    title,
    {
      timeOut: 25000,
      extendedTimeOut: 5000,
      tapToDismiss: false,
      closeButton: true,
    },
  );
  reportError(diagnostics, apiBase, opts).then((res) => {
    try { toastr.remove(placeholderRef?.toastId); } catch { /* swallow */ }
    if (res && typeof res.id === 'string') {
      const idMsg = (message ? message + '\n' : '') +
        `Support ID: ${res.id} (click toast to copy)`;
      const ref = toastr.error(idMsg, title, {
        timeOut: 30000,
        extendedTimeOut: 10000,
        tapToDismiss: false,
        closeButton: true,
      });
      if (ref?.onTap?.subscribe) {
        ref.onTap.subscribe(() => copyToClipboard(res.id));
      }
    } else {
      // Backend unreachable — show the message alone so the user still
      // gets feedback. console.warn is the only paper trail.
      console.warn('errorWithSupportId: reportError failed:', res && res.message, diagnostics);
      toastr.error(message || 'An error occurred. Please retry or refresh.', title, {
        timeOut: 10000,
        closeButton: true,
      });
    }
  }).catch((e) => {
    try { toastr.remove(placeholderRef?.toastId); } catch { /* swallow */ }
    console.warn('errorWithSupportId: reportError threw:', e, diagnostics);
    toastr.error(message || 'An error occurred. Please retry or refresh.', title, {
      timeOut: 10000,
      closeButton: true,
    });
  });
}

/**
 * Best-effort clipboard write. Falls back to a hidden textarea +
 * execCommand for environments where navigator.clipboard is missing or
 * blocked (older Safari, sandboxed iframes).
 *
 * Exported for the React/inline-block error-display surfaces that don't
 * go through a toast library — keeps the copy behavior identical
 * across every SPA.
 *
 * @param {string} text
 */
export function copyToClipboard(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  try {
    if (typeof document === 'undefined') return;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-10000px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {
    /* clipboard unavailable — nothing more to do */
  }
}
