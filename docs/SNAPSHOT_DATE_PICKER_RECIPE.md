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
  Mongo. Ask the backend lane — hardcode; won't change often. On the
  rare case the pipeline is years old, confirm it with the producer /
  backend owner before shipping — adopting a wrong PIPELINE_START
  renders months of unclickable grey cells.
- **HOLIDAYS** is the NYSE calendar covering the full span from
  PIPELINE_START through at least next year. **Extend backward, not
  just forward** — a holiday set that only covers "current + next
  year" wrongly offers past-year holidays (e.g. 2025 Good Friday) as
  trading days when PIPELINE_START is older than this year. Keep one
  Set with the full span.
- **Recompute cadence**: at the top of every minute. Simpler cadences
  (daily / on-focus) miss the rollover to a new trading day mid-
  session; sub-minute is unnecessary since dates change once a day.
- **When to fall back vs when to trust backend** (`/dates` is live but
  may still be empty, see §4.4): switch per-request, not per-session.
  Backend returns `[]` → use the fallback for this picker open.
  Backend returns a non-empty list → use it. This way the moment the
  producer puts a doc in today's dated DB, the next picker open shows
  it without a SPA deploy.
- **Retire this** when backend `/dates` is reliably populated AND the
  SPA's call sites always use the backend response. A hybrid state
  where fallback silently papers over a backend regression is worse
  than either pure path — add a one-line `console.warn` on fallback
  entry so a stuck /dates is visible in logs.

**Gotcha (Mike IT-F2-360 cid b8d31a6c 2026-09-23):** the interval id
in the minute-tick effect MUST live in a closure variable
(`let ivId: number | undefined`), NOT stashed as a property on the
`setTimeout` return value. Browsers return a primitive `number`
from `setTimeout`/`setInterval` and property assignment throws
`TypeError: can't assign to property "iv" on 1: not an object`,
which crashes the useEffect and takes the picker down with it.
Works in Node.js (Timeout is an object) — dies on every browser.
The reference snippet above uses the closure pattern; copy it
verbatim.

### 4.6.1 Angular / Luxon port of the client-side fallback

The React snippet above drives off `new Date()` + `getDay()`. The
Angular ports in the fleet (option-pit, flow, mti) use Luxon
`DateTime` for consistent ET-zone math. Reference impl: option-pit
`src/app/scans/zeta/zeta.component.ts` (IT-F2-287 c/34a4433).

```typescript
// Static class members
private static readonly PIPELINE_START = '2025-04-02';  // ← confirm w/ producer
private static readonly US_MARKET_HOLIDAYS = new Set<string>([
  // Spans PIPELINE_START → today + 1y. Extend annually.
  // 2025 (post-April-2 example): '2025-04-18', '2025-05-26', '2025-06-19',
  //   '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026: '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', ...
]);

private _client_side_trading_days(): string[] {
  const start = DateTime.fromISO(MyComponent.PIPELINE_START, { zone: 'America/New_York' });
  const today = DateTime.now().setZone('America/New_York').startOf('day');
  const out: string[] = [];
  let d = start;
  while (d <= today) {
    // Luxon weekday: 1=Mon..7=Sun. Skip Sat (6) + Sun (7).
    if (d.weekday < 6) {
      const iso = d.toFormat('yyyy-MM-dd');
      if (!MyComponent.US_MARKET_HOLIDAYS.has(iso)) out.push(iso);
    }
    d = d.plus({ days: 1 });
  }
  out.reverse();  // newest-first; matches backend /dates descending contract
  return out;
}

async load_dates(force = false) {
  const { dates, today } = await this.service.getDates(force);
  // Fallback trigger: backend returned an empty list (endpoint shipped but
  // the Scanners row / collection isn't populated yet) OR getDates swallowed
  // a network error into [] — treat both the same.
  if (!dates || dates.length === 0) {
    this.available_dates = this._client_side_trading_days();
    this.today_iso = DateTime.now().setZone('America/New_York').toFormat('yyyy-MM-dd');
  } else {
    this.available_dates = dates;
    this.today_iso = today;
  }
  if (this.datepickerInput?.nativeElement) this._init_datepicker();
}
```

**Angular-specific gotchas:**

- **Luxon `weekday` is 1-indexed from Monday** (1=Mon..7=Sun). JS
  `Date.getDay()` is 0-indexed from Sunday (0=Sun..6=Sat). Mixing
  the two drops the wrong days — e.g. `d.weekday === 0` is never true
  in Luxon (there is no 0), silently never-filtering, so Sat/Sun
  stays in the whitelist and the picker offers weekends. Always
  `weekday < 6` for Mon-Fri when porting from `.getDay() === 0 || 6`.
