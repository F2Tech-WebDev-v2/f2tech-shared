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
 *   - HOVER (mouseenter / focus) → coin expands to reveal the email
 *     in a pill on its left. The pill collapses on mouseleave/blur
 *     unless the dropdown is open.
 *   - CLICK → dropdown with Exchange Agreements / Change password /
 *     Sign out items.
 *
 * Wiring:
 *   - `agreementUrl`      - per-customer iframe URL from
 *                           f2tech-shared/agreements#exchAgreementsUrl().
 *                           Hides the Exchange Agreements row when null.
 *   - `email`             - signed-in user email. Surfaced via the
 *                           hover-pill; also used as the coin's
 *                           accessible label.
 *   - `(signOut)`         - fires on Sign out click.
 *   - `(changePassword)`  - fires on Change password click; consumer
 *                           handles routing (e.g. router.navigate to
 *                           `/change-pwd`) or opens a modal.
 *
 * Self-contained: no Flowbite dep, no FontAwesome dep, no Tailwind.
 * Inline SVG user-circle so the coin renders identically in every SPA
 * regardless of consumer config.
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
        *ngIf="email"
        [attr.aria-hidden]="!expanded"
        [style.max-width.px]="expanded ? 280 : 0"
        [style.opacity]="expanded ? 1 : 0"
        [style.padding-left.px]="expanded ? 12 : 0"
        [style.padding-right.px]="expanded ? 12 : 0"
        [style.margin-right.px]="expanded ? 8 : 0"
        [style.pointer-events]="expanded ? 'auto' : 'none'"
        style="padding-top:6px;padding-bottom:6px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;background:white;color:#11314D;font-size:13px;font-weight:500;line-height:1.1;border-radius:9999px;transition:max-width 200ms ease,opacity 150ms ease,padding 200ms ease,margin 200ms ease"
      >{{ email }}</span>
      <button
        type="button"
        (click)="toggle($event)"
        (focus)="focus = true"
        (blur)="focus = false"
        [attr.aria-expanded]="open"
        aria-haspopup="true"
        [attr.aria-label]="email ? 'Open account menu for ' + email : 'Open account menu'"
        [attr.title]="email || null"
        style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9999px;background:white;border:0;padding:0;cursor:pointer"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="12" cy="12" r="11" fill="#11314D"/>
          <circle cx="12" cy="9.5" r="3.25" fill="white"/>
          <path d="M5.5 19c1.2-3.2 3.7-4.75 6.5-4.75S17.3 15.8 18.5 19" stroke="white" stroke-width="1.6" stroke-linecap="round" fill="none"/>
        </svg>
      </button>

      <div
        *ngIf="open"
        role="menu"
        style="position:absolute;top:calc(100% + 8px);right:0;z-index:9999;min-width:220px;background:#0E1019;border:1px solid rgba(255,255,255,0.08);border-radius:4px;box-shadow:0 6px 16px rgba(0,0,0,0.4);overflow:hidden"
      >
        <a
          *ngIf="agreementUrl"
          [href]="agreementUrl"
          target="_blank"
          rel="noopener noreferrer"
          role="menuitem"
          (click)="open = false"
          style="display:block;padding:10px 16px;font-size:14px;color:#e5e7eb;text-decoration:none;cursor:pointer"
          onmouseover="this.style.background='rgba(255,255,255,0.08)'"
          onmouseout="this.style.background='transparent'"
        >Exchange Agreements</a>
        <button
          type="button"
          role="menuitem"
          (click)="onChangePassword()"
          style="display:block;width:100%;text-align:left;padding:10px 16px;font-size:14px;color:#e5e7eb;background:transparent;border:0;cursor:pointer"
          onmouseover="this.style.background='rgba(255,255,255,0.08)'"
          onmouseout="this.style.background='transparent'"
        >Change password</button>
        <button
          type="button"
          role="menuitem"
          (click)="onSignOut()"
          style="display:block;width:100%;text-align:left;padding:10px 16px;font-size:14px;color:#e5e7eb;background:transparent;border:0;border-top:1px solid rgba(255,255,255,0.08);cursor:pointer"
          onmouseover="this.style.background='rgba(255,255,255,0.08)'"
          onmouseout="this.style.background='transparent'"
        >Sign out</button>
      </div>
    </div>
  `,
})
export class AccountMenuComponent {
  @Input() agreementUrl: string | null = null;
  @Input() email: string | null = null;
  @Output() signOut = new EventEmitter<void>();
  @Output() changePassword = new EventEmitter<void>();

  open = false;
  hover = false;
  focus = false;

  constructor(private host: ElementRef<HTMLElement>) {}

  get expanded(): boolean {
    return !!(this.email && (this.hover || this.focus || this.open));
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
