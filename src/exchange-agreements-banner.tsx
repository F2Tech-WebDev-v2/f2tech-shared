import { useEffect, useState } from 'react';

/**
 * React equivalent of f2-exchange-agreements-banner (Angular). Same
 * COPY + COLORS + inline styles so React SPAs (members, alpha-shark-
 * flow, trend-labs-react, oxc-rrg meridian) match the Angular ones.
 *
 * Consumer wiring:
 *   <ExchangeAgreementsBanner
 *      visible={liveRequired && !completed}
 *      agreementUrl="/data-agreements?customer=oxc"
 *      dismissible                 // IT-F2-391 item 1 opt-in
 *      dismissKey="oxc"            // per-customer sessionStorage scope
 *      label="DELAYED DATA MODE"
 *      message="Data is delayed 15 minutes. Fill out Exchange Agreement to access realtime data."
 *   />
 *
 * Dismissal persists in sessionStorage (per browser session). Refresh
 * / nav within the session doesn't re-show. Closing the browser (or
 * opening a new tab) re-shows so the compliance signal isn't lost
 * across sessions. Storage failure (Safari private, etc.) degrades
 * gracefully — dismissal is runtime-only for that component instance.
 */

export interface ExchangeAgreementsBannerProps {
  visible: boolean;
  agreementUrl: string | null;
  dismissible?: boolean;
  label?: string;
  message?: string;
  dismissKey?: string;
}

const DEFAULT_LABEL = 'SIGN AGREEMENTS';
const DEFAULT_MESSAGE = 'Exchange agreements are required to use real-time data. Click here to complete.';

export function ExchangeAgreementsBanner(props: ExchangeAgreementsBannerProps) {
  const {
    visible,
    agreementUrl,
    dismissible = false,
    label = DEFAULT_LABEL,
    message = DEFAULT_MESSAGE,
    dismissKey = '',
  } = props;

  const storageKey = `f2-exchange-agreements-banner-dismissed:${dismissKey || 'default'}`;
  const [dismissed, setDismissed] = useState<boolean>(false);

  // Restore prior sessionStorage dismissal on mount (only when dismissible).
  useEffect(() => {
    if (!dismissible) return;
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(storageKey) === '1') {
        setDismissed(true);
      }
    } catch { /* storage blocked — safe default is not-dismissed */ }
    // key changes → re-check
  }, [dismissible, storageKey]);

  if (!visible || dismissed) return null;

  const onDismiss = () => {
    setDismissed(true);
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(storageKey, '1');
    } catch { /* storage blocked — runtime-only dismissal */ }
  };

  return (
    <div
      role="status"
      style={{
        width: '100%',
        padding: '14px 16px',
        background: '#2a2e32',
        color: 'white',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <strong style={{ fontWeight: 700 }}>{label}</strong>
      <span aria-hidden="true">→</span>
      {agreementUrl ? (
        <a
          href={agreementUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'white', fontWeight: 600, textDecoration: 'underline', cursor: 'pointer' }}
        >
          {message}
        </a>
      ) : null}
      {dismissible ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss banner for this session"
          title="Dismiss for this session"
          style={{
            marginLeft: 8,
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.4)',
            color: 'white',
            width: 26,
            height: 26,
            borderRadius: 4,
            fontSize: 16,
            lineHeight: 1,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
