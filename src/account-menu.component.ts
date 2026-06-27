import { Component, Input, Output, EventEmitter, HostListener, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Canonical Angular standalone component for the top-right "account
 * coin" + dropdown. Replaces the inline `id="user-menu-button"` HTML
 * duplicated across theo-trade, option-pit, alpha-shark, delphi-signal,
 * mta, quant-pivot-pro, f2-admin, strat-alerts. Single source of truth
 * for the coin shape, dropdown layout, and item ordering.
 *
 * Behavior contract (matches React twin in account-menu.tsx):
 *   - HOVER (mouseenter / focus) → coin expands to reveal an identity
 *     pill on its left. When firstName/lastName are present the pill
 *     shows "First Last" on top with the email as a smaller subtext;
 *     otherwise the pill collapses to just the email. The pill collapses
 *     on mouseleave/blur unless the dropdown is open.
 *   - CLICK → dropdown with Exchange Agreements / Change password /
 *     Sign out items.
 *
 * Why two-line identity: the underlying Cognito bundle sometimes lands
 * with the Username (sub UUID) where the email should be — surfacing
 * "64686498-4081-70da-7dab-..." as the only label is unreadable. Even
 * when the email is correct, the human-readable name is the better
 * primary label. Falling back to email-only keeps the pill useful when
 * the consumer hasn't wired identity through yet.
 */
@Component({
  standalone: true,
  selector: 'f2-account-menu',
  imports: [CommonModule],
  template: `
    <div
      style="position:relative;display:inline-flex;align-items:center"
      data-f2-account-menu
      (mouseenter)="hover = true"
      (mouseleave)="hover = false"
    >
      <span
        *ngIf="hasIdentity"
        [attr.aria-hidden]="!expanded"
        [style.max-width.px]="expanded ? 320 : 0"
        [style.opacity]="expanded ? 1 : 0"
        [style.padding-left.px]="expanded ? 12 : 0"
        [style.padding-right.px]="expanded ? 12 : 0"
        [style.margin-right.px]="expanded ? 8 : 0"
        [style.pointer-events]="expanded ? 'auto' : 'none'"
        style="padding-top:6px;padding-bottom:6px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;background:var(--brand-accent, white);color:var(--brand-accent-text, #11314D);line-height:1.1;border-radius:9999px;transition:max-width 200ms ease,opacity 150ms ease,padding 200ms ease,margin 200ms ease;display:inline-flex;flex-direction:column;align-items:flex-end"
      >
        <span *ngIf="displayName" style="font-size:13px;font-weight:600">{{ displayName }}</span>
        <span *ngIf="email" [style.font-size.px]="displayName ? 11 : 13" [style.font-weight]="displayName ? 400 : 500" [style.opacity]="displayName ? 0.7 : 1">{{ email }}</span>
      </span>
      <button
        type="button"
        (click)="toggle($event)"
        (focus)="focus = true"
        (blur)="focus = false"
        [attr.aria-expanded]="open"
        aria-haspopup="true"
        [attr.aria-label]="ariaLabel"
        [attr.title]="displayName || email || null"
        style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9999px;background:var(--brand-accent, white);border:0;padding:0;cursor:pointer"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="12" cy="12" r="11" [attr.fill]="'var(--brand-accent-text, #11314D)'"/>
          <circle cx="12" cy="9.5" r="3.25" [attr.fill]="'var(--brand-accent, white)'"/>
          <path d="M5.5 19c1.2-3.2 3.7-4.75 6.5-4.75S17.3 15.8 18.5 19" [attr.stroke]="'var(--brand-accent, white)'" stroke-width="1.6" stroke-linecap="round" fill="none"/>
        </svg>
      </button>

      <div
        *ngIf="open"
        role="menu"
        style="position:absolute;top:calc(100% + 8px);right:0;z-index:9999;min-width:240px;background:var(--brand-panel-to, #0E1019);border:1px solid var(--brand-panel-border, rgba(255,255,255,0.08));border-radius:4px;box-shadow:0 6px 16px rgba(0,0,0,0.4);overflow:hidden"
      >
        <div
          *ngIf="displayName || email"
          style="padding:10px 16px;border-bottom:1px solid var(--brand-panel-border, rgba(255,255,255,0.08));background:var(--brand-panel-bg-hover, rgba(255,255,255,0.03))"
        >
          <div *ngIf="displayName" style="font-size:13px;font-weight:600;color:var(--brand-text-primary, #f3f4f6);line-height:1.2">{{ displayName }}</div>
          <div *ngIf="email" [style.font-size.px]="displayName ? 11 : 13" [style.color]="displayName ? 'var(--brand-text-muted, #9ca3af)' : 'var(--brand-text-primary, #e5e7eb)'" [style.margin-top.px]="displayName ? 2 : 0" style="line-height:1.2;word-break:break-all">{{ email }}</div>
        </div>
        <a
          *ngIf="agreementUrl"
          [href]="agreementUrl"
          target="_blank"
          rel="noopener noreferrer"
          role="menuitem"
          (click)="open = false"
          style="display:block;padding:10px 16px;font-size:14px;color:var(--brand-text-primary, #e5e7eb);text-decoration:none;cursor:pointer"
          onmouseover="this.style.background='var(--brand-panel-bg-hover, rgba(255,255,255,0.08))'"
          onmouseout="this.style.background='transparent'"
        >Exchange Agreements</a>
        <button
          type="button"
          role="menuitem"
          (click)="onChangePassword()"
          style="display:block;width:100%;text-align:left;padding:10px 16px;font-size:14px;color:var(--brand-text-primary, #e5e7eb);background:transparent;border:0;cursor:pointer"
          onmouseover="this.style.background='var(--brand-panel-bg-hover, rgba(255,255,255,0.08))'"
          onmouseout="this.style.background='transparent'"
        >Change password</button>
        <button
          type="button"
          role="menuitem"
          (click)="onSignOut()"
          style="display:block;width:100%;text-align:left;padding:10px 16px;font-size:14px;color:var(--brand-text-primary, #e5e7eb);background:transparent;border:0;border-top:1px solid var(--brand-panel-border, rgba(255,255,255,0.08));cursor:pointer"
          onmouseover="this.style.background='var(--brand-panel-bg-hover, rgba(255,255,255,0.08))'"
          onmouseout="this.style.background='transparent'"
        >Sign out</button>
      </div>
    </div>
  `,
})
export class AccountMenuComponent {
  @Input() agreementUrl: string | null = null;
  @Input() email: string | null = null;
  @Input() firstName: string | null = null;
  @Input() lastName: string | null = null;
  @Output() signOut = new EventEmitter<void>();
  @Output() changePassword = new EventEmitter<void>();

  open = false;
  hover = false;
  focus = false;

  constructor(private host: ElementRef<HTMLElement>) {}

  get displayName(): string {
    const f = (this.firstName || '').trim();
    const l = (this.lastName || '').trim();
    const combined = [f, l].filter(Boolean).join(' ');
    return combined || '';
  }

  get hasIdentity(): boolean {
    return !!(this.email || this.displayName);
  }

  get expanded(): boolean {
    return !!(this.hasIdentity && (this.hover || this.focus || this.open));
  }

  get ariaLabel(): string {
    const label = this.displayName || this.email;
    return label ? `Open account menu for ${label}` : 'Open account menu';
  }

  toggle(ev: MouseEvent) {
    ev.stopPropagation();
    this.open = !this.open;
  }

  onSignOut() {
    this.open = false;
    this.signOut.emit();
  }

  onChangePassword() {
    this.open = false;
    this.changePassword.emit();
  }

  // Click-outside close. Cheaper than wiring an overlay; the menu is
  // small and short-lived so the document listener cost is negligible.
  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent) {
    if (!this.open) return;
    if (!this.host.nativeElement.contains(ev.target as Node)) {
      this.open = false;
    }
  }

  // Esc closes — keyboard parity with the underlying dropdown contract.
  @HostListener('document:keydown.escape')
  onEsc() {
    this.open = false;
  }
}
