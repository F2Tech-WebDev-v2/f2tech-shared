/**
 * IT-F2-391 c/0312c1a7 (Mike, T3 rollout) — fleet-standard displaced-tab
 * banner for the LIVE_SESSIONS single-window enforcement. Rendered above
 * the app when THIS session's live-data slot has been taken by another
 * browser/tab (backend responded 401 + X-F2-Reject-Reason: displaced on
 * the sanitize probe, or set data_tier=delayed_displaced).
 *
 * Fleet contract:
 *   The consumer SPA detects the displaced state (from the sanitize probe
 *   response OR from a socket.io session_displaced event) and toggles
 *   `visible=true`. On click, the banner runs `onReclaim` — canonical
 *   implementation clears sessionStorage.f2_session_id and reloads, so
 *   the fresh mount generates a new id and re-issues X-F2-Claim-Slot:
 *   reclaim, winning the slot back.
 *
 * COPY:
 *   Per Mike's spec: "another session has taken your realtime data — not
 *   start asking them to fill out paperwork all over again that they
 *   already have filled out and has been approved". This banner is
 *   distinct from ExchangeAgreementsBanner (which routes on missing /
 *   pending / declined agreement state). Consumer should suppress the
 *   ExchangeAgreementsBanner when displaced=true — displacement is not
 *   an agreement-completion issue.
 *
 * STYLING:
 *   Orange (#c2410c ↔ #9a3412) pulse at 1.6s, matching FinderView's
 *   fn-delayed.displaced chip color palette so the banner visually
 *   binds to the chip.
 *
 * Kept inline-styles + a scoped keyframe so consumer SPAs that
 * don't use Tailwind (Angular apps) render identically.
 */

export interface SessionDisplacedBannerProps {
  /** Show the banner. Consumer sets true when the SPA detects
   *  data_tier=delayed_displaced OR receives a session_displaced WS event. */
  visible: boolean;
  /** Handler for the click-to-reclaim action. Canonical implementation:
   *  clear sessionStorage.f2_session_id then window.location.reload(). */
  onReclaim: () => void;
  /** Optional override for the "ANOTHER SESSION IS LIVE" strong label. */
  label?: string;
  /** Optional override for the plain-text explanation. */
  message?: string;
}

const DEFAULT_LABEL = 'ANOTHER SESSION IS LIVE';
const DEFAULT_MESSAGE = 'Your realtime data seat was taken by another window/browser. Click here to reload and reclaim it.';

// Unique keyframe name so multiple copies of this component on the page
// (unlikely but possible) don't collide. Also avoids clashing with a
// consumer's own `@keyframes pulse`.
const KEYFRAME_NAME = 'f2-session-displaced-pulse';

export function SessionDisplacedBanner({
  visible, onReclaim, label = DEFAULT_LABEL, message = DEFAULT_MESSAGE,
}: SessionDisplacedBannerProps) {
  if (!visible) return null;
  return (
    <>
      <style>{`
        @keyframes ${KEYFRAME_NAME} {
          0%, 100% { background:#c2410c; }
          50%      { background:#9a3412; }
        }
      `}</style>
      <div
        role="alert"
        aria-live="polite"
        onClick={onReclaim}
        style={{
          width: '100%',
          padding: '10px 16px',
          textAlign: 'center',
          color: '#fff',
          fontSize: 14,
          lineHeight: 1.4,
          fontWeight: 500,
          boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
          animation: `${KEYFRAME_NAME} 1.6s ease-in-out infinite`,
          cursor: 'pointer',
        }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onReclaim(); }}
        tabIndex={0}
      >
        <strong style={{ fontWeight: 700, letterSpacing: '.02em' }}>{label}</strong>
        <span style={{ marginLeft: 8 }}>· {message}</span>
      </div>
    </>
  );
}
