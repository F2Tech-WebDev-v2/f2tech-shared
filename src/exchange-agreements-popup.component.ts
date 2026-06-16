import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Canonical Angular standalone component for the per-customer
 * Exchange Agreements modal. Single source of truth for the modal's
 * copy + layout — every scanner SPA imports this so the wording can't
 * drift (e.g. theo-trade's "agreement" vs others' "agreements" naming
 * cleanup).
 *
 * Wiring contract:
 *   - `visible`       - boolean. Caller computes from a per-SPA
 *                       DataAgreementsService (e.g. live_data && !completed).
 *   - `agreementUrl`  - the per-customer iframe URL from
 *                       f2tech-shared/agreements#exchAgreementsUrl().
 *   - `(dismissed)`   - fires when user clicks Close. Caller flips
 *                       its `popup_ack` flag so the modal disappears
 *                       for this session.
 *
 * Inline styles (no Tailwind dependency) so the modal renders the
 * same regardless of SPA Tailwind config.
 */
@Component({
  standalone: true,
  selector: 'f2-exchange-agreements-popup',
  imports: [CommonModule],
  template: `
    <div
      *ngIf="visible"
      style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px"
      role="dialog"
      aria-modal="true"
      aria-labelledby="f2-exch-agr-title"
    >
      <div style="background:white;width:75%;max-width:475px;border-radius:4px;padding:28px 20px">
        <h1 id="f2-exch-agr-title" style="font-size:30px;font-weight:bold;text-align:center;margin:0 0 16px 0;color:black">Real-Time Market Data</h1>
        <p style="text-align:center;font-size:18px;color:black;margin:0">
          Exchange agreements are required to use real-time market data. Please click below to complete.
        </p>
        <div style="display:flex;gap:20px;justify-content:center;margin-top:32px">
          <a
            *ngIf="agreementUrl"
            [href]="agreementUrl"
            target="_blank"
            rel="noopener noreferrer"
            style="flex:1;padding:8px 16px;background:#15803d;color:white;text-align:center;border-radius:4px;text-decoration:none;font-weight:600"
          >View Agreements</a>
          <button
            type="button"
            (click)="dismissed.emit()"
            style="flex:1;padding:8px 16px;background:#374151;color:white;text-align:center;border-radius:4px;font-weight:600;cursor:pointer;border:none"
          >Close</button>
        </div>
      </div>
    </div>
  `,
})
export class ExchangeAgreementsPopupComponent {
  @Input() visible = false;
  @Input() agreementUrl: string | null = null;
  @Output() dismissed = new EventEmitter<void>();
}
