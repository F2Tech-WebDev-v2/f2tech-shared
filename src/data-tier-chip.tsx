// Fleet DataTierChip — extracted from alpha-pivot-frontend (Core4) per
// IT-F2-413 fleet rollout. Renders the 7-state Live / Displaced / Pro-gate
// / Delayed-Under-Review / Delayed-Declined / Delayed-Default / Denied
// chip variants from the server-derived `data_tier` enum (+ `review_status`)
// so every customer-branded SPA (T3 Alpha Signal, Oxford Club Trend Labs,
// MTA, Trading Signals UX, Option Pit, Option Sniper UI, etc.) shows the
// identical Mike-approved copy + palette.
//
// The chip does NOT derive its state — the state comes from
// `GET /rest/user/data-agreements?sanitize=1` which f2-admin-service
// derives in `data-agreements.service.ts:get_user_data_agreements`
// (precedence: denied > delayed_pro_gate > delayed_by_agreement >
// delayed_displaced > realtime). The SPA passes the returned fields
// through as props.
//
// Load-order contract (Mike IT-F2-391 c/6e4a9ab8): render null until
// `dataTier` arrives. No flash of "Live Data" while the sanitize probe
// is in flight.
//
// This component intentionally has NO legacy fallback branch — the
// original alpha-pivot-frontend copy carried a pre-PR-#124 fallback that
// branched on `displaced`/`isDelayed`/`isPro` when `dataTier` was null.
// Every current SPA hits the PR #124+ backend so that fallback was dead
// code; it's dropped in the shared version.

export type DataTier =
  | 'realtime'
  | 'delayed_by_agreement'
  | 'delayed_pro_gate'
  | 'delayed_displaced'
  | 'denied'
  | null;

export type ReviewStatus = 'pending' | 'approved' | 'declined' | null;

/**
 * Optional server-driven copy for the chip. Mike IT-F2-413 c/7420760c
 * 2026-09-22: "the friendly names for the chip should be in the service
 * not in the app so they are common across all implementations".
 * Backend `get_user_data_agreements(sanitize=1)` now returns a `chip`
 * subdoc when the tier has a chip variant; consumers pass it through
 * unchanged. When absent (older backend OR consumer hasn't wired the
 * pass-through), we fall back to the hardcoded copy below so this
 * change is fully backwards-compatible.
 */
export type ChipVariant = 'live' | 'displaced' | 'pro' | 'pending' | 'declined' | 'delayed';
export interface ChipCopy {
  variant: ChipVariant;
  label: string;
  title: string;
  aria_label: string;
}

export interface DataTierChipProps {
  dataTier?: DataTier;
  reviewStatus?: ReviewStatus;
  onAgreementsClick?: () => void;
  /** When supplied, overrides the hardcoded chip copy — set from the
   *  backend's data-agreements sanitize response. */
  chip?: ChipCopy | null;
}

const OpenIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 6, verticalAlign: '-1px' }} aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

// Palette lifted verbatim from alpha-pivot-frontend/src/scanner/DataTierChip.tsx
// (fn-delayed dark-theme variants). Cockpit's frame is dark so we skip the
// light-theme variants; a future light-mode consumer can add
// [data-theme="light"] overrides here.
const CHIP_CSS = `
.dtc-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:14px;
  border:1px solid rgba(245,158,11,.28);background:rgba(245,158,11,.12);color:#fbbf24;
  font:inherit;font-size:11px;font-weight:600;line-height:1;letter-spacing:.02em;
  white-space:nowrap;cursor:pointer;
  transition:background .12s,border-color .12s,transform .12s}
.dtc-chip em{font-style:normal;color:#f59e0b;font-size:9px;line-height:1;
  animation:dtcPulse 2s ease-in-out infinite}
.dtc-chip:hover{background:rgba(245,158,11,.2);border-color:rgba(245,158,11,.45)}
.dtc-chip:active{transform:scale(.97)}
@keyframes dtcPulse{0%,100%{opacity:.55}50%{opacity:1}}
.dtc-chip.live{color:#86efac;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.28)}
.dtc-chip.live em{color:#22c55e}
.dtc-chip.live:hover{background:rgba(34,197,94,.2);border-color:rgba(34,197,94,.45)}
.dtc-chip.pro{color:#93c5fd;background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.28)}
.dtc-chip.pro em{color:#3b82f6}
.dtc-chip.pro:hover{background:rgba(59,130,246,.2);border-color:rgba(59,130,246,.45)}
.dtc-chip.pending{color:#7dd3fc;background:rgba(56,189,248,.12);border-color:rgba(56,189,248,.28)}
.dtc-chip.pending em{color:#38bdf8}
.dtc-chip.pending:hover{background:rgba(56,189,248,.2);border-color:rgba(56,189,248,.45)}
.dtc-chip.declined{color:#fca5a5;background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.35)}
.dtc-chip.declined em{color:#ef4444}
.dtc-chip.declined:hover{background:rgba(239,68,68,.22);border-color:rgba(239,68,68,.55)}
.dtc-chip.displaced{color:#fdba74;background:rgba(249,115,22,.16);border-color:rgba(249,115,22,.4)}
.dtc-chip.displaced em{color:#f97316}
.dtc-chip.displaced:hover{background:rgba(249,115,22,.26);border-color:rgba(249,115,22,.6)}
.dtc-wrap{display:flex;align-items:center}
`;

