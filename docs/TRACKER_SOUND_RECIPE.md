# Tracker chime + toast + tab-attention recipe

**When to read this:** you're wiring a browser SPA that needs to signal "something changed on a specific object" to a user whose tab is probably backgrounded, without autoplaying audio, without blowing eardrums, and without the signal being lost if the user Alt-Tabs away for ten minutes. Walk this door-by-door once; don't invent the sequence per SPA. Written 2026-10-19 after IT-F2-353 iterated the full path across ~40 SPA checklist items (ff779e52, 94c7a86b, 6c8bafdb, 50d8066f, c7011e88, 985acb01, …).

A "signal" is **three doors stacked**: an audible chime, a visible in-page toast, and an attention indicator on the backgrounded tab (title prefix + animated favicon). All three fire from a single call site. Mute controls are additive — you can gag any door at any granularity (fleet / per-ticket / per-(ticket,reason)).

---

## The three doors

Every event that deserves attention emits one call that lights up all three doors in parallel. Audit each.

| # | Surface | What fires | Opt-out knob |
|---|---|---|---|
| 1 | **Chime** — WebAudio oscillator | Short bell tone, per-ticket deterministic voice (hash → wave × octave × note), 1.75s decay | Fleet `f2tr:sound-on` localStorage; per-ticket `_ticketAudio[issueId].muted`; focus-mode gate |
| 2 | **Toast** — bottom-right pinned stack | 15s TTL card with issueKey + summary + reason + anchor jump; dedup pulse on repeat | Per-(issueId,reason) `BellOff` with 4h TTL; `overviewFavoritesOnly` skips emission at source |
| 3 | **Tab attention** — title prefix + favicon | `🔔 ` prepended to `document.title` while backgrounded; favicon animates between pulse frames | None — these are passive and cost ~zero when idle |

If you're adding a new signal source, all three doors go in together via `notifyTicketChime()`. Don't fire a chime without a toast — the toast is the "why did you just beep at me" explanation.

---

## Door 1 — AudioContext lifecycle

Browsers forbid audio playback before a user gesture ("autoplay policy"). You MUST lazy-create the `AudioContext` on the first play attempt that comes after any click/key/paste the user has done since page load.

```ts
let _audioCtx: AudioContext | null = null;
function _ensureAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (_audioCtx) return _audioCtx;
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    _audioCtx = new Ctx();
  } catch { _audioCtx = null; }
  return _audioCtx;
}
```

**Idle-suspend after 10s of silence.** A running `AudioContext` keeps a scheduling callback alive even when no oscillator is playing — on Chrome / Firefox this costs a measurable sliver of CPU per tab, which Mike noticed as "MIDI sound keeps burning cycles after it finishes". Fix:

```ts
const AUDIO_IDLE_SUSPEND_MS = 10_000;
let _audioIdleTimer: ReturnType<typeof setTimeout> | null = null;
function _scheduleAudioIdleSuspend(): void {
  if (_audioIdleTimer) clearTimeout(_audioIdleTimer);
  _audioIdleTimer = setTimeout(() => {
    _audioIdleTimer = null;
    if (_audioCtx?.state === 'running') {
      _audioCtx.suspend().catch(() => { /* next play resumes anyway */ });
    }
  }, AUDIO_IDLE_SUSPEND_MS);
}
```

**Resume on next play.** The chime fn checks and resumes if suspended:

```ts
if (ctx.state === 'suspended') {
  ctx.resume().catch(() => { /* first-gesture race; next chime succeeds */ });
}
```

---

## Door 1 — Chime generation (ADSR + per-ticket voice)

A chime is one oscillator fed through one gain node, with an envelope. Mike picked **20ms attack / 1.75s exponential release** (midpoint of his "1.5–2s decay" ask) — long enough to feel bell-like, short enough that two chimes in rapid succession don't pile up as mud.

```ts
function playTicketChime(issueId: string): void {
  if (!_chimeEnabled) return;
  if (_ticketAudio[issueId]?.muted) return;
  const ctx = _ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  _cutoffActiveChime(ctx);   // single-voice: new chime kills prior tail

  const { wave, freq } = _voiceForTicket(issueId);
  const now = ctx.currentTime;
  const RELEASE_S = 1.75;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(_chimeMasterGain, now + 0.02);  // attack
  gain.gain.exponentialRampToValueAtTime(0.001, now + RELEASE_S);   // release

  const osc = ctx.createOscillator();
  osc.type = wave; osc.frequency.value = freq;
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + RELEASE_S + 0.05);
  _activeChimeOsc = { osc, gain };

  osc.onended = () => {
    if (_activeChimeOsc?.osc === osc) _activeChimeOsc = null;
    try { osc.disconnect(); gain.disconnect(); } catch {}
  };
  _scheduleAudioIdleSuspend();
}
```

