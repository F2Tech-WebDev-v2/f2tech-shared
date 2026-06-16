// React JSX runtime — no default React import needed (and trips
// noUnusedLocals in strict-mode consumer SPAs).

/**
 * React Exchange Agreements popup — visual twin of f2-exchange-agreements-popup
 * (Angular). Caller controls visibility + supplies the per-customer
 * iframe URL. The popup itself is purely presentational.
 */

export interface ExchangeAgreementsPopupProps {
  visible: boolean;
  agreementUrl: string | null;
  onDismiss: () => void;
}

export function ExchangeAgreementsPopup({ visible, agreementUrl, onDismiss }: ExchangeAgreementsPopupProps) {
  if (!visible) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="f2-exch-agr-title"
    >
      <div style={{ background: 'white', width: '75%', maxWidth: 475, borderRadius: 4, padding: '28px 20px' }}>
        <h1
          id="f2-exch-agr-title"
          style={{ fontSize: 30, fontWeight: 'bold', textAlign: 'center', margin: '0 0 16px 0', color: 'black' }}
        >
          Real-Time Market Data
        </h1>
        <p style={{ textAlign: 'center', fontSize: 18, color: 'black', margin: 0 }}>
          Exchange agreements are required to use real-time market data. Please click below to complete.
        </p>
        <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 32 }}>
          {agreementUrl && (
            <a
              href={agreementUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                flex: 1,
                padding: '8px 16px',
                background: '#15803d',
                color: 'white',
                textAlign: 'center',
                borderRadius: 4,
                textDecoration: 'none',
                fontWeight: 600,
              }}
            >
              View Agreements
            </a>
          )}
          <button
            type="button"
            onClick={onDismiss}
            style={{
              flex: 1,
              padding: '8px 16px',
              background: '#374151',
              color: 'white',
              textAlign: 'center',
              borderRadius: 4,
              fontWeight: 600,
              cursor: 'pointer',
              border: 'none',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ExchangeAgreementsBannerProps {
  visible: boolean;
  agreementUrl: string | null;
}

/**
 * Persistent "SIGN AGREEMENTS" strip — sits above the page header until
 * the per-customer Exchange Agreements are completed. Pair with
 * <ExchangeAgreementsPopup> using the same `agreementUrl`.
 */
export function ExchangeAgreementsBanner({ visible, agreementUrl }: ExchangeAgreementsBannerProps) {
  if (!visible) return null;
  return (
    <div
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
      role="status"
    >
      <strong style={{ fontWeight: 700 }}>SIGN AGREEMENTS</strong>
      <span aria-hidden="true">→</span>
      {agreementUrl && (
        <a
          href={agreementUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'white', fontWeight: 600, textDecoration: 'underline', cursor: 'pointer' }}
        >
          Exchange agreements are required to use real-time data. Click here to complete.
        </a>
      )}
    </div>
  );
}
