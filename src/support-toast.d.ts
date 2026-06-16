export interface ToastrLike {
  error(message: string | undefined, title: string, options?: any): { toastId: any; onTap?: { subscribe(cb: () => void): void } };
  remove(toastId: any): void;
}

export interface ToastDiagnostics {
  error_code: string;
  customer?: string;
  scanner_path?: string;
  url?: string;
  user_agent?: string;
  http_status?: number | null;
  f2_response_body?: string;
  f2_response_message?: string;
  [k: string]: any;
}

export function errorWithSupportId(
  toastr: ToastrLike,
  title: string,
  message: string | undefined,
  diagnostics: ToastDiagnostics | undefined,
  apiBase: string,
): void;

export function copyToClipboard(text: string): void;
