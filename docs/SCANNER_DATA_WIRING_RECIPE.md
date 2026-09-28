# Scanner Data Wiring Recipe

Canonical recipe for **connecting a scanner SPA to real per-day database
data + purging built-in / placeholder data**. Distilled from the traps
between "mockup rendering static rows" and "live rows driven by the
producer's schema, adapter, quintiles, and joins" — so the next
scanner doesn't repeat the cycle.

Scope is deliberately generic. Substitute your scanner's collection
prefix, field names, and slice labels in every fenced example — none
of them are load-bearing outside the pattern they demonstrate. The
reference-implementation pointers in §10 name a specific existing
scanner so a reader can go read live code, but the recipe body should
apply to any per-day scanner.

Companion recipes in this folder:

- `LIVE_DATA_SCANNER_RECIPE.md` — live/delayed data chip + agreements.
- `SNAPSHOT_DATE_PICKER_RECIPE.md` — the historical date picker.

---

## 1. The producer contract

The producer (C++ / Python / whatever writes to mongo) publishes one
database per trading day, following a canonical `<PREFIX>-YYYY-MM-DD`
pattern.

```
mongo host: <mongo-host>:27017
databases:  <PREFIX>-YYYY-MM-DD     (per-day)
collections per db:
  Primary          — the row-per-symbol scanner output
  <Primary>_<X>    — related tables (options, alerts, backtest, …)
  __schema__       — singleton doc holding the k## → real-name map
                     (present on Primary + every related collection
                     that uses k-numbered fields).
```

### 1.1 `__schema__` singleton (CSA convention)

To keep per-day databases small, producers store field names as
`k1`, `k2`, `k3`, … and put the human-readable names in a singleton at
`_id: "__schema__"`. Two accepted shapes:

```jsonc
// Object form
{ "_id": "__schema__", "schema": { "k1": "symbol", "k2": "signal", ... } }

// Positional-array form (index 0 → k1)
{ "_id": "__schema__", "schema": ["symbol", "signal", ...] }
```

Adapters MUST support both. If the singleton is absent or malformed,
the adapter degrades to pass-through (row keys used as-is) — no
throwing.

### 1.2 Row `_id` convention for related collections

Joinable child collections use a composite `_id` embedding the join
keys, e.g.:

```
<Primary>_Options _id:  <symbol>_<entry_date>_<tier>
<Primary>_Alerts  _id:  <symbol>_<entry_date>_<kind>
```

Never parse this format with a greedy regex — split on the first `_`
for the symbol prefix, then peel from the right for the tier / algo
suffix. See §8.3 for the trap.

### 1.3 Field-mapping contract

Before writing a single line of adapter code, get an authoritative
field mapping from the producer. This is the source-of-truth
translation Mike calls out on every scanner rollout.

Minimum shape of the mapping doc (post on the ticket, keep in the
adapter as a comment block):

| Producer field | Adapter output | Notes |
|---|---|---|
| `<producer_name_1>` | `<spa_field_1>` | Direct pass-through / rename / unit conversion / enum re-label — spell out which |
| `<producer_direction>` | `<spa_signal>` | If the producer emits an enum ("LONG"/"SHORT" or similar) and the SPA renders a friendlier label, do the swap here |
| `<producer_long_form>` | `<spa_short_form>` | Long descriptive strings often need a short display extract |
| `<producer_price>` | `<spa_price>` | Which price field (last close, mark, mid) and how it's timestamped |
| `<producer_date>` | `<spa_date>` | ISO YYYY-MM-DD; document which date semantically (signal date vs entry date vs close date) |
| ... | ... | ... |

Every non-trivial mapping (hardcoded per-row constants, unit
conversions, enum re-labels) MUST be documented in this table. If the
producer ships without a mapping, file a §9.5 clar on the umbrella
ticket — do not guess.

---

## 2. Backend adapter — the translation layer

The SPA MUST NOT know about `k##` field names, schema singletons, or
per-tier join _id formats. The backend service (yours per-scanner,
`alpha-pivot-service`-style) owns the translation.

### 2.1 File layout

```
<your-scanner-service>/src/
  routes/
    meta.mjs        — /api/signals, /api/signals/dates, /api/signals/alerts
    scanner.mjs     — readCollectionWithFallback + collection map
  mongo.mjs         — connection + listDatabases + latestDbName helpers
```

