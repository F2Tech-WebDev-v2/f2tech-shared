import { useCallback, useState, type ReactNode } from "react";

/**
 * Exchange Agreements popup — canonical in-SPA modal for opening the
 * per-customer Exchange Agreements form. Iframe-based so the branded
 * URL bar stays on the scanner host end-to-end; the iframe navigates,
 * not the outer window.
 *
 * Two exports:
 *
 *   <ExchangeAgreementsPopup visible url onClose /> — the dumb modal.
 *   useExchangeAgreementsPopup({ customerSlug, identity, guardedFetch })
 *     — full state + openAgreements() + the popup node bundled together.
 *
 * The hook is the recommended entry point — pass the returned
 * `openAgreements` to your TopMenu's `onAgreementsClick`, your
 * DataTierChip's `onAgreementsClick`, and the ExchangeAgreementsBanner's
 * click-interceptor wrapper. Render the returned `popupNode` once
 * anywhere in your tree (typically near the root). See
 * f2tech-shared/docs/LIVE_DATA_SCANNER_RECIPE.md §12 for the full
 * pattern.
 *
 * Replaces the pre-2026-09 simple prompt version (which just opened
 * an external link in a new tab). No consumers imported the old React
 * version — Core4 built its own inline iframe modal, and that's the
 * pattern promoted to shared here.
 */

export interface ExchangeAgreementsPopupProps {
  /** When true the modal is mounted + visible. */
  visible: boolean;
  /**
   * Full URL for the iframe src (usually built by the hook: an absolute
   * `members.f2-tech.ai/<slug>/data-agreements?sid=&email=&first=&last=`).
   */
  url: string;
  /** Fired when the user clicks the scrim, the close button, or Esc. */
  onClose: () => void;
  /** Optional aria-label override on the outer dialog + header title. */
  ariaLabel?: string;
}

