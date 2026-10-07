# AG-Grid Infinite-Scroll with Demand-Load Recipe

Canonical recipe for displaying a large collection in an AG-Grid
without front-loading the whole thing. The grid paints the first ~2
screen-fulls, shows a cursor-aware "N shown / TOTAL available" tally
in the footer, and demand-loads additional rows via a cursor-paged
REST endpoint as the user scrolls (or clicks a Load-more / page
control).

Pattern is a sibling of `SNAPSHOT_DATE_PICKER_RECIPE.md`: data-side
pagination that complements the SPA-side date snapshot flow.

---

## 1. When to use this

Reach for this when the backend collection for a given snapshot can
exceed ~500 rows AND you don't actually need all of them to render
the first paint:

- **OS Flow** — hundreds of thousands per day. Grid paints in <2s;
  the full count never loads.
- **Zeta** (IT-F2-287) — ~500-1200/day. First screen fine without
  paging, but we still want the "N / TOTAL" tally.
- **RR** (IT-F2-287) — ~20-30/day. **Below the pagination threshold** —
  loading the full set is cheaper than two round trips. Skip the
  recipe here.

Rule of thumb: adopt when a single snapshot regularly exceeds 300
rows OR when the row shape is large (>2KB per doc).

---

## 2. Backend contract

f2-api's Append views (per `F2-ADMIN.Scanners.<id>.Stream.Append:true`)
already carry the primitives — no backend change needed to adopt this
on existing scanners.

### 2.1 Rows endpoint

```
GET /rest/<rest-path>?limit=<N>&after=<cursor-id>
```

- `limit` — rows to return (default 200, max 2000).
- `after` — opaque cursor; passed back as `nextCursor` in the previous
  response. Omit on first call.
- Response:
  ```json
  {
    "rows": [...],
    "db": "OptionPit_LIVE-2026-10-07",
    "collection": "Zeta-Alerts",
    "asOf": "2026-10-07T20:03:21.126Z",
    "nextCursor": "<id-hex-or-null>"
  }
  ```
- `nextCursor` is `null` when the server returns fewer than `limit`
  rows — i.e., end of stream for this snapshot.

### 2.2 Count endpoint

```
GET /rest/<rest-path>/count
```

Same query params as `/rows` (`?filter=<json>`, `?unfiltered=1`,
`?date=YYYY-MM-DD`, `?collection=<name>` — see f2-api's
Append-view REST handlers in `server.js:2270+`). Response:

```json
{ "total": 587, "collection": "Zeta-Alerts", "asOf": "..." }
```

Count is the filtered total across the full snapshot — not scoped to
cursor. Fire-and-forget on page load + whenever the filter changes.
The rows paint before the count returns; the UI updates the
denominator when the count scan finishes.

---

## 3. SPA integration (AG-Grid clientside row model + append)

Two viable paths with AG-Grid:

| Path | When to use |
|---|---|
| **Clientside + append on scroll** (recommended default) | Snapshot ≤ ~5000 rows total. All loaded rows live in memory. Simplest to adopt, trivially supports WS live-row inserts. |
| **Infinite row model with cursor map** | Snapshot ≫ 5000 rows OR memory-sensitive deployments. Random-access scrolling needs a cursor map rebuilt on every filter change — more code, more edge cases. |

This recipe covers the recommended default. Use the infinite-model
path only when you've measured the clientside path too slow or too
memory-heavy on real production snapshots.

### 3.1 Component state

```typescript
all_alerts: any[] = [];           // accumulates across pages
filtered_alerts: any[] = [];      // after client-side filter (search box)
_next_cursor: string | null = null;
_loading_page = false;            // guard against double-fire on scroll
_total: number | null = null;     // from /count; null until loaded
_page_size = 200;                 // rows per demand-load page
```

### 3.2 Initial load

