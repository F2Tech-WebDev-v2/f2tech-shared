import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Angular standalone sibling of data-tier-chip.tsx. Added IT-F2-437 (2026-10-06,
 * theo-trade) so Angular adopters get the same 7-state Live / Displaced /
 * Pro-gate / Delayed-Under-Review / Delayed-Declined / Delayed-Default / Denied
 * chip variants from a single source. Styling, copy, and click behaviour
 * mirror the React component 1:1.
 *
 * State comes from `GET /rest/user/data-agreements?sanitize=1` (f2-admin-service
 * precedence: denied > delayed_pro_gate > delayed_by_agreement >
 * delayed_displaced > realtime). SPA passes the returned fields through as
 * Inputs.
 *
 * Load-order contract (Mike IT-F2-391 c/6e4a9ab8): render nothing until
 * `dataTier` arrives — no flash of "Live Data" while the probe is in flight.
 * The host template MUST pass the dataTier state through as-is (null on first
 * paint, real value after probe resolves).
 *
 * Inline styles are injected via a single `<style>` element so the component
 * renders identically in every SPA regardless of Tailwind config.
 */
export type DataTier =
  | 'realtime'
  | 'delayed_by_agreement'
  | 'delayed_pro_gate'
  | 'delayed_displaced'
  | 'denied'
  | null;

export type ReviewStatus = 'pending' | 'approved' | 'declined' | null;

export type ChipVariant = 'live' | 'displaced' | 'pro' | 'pending' | 'declined' | 'delayed';

export interface ChipCopy {
  variant: ChipVariant;
  label: string;
  title: string;
  aria_label: string;
}

// Palette lifted verbatim from alpha-pivot-frontend/src/scanner/DataTierChip.tsx
// (fn-delayed dark-theme variants). Dark-frame SPAs skip the light variants;
// a light-mode consumer can add [data-theme="light"] overrides.
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
.dtc-open-icon{margin-left:6px;vertical-align:-1px}
`;

@Component({
  standalone: true,
  selector: 'f2-data-tier-chip',
  imports: [CommonModule],
  template: `
    <ng-container *ngIf="shouldRender()">
      <div class="dtc-wrap">
        <style>{{ cssText }}</style>

        <!-- Server-driven copy path (IT-F2-413 c/7420760c): backend ships a
             chip subdoc with variant + label + title + aria_label; we render
             from that directly so copy stays in sync across adopters. -->
        <ng-container *ngIf="chip as sc; else hardcoded">
          <button type="button"
            [class]="serverClass(sc.variant)"
            (click)="onServerClick(sc.variant)"
            [title]="sc.title"
            [attr.aria-label]="sc.aria_label">
            <em aria-hidden="true">●</em> {{ sc.label }}<ng-container
              *ngIf="serverTrailIcon(sc)"><ng-container *ngTemplateOutlet="openIcon"></ng-container></ng-container>
          </button>
        </ng-container>

        <!-- Hardcoded fallback branches — identical copy to data-tier-chip.tsx. -->
        <ng-template #hardcoded>
          <ng-container [ngSwitch]="dataTier">
            <button *ngSwitchCase="'realtime'" type="button" class="dtc-chip live"
              (click)="agree()"
              title="You have realtime market data. Click to view your Exchange Agreement."
              aria-label="Live market data — open Exchange Agreement">
              <em aria-hidden="true">●</em> Live Data
            </button>

            <button *ngSwitchCase="'delayed_displaced'" type="button" class="dtc-chip displaced"
              (click)="reclaim()"
              title="Another window has your live-data seat for this scanner. Click to reload and take it back."
              aria-label="Displaced — reload to take back live data">
              <em aria-hidden="true">●</em> Another window is live — click to reload
            </button>

            <button *ngSwitchCase="'delayed_pro_gate'" type="button" class="dtc-chip pro"
              (click)="agree()"
              title="You're classified as a Pro subscriber. Realtime data unlocks once the exchange approves the Pro tier."
              aria-label="Pro tier — 15-minute delayed data — open Exchange Agreement">
              <em aria-hidden="true">●</em> Pro — 15-min delayed
            </button>

            <ng-container *ngSwitchCase="'delayed_by_agreement'" [ngSwitch]="reviewStatus">
              <button *ngSwitchCase="'pending'" type="button" class="dtc-chip pending"
                (click)="agree()"
                title="Your Exchange Agreement is with the compliance team. Click to view status."
                aria-label="15-min Delayed Data — Non Pro — Agreement Under Review">
                <em aria-hidden="true">●</em> 15-min Delayed Data · Non Pro · Agreement Under Review
              </button>

              <button *ngSwitchCase="'declined'" type="button" class="dtc-chip declined"
                (click)="agree()"
                title="You're on 15-minute delayed data. Click to update your Exchange Agreement and resubmit for realtime access."
                aria-label="15-min Delayed Data — Non Pro — Agreement Declined — open Exchange Agreement to resubmit">
                <em aria-hidden="true">●</em> 15-Min Delayed Data (Live Declined) <ng-container *ngTemplateOutlet="openIcon"></ng-container>
              </button>

              <button *ngSwitchDefault type="button" class="dtc-chip"
                (click)="agree()"
                title="Data is delayed 15 minutes. Click to open the Exchange Agreement for realtime data."
                aria-label="15-min Delayed Data — open Exchange Agreement to fill out">
                <em aria-hidden="true">●</em> 15-min Delayed Data <ng-container *ngTemplateOutlet="openIcon"></ng-container>
              </button>
            </ng-container>

            <!-- dataTier === 'denied' | null → no chip -->
          </ng-container>
        </ng-template>
      </div>

      <ng-template #openIcon>
        <svg class="dtc-open-icon" width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </ng-template>
    </ng-container>
  `,
})
export class DataTierChipComponent {
  @Input() dataTier: DataTier = null;
  @Input() reviewStatus: ReviewStatus = null;
  /** Server-driven chip copy — when present, overrides the hardcoded branches
   *  (variant → styling class + button copy comes from backend). */
  @Input() chip: ChipCopy | null = null;
  @Output() agreementsClick = new EventEmitter<void>();

  readonly cssText = CHIP_CSS;

  shouldRender(): boolean {
    if (this.chip && this.chip.variant) return true;
    return this.dataTier !== null && this.dataTier !== 'denied';
  }

  serverClass(v: ChipVariant): string {
    const map: Record<ChipVariant, string> = {
      live: 'live', displaced: 'displaced', pro: 'pro',
      pending: 'pending', declined: 'declined', delayed: '',
    };
    return `dtc-chip ${map[v] || ''}`.trim();
  }

  serverTrailIcon(sc: ChipCopy): boolean {
    if (sc.variant === 'declined') return true;
    if (sc.variant === 'delayed' && sc.label.includes('Delayed')) return true;
    return false;
  }

  onServerClick(v: ChipVariant) {
    if (v === 'displaced') this.reclaim();
    else this.agree();
  }

  agree() { this.agreementsClick.emit(); }

  /** Force a fresh session_id + reload — displaced-chip click path. The next
   *  mount POSTs `X-F2-Claim-Slot: reclaim` and re-wins the live_sessions
   *  entry (f2-admin-service auth.service.ts _claimLiveSlot). */
  reclaim() {
    try { sessionStorage.removeItem('f2_session_id'); } catch { /* ignore */ }
    if (typeof window !== 'undefined') window.location.reload();
  }
}