### 2.2 Adapter pipeline (per request)

1. Resolve the target database — by explicit `?date=YYYY-MM-DD` or
   fallback to `latestPopulatedDbName()`.
2. `buildSchemaMap(schemaDoc)` — normalizes both the object and
   positional-array `__schema__` shapes into `{ k1: name, k2: name, … }`.
3. Fetch the primary collection's rows (excluding the schema doc via
   `{ _id: { $ne: "__schema__" } }`).
4. `remapKeys(row, schemaMap)` — replaces `k##` with real names on
   each row; pass-through for real-name keys.
5. Compute per-batch derived fields (see §3).
6. Fetch related collections and build their join maps (see §4).
7. Emit the SPA-shaped row from `adaptRowBatch(rows, joinMaps, …)`.

### 2.3 Never let the adapter's fallback be silent

If the producer emits a field the adapter didn't expect, the row
should still ship — with an explicit `null` or `"—"` so the SPA can
render the missing-data affordance. Silent adapter drops turn into
"why is the grid half empty" tickets weeks later. Log a `warn` line
with `{ symbol, missingField, rowSample }` when the fallback fires.

---

## 3. Per-batch computed fields

Any per-row metric that ranks against the day's cohort (Potential,
Intensity, Snap, Buzz, whatever your SPA calls quintile-bucketed
values) is computed **per-batch** on the adapter — never hardcoded in
the SPA and never persisted to the producer.

Rationale: the shape of the day's cohort shifts. Yesterday's `p60`
breakpoint for a ranking metric is not today's. If you hardcode
breakpoints or shift the compute to the SPA, you get wrong buckets on
smaller / larger snapshot days.

### 3.1 Quintile shape

```js
function computeQuintileBreakpoints(samples) {
  const clean = samples.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const q = (p) => { /* linear-interpolated */ };
  return { p20: q(0.20), p40: q(0.40), p60: q(0.60), p80: q(0.80) };
}

function quintileBucket(value, breaks) {
  if (!Number.isFinite(value) || !breaks) return null;  // renders "no data"
  if (value < breaks.p20) return 1;
  if (value < breaks.p40) return 2;
  if (value < breaks.p60) return 3;
  if (value < breaks.p80) return 4;
  return 5;
}
```

Values that aren't finite return `null` — the SPA renders a
"no data" affordance rather than a synthetic 0.

### 3.2 Cohort filter for the bucket

Some metrics only make sense on a subset of rows (e.g. a metric that's
only defined for ACTIVE rows). The cohort filter goes on the adapter
side:

```js
const activeSamples = rows
  .filter((r) => r.status === "ACTIVE" && Number.isFinite(r.rankingMetric))
  .map((r) => r.rankingMetric);
const breaks = computeQuintileBreakpoints(activeSamples);
// ... per row:
bucket: isActive
  ? quintileBucket(row.rankingMetric, breaks)
  : null,   // non-ACTIVE rows deliberately null
```

Document the cohort filter in the field-mapping table (§1.3).

---

## 4. Multi-collection joins

Related collections (options tables, alerts feeds, backtest results)
are pulled once per batch and joined per row. Two common shapes:

### 4.1 Composite-id keyed join

```js
async function loadRelatedByKey(database, collectionName) {
  const map = new Map();  // key: `${symbol}|${date}` → { <slice1>, <slice2>, <slice3> }
  const coll = database.collection(collectionName);
  const schemaDoc = await coll.findOne({ _id: "__schema__" });
  const schemaMap = buildSchemaMap(schemaDoc);
  const rows = await coll.find(
    { _id: { $ne: "__schema__" } },
    { projection: { _id: 1 } }
  ).toArray();
  const idParts = [];
  for (const r of rows) {
    // <symbol>_<YYYY-MM-DD>_<slice> — adjust the regex to your producer's shape.
    const m = String(r._id).match(/^([A-Za-z0-9._-]+)_(\d{4}-\d{2}-\d{2})_([A-Za-z0-9]+)$/i);
    if (m) idParts.push({ id: r._id, symbol: m[1], date: m[2], slice: m[3].toLowerCase() });
  }
  const ids = idParts.map((p) => p.id);
  const fullRows = await coll.find({ _id: { $in: ids } }).toArray();
  const byId = new Map(fullRows.map((r) => [r._id, remapKeys(r, schemaMap)]));
  for (const p of idParts) {
    const key = `${p.symbol}|${p.date}`;
    let bucket = map.get(key) ?? {};
    bucket[p.slice] = byId.get(p.id);
    map.set(key, bucket);
  }
  return map;
}
```

