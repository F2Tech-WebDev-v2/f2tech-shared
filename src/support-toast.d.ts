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
export function errorWithSupportId(
  toastr: ToastrLike,
  title: string,
  message: string | undefined,
  diagnostics: ErrorDiagnostics | undefined,
  apiBase: string,
): void;

export function copyToClipboard(text: string): void;
