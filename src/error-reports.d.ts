/**
 * Diagnostics object shape — caller passes a flat key/value record. The
 * backend models a few well-known keys directly; everything else lands in
 * the `extra` map server-side. All string fields are server-capped.
 */
export interface ErrorDiagnostics {
  /** Hidden support-triage identifier; format <APP>_<SUBSYSTEM>_<FAILURE>_E<NN>. Greppable. */
  error_code?: string;
  customer?: string;
  scanner_path?: string;
  /** Auto-injected from window.location.href when omitted. */
  url?: string;
  /** Auto-injected from navigator.userAgent when omitted. */
  user_agent?: string;
  http_status?: number | null;
  f2_response_body?: string;
  f2_response_message?: string;
  [k: string]: string | number | boolean | undefined | null;
}

export type ErrorReportResult =
  | { id: string }
  | { error: true; status: number | null; body: any; message: string };

export interface ReportErrorOptions {
  /**
   * Signed-in user's id_token. When provided, sent as `Authorization: Bearer`
   * so the backend opportunistically decodes claims into the ER. Backend does
   * NOT verify the signature — safe to pass expired/wrong-pool tokens; those
   * are exactly the cases where we want identity stamped.
   */
  authToken?: string;
}

/**
 * Submit an error report to the F2 admin backend. Returns the short ID
 * (`ER-XXXXXXX`) that the SPA surfaces via the toast's copy button.
 * Returns a structured error shape on any failure so the SPA can show
 * a graceful local toast (no inline diagnostics dump on the user).
 */
export function reportError(
  diagnostics: ErrorDiagnostics,
  apiBase: string,
  opts?: ReportErrorOptions,
): Promise<ErrorReportResult>;
