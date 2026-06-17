import { useEffect, useRef, useState } from 'react';

/**
 * React twin of f2-account-menu (Angular). Top-right "account coin"
 * trigger + dropdown with Exchange Agreements / Change password / Sign
 * out. Self-contained — no external icon or dropdown library.
 */

export interface AccountMenuProps {
  agreementUrl?: string | null;
  email?: string | null;
  onSignOut: () => void;
  onChangePassword: () => void;
}

export function AccountMenu({ agreementUrl, email, onSignOut, onChangePassword }: AccountMenuProps) {
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

  const itemBase = {
    display: 'block' as const,
    padding: '10px 16px',
    fontSize: 14,
    color: '#e5e7eb',
    textDecoration: 'none',
    background: 'transparent',
    border: 0,
    cursor: 'pointer',
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }} data-f2-account-menu>
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Open account menu"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: 9999,
          background: 'white',
          border: 0,
          padding: 0,
          cursor: 'pointer',
        }}
      >
        <svg width={22} height={22} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="12" cy="12" r="11" fill="#11314D" />
          <circle cx="12" cy="9.5" r="3.25" fill="white" />
          <path d="M5.5 19c1.2-3.2 3.7-4.75 6.5-4.75S17.3 15.8 18.5 19" stroke="white" strokeWidth={1.6} strokeLinecap="round" fill="none" />
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
            minWidth: 220,
            background: '#0E1019',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 4,
            boxShadow: '0 6px 16px rgba(0,0,0,0.4)',
            overflow: 'hidden',
          }}
        >
          {email && (
            <div
              style={{
                padding: '10px 16px',
                fontSize: 12,
                color: 'rgba(255,255,255,0.55)',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {email}
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
              onMouseOver={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
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
            onMouseOver={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
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
            style={{ ...itemBase, width: '100%', textAlign: 'left', borderTop: '1px solid rgba(255,255,255,0.08)' }}
            onMouseOver={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
