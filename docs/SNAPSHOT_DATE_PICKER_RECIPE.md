# Snapshot Date Picker Recipe

Canonical recipe for adding a **historical-snapshot date picker** to any
F2 scanner SPA that indexes daily / dated database collections
(`T3-YYYY-MM-DD`, `trendlabs-YYYY-MM-DD`, `OptionPit_LIVE-YYYY-MM-DD`,
etc.).

Core4 (`alpha-pivot-frontend`) is the reference wire-up; the reusable
component lives at
`f2tech-shared/src/snapshot-date-picker.tsx` (exported as
`SnapshotDatePicker`).

---

## 1. What it renders

A single-chip picker in the SPA toolbar:

- **Collapsed:** teal calendar icon + `MM/DD/YYYY` chip (or the
  `todayLabel` when `value` is empty).
- **Expanded (popup):** month grid with weekday header + prev/next
  month nav + optional "↻ Back to today (live)" reset button when a
  non-live date is selected.

Days not in the SPA's `availableDates` set render as greyed
(`dayDisabledText`) and are unclickable. The selected day gets the
`accent` background; today gets a 1px `accent` outline (visible even
when today isn't selected).

---

## 2. Component API

Import:

```ts
import { SnapshotDatePicker, normalizeAvailableDates } from "f2tech-shared/snapshot-date-picker";
```

### 2.1 Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `value` | `string` | ✓ | Selected date as `YYYY-MM-DD`, or `""` for "today / live". |
| `onChange` | `(next: string) => void` | ✓ | Fires on pick. `""` = "back to today" (Today button OR clicking today's date). |
| `availableDates` | `string[]` | ✗ | Whitelist of clickable dates. Omit → every date `<= maxDate` is enabled (graceful degrade when your `/dates` endpoint isn't live yet). |
| `maxDate` | `string` | ✗ | Inclusive ceiling. Defaults to today. |
| `minDate` | `string` | ✗ | Inclusive floor. |
| `todayLabel` | `string` | ✗ | Chip text when `value === ""`. Defaults to today's `MM/DD/YYYY`. |
| `ariaLabel` | `string` | ✗ | ARIA on the chip button. Defaults `"Pick snapshot date"`. |
| `theme` | `SnapshotDatePickerTheme` | ✗ | Partial theme override (see §3). |
| `className` | `string` | ✗ | Passthrough on the chip wrapper. |
| `disabled` | `boolean` | ✗ | Disables the chip. |

### 2.2 Helper — `normalizeAvailableDates(raw)`

Feed it the raw `/dates` response; it filters non-`YYYY-MM-DD` strings,
dedups, and returns a sorted-descending list. Use this before setting
the `availableDates` prop — never trust the network payload shape
directly.

```ts
const r = await fetch("/api/signals/dates?days=180").then((r) => r.json());
setAvailableDates(normalizeAvailableDates(r));
```

---

## 3. Theme

All colors overridable. Defaults are the burnt-orange / navy Alpha-Eye
palette (matches the TheoTrade scanner reference).

| Key | Default | Where it shows |
|---|---|---|
| `chipBg` | `#0e2238` | Chip background |
| `chipBorder` | `#1e3c5a` | Chip border |
| `chipText` | `#e2e8f0` | Chip label |
| `iconColor` | `#2dd4bf` (teal-400) | Calendar icon |
| `popupBg` | `#0b1830` | Popup surface |
| `popupBorder` | `#1e3c5a` | Popup border |
| `dayText` | `#cbd5e1` | Clickable day text |
| `dayDisabledText` | `#3f5670` | Greyed day text |
| `accent` | `#f97316` (burnt-orange) | Selected day background + today outline |
| `accentText` | `#ffffff` | Selected day foreground |
| `muted` | `#7a92ad` | Weekday header + Today CTA |

Consumers pass a partial object — missing keys fall through to
`DEFAULT_THEME`:

```tsx
<SnapshotDatePicker
  theme={{ accent: "var(--brand-primary)", chipBg: "var(--surface2)" }}
  ...
/>
```

---

## 4. Backend endpoint contract

Every SPA needs a `/<rest-path>/dates` endpoint that returns the
enumerable snapshot list. Core4's reference lives at
`alpha-pivot-service` `src/routes/meta.mjs`.

### 4.1 Signature

```
GET /api/signals/dates?days=<N>
```

- `days` (optional) — lookback window in days. Default 180, capped at 365.
- Returns: `string[]` of `YYYY-MM-DD`, sorted ascending.
- Response shape is bare array — no envelope. `normalizeAvailableDates`
  handles the sort + dedup on the SPA.

### 4.2 What the backend does

1. Enumerate all `<PREFIX>-YYYY-MM-DD` databases (Core4:
   `listT3Databases()`).
2. Parse the date suffix; drop anything outside the `days` window.
3. **Existence check per db** — hit the primary collection with a
   projection-only `findOne` (Core4: `Core4` collection; fall back to
   legacy `Alpha_Pivot`). If the collection has at least one non-
   schema doc, keep the date. Empty databases (e.g. pipeline hasn't
   populated yet) are dropped so the picker doesn't offer a date that
   would render an empty grid.
4. Sort ascending.

### 4.3 Concurrency

Existence checks run in parallel via `Promise.all` — 180 dbs stay
under ~1 s on Core4's Mongo. Index the primary collection's `_id` for
this pattern.

### 4.4 Why filter empties

> Mike IT-F2-391 c/79446416: T3-2026-09-18 existed but was empty
> (pipeline never advanced past 09-17 because ORATS hadn't posted yet).
> SPA auto-picked it as "latest" and rendered the empty panel.

Fix: drop empty dates so "latest" always points at the newest populated
day. Every SPA adopting this recipe MUST filter — the picker itself has
no way to know a date is "there but empty".

### 4.5 Two invariants the picker cannot violate

Mike IT-F2-360 c/91a0942f 2026-09-23 (during oxc-rrg picker rollout):

1. **No selectable dates without data.** Do NOT ship the picker without
   `availableDates` populated. The graceful-degrade "every date ≤ today
   clickable" mode from §7 is fine for a single dev smoke, but MUST NOT
   ship to a customer — it lets the user pick an empty date and stare
   at the empty state. If the SPA's backend hasn't opened `/dates` yet,
   fall back to a client-side trading-day whitelist (see §4.6). Do NOT
   just disable the picker — Mike c/d189bf90 same session: "don't block
   the date picker, just don't allow specific dates to be picked that
   don't have data to support them."

2. **Chip displays the loaded snapshot's date, not "today".** This is
   an end-of-day scanner pattern — the server rolls back to the most
   recent populated db when today's isn't ready yet (per §4.4 filter +
   the f2-api `findLatestPatternDb` fallback in the `resolveDbForRequest`
   handler). The picker's `todayLabel` MUST reflect whatever date the
   server actually returned, not `todayIso()`. Pass the loaded
   snapshot's own date (usually `data.asOf` or equivalent) as
   `todayLabel` when `value === ""`.

### 4.6 Client-side trading-day whitelist (fallback until `/dates` lands)

Mike c/d189bf90 2026-09-23: when the backend `/dates` endpoint isn't
available yet, compute `availableDates` client-side from the pipeline
start date up through today, excluding weekends and US market
holidays. Cache "dirty at the top of the minute" so today's date
becomes clickable the moment the clock rolls over.

Reference implementation lives in oxc-rrg's `RealScanner.tsx` — the
`availableDates` `useMemo` keyed on a `minuteTick` state that
increments via a `setTimeout` aligned to the next minute boundary
then `setInterval(bump, 60_000)`.

Shape:

```typescript
const [minuteTick, setMinuteTick] = useState(0);
useEffect(() => {
  const bump = () => setMinuteTick((v) => v + 1);
  const now = new Date();
  const msToNextMinute = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
  const t = window.setTimeout(() => {
    bump();
    const iv = window.setInterval(bump, 60_000);
    // stash iv on the timeout handle for cleanup
    (t as unknown as { iv?: number }).iv = iv;
  }, msToNextMinute);
  return () => { /* clear both */ };
}, []);

const availableDates = useMemo(() => {
  const HOLIDAYS = new Set(["2026-01-01", /* ... NYSE calendar ... */]);
  const out: string[] = [];
  for (
    let d = new Date(`${PIPELINE_START}T12:00`);
    d.getTime() <= todayNoon();
    d.setDate(d.getDate() + 1)
  ) {
    if (d.getDay() === 0 || d.getDay() === 6) continue; // Sat/Sun
    const iso = isoOf(d);
    if (HOLIDAYS.has(iso)) continue;
    out.push(iso);
  }
  return out;
}, [minuteTick]);
```

Rules:

- **PIPELINE_START** is the earliest date the SPA's producer wrote to
  Mongo. Ask the backend lane — hardcode; won't change often.
- **HOLIDAYS** is the NYSE calendar for the current + next year.
  Extend annually.
- **Recompute cadence**: at the top of every minute. Simpler cadences
  (daily / on-focus) miss the rollover to a new trading day mid-
  session; sub-minute is unnecessary since dates change once a day.
- **Retire this** as soon as backend adds `/dates` per §4 — swap the
  useMemo for a `fetch(...).then(setAvailableDates)` on mount. Delete
  the holidays constant.

---

## 5. State machine

| State | Trigger |
|---|---|
| Closed | Initial mount, outside-click, Esc, successful pick |
| Open | Click chip |
| Cursor at value's month | On open (re-anchors every open) |

Behaviors:

- **Outside click** → close (via `document.mousedown` listener).
- **Esc** → close.
- **Click today's date** → equivalent to picking `""` (fires `onChange("")`).
- **"Back to today (live)" button** — shown only when `value !== ""`.

The popup always renders a **42-cell grid** (6 weeks) so the height
never jumps between short and long months.

---

## 6. Accessibility

- Chip has `aria-haspopup="dialog"` + `aria-expanded={open}` +
  `aria-label={ariaLabel}`.
- Popup has `role="dialog"` + matching `aria-label`.
- Prev/next month buttons have `aria-label="Previous month"` /
  `"Next month"`.
- Each day cell has `aria-pressed={isSelected}` + `aria-label={c.iso}`
  (screen-reader-friendly ISO date).
- Weekday labels are `<div>`s with visible text (not sr-only) since
  they're already compact.

Keyboard nav is currently limited to Tab + Enter + Esc. Arrow-key
grid nav is a future add if a consumer SPA needs full a11y compliance;
call it out in your ticket and I'll extend.

---

## 7. Wire-up in a consumer SPA

Minimal snippet lifted from Core4's `Cockpit.tsx`:

```tsx
const [scanDate, setScanDate] = useState<string>("");
const [availableDates, setAvailableDates] = useState<string[]>([]);

useEffect(() => {
  fetch("/api/signals/dates?days=180", { credentials: "include" })
    .then((r) => r.json())
    .then((raw) => setAvailableDates(normalizeAvailableDates(raw)))
    .catch(() => setAvailableDates([]));
}, []);

// Re-fetch data whenever scanDate changes (or first paint when it's "")
useEffect(() => {
  const q = scanDate ? `?date=${scanDate}` : "";
  fetch(`/api/signals${q}`, { credentials: "include" })
    .then((r) => r.json())
    .then((rows) => setLiveRows(rows))
    .catch(() => setLiveRows([]));
}, [scanDate]);

return (
  <SnapshotDatePicker
    value={scanDate}
    onChange={(next) => setScanDate(next || "")}
    availableDates={availableDates}
    ariaLabel="Scan date"
    todayLabel="Today"
    theme={{
      chipBg: "var(--surface2, #0e2238)",
      chipBorder: "var(--line, #1e3c5a)",
      chipText: "var(--txt, #e2e8f0)",
      iconColor: "#2dd4bf",
      popupBg: "var(--surface, #0b1830)",
      popupBorder: "var(--line, #1e3c5a)",
      dayText: "var(--txt2, #cbd5e1)",
      dayDisabledText: "var(--txt3, #3f5670)",
      accent: "var(--accent, #f97316)",
      accentText: "#ffffff",
      muted: "var(--txt3, #7a92ad)",
    }}
  />
);
```

---

## 8. Adoption checklist for a new SPA

- [ ] Import `SnapshotDatePicker` + `normalizeAvailableDates` from
      `f2tech-shared/snapshot-date-picker`.
- [ ] Add `/<rest-path>/dates` on the SPA's backend. Enumerate dated
      dbs, filter to the `days` window, drop empty dbs via a
      per-db `findOne` projection, return sorted ascending. See §4.
- [ ] Store `scanDate: string` (initial `""` = live) in SPA state.
- [ ] Fetch `availableDates` on mount; run through
      `normalizeAvailableDates` before setting state.
- [ ] Wire `onChange` to your data-loader: refetch snapshot rows
      whenever `scanDate` changes; empty string = "load latest".
- [ ] Pass a theme override to match the SPA's brand palette. Keep
      the teal calendar icon unless the customer explicitly rebrands
      it — recognition value.
- [ ] `todayLabel` reads the LOADED snapshot's date, not `todayIso()`
      (§4.5 invariant #2). Pass `data.asOf` (or whatever your store
      calls the loaded snapshot's date) formatted MM/DD/YYYY when
      `value === ""`. Core4 uses "Today" only because Core4 is a live
      strategy dashboard where "today" always has data; end-of-day
      scanners (oxc-rrg, TheoTrade, etc.) MUST show the actual date.
- [ ] `availableDates` is populated from the backend's `/dates`
      endpoint (§4). Do NOT ship without it — per §4.5 invariant #1,
      the graceful-degrade "every date ≤ today clickable" mode is for
      dev smoke only and MUST NOT reach a customer.
- [ ] Smoke: opening it with `availableDates` shows the current month
      with correct greys; last-populated day is highlighted with the
      accent outline when it IS today.

---

## 9. Reference implementation

- **Component:** `f2tech-shared/src/snapshot-date-picker.tsx` (420
  lines, single file, no build step required).
- **Consumer:** `alpha-pivot-frontend/src/scanner/Cockpit.tsx` — the
  `<SnapshotDatePicker>` block near the toolbar.
- **Backend `/dates` endpoint:** `alpha-pivot-service/src/routes/meta.mjs`,
  `app.get("/api/signals/dates", ...)`. Empty-db filter added
  IT-F2-391 c/79446416.

---

## 10. Origin

Filed at Mike's request — IT-F2-391 comment
`ce0f8d05-f72a-435b-a168-da7268a0c5f4`:

> Pull from here the info you need to do a date picker into a .md
> file in the shared docs folder too, so next time it will be
> simple to implement on another SPA.

Companion to `LIVE_DATA_SCANNER_RECIPE.md` in this same
`f2tech-shared/docs/` folder.