**Why single-voice (cutoff on new chime).** Without `_cutoffActiveChime`, a burst of events on the same ticket stacks oscillators and the user hears sludge. The cutoff ramps the prior gain to 0.0001 over 30ms, stops the osc, and clears the active handle — so the new chime starts clean:

```ts
function _cutoffActiveChime(ctx: AudioContext): void {
  if (!_activeChimeOsc) return;
  const { osc, gain } = _activeChimeOsc;
  _activeChimeOsc = null;
  const now = ctx.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(0.0001, now + 0.03);
  osc.stop(now + 0.04);
}
```

**Per-ticket voice via djb2 hash.** 4 waveforms × 5 octaves × 12 semitones = **240 unique signatures**, derived deterministically from `issue_id`. Two notifications on the same ticket sound identical; two on different tickets sound distinct. Users develop ear-memory for "that's my ticket".

```ts
const _CHIME_WAVEFORMS: OscillatorType[] = ['sine','triangle','square','sawtooth'];
const _CHIME_OCTAVES = [3,4,5,6,7];
const _SEMITONE_RATIO = Math.pow(2, 1/12);
const _C0_HZ = 16.35;

function _hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function _voiceForTicket(issueId: string): { wave: OscillatorType; freq: number } {
  const over = _ticketAudio[issueId];
  const h = _hashStr(issueId);
  const wave     = over?.wave     ?? _CHIME_WAVEFORMS[h % 4];
  const octave   = over?.octave   ?? _CHIME_OCTAVES[(h >>> 4) % 5];
  const semitone = over?.semitone ?? (h >>> 8) % 12;
  const freq = _C0_HZ * Math.pow(2, octave) * Math.pow(_SEMITONE_RATIO, semitone);
  return { wave, freq };
}
```

**Why not pre-record WAV files.** 240 signatures × ~8KB each = ~2MB. WebAudio generates them in-process for free, matches the host sample rate, and lets per-ticket overrides work (user picks a different note for one noisy ticket).

---

## Door 1 — Enable flag + volume (persisted, default OFF)

Users opt in **once** to sound; the state survives reloads via `localStorage.f2tr:sound-on`. Default off because autoplay policy already blocks the first chime anyway, and nothing is more alienating than "I opened a tab and it beeped at me".

```ts
let _chimeEnabled = localStorage.getItem('f2tr:sound-on') === '1';
export function setChimeEnabled(v: boolean) {
  _chimeEnabled = v;
  if (v) localStorage.setItem('f2tr:sound-on', '1');
  else   localStorage.removeItem('f2tr:sound-on');
}

let _chimeMasterGain = 0.18;   // audible but not eardrum-blowing
export function setChimeMasterGain(g: number) {
  _chimeMasterGain = Math.max(0, Math.min(1, g));
}
```

**UI (overview toolbar):** 🔔/🔇 toggle + 0–100 range slider, side by side. Volume slider is enabled regardless of toggle state so the user can preview-adjust before enabling.

```tsx
<button onClick={() => setSoundOn(v => !v)}>
  {soundOn ? '🔔' : '🔇'}
</button>
<input type="range" min={0} max={100} step={1}
       value={chimeVol}
       onChange={e => setChimeVol(Number(e.currentTarget.value))} />
```

---

## Door 2 — Chime toast queue

The toast is a short card pinned bottom-right that says *why* the chime beeped. 15s TTL (dismissible early). Emission is a module-level pub/sub so every call site can fire one without threading props:

```ts
export type ChimeToast = {
  id: string; issueId: string; issueKey: string;
  summary: string; reason: string;
  anchorCommentId?: string;
  anchorClarId?: string;
  anchorChecklistItemId?: string;
  anchorSection?: string;
  ts: number;
  repeatCount: number;    // dedup counter
  pulseTs: number;        // bump → trigger CSS pulse animation
};

let _chimeToasts: ChimeToast[] = [];
const _toastSubs = new Set<() => void>();
export function subscribeChimeToasts(cb: () => void) { _toastSubs.add(cb); return () => _toastSubs.delete(cb); }
export function emitChimeToast(t: Omit<ChimeToast, 'id'|'ts'|'repeatCount'|'pulseTs'>): string {
  // dedup by (issueId, reason) — if a matching toast is already in the
  // visible stack, bump its pulseTs + repeatCount instead of pushing a
  // duplicate. Users get a visual "same alert, still active" cue.
  ...
}
```