- **No `new Date("YYYY-MM-DD")` for ET math.** `new Date("2025-04-02")`
  parses as UTC midnight; `.getDay()` on an ET machine already
  west-of-UTC returns the previous weekday for the first few hours
  of each day. Construct zoned DateTimes:
  `DateTime.fromISO(iso, { zone: 'America/New_York' })`.
- **No minute-tick effect needed in Angular** when `load_dates()`
  runs on every picker-open + on tab-return (visibility change).
  Change-detection re-reads the field; the "top of the minute"
  trigger from §4.6 is a React-ism to force a `useMemo` re-run.
  If you need periodic re-compute (long-lived component, no re-open),
  use `rxjs/interval(60_000)` scoped to the component — not a bare
  `setInterval` without cleanup.
- **Match the backend's sort order.** Backend `/dates` returns
  descending (newest-first) per §4; the client-side fallback must
  do the same (`out.reverse()` after the ascending walk) or your
  "latest populated day" selection logic reads the wrong end.

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

**The picker only renders a chip + popup — the SPA owns the data
refetch.** Setting `value` doesn't do anything by itself; `onChange`
is where you re-request rows for the picked date. Skip the `onChange`
wire-up and the picker looks like it works (chip highlights, popup
closes) but the grid never updates.

### 7.1 React (canonical)

Minimal snippet lifted from Core4's `Cockpit.tsx`:

```tsx
const [scanDate, setScanDate] = useState<string>("");
const [availableDates, setAvailableDates] = useState<string[]>([]);
const [liveRows, setLiveRows] = useState<Row[]>([]);

// (1) Fetch the /dates list once on mount.
useEffect(() => {
  fetch("/api/signals/dates?days=180", { credentials: "include" })
    .then((r) => r.json())
    .then((raw) => setAvailableDates(normalizeAvailableDates(raw)))
    .catch(() => setAvailableDates([]));
}, []);

// (2) Re-fetch data whenever scanDate changes (empty string = "load
//     latest / live"). THIS is what makes picking a date actually do
//     something. Without it the chip toggles but the grid is frozen.
useEffect(() => {
  const q = scanDate ? `?date=${scanDate}` : "";
  fetch(`/api/signals${q}`, { credentials: "include" })
    .then((r) => r.json())
    .then((rows) => setLiveRows(rows))
    .catch(() => setLiveRows([]));
}, [scanDate]);

// (3) If the SPA also has a live WS, PAUSE it while browsing history
//     — otherwise late-arriving live trades corrupt the frozen
//     snapshot. Resume on scanDate === "".
useEffect(() => {
  if (scanDate) ws.pause();
  else ws.resume();
}, [scanDate]);

return (
  <SnapshotDatePicker
    value={scanDate}
    onChange={(next) => setScanDate(next || "")}
    availableDates={availableDates}
    ariaLabel="Scan date"
    todayLabel="Today"
    theme={{ /* ... palette overrides ... */ }}
  />
);
```

### 7.2 Angular port

The React reference isn't published as an Angular package — port the
component to your app's `@shared/` folder (see option-pit's
`snapshot-date-picker.component.ts` — 295 lines, single file, no
dependencies beyond `@angular/common`). Wire-up:

```typescript
// flow.component.ts
scan_date = '';
available_dates: string[] = [];

async ngOnInit() {
  // (1) Fetch /dates once on mount.
  this.flowService.getSnapshotDates().then((raw) => {
    this.available_dates = normalizeAvailableDates(raw);
  });
  // ... existing snapshot + WS wire-up ...
}

// (2) THE handler that makes picking a date do something.
async onScanDateChange(next: string) {
  this.scan_date = next || '';
  // Pause live WS while browsing history; resume when back on today.
  if (this.scan_date) {
    this.flowService.disconnect();
  } else {
    this.flowService.reconnect();
  }
  // Refetch snapshot with ?date=YYYY-MM-DD (empty = live).
  const snap = await this.flowService.getSnapshot(500, tier, this.scan_date);
  this.trades = (snap || []).map((raw) => this._normalize(raw));
  this._recompute_visible();
}
```

```html
<!-- flow.component.html -->
<f2-snapshot-date-picker
  [value]="scan_date"
  [availableDates]="available_dates"
  ariaLabel="Scan date"
  todayLabel="Today"
  (change)="onScanDateChange($event)">
</f2-snapshot-date-picker>
```

**Gotchas the Angular port keeps biting:**

- **`*ngFor` needs `trackBy` + a cached array, NOT a function call.**
  If your template does `*ngFor="let c of cells()"` where `cells()`
  returns a new Cell[] per invocation, Angular re-creates every day
  `<button>` on every CD cycle. Between mousedown and click the DOM
  button under the user's cursor is destroyed — the click fires on
  nothing and pick() never runs. **Cache the cells in a property**
  (rebuilt only when cursor / value / availableDates change) AND
  key the ngFor with `trackBy` on `c.iso`. Bit option-pit
  IT-F2-432 5e4adf3 for ~30 minutes before diagnosis — Mike:
  "WTF? I still can't click on the 29th". Reference impl:
  option-pit `src/app/@shared/snapshot-date-picker.component.ts`.