Two round-trips (id enumeration + full fetch by id) beat one large
scan when the collection has more rows than the current day's join
keys need.

### 4.2 Symbol-keyed grouping

```js
async function loadRelatedBySymbol(database, collectionName, kindLabel, logger) {
  const map = new Map();
  try {
    const coll = database.collection(collectionName);
    const schemaMap = buildSchemaMap(await coll.findOne({ _id: "__schema__" }));
    const rows = await coll.find({ _id: { $ne: "__schema__" } }).toArray();
    for (const raw of rows) {
      const r = remapKeys(raw, schemaMap);
      let symbol = typeof r.symbol === "string" ? r.symbol.toUpperCase() : null;
      if (!symbol && typeof r._id === "string") {
        const idx = r._id.indexOf("_");   // split on FIRST underscore only
        if (idx > 0) symbol = r._id.slice(0, idx).toUpperCase();
      }
      if (!symbol) continue;
      const entry = map.get(symbol) ?? { kinds: [], docs: [] };
      entry.kinds.push(kindLabel);
      entry.docs.push({ ...r, symbol });
      map.set(symbol, entry);
    }
  } catch { /* collection may not exist on older dbs */ }
  logger?.info({ collectionName, mapSize: map.size }, "loadRelatedBySymbol result");
  return map;
}
```

Wrap the collection read in try/catch — related collections often
appear later in the producer's rollout than the primary. Missing
collection → empty map → SPA renders the "no alert" affordance.

### 4.3 Join misses are legal — surface them, don't hide them

Not every row will have a join hit. Log the coverage rate at INFO on
the response line:

```
/api/signals served { rowCount: 252, fullJoinRows: 77,
                     partialJoinRows: 107, noJoinRows: 68, … }
```

A join rate of 100% "for the wrong reason" (a hardcoded fallback
silently synthesizing rows the join missed) is a common regression.
Explicit `null` for a missed join is better than a synthesized dummy.

---

## 5. `/dates` endpoint — empty-day filter is mandatory

Every scanner SPA that offers historical browsing needs a `/dates`
endpoint (see `SNAPSHOT_DATE_PICKER_RECIPE.md` §4). Critical rule
lifted here:

- Enumerate databases matching your prefix.
- For each candidate, hit the primary collection with a projection-only
  `findOne({ _id: { $ne: "__schema__" } }, { projection: { _id: 1 } })`.
