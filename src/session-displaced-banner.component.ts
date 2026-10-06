import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Angular standalone sibling of session-displaced-banner.tsx. Added IT-F2-437
 * (2026-10-06, theo-trade) so Angular adopters get the identical pulsing
 * orange displaced-tab banner.
 *
 * Fleet contract (mirrors session-displaced-banner.tsx):
 *   Consumer SPA detects the displaced state (from the sanitize probe response
 *   OR from a socket.io session_displaced event) and toggles `visible=true`.
 *   On click, the banner emits `reclaim` — canonical implementation clears
 *   sessionStorage.f2_session_id and reloads, so the fresh mount generates a
 *   new id and re-issues X-F2-Claim-Slot: reclaim, winning the slot back.
 *
 * Copy, color palette (#c2410c ↔ #9a3412 pulse at 1.6s), and inline-style
 * approach match the React component 1:1. Keyframe name is unique
 * (`f2-session-displaced-pulse`) so multiple copies on the page cannot
 * collide and consumer `@keyframes pulse` rules cannot clash.
 */

const KEYFRAME_NAME = 'f2-session-displaced-pulse';
const BANNER_CSS = `
@keyframes ${KEYFRAME_NAME} {
  0%, 100% { background:#c2410c; }
  50%      { background:#9a3412; }
}
.f2-sdb-banner{
  width:100%;padding:10px 16px;text-align:center;color:#fff;
  font-size:14px;line-height:1.4;font-weight:500;
  box-shadow:0 2px 4px rgba(0,0,0,0.15);
  animation:${KEYFRAME_NAME} 1.6s ease-in-out infinite;
  cursor:pointer;
}
.f2-sdb-banner strong{font-weight:700;letter-spacing:.02em;}
.f2-sdb-banner .f2-sdb-msg{margin-left:8px;}
`;

@Component({
  standalone: true,
  selector: 'f2-session-displaced-banner',
  imports: [CommonModule],
  styles: [BANNER_CSS],
  template: `
    <ng-container *ngIf="visible">
      <div class="f2-sdb-banner"
        role="alert"
        aria-live="polite"
        tabindex="0"
        (click)="emitReclaim()"
        (keydown)="onKeydown($event)">
        <strong>{{ label }}</strong>
        <span class="f2-sdb-msg">· {{ message }}</span>
      </div>
    </ng-container>
  `,
})
export class SessionDisplacedBannerComponent {
  /** Show the banner. Consumer sets true when the SPA detects
   *  data_tier=delayed_displaced OR receives a session_displaced WS event. */
  @Input() visible = false;
  /** Override for the "ANOTHER SESSION IS LIVE" strong label. */
  @Input() label = 'ANOTHER SESSION IS LIVE';
  /** Override for the plain-text explanation. */
  @Input() message = 'Your realtime data seat was taken by another window/browser. Click here to reload and reclaim it.';
  /** Click (or Enter / Space) emits here. Canonical handler clears
   *  sessionStorage.f2_session_id then window.location.reload(). */
  @Output() reclaim = new EventEmitter<void>();

  emitReclaim() { this.reclaim.emit(); }

  onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.emitReclaim();
    }
  }
}