- **Skip `event.stopPropagation()` in the picker's click handlers.**
  It stops Angular's zone from re-entering to process the emit's
  downstream side effects, and nothing in the picker's tree needs
  it. `preventDefault()` on a `type="button"` also does nothing
  useful. Just drop both.
- **Don't use `ChangeDetectionStrategy.OnPush`.** Default CD is
  safer here — the picker's state is small enough that the perf
  cost is negligible, and OnPush + click events + @Output emit has
  edge cases that silently swallow emits under certain CD timing.
- `@Output() change = new EventEmitter<string>()` — Angular routes
  parent's `(change)="..."` to your custom @Output, NOT the native
  `change` DOM event. Naming it `change` is fine.
- Handler MUST refetch. Setting the parent's `scan_date` state alone
  doesn't reload the grid — Angular's `[rowData]` binding on
  AG-Grid re-renders only when the row array reference changes, and
  no reference changes until you call `getSnapshot(...date)` and
  reassign `this.trades`.

---

## 8. Adoption checklist for a new SPA

- [ ] Import `SnapshotDatePicker` + `normalizeAvailableDates` from
      `f2tech-shared/snapshot-date-picker` (React), OR port the
      component to `@shared/` (Angular — see §7.2).
- [ ] Add `/<rest-path>/dates` on the SPA's backend. Enumerate dated
      dbs, filter to the `days` window, drop empty dbs via a
      per-db `findOne` projection, return sorted ascending. See §4.
      **Verify with a curl before wiring the SPA** — response should
      be a bare array (or `{dates:[...]}` — either shape works with
      `normalizeAvailableDates`).
- [ ] Store `scanDate: string` (initial `""` = live) in SPA state.
- [ ] Fetch `availableDates` on mount; run through
      `normalizeAvailableDates` before setting state.
- [ ] **Wire `onChange` to your data-loader** (§7). This is the load-
      bearing step — the picker only manages the chip + popup. Without
      an onChange handler that refetches rows for the picked date, the
      chip toggles but the grid stays frozen. **If you skip this the
      picker looks broken.**
- [ ] If the SPA also has a live WS: pause the WS when `scanDate !== ""`
      (frozen snapshot; late-arriving live rows corrupt history) and
      resume when the user picks "Back to today" (`scanDate === ""`).
      Disable any Pause/Resume UI while a historical date is loaded
      so the user can't accidentally re-open the live stream.
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
      dev smoke only and MUST NOT reach a customer. If the backend
      `/dates` isn't live yet or is reliably returning `[]` because
      the Scanners row / collection isn't populated, wire the §4.6
      client-side trading-day whitelist (not graceful-degrade).
- [ ] US_MARKET_HOLIDAYS set covers from PIPELINE_START through the
      next NYSE calendar year — **backward AND forward**. A set that
      only covers the current + next year will offer past-year
      holidays (e.g. 2025 Memorial Day) as trading days if your
      pipeline-start is older than this year.
- [ ] Angular ports: confirm Luxon `.weekday` indexing (1=Mon..7=Sun)
      vs JS `Date.getDay()` (0=Sun..6=Sat) when porting the §4.6
      snippet. See §4.6.1 for the ported snippet.
- [ ] Smoke: opening it with `availableDates` shows the current month
      with correct greys; last-populated day is highlighted with the
      accent outline when it IS today. **Pick a past date — the grid
      MUST reload with that day's snapshot.** If the grid stays on
      today's data, your onChange handler isn't refetching (§7 (2)).

---

## 9. Reference implementation

- **Component:** `f2tech-shared/src/snapshot-date-picker.tsx` (420
  lines, single file, no build step required).
- **Consumer:** `alpha-pivot-frontend/src/scanner/Cockpit.tsx` — the
  `<SnapshotDatePicker>` block near the toolbar.
- **Backend `/dates` endpoint:** `alpha-pivot-service/src/routes/meta.mjs`,
  `app.get("/api/signals/dates", ...)`. Empty-db filter added
  IT-F2-391 c/79446416.
- **Angular + Luxon client-side fallback:**
  `option-pit/src/app/scans/zeta/zeta.component.ts` —
  `_client_side_trading_days()` + `load_dates()` fallback switch.
  IT-F2-287 c/34a4433.

---

## 10. Origin

Filed at Mike's request — IT-F2-391 comment
`ce0f8d05-f72a-435b-a168-da7268a0c5f4`:

> Pull from here the info you need to do a date picker into a .md
> file in the shared docs folder too, so next time it will be
> simple to implement on another SPA.

Companion to `LIVE_DATA_SCANNER_RECIPE.md` in this same
`f2tech-shared/docs/` folder.
