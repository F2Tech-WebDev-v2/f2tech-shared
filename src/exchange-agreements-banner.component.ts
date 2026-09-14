import { Component, Input, OnInit } from '@angular/core';
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
 * IT-F2-391 item 1 (Mike 2026-09-14): "dismissable banner at the top
 * that says data is delayed 15 minutes and needs to have a option to
 * fill out a exchange agreement to access realtime data". Adds
 * [dismissible] + [label] + [message] inputs — when [dismissible]=true,
 * an inline close button appears + dismissal persists in sessionStorage
 * (per browser session) so refresh/nav within the session doesn't
 * re-show. Consumer SPAs opt in explicitly.
 *
 * Inline styles only — renders identically in every SPA.
 */
@Component({
  standalone: true,
  selector: 'f2-exchange-agreements-banner',
  imports: [CommonModule],
  template: `
    <div
      *ngIf="visible && !_dismissed"
      style="width:100%;padding:14px 16px;background:#2a2e32;color:white;display:flex;justify-content:center;align-items:center;gap:12px;flex-wrap:wrap"
      role="status"
    >
      <strong style="font-weight:700">{{ label }}</strong>
      <span aria-hidden="true">→</span>
      <a
        *ngIf="agreementUrl"
        [href]="agreementUrl"
        target="_blank"
        rel="noopener noreferrer"
        style="color:white;font-weight:600;text-decoration:underline;cursor:pointer"
      >{{ message }}</a>
      <button
        *ngIf="dismissible"
        type="button"
        (click)="_onDismiss()"
        aria-label="Dismiss banner for this session"
        title="Dismiss for this session"
        style="margin-left:8px;background:transparent;border:1px solid rgba(255,255,255,0.4);color:white;width:26px;height:26px;border-radius:4px;font-size:16px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center"
      >×</button>
    </div>
  `,
})
export class ExchangeAgreementsBannerComponent implements OnInit {
  @Input() visible = false;
  @Input() agreementUrl: string | null = null;
  /**
   * IT-F2-391 item 1: opt-in dismiss button + sessionStorage-scoped
   * dismissal. Default false to preserve pre-existing behavior for
   * consumers that WANT the persistent-until-completed pattern.
   */
  @Input() dismissible = false;
  /**
   * Left-side label above the CTA link. Default "SIGN AGREEMENTS"
   * preserves the pre-existing wording. Item 1 asked for a "data is
   * delayed 15 minutes" wording; SPAs can pass label="DELAYED DATA
   * MODE" + message="Data is delayed 15 minutes. Fill out Exchange
   * Agreement to access realtime data." to match.
   */
  @Input() label = 'SIGN AGREEMENTS';
  @Input() message = 'Exchange agreements are required to use real-time data. Click here to complete.';
  /**
   * sessionStorage key stem. Different SPAs may render the banner on
   * multiple customer surfaces — appending the customer slug via
   * [dismissKey]="'oxc'" scopes the dismissal per customer so a user
   * dismissing on one customer's surface doesn't hide it on another.
   */
  @Input() dismissKey = '';

  _dismissed = false;

  private get _storageKey(): string {
    return `f2-exchange-agreements-banner-dismissed:${this.dismissKey || 'default'}`;
  }

  ngOnInit(): void {
    if (!this.dismissible) return;
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(this._storageKey) === '1') {
        this._dismissed = true;
      }
    } catch { /* private-browsing / storage-blocked — safe default is not-dismissed */ }
  }

  _onDismiss(): void {
    this._dismissed = true;
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(this._storageKey, '1');
    } catch { /* storage blocked — dismissal stays runtime-only for this component instance */ }
  }
}