```typescript
async load_alerts(iso?: string | null) {
  this.all_alerts = [];
  this._next_cursor = null;
  this._total = null;
  // First page.
  const res = await this.service.getAlerts({
    date: iso ?? null,
    unfiltered: this.active_tab === 'all',
    limit: this._page_size,
    after: null,
  });
  if (res?.rows) {
    this.on_snapshot(res.rows);
    this._next_cursor = res.nextCursor ?? null;
  }
  // Count (independent — don't block the paint on it).
  this.service.getCount({
    date: iso ?? null,
    unfiltered: this.active_tab === 'all',
  }).then((c) => { this._total = c?.total ?? null; });
}
```

### 3.3 Demand-load on scroll

AG-Grid fires `bodyScroll` + `bodyScrollEnd` events. Use
`bodyScrollEnd` (fires once at rest) + a scroll-position check:

```typescript
async on_body_scroll_end(ev: any) {
  if (this._loading_page || this._next_cursor == null) return;
  // Trigger when the user is within ~2 blocks of the bottom.
  const api = this.grid?.api;
  if (!api) return;
  const lastDisplayed = api.getLastDisplayedRow?.() ?? -1;
  const totalDisplayed = api.getDisplayedRowCount?.() ?? this.all_alerts.length;
  const threshold = totalDisplayed - (this._page_size / 2);
  if (lastDisplayed < threshold) return;

  this._loading_page = true;
  try {
    const res = await this.service.getAlerts({
      date: this.current_iso ?? null,
      unfiltered: this.active_tab === 'all',
      limit: this._page_size,
      after: this._next_cursor,
    });
    if (res?.rows?.length) {
      // Append — don't replace. applyTransaction keeps scroll position.
      this.all_alerts = [...this.all_alerts, ...res.rows];
      api.applyTransaction({ add: res.rows });
      this._next_cursor = res.nextCursor ?? null;
    } else {
      this._next_cursor = null;  // end of stream
    }
  } finally {
    this._loading_page = false;
  }
}
```

Wire up in grid options:

```typescript
gridOptions: {
  rowData: [],
  onBodyScrollEnd: this.on_body_scroll_end.bind(this),
  // ... everything else as before
}
```

### 3.4 Footer tally

```html
<div class="footer">
  <span>
    Showing
    <strong>{{ filtered_alerts.length }}</strong>
    of
    <strong>{{ _total !== null ? _total : '…' }}</strong>
  </span>
</div>
```

`filtered_alerts.length` reflects the current client-side search-box
filter; `_total` is the full snapshot count. Both change independently:
scrolling updates `filtered_alerts.length` as blocks load; filter
changes trigger a fresh `/count` call.

### 3.5 Filter changes

Any filter / date / tab change invalidates the page cache:

```typescript
async on_filter_change() {
  await this.load_alerts();   // resets all_alerts + cursor + total
}
```

The `/count` call fires in parallel and updates the denominator when
it lands. Don't block the UI on `/count` — it does a full-collection
`$count` aggregation and can be slow on large snapshots.

---

## 4. Live-WS appends (append views only)

Append-view scanners also stream live rows via WS. When a doc arrives:

```typescript
on_live_append(doc: any) {
  if (!doc) return;
  // Dedup by _id — WS can re-fire for docs already in the REST snapshot
  // (change-stream backfill, subscribe-time replay, reconnects).
  const id = doc._id;
  if (id != null && this._seen_ids.has(id)) return;
  if (id != null) this._seen_ids.add(id);

  // Prepend to keep sort-desc semantics (newest at top).
  this.all_alerts = [doc, ...this.all_alerts];
  if (this.grid?.api) {
    this.grid.api.applyTransaction({ add: [doc], addIndex: 0 });
  }
  // Bump the total since this is a new doc on the snapshot.
  if (this._total !== null) this._total += 1;
}
```

**Important:** DO NOT re-fetch `/count` on every live append — hundreds
of appends per minute would hammer the backend. Increment the local
`_total` instead. If you suspect drift, re-fetch on a long cadence
(e.g. every 60s or on visibilitychange).

---

## 5. Common pitfalls

