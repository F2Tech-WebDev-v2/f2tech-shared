import { useEffect, useRef, useState } from 'react';

/**
 * React twin of f2-account-menu (Angular). Top-right "account coin" —
 * compact circular avatar that EXPANDS ON HOVER to reveal an identity
 * pill next to the coin (First Last on top, email as smaller subtext),
 * and OPENS ON CLICK into a dropdown carrying Exchange Agreements /
 * Change password / Sign out.
 *
 * Hover-to-reveal is the canonical contract: identity is always one
 * mouse move away without spending header real estate on a permanent
 * label. Focus also expands so keyboard users get the same affordance.
 *
 * When firstName/lastName are absent the pill falls back to email-only.
 *
 * Self-contained — no external icon or dropdown library.
 */

export interface AccountMenuProps {
  agreementUrl?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  onSignOut: () => void;
  onChangePassword: () => void;
}

export function AccountMenu({ agreementUrl, email, firstName, lastName, onSignOut, onChangePassword }: AccountMenuProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    };
    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const displayName = [firstName || '', lastName || ''].map(s => s.trim()).filter(Boolean).join(' ');
  const hasIdentity = !!(email || displayName);

  // Pill is visible while the user is hovering, focused, OR has the
  // menu open. Keeping it open during the dropdown means the identity
  // header inside the menu can be dropped without losing context.
  const expanded = hasIdentity && (hover || focus || open);

  // Per-customer brand-aware colors. Each value falls back to the pre-
  // theming hex so SPAs without a Customer.branding subdoc render exactly
  // as before. Light-on-dark dropdown was the original f2 default and
  // still matches dark-themed customers (hima); light-themed customers
  // (option-pit cream + lime) get the lime accent on the coin/pill and
  // their panel-to color in the dropdown sheet. Mike 2026-06-27.
  const itemBase = {
    display: 'block' as const,
    padding: '10px 16px',
    fontSize: 14,
    color: 'var(--brand-text-primary, #e5e7eb)',
    textDecoration: 'none',
    background: 'transparent',
    border: 0,
    cursor: 'pointer',
  };
  // rgba-fallback variants keep the original subtle overlay look on
  // brands that don't supply panel-bg-hover / panel-border, and inherit
  // the brand-tinted color on those that do.
  const itemHoverBg = 'var(--brand-panel-bg-hover, rgba(255,255,255,0.08))';
  const sheetBorder = 'var(--brand-panel-border, rgba(255,255,255,0.08))';

  return (
    <div
      ref={wrapRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      data-f2-account-menu
    >
      {hasIdentity && (
        <span
          aria-hidden={!expanded}
          style={{
            maxWidth: expanded ? 320 : 0,
            opacity: expanded ? 1 : 0,
            paddingLeft: expanded ? 12 : 0,
            paddingRight: expanded ? 12 : 0,
            paddingTop: 6,
            paddingBottom: 6,
            marginRight: expanded ? 8 : 0,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            background: 'var(--brand-accent, white)',
            color: 'var(--brand-accent-text, #11314D)',
            lineHeight: 1.1,
            borderRadius: 9999,
            transition: 'max-width 200ms ease, opacity 150ms ease, padding 200ms ease, margin 200ms ease',
            pointerEvents: expanded ? 'auto' : 'none',
            display: 'inline-flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
          }}
        >
          {displayName && (
            <span style={{ fontSize: 13, fontWeight: 600 }}>{displayName}</span>
          )}
          {email && (
            <span
              style={{
                fontSize: displayName ? 11 : 13,
                fontWeight: displayName ? 400 : 500,
                opacity: displayName ? 0.7 : 1,
              }}
            >
              {email}
            </span>
          )}
        </span>
      )}
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation();
          setOpen((v) => !v);
        }}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={displayName ? `Open account menu for ${displayName}` : email ? `Open account menu for ${email}` : 'Open account menu'}
        title={displayName || email || undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: 9999,
          background: 'var(--brand-accent, white)',
          border: 0,
          padding: 0,
          cursor: 'pointer',
        }}
      >
        <svg width={22} height={22} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          {/* The figure silhouette inside the coin uses --brand-accent-text
              for the bg circle (the same dark color paired with the lime/
              white coin bg above), and --brand-accent for the figure
              itself so it inherits the coin tone — keeps the contrast
              ratio identical to the default white-on-navy design when
              swapped with any brand pair. */}
          <circle cx="12" cy="12" r="11" fill="var(--brand-accent-text, #11314D)" />
          <circle cx="12" cy="9.5" r="3.25" fill="var(--brand-accent, white)" />
          <path d="M5.5 19c1.2-3.2 3.7-4.75 6.5-4.75S17.3 15.8 18.5 19" stroke="var(--brand-accent, white)" strokeWidth={1.6} strokeLinecap="round" fill="none" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            zIndex: 9999,
            minWidth: 240,
            background: 'var(--brand-panel-to, #0E1019)',
            border: `1px solid ${sheetBorder}`,
            borderRadius: 4,
            boxShadow: '0 6px 16px rgba(0,0,0,0.4)',
            overflow: 'hidden',
          }}
        >
          {(displayName || email) && (
            <div
              style={{
                padding: '10px 16px',
                borderBottom: `1px solid ${sheetBorder}`,
                background: 'var(--brand-panel-bg-hover, rgba(255,255,255,0.03))',
              }}
            >
              {displayName && (
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--brand-text-primary, #f3f4f6)', lineHeight: 1.2 }}>{displayName}</div>
              )}
              {email && (
                <div
                  style={{
                    fontSize: displayName ? 11 : 13,
                    color: displayName ? 'var(--brand-text-muted, #9ca3af)' : 'var(--brand-text-primary, #e5e7eb)',
                    marginTop: displayName ? 2 : 0,
                    lineHeight: 1.2,
                    wordBreak: 'break-all',
                  }}
                >
                  {email}
                </div>
              )}
            </div>
          )}
          {agreementUrl && (
            <a
              href={agreementUrl}
              target="_blank"
              rel="noopener noreferrer"
              role="menuitem"
              onClick={() => setOpen(false)}
              style={itemBase}
              onMouseOver={(e) => (e.currentTarget.style.background = itemHoverBg)}
              onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              Exchange Agreements
            </a>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onChangePassword();
            }}
            style={{ ...itemBase, width: '100%', textAlign: 'left' }}
            onMouseOver={(e) => (e.currentTarget.style.background = itemHoverBg)}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            Change password
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            style={{ ...itemBase, width: '100%', textAlign: 'left', borderTop: `1px solid ${sheetBorder}` }}
            onMouseOver={(e) => (e.currentTarget.style.background = itemHoverBg)}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