**Dedup pulse.** When the same `(issueId, reason)` toast re-emits (e.g. the still-blocked 15s repeat), we DON'T push a duplicate — we bump the existing row's `pulseTs = Date.now()` and increment `repeatCount`. The row's component is key-remounted on `pulseTs` so a 1.5s CSS keyframe (`f2tr-toast-pulse` — bg tint + glow + scale) fires fresh. A small `×N` pill shows the count.

**Anchor jump on click.** `anchorCommentId` / `anchorClarId` / `anchorChecklistItemId` tell the renderer where to scroll on click. The jump walks ancestor `<details>` elements and opens them before scrolling, then applies a 2.4s two-peak gold pulse to the target — otherwise clicking a toast for a comment buried inside a collapsed section would scroll to an empty page.

```ts
function _jumpToToastAnchor(t: ChimeToast): void {
  const sel =
    t.anchorCommentId       ? `[data-comment-id="${t.anchorCommentId}"]` :
    t.anchorClarId          ? `[data-clar-id="${t.anchorClarId}"]` :
    t.anchorChecklistItemId ? `[data-checklist-item-id="${t.anchorChecklistItemId}"]` :
    t.anchorSection         ? `[data-section="${t.anchorSection}"]` : null;
  if (!sel) return;
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el) return;
  // Open every ancestor <details> so the anchor is actually visible before scrolling.
  let p = el.parentElement;
  while (p) {
    if (p.tagName === 'DETAILS') (p as HTMLDetailsElement).open = true;
    p = p.parentElement;
  }
  // Wait 2 rAFs for the open <details> to layout, THEN scroll.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('f2tr-jump-pulse');
    setTimeout(() => el.classList.remove('f2tr-jump-pulse'), 2400);
  }));
}
```

---

## Door 3 — Tab title bell prefix (🔔)

When the tab is backgrounded (`document.visibilityState === 'hidden'`) AND a toast fires, prepend `🔔 ` to `document.title`. Cleared on next `visibilitychange` → `visible`. This is the signal the user sees in their browser tab strip when they're in another app.

```tsx
useEffect(() => {
  const onVis = () => { if (document.visibilityState === 'visible') setBgAttention(false); };
  document.addEventListener('visibilitychange', onVis);
  const unsub = subscribeChimeToasts(() => {
    if (document.visibilityState === 'hidden') setBgAttention(true);
  });
  return () => { document.removeEventListener('visibilitychange', onVis); unsub(); };
}, []);

useEffect(() => {
  const bgPrefix = bgAttention ? '🔔 ' : '';
  document.title = `${bgPrefix}${openDetail ? `${openDetail.issue.issue_key} · …` : 'F2 Issue Tracker'}`;
}, [bgAttention, openDetail]);
```

**Why not Notification API.** OS-level notifications require a permission grant that most users never give; they also fire outside the browser and lose click-to-jump context. Tab title + favicon are passive — they don't ask for anything and they live where the user is already going to look (the browser tab).

---

## Door 3 — Animated favicon

The favicon has three composable signals:

- **Thinking pulse** — green dot top-left, 6-frame pulse animation at ~500ms/frame
- **Clarification badge** — yellow `?` top-right (or `!`, `…`, `+` for other glyphs)
- **Unread border** — red frame around the whole icon

**Pre-render all frames at startup.** On first paint, load the base SVG into an `<img>`, draw it onto a canvas, then compose each state × border × glyph combination into a cached `data:image/png;base64,…` URL. Mike's 2026-09-16 HAR capture showed the original design was swapping `<link rel="icon">` 10 times per 6-second window because frames were being generated on-demand — browsers log every favicon load to DevTools Network, so this looks like a bug. Pre-rendering drops that to one swap per animation frame against the in-memory cache.