- Only return dates whose db has at least one non-schema doc.
- Empty databases (pipeline hasn't populated yet, upstream data source
  didn't deliver) are dropped so `"latest"` always points at the
  newest populated day.

Skipping the filter means the SPA auto-picks an empty date and
renders the empty state on load — every scanner has hit this once.

---

## 6. SPA fetch state machine — three states, not two

The SPA MUST distinguish loading / empty / error explicitly. A
two-state (loading vs data-or-nothing) machine leads to the "why does
it show 'no data' for 300 ms before rendering?" complaint.

```ts
type FetchState = "idle" | "loading" | "loaded" | "error";
const [fetchState, setFetchState] = useState<FetchState>("idle");
```

Render decision tree:

- `fetchState === "loading"` → skeleton or "Loading X signals…" panel.
- `fetchState === "loaded" && rows.length === 0` → "No signals for
  {scanDate}. Try another date or check /api/signals?date={scanDate}
  in Network for the raw payload."
- `fetchState === "loaded" && rows.length > 0` → real grid.
- `fetchState === "error"` → error panel + retry.

Never render placeholder rows while `fetchState === "loading"` — even
if the SPA has cached data from a previous fetch. Stale-while-revalidate
looks like a hallucination when the user clicked a different date and
sees yesterday's rows still on screen.

---

## 7. Purging built-in / placeholder data

Hardcoded mock data lingering behind fallback branches is the single
largest source of iteration on any new scanner. Purge in this order:

### 7.1 Static row arrays

Delete every `const MOCK_ROWS = [...]`, `RAW_SNAPSHOT = […]`,
`SAMPLE_DATA = […]`. Even if they're only imported by "debug" paths.
They will get accidentally re-imported later.

### 7.2 Hardcoded constants that leak into per-row logic

Common example: a "X always highlighted" bug where a `MOCK_META.<key>`
constant survives the mockup phase and is still consulted by the
grid's star / highlight gate. Every hardcoded default like this must
go — the SPA reads real per-row flags from the adapter output.

Grep aggressively:

```
grep -rE "MOCK_|SAMPLE_|PLACEHOLDER_|DEMO_|FAKE_|STATIC_" src/
grep -rE "defaultTier|recoTier|hardcoded|HARDCODED" src/
```

### 7.3 Fallback-to-mock branches

Anything like:

```ts
// DELETE:
const rows = liveRows.length > 0 ? liveRows : MOCK_ROWS;
```

Ship the empty state instead. If Mike sees an empty state and asks
for a placeholder, you can add ONE explicit `<EmptyStateHint>` — but
never fall back to visually-real-looking synthesized rows.

### 7.4 Fake-looking numbers

Any per-row default that renders as `0.30` for IV, `100` for spot,
`0` for pl, etc. must be reviewed. `null` + `"—"` in the cell is
correct; a synthetic zero is wrong because users will trade off it.

### 7.5 Migration rule (feedback memory)

> Never drop a hardcoded UI-visible default before the source-of-truth
> is verified populated.

Rule of three:

1. Endpoint live (adapter deployed, returns 200).
2. Source-of-truth doc populated (producer wrote the field on real days).
3. SPA reads from the endpoint.

Skip any of those, keep the hardcoded fallback with a clear
`!loaded || fetched.length === 0 → renderPlaceholder` gate that is
IMMEDIATELY removed once all three land. Don't do this as a swap —
ship it as a prioritized fallback, then remove.

---

## 8. Gotchas caught during past scanner rollouts

Each of these has cost at least one round-trip with the customer or a
peer lane on prior scanners. Learn them here so your rollout doesn't
re-earn them.

### 8.1 The `__schema__` step is not optional

Reading a k-numbered document without remapping produces an object
whose fields are all `undefined` to the SPA. The grid renders "—"
across the board and looks like a join miss. Symptom: every cell is
"—", but the row count matches expected.

Fix: `remapKeys(row, buildSchemaMap(schemaDoc))` before ANY field
access. Add a debug log that emits `{ schemaMapSize, firstRealFieldName }`
so you can spot-check the remap on first request.

### 8.2 Empty-day database → SPA auto-picks it as "latest"

Producer hasn't populated today's db yet. `/dates` returns it. SPA
picks it. Grid renders empty. See §5 for the fix.

### 8.3 Greedy regex on composite `_id` fields

```js
// WRONG — greedy, matches "ABC_2026-07-09" as the "symbol" because
// `_` is in the char class and the trailing `_` matches the second
// underscore before "algo".
// Given _id = "ABC_2026-07-09_algo"
const m = _id.match(/^([A-Z][A-Z0-9._-]*)_/);   // group 1 = "ABC_2026-07-09"

// RIGHT — split on FIRST underscore
const idx = _id.indexOf("_");                    // 3
const symbol = _id.slice(0, idx);                // "ABC"
```

If your join key includes dashes or dots in the leading token
(unlikely for symbols but common for ISO dates), tighten the regex.
Never let `_` back into the char class.

### 8.4 Per-tier / per-slice flags MUST come from producer

Star flags, recommended-slice flags, alert-bucket flags — all live on
the producer's per-slice boolean fields. The SPA reads per-row; a row
can have 0 / 1 / 2 / … stars depending on the flag. Do NOT hardcode
"the middle slice is always starred" or "the first row is always
alertable". These end up as "why does every row look identical"
regressions on customer smoke.

### 8.5 Loading vs empty state confusion

Symptom: user reports "why does the panel flash 'no data' for 300 ms
before loading?". Fix: distinct `loading` state per §6.

### 8.6 Producer field renames

When the producer renames a field (or adds a new one that supersedes
an old one), the adapter needs a compatibility branch:

```js
const value = row.new_field_name ?? row.legacy_field_name ?? null;
```

Keep the compatibility branch for one grace release, then remove the
legacy fallback once the producer's rolling change lands everywhere.
Document the removal in a checklist item on the umbrella.

### 8.7 Direct-mongo writes bypass the adapter cache

If your service has a `Customers.<slug>.<sub-doc>` cache with a TTL
(common pattern on `f2-admin-service2`), direct `mongosh` writes
DON'T invalidate it. Symptom: you edit the doc in mongo, the SPA
still reads the old value. Fix: pm2-restart the service OR prefer
the admin UI's PUT which invalidates the cache.

### 8.8 Adapter changes need backend deploy — SPA changes need alias re-point

Every backend adapter change: `git push` → SSH `git pull` +
`pm2 delete + start`. Every SPA change: `git push` → Vercel auto-build
→ **manually re-alias** the customer-facing alias to the new deployment
id (Vercel doesn't auto-follow manually-pinned aliases).

See `LIVE_DATA_SCANNER_RECIPE.md` §11.7 for the vercel.json rewrites
that route the SPA's `/api/*` to your backend.

---

## 9. Adoption checklist for a new scanner

Backend:

- [ ] `mongo.mjs` helper: `listDatabases()` filtered by your prefix,
      `latestPopulatedDbName()` (uses §5's existence check).
- [ ] `readCollectionWithFallback()` that tries the current collection
      name and falls back to any legacy name during a rename window.
- [ ] `/api/signals` — reads the primary collection, remaps k##,
      computes per-batch quintiles + cohort flags, joins related
      collections, returns shaped rows.
- [ ] `/api/signals/dates?days=N` — enumerates + empty-filters + sorts.
      See `SNAPSHOT_DATE_PICKER_RECIPE.md`.
- [ ] `/api/signals/alerts` (if you have an alerts feed) — reads
      related collection, filters by tab predicate.
- [ ] Structured INFO log line on every /signals response with
      `{ db, rowCount, joinCounts, sampleField }` so future
      "why is X empty" tickets have data.

SPA:

- [ ] `docToRow()` maps adapter output to renderable row objects.
- [ ] Grep-clean of MOCK / PLACEHOLDER / SAMPLE / DEMO / FAKE
      constants (§7.2).
- [ ] `fetchState` machine (§6) with distinct loading / empty / error
      renders.
- [ ] Per-row star / meter values come from real producer-emitted
      fields (per-slice boolean flags, quintile bucket integers) —
      not hardcoded per-row constants.
- [ ] No fallback-to-mock branches (§7.3).
- [ ] Empty-state text names the date + suggests the network-tab
      debug path so users can self-service.

Producer contract (get from data lane before you write the adapter):

- [ ] Field-mapping table (§1.3) posted on the umbrella ticket.
- [ ] `__schema__` singleton confirmed present on primary + related
      collections.
- [ ] `_id` format for related collections documented.
- [ ] Per-tier / per-slice boolean flags emitted where relevant.
- [ ] Rollout day communicated so the SPA can plan its "kill the
      hardcoded fallback" ship.

Smoke:

- [ ] Empty-day filter fires: pick a date the producer hasn't
      populated → date is greyed on the picker.
- [ ] Join-miss row renders with "—" cells, not with synthesized
      values.
- [ ] Quintile breakpoints move day-to-day (log them; verify the
      p20/p60 values change on a different snapshot).
- [ ] Grep confirms no `MOCK_` / `SAMPLE_` / `PLACEHOLDER_` constant
      remains in the SPA source.

---

## 10. Reference implementation

- **Backend adapter:** `alpha-pivot-service/src/routes/meta.mjs`.
- **SPA consumer:** `alpha-pivot-frontend/src/scanner/Cockpit.tsx`,
  `docToRow()` function.
- **Producer contract:** documented at
  `alpha-pivot-frontend/HANDOFF_README_FRONTEND.md` — includes the
  Core4 field-mapping table Mike published on IT-F2-391 c/f138ea44.

---

## 11. Origin

Filed at Mike's request during Core4 wrap-up:

> We spent a lot of time getting t3-core4 to properly connect to the
> database data and purge the built in data. Can you make a generic
> not t3-core4 specific .md recipe for that process so we don't have
> to iterate through all those prompts again.

Companion to `LIVE_DATA_SCANNER_RECIPE.md` and
`SNAPSHOT_DATE_PICKER_RECIPE.md` in this same `docs/` folder.
