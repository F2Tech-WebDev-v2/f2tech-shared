import type { ErrorDiagnostics } from './error-reports.js';

export interface ToastrLike {
  error(message: string | undefined, title: string, options?: any): { toastId: any; onTap?: { subscribe(cb: () => void): void } };
  remove(toastId: any): void;
}

/**
 * Reuses ErrorDiagnostics from ./error-reports so consumers don't have
 * to satisfy two separate narrower contracts. error_code is OPTIONAL
 * here (matching error-reports) — the helper short-circuits to a plain
 * toast when diagnostics is undefined.
 */
export interface ErrorWithSupportIdOptions {
  /**
   * Signed-in user's id_token. When provided, sent as `Authorization: Bearer`
   * so the backend can opportunistically decode the JWT claims (email, role,
   * customers, iss/iat/exp) into the ER. Backend does NOT verify the signature
   * — purely diagnostic surface. Safe to pass an expired or wrong-pool token;
   * those are exactly the cases where we want identity stamped.
   */
  authToken?: string;
}

export function errorWithSupportId(
  toastr: ToastrLike,
  title: string,
  message: string | undefined,
  diagnostics: ErrorDiagnostics | undefined,
  apiBase: string,
  opts?: ErrorWithSupportIdOptions,
): void;

export function copyToClipboard(text: string): void;