```ts
type FaviconState =
  | `base:${FaviconBorder}`
  | `thinking:${FaviconBorder}`
  | `clar:${FaviconBorder}:${ClarGlyph}`
  | `both:${FaviconBorder}:${ClarGlyph}`;
const _faviconCache: Partial<Record<FaviconState, string[]>> = {};

async function _ensureFaviconCache(): Promise<void> {
  // Load base SVG once, compose every frame of every state × border × glyph
  // into a data: URL. ~16 states × ~6 frames = ~96 base64 strings stored.
  ...
}

function _startFaviconAnim(frames: string[]) {
  _stopFaviconAnim();
  if (frames.length <= 1) { _writeFaviconHref(frames[0]); return; }
  _faviconAnimFrames = frames;
  _faviconAnimIndex = 0;
  _writeFaviconHref(frames[0]);
  _faviconAnimTimer = setInterval(() => {
    _faviconAnimIndex = (_faviconAnimIndex + 1) % _faviconAnimFrames!.length;
    _writeFaviconHref(_faviconAnimFrames![_faviconAnimIndex]);
  }, FRAME_MS);
}
```

**Scope rules.** When a ticket is open, favicon signals reflect THAT ticket only (awaiting-clars on it, thinking on it). On the overview, awaiting-clars is fleet-wide sum but thinking is scoped to **favorited** tickets only — otherwise an idle tab with no favorited-ticket activity pulses continuously because the fleet always has some live work somewhere.

```ts
const hasToasts = getChimeToasts().length > 0;
const showGreen = hasThinking || hasToasts;
const corners: FaviconCorners =
  awaiting > 0 && showGreen ? 'both' :
  awaiting > 0              ? 'clar' :
  showGreen                 ? 'thinking' :
                              'base';
const border: FaviconBorder = hasUnread ? 'red' : 'none';
void setFaviconBadge(corners, border, awaiting);
```

---

## Mute controls — three granularities

**Fleet-wide:** 🔔/🔇 in the overview toolbar (`f2tr:sound-on` localStorage).

**Per-ticket (persistent):** speaker icon (`Volume2` / `VolumeX`) in each drawer's header. Click opens a small popover with:

- Muted checkbox (truly silent — no chime, no toast)
- Instrument dropdown (sine / triangle / square / sawtooth) — override the hash-derived waveform
- Octave dropdown (3–7)
- Note dropdown (C–B)
- Reset button

```ts
type TicketAudio = {
  muted?: boolean;
  wave?: OscillatorType;
  octave?: number;
  semitone?: number;
};
let _ticketAudio: Record<string, TicketAudio> = /* ...read from localStorage... */;

export function setTicketAudio(issueId: string, patch: TicketAudio): void {
  const next = { ..._ticketAudio[issueId], ...patch };
  // Strip undefined keys so JSON doesn't retain hollow blobs
  (Object.keys(next) as (keyof TicketAudio)[]).forEach((k) => {
    if (next[k] === undefined) delete next[k];
  });
  const empty = !next.muted && next.wave == null && next.octave == null && next.semitone == null;
  if (empty) delete _ticketAudio[issueId];
  else _ticketAudio[issueId] = next;
  localStorage.setItem('f2tr:ticket-audio', JSON.stringify(_ticketAudio));
  _audioSubs.forEach(cb => cb());
}
```

**Per-(ticket, reason) with TTL:** `BellOff` button on each toast row. Mutes just that signal shape (e.g. "blocked (repeat)" on ticket X) for 4h without touching the ticket's other alerts. Stored as `{issueId, reason, expiresAt}` tuples in localStorage, checked at the top of `emitChimeToast()`.

```ts
export function isToastMuted(issueId: string, reason: string): boolean {
  const key = `${issueId}:${reason}`;
  const row = _mutedToasts.get(key);
  if (!row) return false;
  if (row.expiresAt < Date.now()) { _mutedToasts.delete(key); return false; }
  return true;
}
```

---

## The single-funnel call site

Every event in the SPA that fires a chime goes through `notifyTicketChime()` — the ONLY entry point. This guarantees:

- Focus-mode gate (`chimeGate(issueId)` — in full-page view of ticket A, no sound for ticket B)
- Overview-favorites-filter gate (if viewing favorites-only, no chime for non-favorited tickets)
- Per-ticket mute check
- Toast dedup check
- History push
- Favicon re-eval (via the thinking-store subscription)