- **Double-fire on scroll** — `bodyScroll` fires continuously as the
  user drags. Always guard with `_loading_page`. Prefer
  `bodyScrollEnd` which only fires once at rest.
- **End-of-stream vs transient empty page** — `nextCursor:null` is the
  server telling you "no more rows." Setting `_next_cursor = null`
  disables further demand-loads. If you ever re-enable paging after
  that (e.g. date change), reset to the fresh cursor from the new
  initial load.
- **Filter after load** — AG-Grid's `quickFilter` works on the
  already-loaded rows. If the user filters out everything on screen,
  the scrollbar never reaches the bottom and demand-load never
  fires — the UI just shows "0 shown of 587." That's correct
  behavior for client-side filtering; if the backend's filter can
  express the same query, send it via `?filter=` on load + count
  instead and let the server narrow the universe first.
- **AG-Grid v33 column widths** — don't call `sizeColumnsToFit` after
  every `applyTransaction({add})`. Column widths jump mid-scroll.
  Fit once on `gridReady`, let widths stick.
- **Cursor opacity** — the cursor is opaque to the SPA; don't parse it.
  f2-api uses `_id` hex but that's an implementation detail that may
  change.
- **asOf drift** — the first-page `asOf` and the second-page `asOf`
  are a few seconds apart. If you snapshot `asOf` for a "data as of"
  badge, use the LATEST page's asOf, not the first. Otherwise the
  badge lies after a live append arrives.

---

## 6. Adoption checklist

- [ ] Confirm backend endpoint supports `?limit` + `?after` + sibling
      `/count` (standard on every f2-api Append view).
- [ ] Service-layer: `getAlerts({date, unfiltered, limit, after})`
      returns `{rows, nextCursor, ...}`. `getCount({date, unfiltered})`
      returns `{total, ...}`.
- [ ] Component state: `_next_cursor`, `_loading_page`, `_total`,
      `_page_size` (default 200).
- [ ] Initial load fetches first page via REST + fires `/count` in
      parallel; count populates when it lands.
- [ ] `onBodyScrollEnd` wired to a guarded demand-load that calls
      `applyTransaction({ add: nextPage })` + updates `_next_cursor`.
- [ ] Live WS appends prepend via `applyTransaction({ add: [doc], addIndex: 0 })`
      + increment local `_total`.
- [ ] Filter/date/tab change calls `load_alerts()` which resets
      `_next_cursor` + re-fires `/count`.
- [ ] Footer renders "N of TOTAL" via `filtered_alerts.length` and
      `_total`.
- [ ] Smoke: scroll to the bottom; demand-load fires once, grid grows,
      scrollbar extends. Scroll again; next page loads. When
      `nextCursor:null` arrives, scrolling further is a no-op.

---

## 7. Reference implementation

- **Component (clientside + append):** `option-pit/src/app/scans/zeta/zeta.component.ts` — IT-F2-287 (pending ship after c/aa9af843).
- **Backend `/alerts` + `/count`:** `f2-api/server.js:2270+` (REST) and `:2402+` (count), both auto-registered from Scanners.<id>.Stream.Append:true.
- **Live-WS matcher:** `f2-api/server.js matchesFilterSpec` — the same filter spec gates REST + WS so a page's `?filter=` matches the live stream the SPA opens with `{filter:...}` subscribe.

---

## 8. Origin

Filed at Mike's request — IT-F2-287 comment `c49ebd8b` 2026-10-07:

> we need a paging feature so the total at the bottom shows the total
> possible for the view, but it only loades enogh for the sorted and
> filter view to display items a couple of pages at a time to optimize
> bandwitdh utilization and when you page or scroll down the view will
> demand load those items. this should also be a new generic common
> .md recipe because we do this allot with other views and have to
> spend a lot of time repeating these design qualifications /
> expectations.

Companion to `SNAPSHOT_DATE_PICKER_RECIPE.md` + `LIVE_DATA_SCANNER_RECIPE.md`
+ `SCANNER_DATA_WIRING_RECIPE.md` in this same `f2tech-shared/docs/` folder.
