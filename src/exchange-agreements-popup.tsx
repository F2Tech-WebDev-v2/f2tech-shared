import {
  useCallback, useEffect, useRef, useState, type ReactNode,
} from "react";

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
 *
 * IT-F2-223 (f2-session kickoff 2026-10-20 cid 1ad08df6) — close-abandon
 * UX: iframe posts {type:'f2-members:data-agreements:dirty-state', dirty}
 * on every change + on mount (clean initial signal). Parent (us) tracks
 * the latest flag and intercepts the X-close affordance. If dirty=false,
 * close silently. If dirty=true, show a 3-button confirm — Cancel (stay
 * open), Abandon (close + discard), Save (postMessage request-save →
 * wait for subsequent dirty-state=false → close). Protocol fully
 * documented in f2-members src/pages/DataAgreements.tsx + its PR #89 /
 * #90 / #91 commit messages. Customer-agnostic — same iframe code runs
 * for every branded customer.
 */

/** postMessage protocol envelope types. Kept as const strings so a typo
 *  on the parent side can't silently miss a real envelope. */
const MSG_DIRTY_STATE = "f2-members:data-agreements:dirty-state";
const MSG_REQUEST_SAVE = "f2-members:data-agreements:request-save";
const MSG_SAVE_COMPLETE = "f2-members:data-agreements:save-complete";

/** Internal pendingClose state. 'idle' = no close pending; 'confirm' =
 *  dirty-close triggered the confirm dialog; 'awaiting-save' = user
 *  picked Save on the confirm and we're waiting for the iframe to
 *  broadcast dirty-state=false before actually closing. */
type PendingClose = "idle" | "confirm" | "awaiting-save";

export interface ExchangeAgreementsPopupProps {
  /** When true the modal is mounted + visible. */
  visible: boolean;
  /**
   * Full URL for the iframe src (usually built by the hook: an absolute
   * `members.f2-tech.ai/<slug>/data-agreements?sid=&email=&first=&last=`).
   */
  url: string;
  /** Fired when the user clicks the scrim, the close button, or Esc.
   *  The hook wraps this with the dirty-state confirm flow — callers of
   *  the raw component without the hook get the pre-IT-F2-223 behavior
   *  (immediate close, no confirm). */
  onClose: () => void;
  /** Optional aria-label override on the outer dialog + header title. */
  ariaLabel?: string;
  /** Internal: set by the hook so the iframe ref is available for
   *  postMessage(request-save). Not part of the public API. */
  iframeRef?: React.RefObject<HTMLIFrameElement | null>;
}