```ts
export function notifyTicketChime(args: {
  issueId: string;
  issueKey: string;
  summary: string;
  reason: string;
  anchorCommentId?: string;
  anchorClarId?: string;
  anchorChecklistItemId?: string;
  anchorSection?: string;
}): void {
  if (!chimeGate(args.issueId)) return;
  if (isToastMuted(args.issueId, args.reason)) return;
  if (_ticketAudio[args.issueId]?.muted) return;
  playTicketChime(args.issueId);
  emitChimeToast({ ...args });
}
```

Call sites in the SPA that use this: `comment.added` on my ticket; `clarification.upserted` on my ticket with status=`awaiting`; `checklist.upserted` where `isChecklistItemNewSighting(id)` is true; blocked-ticket 15s repeat; still-blocked coalesced burst. Add a new signal source? Call `notifyTicketChime()`, do not reach into the primitives.

---

## Common pitfalls (what NOT to do)

- **Don't fire a chime without a toast.** Users forget what the beep was for. A chime without an in-page explanation is noise, not signal.
- **Don't fire a toast without a chime.** The whole point of the audio layer is to pull the user's attention over to the visible toast; without the ping they'll miss it.
- **Don't skip the dedup.** A re-emitting signal (status loop that fires every 15s) will cover the screen in duplicate toasts within a minute. Dedup by `(issueId, reason)`, pulse the existing row.
- **Don't poll for favicon state.** Subscribe to the stores (`_thinkingStore`, `_chimeToasts`, `_unreadStore`) and re-eval only on change. Mike's HAR capture caught the "pulse continuously" bug once — don't let it come back.
- **Don't flip favicon frames faster than ~500ms.** Each `_writeFaviconHref` logs in DevTools Network. Faster = debuggable noise.
- **Don't autoplay the first chime.** `localStorage.f2tr:sound-on` must default to `null` (unset); user opts in explicitly. Browsers will block it anyway, but the explicit opt-in means the first click to enable *is* the user gesture that unlocks the AudioContext.
- **Don't share one `AudioContext` across tabs.** Each tab lazy-creates its own. If two tabs are both playing, the user hears both — that's correct (two tabs, two conversations). Trying to coordinate via BroadcastChannel is a trap.
- **Don't notify the OS.** Resist adding `new Notification(...)`. It triggers a permission prompt most users decline, and the resulting notification exits the browser, breaking click-to-jump.

---

## Reference — IT-F2-353 checklist items that shaped this

Chronological, so you can `git blame` or ticket-drill the "why" on any sharp edge:

| cid | What |
|---|---|
| `ff779e52` | 1.5–2s decay (picked 1.75s midpoint, 20ms attack) |
| `9fd46691` | AudioContext idle-suspend after 10s silence |
| `ae988726` | Toast body uses `…` not ticket title when drawer is open |
| `847cb24d` | Toasts persist until ticket opened (3s buffer post-open) |
| `6fd8ae13` | No countdown — manual click-only |
| `f370b1d9` | New checklist items trigger chime (first-sighting registry) |
| `94c7a86b` | Toast dismissals sync cross-browser via WS `toast.dismissed` |
| `6c8bafdb` | Favicon animates while any chime toast is active |
| `9de6f8fd` | Toast color coding — comment=blue, clar=gold, checklist=teal, ticket=red |
| `da5f41b9` | 3-step pre-flight before every clar POST (unrelated but same wave) |
| `eb4639c0` | Toast click walks ancestor `<details>` + opens them before scroll |
| `3a4b24e5` | Ctrl-Enter posts clar answer / comment edit |
| `3a70d2a0` | Dedup pulse + `×N` counter pill on same-key repeat |
| `b453100b` | `BellOff` per-(issueId, reason) with 4h TTL |
| `50d8066f` | CSS keyframe `f2tr-toast-pulse` + key-remount on `pulseTs` |
| `c7011e88` | Bell icon toolbar dropdown, rolling 50-toast history |
| `a3317002` | Bell icon in drawer header too, shared state |
| `858a1045` | Favicon idle-noise fix (HAR-captured 10 frames in 6s) |
| `985acb01` | Favicon: canvas/PNG pipeline → single data:image/svg+xml URL |
| `f6985ed6` | Revert favicon back to Canvas → PNG data URL |
| `844b19f3` | `_jumpToAnchor` 2.4s two-peak pulse animation |
| `b78f6814` | 5-min stale threshold on `processing_sessions[]` for drawer chip + favicon |

If something feels wrong, grep for the cid in `App.tsx` and read the surrounding comment block — every one of these items left a `cid=…` marker at the touched call site.
