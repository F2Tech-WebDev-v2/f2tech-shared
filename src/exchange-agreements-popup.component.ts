import { Component, Input, Output, EventEmitter, SimpleChanges, OnChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

/**
 * Canonical Angular standalone component for the per-customer Exchange
 * Agreements modal.
 *
 * TWO MODES — switched by whether `customerSlug` is passed:
 *
 * 1. **Iframe mode** (RECOMMENDED, mirrors the React useExchangeAgreementsPopup
 *    hook): set `customerSlug` + optional `identity`. On `visible=true`, the
 *    component POSTs `/rest/auth/mint-sid-from-cookies` to mint a one-time
 *    sid, builds the members Exchange Agreements URL, and renders a dark
 *    full-height iframe modal. Same-origin branded path by default
 *    (`/data-agreements?sid=...`); set `useBrandedHost=false` for absolute
 *    `membersOrigin/<slug>/data-agreements?sid=...` fallback (3rd-party
 *    cookie risk — Firefox ITP). Mirrors recipe §12.0.
 *
 * 2. **Legacy stub mode** (pre-2026-09-30 wiring): set `agreementUrl` only.
 *    Renders the simple white "Real-Time Market Data" modal with an external
 *    "View Agreements" link. Flagged by recipe §12.0 as the wrong-popup
 *    canary; kept for consumers that haven't upgraded yet.
 *
 * Dismiss contract: `(dismissed)` event fires on scrim click, close button,
 * or Escape key (iframe mode). Caller flips its popup_ack flag.
 *
 * Inline styles (no Tailwind dependency) — modal renders the same in every
 * SPA regardless of Tailwind config.
 */

export interface AgreementsIdentity {
  email?: string | null;
  first?: string | null;
  last?: string | null;
}

@Component({
  standalone: true,
  selector: 'f2-exchange-agreements-popup',
  imports: [CommonModule],
  styles: [`
    /* Iframe-mode shell */
    .f2-eap-scrim{position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px;}
    .f2-eap-modal{background:#0b1830;color:#e2e8f0;border-radius:8px;box-shadow:0 30px 80px rgba(0,0,0,.6);width:100%;max-width:1100px;height:85vh;display:flex;flex-direction:column;overflow:hidden;}
    .f2-eap-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid #1e3c5a;background:#0e2238;}
    .f2-eap-title{font-size:14px;font-weight:600;margin:0;}
    .f2-eap-close{background:transparent;border:0;color:#cbd5e1;cursor:pointer;font-size:13px;padding:4px 12px;border-radius:4px;}
    .f2-eap-close:hover{background:rgba(203,213,225,.1);}
    .f2-eap-iframe{flex:1;width:100%;border:0;}
    .f2-eap-prep{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:#98a2b0;font-size:13px;}

    /* Legacy stub mode */
    .f2-eap-legacy-scrim{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px;}
    .f2-eap-legacy-card{background:white;width:75%;max-width:475px;border-radius:4px;padding:28px 20px;}
    .f2-eap-legacy-h1{font-size:30px;font-weight:bold;text-align:center;margin:0 0 16px 0;color:black;}
    .f2-eap-legacy-p{text-align:center;font-size:18px;color:black;margin:0;}
    .f2-eap-legacy-actions{display:flex;gap:20px;justify-content:center;margin-top:32px;}
    .f2-eap-legacy-view{flex:1;padding:8px 16px;background:#15803d;color:white;text-align:center;border-radius:4px;text-decoration:none;font-weight:600;}
    .f2-eap-legacy-close{flex:1;padding:8px 16px;background:#374151;color:white;text-align:center;border-radius:4px;font-weight:600;cursor:pointer;border:none;}
  `],
  template: `
    <!-- Iframe mode — customer slug drives mint-sid + iframe URL build. -->
    <div *ngIf="visible && customerSlug"
      class="f2-eap-scrim"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="ariaLabel"
      (click)="onScrimClick($event)">
      <div class="f2-eap-modal">
        <div class="f2-eap-header">
          <h2 class="f2-eap-title">{{ ariaLabel }}</h2>
          <button type="button" class="f2-eap-close" (click)="emitDismissed()" aria-label="Close">Close</button>
        </div>
        <iframe *ngIf="iframeUrl; else prep"
          class="f2-eap-iframe"
          [src]="trustedIframeUrl()"
          [title]="ariaLabel"></iframe>
        <ng-template #prep>
          <div class="f2-eap-prep">Preparing Exchange Agreements form…</div>
        </ng-template>
      </div>
    </div>

    <!-- Legacy stub mode — agreementUrl without customerSlug. -->
    <div *ngIf="visible && !customerSlug"
      class="f2-eap-legacy-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="f2-exch-agr-title">
      <div class="f2-eap-legacy-card">
        <h1 id="f2-exch-agr-title" class="f2-eap-legacy-h1">Real-Time Market Data</h1>
        <p class="f2-eap-legacy-p">
          Exchange agreements are required to use real-time market data. Please click below to complete.
        </p>
        <div class="f2-eap-legacy-actions">
          <a *ngIf="agreementUrl" [href]="agreementUrl" target="_blank" rel="noopener noreferrer" class="f2-eap-legacy-view">View Agreements</a>
          <button type="button" (click)="emitDismissed()" class="f2-eap-legacy-close">Close</button>
        </div>
      </div>
    </div>
  `,
})
export class ExchangeAgreementsPopupComponent implements OnChanges {
  @Input() visible = false;
  /** Legacy stub mode input. Set to the agreements external URL for consumers
   *  that haven't upgraded to iframe mode. */
  @Input() agreementUrl: string | null = null;
  /** IFRAME-MODE: customer slug for members URL + mint-sid-from-cookies. */
  @Input() customerSlug: string | null = null;
  /** IFRAME-MODE: identity pre-fill (passes email/first/last to the members
   *  form so the user doesn't retype them). */
  @Input() identity: AgreementsIdentity | null = null;
  /** IFRAME-MODE: when true (default), iframe src is same-origin relative
   *  `/data-agreements?sid=…` so it loads under the SPA's branded host
   *  (cookies same-origin, URL bar stays on branded). When false, uses
   *  absolute `membersOrigin/<slug>/data-agreements?sid=…` — cookies become
   *  3rd-party; Firefox ITP will drop them. */
  @Input() useBrandedHost = true;
  /** IFRAME-MODE: override the members origin for the non-branded fallback.
   *  Default `https://members.f2-tech.ai`. */
  @Input() membersOrigin = 'https://members.f2-tech.ai';
  /** IFRAME-MODE: optional authed-fetch wrapper (your SPA's httpClient.fetch
   *  with refresh-retry). Falls back to global `fetch` on undefined. */
  @Input() guardedFetch: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
  /**
   * IFRAME-MODE escape hatch for SPAs that don't use the cookie-session
   * auth model (e.g. JWT-bearer SPAs like theo-trade). When set, the
   * component calls this instead of its own
   * `/rest/auth/mint-sid-from-cookies` flow — the SPA is responsible
   * for minting the sid via whatever primitive its auth model provides
   * (e.g. TT's /rest/auth/exchange-portal-token which takes a JWT and
   * returns a members sid URL) and returning the full iframe URL to
   * load. Return `null` to signal mint failure — component falls through
   * to the identity-only URL as before. IT-F2-437 2026-10-07.
   */
  @Input() urlResolver: (() => Promise<string | null>) | null = null;
  /** Shell aria-label + header title text. */
  @Input() ariaLabel = 'Exchange Agreements';

  @Output() dismissed = new EventEmitter<void>();

  iframeUrl: string | null = null;
  private _escHandler: ((e: KeyboardEvent) => void) | null = null;

  async ngOnChanges(changes: SimpleChanges) {
    if (!changes['visible']) return;
    if (this.visible && this.customerSlug) {
      // Mint sid and build iframe URL. Hide iframe until the URL is ready
      // (template falls through to the "Preparing…" placeholder).
      this.iframeUrl = null;
      await this._buildIframeUrl();
    } else {
      this.iframeUrl = null;
    }
    // Esc-key dismiss — bind on open, unbind on close. Only in iframe mode;
    // legacy stub mode uses the Close button only.
    if (this.visible && this.customerSlug && typeof window !== 'undefined') {
      if (!this._escHandler) {
        this._escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') this.emitDismissed(); };
        window.addEventListener('keydown', this._escHandler);
      }
    } else if (this._escHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
  }

  private async _buildIframeUrl() {
    const slug = this.customerSlug;
    if (!slug) return;

    // Escape hatch for JWT-bearer SPAs (theo-trade, et al.): if the host
    // provided a urlResolver, let it mint the full iframe URL itself
    // using whatever primitive its auth model provides. Skip the shared
    // mint-sid-from-cookies path, which only works for cookie-session
    // SPAs (recipe default). IT-F2-437 2026-10-07.
    if (this.urlResolver) {
      try {
        const resolved = await this.urlResolver();
        if (resolved) {
          this.iframeUrl = resolved;
          return;
        }
      } catch { /* fall through to identity-only URL */ }
      // Resolver returned null / threw → fall through to the identity-
      // only URL so the shell at least renders something.
      const bareFallback = this.useBrandedHost
        ? '/data-agreements'
        : `${this.membersOrigin}/${slug}/data-agreements`;
      this.iframeUrl = `${bareFallback}${this._buildQueryString(null)}`;
      return;
    }

    const bare = this.useBrandedHost
      ? '/data-agreements'
      : `${this.membersOrigin}/${slug}/data-agreements`;
    const doFetch: (u: string, init?: RequestInit) => Promise<Response> =
      this.guardedFetch || ((u: string, init?: RequestInit) => fetch(u, init));
    let sid: string | null = null;
    try {
      // Mint a session id from the scanner's cookies. The members iframe
      // will redeem this sid for a short-lived members session so the
      // embedded form can authenticate the user without re-login.
      const r = await doFetch('/rest/auth/mint-sid-from-cookies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (r.ok) {
        const body = await r.json().catch(() => ({}));
        if (body && typeof body.sid === 'string') sid = body.sid;
      }
    } catch { /* fall through to identity-only URL */ }
    this.iframeUrl = `${bare}${this._buildQueryString(sid)}`;
  }

  private _buildQueryString(sid: string | null): string {
    const p = new URLSearchParams();
    if (sid) p.set('sid', sid);
    if (this.identity?.email) p.set('email', this.identity.email);
    if (this.identity?.first) p.set('first', this.identity.first);
    if (this.identity?.last)  p.set('last',  this.identity.last);
    const qs = p.toString();
    return qs ? `?${qs}` : '';
  }

  private readonly _sanitizer = inject(DomSanitizer);

  /** Angular's iframe [src] binding requires a SafeResourceUrl, not a plain
   *  string — bypassSecurityTrustResourceUrl marks our known-safe URL
   *  trusted. For same-origin relative URLs this is safe; for absolute
   *  members URLs we're trusting the known members host. */
  trustedIframeUrl(): SafeResourceUrl {
    return this._sanitizer.bypassSecurityTrustResourceUrl(this.iframeUrl || '');
  }

  onScrimClick(e: MouseEvent) {
    // Only dismiss if the click landed on the scrim itself, not a child.
    if (e.target === e.currentTarget) this.emitDismissed();
  }

  emitDismissed() { this.dismissed.emit(); }
}
