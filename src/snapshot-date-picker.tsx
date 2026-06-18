import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Shared snapshot-date picker. Single canonical date-picker treatment
 * for any F2 scanner SPA that wants to browse historical days of a
 * dated-DB-pattern collection (trendlabs-{ET-date}, OptionPit_LIVE-
 * {ET-date}, etc.). Matches the visual the TheoTrade scanners use:
 * teal calendar icon + MM/DD/YYYY chip → click opens a month-grid
 * popup. Dates not in `availableDates` are greyed and unclickable.
 *
 * Self-contained — no extra deps beyond react. Styling is inline so
 * f2tech-shared can stay build-step-free. Consumers control the
 * accent / surface colors via the `theme` prop (defaults match the
 * burnt-orange / navy palette but every value is overridable).
 *
 * Auth-aware data fetching is the consumer's job: pass the list of
 * available dates in via `availableDates` after fetching from your
 * SPA's authenticated /rest/<restPath>/dates client. When the prop
 * is absent every date <= maxDate is enabled (graceful degrade for
 * SPAs whose f2-api hasn't opened the /dates endpoint yet).
 */

export interface SnapshotDatePickerTheme {
  /** Chip surface color (the boxed display) */
  chipBg?: string;
  /** Chip border color */
  chipBorder?: string;
  /** Chip text color */
  chipText?: string;
  /** Calendar icon color (teal in the TheoTrade screenshot) */
  iconColor?: string;
  /** Popup surface */
  popupBg?: string;
  /** Popup border */
  popupBorder?: string;
  /** Day-cell text */
  dayText?: string;
  /** Disabled-day text (greyed) */
  dayDisabledText?: string;
  /** Accent for the selected day + 'today' outline */
  accent?: string;
  /** Accent text (selected day foreground) */
  accentText?: string;
  /** Muted text (weekday labels, header chrome) */
  muted?: string;
}

const DEFAULT_THEME: Required<SnapshotDatePickerTheme> = {
  chipBg: '#0e2238',
  chipBorder: '#1e3c5a',
  chipText: '#e2e8f0',
  iconColor: '#2dd4bf', // teal-400 — matches TheoTrade
  popupBg: '#0b1830',
  popupBorder: '#1e3c5a',
  dayText: '#cbd5e1',
  dayDisabledText: '#3f5670',
  accent: '#f97316', // burnt-orange (alpha-eye palette)
  accentText: '#ffffff',
  muted: '#7a92ad',
};

export interface SnapshotDatePickerProps {
  /** Selected date in YYYY-MM-DD or empty string for "today / live". */
  value: string;
  /** Fired when the user picks a date. Empty string = "back to today". */
  onChange: (next: string) => void;
  /** Optional whitelist of YYYY-MM-DD strings that are clickable. When
   *  omitted every date <= maxDate is enabled. */
  availableDates?: string[];
  /** Inclusive ceiling for picks (defaults to today). YYYY-MM-DD. */
  maxDate?: string;
  /** Optional floor for picks. YYYY-MM-DD. */
  minDate?: string;
  /** Display label shown when value is empty. Defaults to today's date. */
  todayLabel?: string;
  /** ARIA label on the chip button. */
  ariaLabel?: string;
  /** Visual overrides. Partial — missing keys use DEFAULT_THEME. */
  theme?: SnapshotDatePickerTheme;
  /** Optional className passthrough on the chip wrapper. */
  className?: string;
  disabled?: boolean;
}

/** YYYY-MM-DD for the user's LOCAL day. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** MM/DD/YYYY for display in the chip. */
function fmtDisplay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/** Parse a YYYY-MM-DD as a local-noon Date (avoids DST midnight edges). */
function parseLocal(iso: string): Date {
  const [y, mo, d] = iso.split('-').map((n) => parseInt(n, 10));
  return new Date(y, mo - 1, d, 12, 0, 0, 0);
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function SnapshotDatePicker(props: SnapshotDatePickerProps) {
  const {
    value,
    onChange,
    availableDates,
    minDate,
    todayLabel,
    ariaLabel = 'Pick snapshot date',
    className,
    disabled = false,
  } = props;
  const theme = { ...DEFAULT_THEME, ...(props.theme ?? {}) };
  const today = todayIso();
  const max = props.maxDate ?? today;

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // The month being viewed in the popup. Defaults to the selected
  // value's month (or today's if value is empty).
  const [cursorMonth, setCursorMonth] = useState<Date>(() => parseLocal(value || today));

  // Re-anchor the popup month when the picker opens fresh.
  useEffect(() => {
    if (open) setCursorMonth(parseLocal(value || today));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside-click + Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Pre-index availableDates for O(1) lookup. undefined = no whitelist.
  const allowedSet = useMemo(() => {
    if (!availableDates) return null;
    return new Set(availableDates);
  }, [availableDates]);

  const displayText = value ? fmtDisplay(value) : (todayLabel ?? fmtDisplay(today));

  // Build the 6-week grid for the current cursorMonth. We always
  // render 42 cells so the popup height never jumps when navigating
  // between short / long months.
  const cells = useMemo(() => {
    const out: Array<{ iso: string; day: number; inMonth: boolean }> = [];
    const first = new Date(cursorMonth.getFullYear(), cursorMonth.getMonth(), 1, 12);
    const startWeekday = first.getDay(); // 0 = Sunday
    const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - startWeekday, 12);
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i, 12);
      out.push({
        iso: isoOf(d),
        day: d.getDate(),
        inMonth: d.getMonth() === cursorMonth.getMonth(),
      });
    }
    return out;
  }, [cursorMonth]);

  const isClickable = (iso: string): boolean => {
    if (iso > max) return false;
    if (minDate && iso < minDate) return false;
    if (allowedSet && !allowedSet.has(iso)) return false;
    return true;
  };

  const stepMonth = (delta: number) => {
    setCursorMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1, 12));
  };

  const handlePick = (iso: string) => {
    if (!isClickable(iso)) return;
    onChange(iso === today ? '' : iso);
    setOpen(false);
  };

  const handleToday = () => {
    onChange('');
    setOpen(false);
  };

  // Styles — inline so f2tech-shared doesn't ship a CSS file. Consumers
  // can override the most important colors via the theme prop.
  const chipStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    height: 30,
    padding: '0 10px',
    border: `1px solid ${theme.chipBorder}`,
    borderRadius: 4,
    background: theme.chipBg,
    color: theme.chipText,
    font: 'inherit',
    fontSize: 13,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  };
  const popupStyle: React.CSSProperties = {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    minWidth: 244,
    background: theme.popupBg,
    border: `1px solid ${theme.popupBorder}`,
    borderRadius: 6,
    padding: 10,
    boxShadow: '0 10px 32px rgba(0,0,0,0.45)',
    zIndex: 80,
    color: theme.dayText,
    fontSize: 12,
  };
  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  };
  const navBtnStyle: React.CSSProperties = {
    width: 24,
    height: 24,
    background: 'transparent',
    border: 0,
    color: theme.muted,
    cursor: 'pointer',
    borderRadius: 4,
    fontSize: 14,
    lineHeight: 1,
  };
  const monthTitleStyle: React.CSSProperties = {
    color: theme.dayText,
    fontSize: 13,
    fontWeight: 600,
  };
  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: 2,
  };
  const weekdayCellStyle: React.CSSProperties = {
    textAlign: 'center',
    color: theme.muted,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    padding: '4px 0',
  };
  const todayBtnStyle: React.CSSProperties = {
    marginTop: 8,
    padding: '4px 8px',
    background: 'transparent',
    border: `1px solid ${theme.popupBorder}`,
    color: theme.muted,
    borderRadius: 4,
    fontSize: 11,
    cursor: 'pointer',
    width: '100%',
    fontFamily: 'inherit',
  };
  const dayCellBase: React.CSSProperties = {
    textAlign: 'center',
    padding: '6px 0',
    borderRadius: 4,
    border: 0,
    background: 'transparent',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 12,
    color: theme.dayText,
  };

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <button
        type="button"
        style={chipStyle}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
      >
        <CalendarIcon color={theme.iconColor} />
        <span>{displayText}</span>
      </button>

      {open ? (
        <div style={popupStyle} role="dialog" aria-label={ariaLabel}>
          <div style={headerStyle}>
            <button
              type="button"
              style={navBtnStyle}
              onClick={() => stepMonth(-1)}
              aria-label="Previous month"
            >
              ‹
            </button>
            <span style={monthTitleStyle}>
              {MONTH_NAMES[cursorMonth.getMonth()]} {cursorMonth.getFullYear()}
            </span>
            <button
              type="button"
              style={navBtnStyle}
              onClick={() => stepMonth(1)}
              aria-label="Next month"
            >
              ›
            </button>
          </div>

          <div style={gridStyle}>
            {WEEKDAY_LABELS.map((w, i) => (
              <div key={`wd-${i}`} style={weekdayCellStyle}>{w}</div>
            ))}
            {cells.map((c) => {
              const clickable = isClickable(c.iso);
              const isSelected = c.iso === value;
              const isToday = c.iso === today;
              const cellStyle: React.CSSProperties = {
                ...dayCellBase,
                cursor: clickable ? 'pointer' : 'not-allowed',
                background: isSelected ? theme.accent : 'transparent',
                color: isSelected
                  ? theme.accentText
                  : clickable
                  ? theme.dayText
                  : theme.dayDisabledText,
                opacity: c.inMonth ? 1 : (clickable ? 0.55 : 0.35),
                outline: isToday && !isSelected ? `1px solid ${theme.accent}` : 'none',
                fontWeight: isSelected ? 700 : 400,
              };
              return (
                <button
                  key={c.iso}
                  type="button"
                  style={cellStyle}
                  disabled={!clickable}
                  onClick={() => handlePick(c.iso)}
                  aria-pressed={isSelected}
                  aria-label={c.iso}
                >
                  {c.day}
                </button>
              );
            })}
          </div>

          {value ? (
            <button type="button" style={todayBtnStyle} onClick={handleToday}>
              ↻ Back to today (live)
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CalendarIcon({ color }: { color: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      aria-hidden="true"
      style={{ flex: '0 0 auto' }}
    >
      <path
        fill={color}
        d="M20 4a2 2 0 0 0-2-2h-2V1a1 1 0 0 0-2 0v1h-3V1a1 1 0 0 0-2 0v1H6V1a1 1 0 0 0-2 0v1H2a2 2 0 0 0-2 2v2h20V4ZM0 18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8H0v10Zm5-8h10a1 1 0 0 1 0 2H5a1 1 0 0 1 0-2Z"
      />
    </svg>
  );
}

/**
 * Optional helper: given a YYYY-MM-DD list returned from
 * /rest/<restPath>/dates (or anywhere), normalize + sort it for the
 * picker. Filters out anything not matching the regex.
 */
export function normalizeAvailableDates(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      seen.add(v);
    }
  }
  return [...seen].sort().reverse();
}