// Force a fresh session_id + reload — used when the chip signals a
// displaced state and the user wants to reclaim the live slot. The next
// mount POSTs `X-F2-Claim-Slot: reclaim` and re-wins the live_sessions
// entry (f2-admin-service auth.service.ts _claimLiveSlot).
function reclaimAndReload() {
  try { sessionStorage.removeItem('f2_session_id'); } catch { /* ignore */ }
  window.location.reload();
}

export function DataTierChip({ dataTier, reviewStatus, onAgreementsClick, chip: serverChip }: DataTierChipProps) {
  const chip = renderChip({ dataTier, reviewStatus, onAgreementsClick, chip: serverChip });
  if (!chip) return null;
  return (
    <div className="dtc-wrap">
      <style>{CHIP_CSS}</style>
      {chip}
    </div>
  );
}

function renderChip({ dataTier, reviewStatus, onAgreementsClick, chip: serverChip }: DataTierChipProps): JSX.Element | null {
  if (!dataTier) return null;
  // Server-driven copy path (IT-F2-413 c/7420760c). When the backend
  // includes a `chip` subdoc on the sanitize response, render from that
  // directly. Variant → styling class (same names as the hardcoded
  // branches below so CSS stays reused); click handler routes to
  // reclaim-and-reload for 'displaced', otherwise onAgreementsClick.
  if (serverChip && serverChip.variant) {
    const clsMap: Record<ChipVariant, string> = {
      live: 'live', displaced: 'displaced', pro: 'pro',
      pending: 'pending', declined: 'declined', delayed: '',
    };
    const cls = `dtc-chip ${clsMap[serverChip.variant] || ''}`.trim();
    const onClick = serverChip.variant === 'displaced' ? reclaimAndReload : onAgreementsClick;
    // Declined variant historically carried an OpenIcon; preserve that
    // when the server flags variant=declined for parity.
    const trailIcon = serverChip.variant === 'declined' || (serverChip.variant === 'delayed' && serverChip.label.includes('Delayed'))
      ? <OpenIcon />
      : null;
    return (
      <button type="button" className={cls} onClick={onClick}
        title={serverChip.title} aria-label={serverChip.aria_label}>
        <em aria-hidden="true">●</em> {serverChip.label}{trailIcon}
      </button>
    );
  }

  if (dataTier === 'realtime') {
    return (
      <button type="button" className="dtc-chip live" onClick={onAgreementsClick}
        title="You have realtime market data. Click to view your Exchange Agreement."
        aria-label="Live market data — open Exchange Agreement">
        <em aria-hidden="true">●</em> Live Data
      </button>
    );
  }

  if (dataTier === 'delayed_displaced') {
    return (
      <button type="button" className="dtc-chip displaced" onClick={reclaimAndReload}
        title="Another window has your live-data seat for this scanner. Click to reload and take it back."
        aria-label="Displaced — reload to take back live data">
        <em aria-hidden="true">●</em> Another window is live — click to reload
      </button>
    );
  }

  if (dataTier === 'delayed_pro_gate') {
    return (
      <button type="button" className="dtc-chip pro" onClick={onAgreementsClick}
        title="You're classified as a Pro subscriber. Realtime data unlocks once the exchange approves the Pro tier."
        aria-label="Pro tier — 15-minute delayed data — open Exchange Agreement">
        <em aria-hidden="true">●</em> Pro — 15-min delayed
      </button>
    );
  }

  if (dataTier === 'delayed_by_agreement') {
    if (reviewStatus === 'pending') {
      return (
        <button type="button" className="dtc-chip pending" onClick={onAgreementsClick}
          title="Your Exchange Agreement is with the compliance team. Click to view status."
          aria-label="15-min Delayed Data — Non Pro — Agreement Under Review">
          <em aria-hidden="true">●</em> 15-min Delayed Data · Non Pro · Agreement Under Review
        </button>
      );
    }
    if (reviewStatus === 'declined') {
      return (
        <button type="button" className="dtc-chip declined" onClick={onAgreementsClick}
          title="You're on 15-minute delayed data. Click to update your Exchange Agreement and resubmit for realtime access."
          aria-label="15-min Delayed Data — Non Pro — Agreement Declined — open Exchange Agreement to resubmit">
          <em aria-hidden="true">●</em> 15-Min Delayed Data (Live Declined) <OpenIcon />
        </button>
      );
    }
    return (
      <button type="button" className="dtc-chip" onClick={onAgreementsClick}
        title="Data is delayed 15 minutes. Click to open the Exchange Agreement for realtime data."
        aria-label="15-min Delayed Data — open Exchange Agreement to fill out">
        <em aria-hidden="true">●</em> 15-min Delayed Data <OpenIcon />
      </button>
    );
  }

  // dataTier === 'denied' → no chip
  return null;
}
