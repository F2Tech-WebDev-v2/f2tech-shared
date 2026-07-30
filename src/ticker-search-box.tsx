import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Fleet-standard tiered symbol/company search box. IT-F2-145.
 *
 * Type a query, dropdown shows results ranked in this exact tier order:
 *   1. Symbol starts-with the query   (e.g. `mic` → MIC)
 *   2. Symbol contains the query      (elsewhere in the ticker)
 *   3. Company name contains the query (e.g. Micron, Microsoft, Microchip)
 * Alphabetical within each tier. Case-insensitive.
 *
 * Backed by `GET /rest/instrument-details/search` on `f2-admin-service`
 * (member-safe, F2AuthMiddleware). Same-origin from the SPA by default —
 * consumers' vercel.json rewrites `/rest/*` to f2-admin-service2. Override
 * `authBase` when the consumer isn't going through a same-origin rewrite
 * (e.g. a standalone tool talking to admin.f2-tech.ai directly).
 *
 * Debounced 150ms. Renders `<TICKER>` bold + `<Company · Exchange (Country)>`
 * subtext per Mike screenshot (2026-07-30). Keyboard navigation via
 * ArrowUp/ArrowDown; Enter selects; Escape closes.
 *
 * Copy-paste companion: `<TickerSearchBoxNg>` in ../account-menu.component.ts
 * pattern would be the Angular twin (not yet shipped — add if a scanner
 * on the Angular side needs it).
 */

export interface TickerSearchResult {
  symbol: string;
  company_common_name: string | null;
  short_name: string | null;
  primary_exchange: string | null;
  exchange_country_code: string | null;
  active: boolean;
  match_type: 'symbol_prefix' | 'symbol_contains' | 'name_contains';
}

export interface TickerSearchBoxProps {
  /** Fired when a result is picked (Enter, click, or Tab). */
  onSelect: (ticker: string, row: TickerSearchResult) => void;
  /** Fired when the user clears the input (X button or backspace-to-empty). */
  onClear?: () => void;
  /** When set, the input syncs to this value (used by parents that clear a
   *  symbol filter via a Clear Filters button; consumers who prefer a fully
   *  uncontrolled input can leave undefined). */
  externalTicker?: string | null;
  placeholder?: string;
  /** Result cap sent as the `limit` param (default 20, cap 50 backend-side). */
  limit?: number;
  /** Whether to hide inactive/retired tickers (default true). */
  activeOnly?: boolean;
  /** Base URL for the search endpoint. Default '' (same-origin via rewrite).
   *  Override to e.g. 'https://f2-admin-service2.f2-tech.ai' when the SPA
   *  can't rewrite `/rest/*` locally. */
  authBase?: string;
  /** Autofocus on mount. */
  autoFocus?: boolean;
  /** CSS width. Default 280px. */
  width?: number | string;
  /** Optional wrapper className for consumer layout. */
  className?: string;
}

const DEBOUNCE_MS = 150;

function MagnifierIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function BoldMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const q = query.toUpperCase();
  const upper = text.toUpperCase();
  const idx = upper.indexOf(q);
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <b>{text.slice(idx, idx + q.length)}</b>
      {text.slice(idx + q.length)}
    </>
  );
}

