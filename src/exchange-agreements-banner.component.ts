import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Canonical Angular standalone component for the persistent "SIGN
 * AGREEMENTS" banner that sits above the page header until the user
 * completes the per-customer Exchange Agreements.
 *
 * Paired with f2-exchange-agreements-popup (the same `agreementUrl`
 * feeds both). Caller toggles `visible` from its DataAgreementsService:
 * typically `visible = live_data_required && !completed`.
 *
 * Inline styles only — renders identically in every SPA.
 */
@Component({
  standalone: true,
  selector: 'f2-exchange-agreements-banner',
  imports: [CommonModule],
  template: `
    <div
      *ngIf="visible"
      style="width:100%;padding:14px 16px;background:#2a2e32;color:white;display:flex;justify-content:center;align-items:center;gap:12px;flex-wrap:wrap"
      role="status"
    >
      <strong style="font-weight:700">SIGN AGREEMENTS</strong>
      <span aria-hidden="true">→</span>
      <a
        *ngIf="agreementUrl"
        [href]="agreementUrl"
        target="_blank"
        rel="noopener noreferrer"
        style="color:white;font-weight:600;text-decoration:underline;cursor:pointer"
      >Exchange agreements are required to use real-time data. Click here to complete.</a>
    </div>
  `,
})
export class ExchangeAgreementsBannerComponent {
  @Input() visible = false;
  @Input() agreementUrl: string | null = null;
}