export function ExchangeAgreementsPopup({
  visible, url, onClose, ariaLabel = "Exchange Agreements", iframeRef,
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
          <iframe ref={iframeRef ?? undefined} src={url} title={ariaLabel}
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

/** The 3-button confirm dialog that pops in front of the agreements
 *  modal when the user tries to close while dirty. Pure presentational
 *  component; the hook owns the state machine. */
interface AbandonConfirmProps {
  visible: boolean;
  onCancel: () => void;
  onAbandon: () => void;
  onSave: () => void;
  /** When true the Save button is in flight — disable all three to
   *  avoid double-dispatch. */
  saving: boolean;
}
function AbandonConfirm({ visible, onCancel, onAbandon, onSave, saving }: AbandonConfirmProps) {
  if (!visible) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Unsaved changes"
      style={{
        position: "fixed", inset: 0, zIndex: 10002,
        background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onCancel(); }}
    >
      <div style={{
        background: "#0e2238",
        color: "#e2e8f0",
        borderRadius: 8,
        boxShadow: "0 20px 60px rgba(0,0,0,.6)",
        width: "100%", maxWidth: 420,
        padding: 20,
        border: "1px solid #1e3c5a",
      }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 8px 0" }}>
          Unsaved changes
        </h3>
        <p style={{ fontSize: 13, color: "#cbd5e1", margin: "0 0 16px 0", lineHeight: 1.5 }}>
          You have unsaved changes on your Exchange Agreement. What would you like to do?
        </p>
        <div style={{
          display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap",
        }}>
          <button type="button" onClick={onCancel} disabled={saving}
            style={{
              background: "transparent", border: "1px solid #334155",
              color: "#cbd5e1", padding: "6px 12px", borderRadius: 4,
              fontSize: 13, cursor: saving ? "not-allowed" : "pointer",
              opacity: saving ? 0.55 : 1,
            }}
          >
            Cancel
          </button>
          <button type="button" onClick={onAbandon} disabled={saving}
            style={{
              background: "transparent", border: "1px solid #7f1d1d",
              color: "#fca5a5", padding: "6px 12px", borderRadius: 4,
              fontSize: 13, cursor: saving ? "not-allowed" : "pointer",
              opacity: saving ? 0.55 : 1,
            }}
          >
            Abandon changes
          </button>
          <button type="button" onClick={onSave} disabled={saving}
            style={{
              background: "#2563eb", border: "1px solid #1d4ed8",
              color: "#fff", padding: "6px 12px", borderRadius: 4,
              fontSize: 13, cursor: saving ? "wait" : "pointer",
              fontWeight: 600,
            }}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
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
  /** Programmatic close if you need it. Runs the dirty-check confirm
   *  the same way the X-button + scrim click + Esc do. */
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

  // Dirty-state tracker — flipped by the iframe's postMessage. Starts
  // false (iframe emits a clean signal on mount; mirror that default so
  // a close before the first message doesn't gate on stale truthy).
  const [isDirty, setIsDirty] = useState(false);
  const [pendingClose, setPendingClose] = useState<PendingClose>("idle");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Reset state whenever we re-open the modal. Prevents a prior session's
  // dirty flag or stale pendingClose from immediately gating the first
  // close of a fresh session.
  useEffect(() => {
    if (visible) {
      setIsDirty(false);
      setPendingClose("idle");
    }
  }, [visible]);

  // Listen for the iframe's dirty-state + save-complete envelopes. Does
  // not filter by origin: f2-members runs on the SAME branded host as
  // the parent SPA when useBrandedHost=true (default), and on the
  // configured membersOrigin otherwise. The envelope type prefix is
  // specific enough that a mismatched posting from another frame would
  // have had to use the exact "f2-members:data-agreements:" prefix.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || typeof data !== "object") return;
      const t = (data as { type?: unknown }).type;
      if (t === MSG_DIRTY_STATE) {
        const d = (data as { dirty?: unknown }).dirty;
        setIsDirty(!!d);
      } else if (t === MSG_SAVE_COMPLETE) {
        const ok = (data as { ok?: unknown }).ok === true;
        // Save finished. On success the iframe will ALSO broadcast
        // dirty-state=false which triggers the pending-close finisher
        // below; we only act on save-complete when ok=false (hard
        // failure like "form not mounted" — bail from awaiting-save
        // and drop back to the confirm so the user can decide again).
        if (!ok) {
          setPendingClose((p) => (p === "awaiting-save" ? "confirm" : p));
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // When Save was clicked on the confirm, we're waiting for the iframe
  // to flip isDirty back to false. The moment it does, finalize the
  // close. Separate effect so we don't re-fire if the user re-dirties.
  useEffect(() => {
    if (pendingClose === "awaiting-save" && !isDirty) {
      setVisible(false);
      setPendingClose("idle");
    }
  }, [pendingClose, isDirty]);

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

  // The gated close. Any X / scrim / Esc / programmatic .close() lands
  // here. If the iframe says it's dirty, pop the confirm instead of
  // actually closing; otherwise close straight away.
  const gatedClose = useCallback(() => {
    if (isDirty) {
      setPendingClose("confirm");
    } else {
      setVisible(false);
    }
  }, [isDirty]);

  const handleCancel = useCallback(() => setPendingClose("idle"), []);

  const handleAbandon = useCallback(() => {
    // Discard — close immediately. Reset local dirty tracker so the
    // next open doesn't inherit a stale truthy from this session.
    setIsDirty(false);
    setPendingClose("idle");
    setVisible(false);
  }, []);

  const handleSave = useCallback(() => {
    // Ask the iframe to save. The iframe runs its own validation + the
    // real POST + flips isDirty back to false on success — that flip
    // is what finalizes the close (see pendingClose effect above).
    // On hard failures (form not mounted / requestSubmit threw) the
    // iframe posts save-complete ok:false, which drops us back to
    // 'confirm'.
    setPendingClose("awaiting-save");
    const win = iframeRef.current?.contentWindow;
    if (win) {
      try { win.postMessage({ type: MSG_REQUEST_SAVE }, "*"); } catch {
        setPendingClose("confirm");
      }
    } else {
      setPendingClose("confirm");
    }
  }, []);

  const popupNode = (
    <>
      <ExchangeAgreementsPopup
        visible={visible}
        url={url}
        onClose={gatedClose}
        iframeRef={iframeRef}
      />
      <AbandonConfirm
        visible={visible && pendingClose !== "idle"}
        saving={pendingClose === "awaiting-save"}
        onCancel={handleCancel}
        onAbandon={handleAbandon}
        onSave={handleSave}
      />
    </>
  );

  return { openAgreements, popupNode, isOpen: visible, close: gatedClose };
}