export function ExchangeAgreementsPopup({
  visible, url, onClose, ariaLabel = "Exchange Agreements",
}: ExchangeAgreementsPopupProps) {
  if (!visible) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      style={{
        position: "fixed", inset: 0, zIndex: 10001,
        background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "#0b1830",
        color: "#e2e8f0",
        borderRadius: 8,
        boxShadow: "0 30px 80px rgba(0,0,0,.6)",
        width: "100%", maxWidth: 1100, height: "85vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 16px", borderBottom: "1px solid #1e3c5a",
          background: "#0e2238",
        }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{ariaLabel}</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{
              background: "transparent", border: 0, color: "#cbd5e1",
              cursor: "pointer", fontSize: 13, padding: "4px 12px", borderRadius: 4,
            }}
          >
            Close
          </button>
        </div>
        {url ? (
          <iframe src={url} title={ariaLabel}
            style={{ flex: 1, width: "100%", border: 0 }}
          />
        ) : (
          <div style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
            padding: 24, textAlign: "center", color: "#98a2b0", fontSize: 13,
          }}>
            Preparing Exchange Agreements form…
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Optional identity fields for pre-filling the "who are you?" step
 * of the members Exchange Agreements form. Pass what your scanner
 * already knows from /rest/api/me — the members iframe cannot re-fetch
 * this itself when loaded in a 3rd-party iframe context (Firefox
 * strict tracking protection, Safari ITP, etc).
 */
export interface AgreementsIdentity {
  email?: string | null;
  first?: string | null;
  last?: string | null;
}

export interface UseExchangeAgreementsPopupOptions {
  /**
   * Customer slug for the URL. Only used when `useBrandedHost` is
   * false (i.e. loading the popup against `members.f2-tech.ai/<slug>/…`
   * directly). On a branded host (default), the slug isn't needed in
   * the URL — the branded host itself identifies the customer via
   * f2-members middleware.
   */
  customerSlug: string;
  /** Identity pre-fill. Optional; the popup opens without it too. */
  identity?: AgreementsIdentity;
  /**
   * The scanner's authenticated fetch wrapper (typically imported
   * from your local httpClient). Used to /rest/auth/mint-sid-from-cookies
   * with refresh-retry so a stale scanner id_token gets re-minted
   * before the sid mint runs. Fall back to global `fetch` if you don't
   * have one — the popup degrades to identity-only URL on mint failure
   * either way.
   */
  guardedFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * When true (default), the iframe src is a same-origin relative URL
   * (`/data-agreements?…`) so it loads under the SPA's branded host.
   * f2-members Edge Middleware routes that path to the customer-
   * branded DataAgreements page, keeping cookies same-origin and the
   * URL bar on the branded scanner host end-to-end.
   *
   * When false, the iframe src is the absolute members URL
   * (`https://members.f2-tech.ai/<slug>/data-agreements?…`). Use only
   * for SPAs NOT hosted behind f2-members' branded routing.
   */
  useBrandedHost?: boolean;
  /**
   * Override the members host (only consulted when `useBrandedHost`
   * is false). Default `https://members.f2-tech.ai`.
   */
  membersOrigin?: string;
}

export interface UseExchangeAgreementsPopupResult {
  /** Call from onAgreementsClick handlers (menu, coin, chip, banner). */
  openAgreements: () => Promise<void>;
  /** Mount this once anywhere in your tree (typically near the root). */
  popupNode: ReactNode;
  /** True when the popup is currently visible. */
  isOpen: boolean;
  /** Programmatic close if you need it. */
  close: () => void;
}

/**
 * Bundles all popup state, mint-sid flow, URL construction, and modal
 * mount into one call. Recommended entry point for adopters.
 *
 * Example:
 *
 *   const { openAgreements, popupNode } = useExchangeAgreementsPopup({
 *     customerSlug: AGREEMENT_CUSTOMER,
 *     identity: { email: meEmail, first: meFirst, last: meLast },
 *     guardedFetch,
 *   });
 *
 *   return (
 *     <>
 *       {popupNode}
 *       <TopMenu   onAgreementsClick={openAgreements} ... />
 *       <DataTierChip onAgreementsClick={openAgreements} ... />
 *       <div onClickCapture={(e) => {
 *         const el = e.target as HTMLElement;
 *         if (el && el.closest("a")) {
 *           e.preventDefault(); e.stopPropagation();
 *           openAgreements();
 *         }
 *       }}>
 *         <ExchangeAgreementsBanner ... />
 *       </div>
 *     </>
 *   );
 */
export function useExchangeAgreementsPopup(
  opts: UseExchangeAgreementsPopupOptions,
): UseExchangeAgreementsPopupResult {
  const {
    customerSlug,
    identity,
    guardedFetch,
    useBrandedHost = true,
    membersOrigin = "https://members.f2-tech.ai",
  } = opts;

  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState("");

  const buildParams = useCallback((sid?: string) => {
    const p = new URLSearchParams();
    if (sid) p.set("sid", sid);
    if (identity?.email) p.set("email", identity.email);
    if (identity?.first) p.set("first", identity.first);
    if (identity?.last)  p.set("last", identity.last);
    const qs = p.toString();
    return qs ? `?${qs}` : "";
  }, [identity?.email, identity?.first, identity?.last]);

  const openAgreements = useCallback(async () => {
    // Branded-host default: iframe src is a same-origin relative URL.
    // The SPA's branded host is served by f2-members Edge Middleware,
    // which renders the customer-branded DataAgreements page at
    // /data-agreements on the same host. Cookies flow same-origin and
    // the URL bar stays on the branded scanner host throughout.
    // Non-branded fallback: absolute members URL with slug in path.
    const bare = useBrandedHost
      ? "/data-agreements"
      : `${membersOrigin}/${customerSlug}/data-agreements`;
    const doFetch = guardedFetch ?? ((u: string, init?: RequestInit) => fetch(u, init));
    try {
      // Mint a session id from the scanner's cookies. guardedFetch
      // refreshes a stale scanner id_token before this runs; without
      // that refresh, an hour-old scanner session 401s here, we fall
      // through to bare URL, members has nothing to redeem, and any
      // authed action inside the iframe 401s downstream (Mike HAR
      // 2026-09-15 c/245e0bc1).
      const r = await doFetch("/rest/auth/mint-sid-from-cookies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (r.ok) {
        const body = await r.json();
        if (body?.sid) {
          setUrl(`${bare}${buildParams(body.sid as string)}`);
          setVisible(true);
          return;
        }
      }
    } catch { /* fall through to identity-only URL */ }
    setUrl(`${bare}${buildParams()}`);
    setVisible(true);
  }, [customerSlug, membersOrigin, useBrandedHost, guardedFetch, buildParams]);

  const close = useCallback(() => setVisible(false), []);

  const popupNode = (
    <ExchangeAgreementsPopup visible={visible} url={url} onClose={close} />
  );

  return { openAgreements, popupNode, isOpen: visible, close };
}