export function TickerSearchBox({
  onSelect,
  onClear,
  externalTicker = null,
  placeholder = 'Search ticker or company',
  limit = 20,
  activeOnly = true,
  authBase = '',
  autoFocus = false,
  width = 280,
  className,
}: TickerSearchBoxProps) {
  const [value, setValue] = useState<string>(externalTicker ?? '');
  const [debounced, setDebounced] = useState<string>('');
  const [results, setResults] = useState<TickerSearchResult[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [open, setOpen] = useState<boolean>(false);
  const [cursor, setCursor] = useState<number>(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const debounceTimer = useRef<number | null>(null);

  // Sync when the parent forces a value (e.g. after Clear Filters).
  useEffect(() => {
    if (externalTicker !== null && externalTicker !== value) {
      setValue(externalTicker);
      setOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalTicker]);

  // Debounce the input → debounced state.
  useEffect(() => {
    if (debounceTimer.current) window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => {
      setDebounced(value.trim());
    }, DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current) window.clearTimeout(debounceTimer.current);
    };
  }, [value]);

  // Fetch on debounced change.
  useEffect(() => {
    if (!debounced) {
      setResults([]);
      setLoading(false);
      return;
    }
    if (inflight.current) inflight.current.abort();
    const ac = new AbortController();
    inflight.current = ac;
    setLoading(true);
    const url = `${authBase}/rest/instrument-details/search?q=${encodeURIComponent(debounced)}&limit=${limit}&active_only=${activeOnly ? 'true' : 'false'}`;
    fetch(url, { credentials: 'include', signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { ok: boolean; results?: TickerSearchResult[] }) => {
        if (ac.signal.aborted) return;
        setResults(Array.isArray(body?.results) ? body.results : []);
        setCursor(0);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (ac.signal.aborted || e.name === 'AbortError') return;
        setResults([]);
        setLoading(false);
      });
    return () => ac.abort();
  }, [debounced, limit, activeOnly, authBase]);

  // Compute dropdown portal position anchored to the input.
  const recomputePos = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    recomputePos();
    const on = () => recomputePos();
    window.addEventListener('scroll', on, true);
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on, true);
      window.removeEventListener('resize', on);
    };
  }, [open, recomputePos]);

  // Click-outside closes.
  useEffect(() => {
    if (!open) return;
    const on = (ev: MouseEvent) => {
      const w = wrapperRef.current;
      if (w && ev.target instanceof Node && !w.contains(ev.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [open]);

  const commit = (row: TickerSearchResult) => {
    setValue(row.symbol);
    setOpen(false);
    onSelect(row.symbol, row);
    inputRef.current?.blur();
  };

  const doClear = () => {
    setValue('');
    setResults([]);
    setDebounced('');
    setOpen(false);
    if (onClear) onClear();
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setCursor((c) => Math.min(results.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length === 0) return;
      const row = results[cursor] || results[0];
      if (row) commit(row);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const showDropdown = open && (results.length > 0 || (loading && debounced.length > 0));

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={{ position: 'relative', width, display: 'inline-block' }}
    >
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <span
          aria-hidden="true"
          style={{ position: 'absolute', left: 8, color: '#94a3b8', pointerEvents: 'none' }}
        >
          <MagnifierIcon />
        </span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(e) => { setValue(e.target.value); setOpen(true); }}
          onFocus={() => { if (value.trim().length > 0) setOpen(true); }}
          onKeyDown={onKeyDown}
          className="w-full h-[28px] pl-7 pr-8 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-[12px] text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:focus:ring-brand-500/30"
        />
        {value && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={doClear}
            style={{ position: 'absolute', right: 6, background: 'transparent', border: 0, cursor: 'pointer', color: '#94a3b8', padding: 2 }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      {showDropdown && pos && createPortal(
        <div
          role="listbox"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: pos.width,
            maxHeight: 320,
            overflowY: 'auto',
            background: 'var(--brand-panel-to, #0f172a)',
            color: 'var(--brand-text-primary, #e2e8f0)',
            border: `1px solid var(--brand-panel-border, rgba(255,255,255,0.08))`,
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(15,23,42,0.35)',
            zIndex: 5000,
          }}
        >
          {loading && results.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--brand-text-muted, #94a3b8)' }}>
              Searching…
            </div>
          )}
          {!loading && results.length === 0 && debounced.length > 0 && (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--brand-text-muted, #94a3b8)' }}>
              No matches for “{debounced}”.
            </div>
          )}
          {results.map((r, i) => {
            const isCursor = i === cursor;
            return (
              <div
                key={r.symbol}
                role="option"
                aria-selected={isCursor}
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(e) => { e.preventDefault(); /* keep input focus so onSelect can blur */ }}
                onClick={() => commit(r)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  background: isCursor ? 'var(--brand-panel-bg-hover, rgba(255,255,255,0.06))' : 'transparent',
                  borderBottom: '1px solid var(--brand-panel-border, rgba(255,255,255,0.04))',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.02em' }}>
                  <BoldMatch text={r.symbol} query={debounced} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--brand-text-muted, #94a3b8)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <BoldMatch text={r.company_common_name || r.short_name || ''} query={debounced} />
                  {r.primary_exchange && <> {' · '} {r.primary_exchange}</>}
                  {r.exchange_country_code && <> {' ('}{r.exchange_country_code}{')'}</>}
                </div>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
