import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Single canonical Angular standalone component for the company/customer
 * data-tier banner. Every scanner SPA imports this so the COPY + COLORS
 * stay in lockstep — drift (mta's red+pulse one-off, etc.) is no
 * longer possible.
 *
 * Wiring contract:
 *   1. Caller computes `mode` from `resolveDataTier({...}).bannerMode`
 *   2. Renders `<f2-data-tier-banner [mode]="dataTierMode"></f2-data-tier-banner>`
 *   3. Place as the FIRST CHILD of the app shell so it pushes header
 *      down rather than overlaying (no position:fixed/absolute/sticky).
 *
 * Inline styles (NOT Tailwind classes) so the component renders the
 * same in every SPA regardless of Tailwind config / content path.
 *
 * The auth/admin/live-data resolution remains per-SPA (depends on each
 * SPA's local auth service) — only the visual presentation is shared.
 */
@Component({
  standalone: true,
  selector: 'f2-data-tier-banner',
  imports: [CommonModule],
  template: `
    <ng-container *ngIf="mode as m">
      <div
        [style.background]="bg(m)"
        style="width:100%;padding:8px 16px;text-align:center;color:white;font-size:14px;font-weight:500;box-shadow:0 2px 4px rgba(0,0,0,0.15)"
        role="status"
        aria-live="polite"
      >{{ text(m) }}</div>
    </ng-container>
  `,
})
export class DataTierBannerComponent {
  @Input() mode: 'delayed' | 'realtime' | 'disabled' | null = null;

  bg(m: 'delayed' | 'realtime' | 'disabled'): string {
    if (m === 'delayed') return '#f59e0b';
    if (m === 'realtime') return '#2563eb';
    return '#dc2626';
  }

  text(m: 'delayed' | 'realtime' | 'disabled'): string {
    if (m === 'delayed') return 'Delayed Data Mode — F2 has switched all scanners to delayed feeds.';
    if (m === 'realtime') return 'Realtime Data Mode — all users serving live data.';
    return 'Service Disabled — F2 has temporarily disabled scanners.';
  }
}
