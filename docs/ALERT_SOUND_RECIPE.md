# Alert sound + toast recipe

**When to read this:** you're wiring a browser SPA that needs to signal "something changed on a specific object" to a user whose tab is probably backgrounded, without autoplaying audio, without blowing eardrums, and without the signal being lost if the user Alt-Tabs away for ten minutes. Walk this door-by-door once; don't invent the sequence per SPA. Framework-agnostic; works with React / Angular / vanilla. Written 2026-10-19 as a reusable extraction of the IT-F2-353 chime system.

A "signal" is **three doors stacked**: an audible chime, a visible in-page toast, and an attention indicator on the backgrounded tab (title prefix + optional favicon hook). All three fire from a single call site: `notifyAlert(spec)`. Mute controls are additive — you can gag any door at any granularity (fleet / per-key / per-(key,reason)).

The library lives in `f2tech-shared/src/alert-sound.{d.ts,js}`. Import once, call configure at startup, then fire `notifyAlert(spec)` per event. The toast queue is a pub/sub — your SPA renders whatever UI you like from the exposed data.

---

## Install + configure (one-time)

```ts
import {
  configureAlerts,
  installTabAttentionWatcher,
  notifyAlert,
  setChimeEnabled,
  setChimeMasterGain,
  isChimeEnabled,
  getChimeMasterGain,
  subscribeToasts,
  getToasts,
  dismissToast,
} from 'f2tech-shared/alert-sound';

// Call ONCE at app startup — e.g. React root or Angular AppComponent constructor.
configureAlerts({
  storagePrefix: 'myapp',   // namespaces localStorage keys to avoid cross-SPA bleed
  // Everything else is optional; defaults match the IT-F2-353 production tuning.
  // defaultMasterGain: 0.18,
  // releaseS: 1.75,
  // idleSuspendMs: 10_000,
  // visibleCap: 5,
  // historyCap: 50,
  // toastTtlMs: 15_000,
});

// Optional: wire the tab-attention watcher so document.title gets 🔔 while backgrounded.
installTabAttentionWatcher({
  titlePrefix: '🔔 ',
  computeBaseTitle: () => `${myOpenObject?.id ?? ''} · MyApp`,
  // Optional callback — use this to drive favicon changes etc.
  onAttentionChange: (hasAttn) => { /* ... */ },
});
```

`configureAlerts()` is idempotent — call it again anytime to re-tune. It re-reads persisted values under the possibly-new `storagePrefix`.

---

## The three doors

Every event that deserves attention emits one `notifyAlert(spec)` call that lights up all three doors in parallel.

| # | Door | What fires | Opt-out knob |
|---|---|---|---|
| 1 | **Chime** | Short bell tone, per-key deterministic voice (hash → wave × octave × note), ~1.75s decay | `isChimeEnabled()` fleet flag; `setKeyAudio(key,{muted:true})` per-key; `setReasonMuted(key,reason,expiresAt)` per-signal |
| 2 | **Toast** | Pub/sub queue entry; your SPA renders bottom-right stack (or whatever); dedup pulse on repeat | Same three mute paths as door 1 — toast skip at source |
| 3 | **Tab attention** | `🔔 ` prepended to `document.title` while backgrounded; your callback for favicon | None — passive, zero cost when idle |

If you're adding a new signal source, call `notifyAlert()` once, don't fire a chime without a toast — the toast is the "why did you just beep at me" explanation.

---

## The single call site

```ts
notifyAlert({
  key: issue.id,                     // deterministic voice ID; same key = same note
  label: `IT-F2-${issue.number}`,    // short header on the toast
  summary: 'New comment from Jim',   // longer context under the header
  reason: 'comment.added',           // dedup component (same (key,reason) = pulse, not duplicate)
  anchor: {                          // optional click-to-jump data
    selector: `[data-comment-id="${commentId}"]`,
    sectionId: 'comments',
  },
});
```

That's it. The library:

- Checks fleet enabled, per-key mute, per-(key,reason) mute
- Dedups against the visible stack — if a matching toast is already live, bumps `pulseTs` + `repeatCount` instead of pushing a duplicate
- Pushes to the history ring (default 50 entries)
- Plays the chime (deterministic voice for `key`)
- Fires the pub/sub so your toast renderer re-renders

Return value is the toast id (new row OR the existing dedup target), or `''` if everything got muted.

---

## Rendering the toast stack

The library owns data; the SPA owns pixels. In React:

```tsx
import { useSyncExternalStore } from 'react';
import { subscribeToasts, getToasts, dismissToast, type AlertToast } from 'f2tech-shared/alert-sound';

function AlertToastStack() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  return (
    <div style={{ position: 'fixed', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {toasts.map((t) => (
        <AlertCard key={t.id + ':' + t.pulseTs}  // key-remount on pulseTs → fresh CSS animation
                   toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}
```

In Angular:

```ts
@Component({ selector: 'app-alert-stack', template: '...' })
export class AlertStackComponent implements OnInit, OnDestroy {
  toasts: AlertToast[] = getToasts();
  private unsub?: () => void;
  ngOnInit() { this.unsub = subscribeToasts(() => this.toasts = getToasts()); }
  ngOnDestroy() { this.unsub?.(); }
  dismiss(id: string) { dismissToast(id); }
}
```

The `pulseTs` field on each toast bumps every time the same `(key,reason)` fires again. Key-remounting on `pulseTs` restarts your CSS animation; a small `×N` pill reading `repeatCount` conveys "same alert, still active".

---

## Chime generation (what the library actually plays)

A chime is one WebAudio oscillator fed through one gain node, with an ADSR envelope. The library picks:

- **Attack:** 20ms linear ramp to master gain
- **Release:** 1.75s exponential decay to silence
- **Waveform × octave × semitone:** derived from a djb2 hash of `key` → 4 waves × 5 octaves × 12 semitones = **240 unique signatures**

Two notifications on the same key sound identical; two on different keys sound distinct. Users develop ear-memory for "that's my object".

The library handles:

- **Lazy AudioContext creation** on first play after any user gesture (browsers forbid audio before gesture — "autoplay policy"). The user clicking "enable sound" IS the gesture that unlocks the context.
- **Idle-suspend after 10s of silence.** A running AudioContext keeps a scheduling callback alive even when no oscillator is playing — on Chrome / Firefox this costs measurable CPU per tab. `suspend()` drops that overhead; next `playChime` resumes.
- **Single-voice cutoff.** New chime kills the prior one's tail — a burst of events on the same key no longer stacks into sludge.

You don't call `playChime` directly; `notifyAlert` does it. But `playChime(key)` is exported for preview UIs ("let me hear what this ticket sounds like").

---

## Mute controls — three granularities

**Fleet-wide:** 🔔/🔇 toggle in your app's toolbar. Persisted via `localStorage.<prefix>:sound-on`. Default OFF (user opts in once; survives reloads).

```ts
<button onClick={() => setChimeEnabled(!isChimeEnabled())}>
  {isChimeEnabled() ? '🔔' : '🔇'}
</button>
<input type="range" min={0} max={100} step={1}
       value={Math.round(getChimeMasterGain() * 100)}
       onChange={(e) => setChimeMasterGain(Number(e.currentTarget.value) / 100)} />
```

**Per-key (persistent):** mute entirely, or override the hash-derived voice. Useful when one noisy object keeps alerting and the user wants it silenced OR re-pitched.

```ts
setKeyAudio('issue-abc', { muted: true });                    // fully silent
setKeyAudio('issue-abc', { wave: 'triangle', octave: 5, semitone: 9 });  // custom voice
setKeyAudio('issue-abc', null);                               // clear override
```

**Per-(key, reason) with TTL:** `BellOff` button on each toast row. Mutes just that signal shape (e.g. "blocked (repeat)" on object X) for N hours without touching other alerts.

```ts
setReasonMuted(toast.key, toast.reason, Date.now() + 4 * 60 * 60 * 1000);  // 4h
isReasonMuted(key, reason);
clearReasonMute(key, reason);
```

---

## Tab attention (title prefix + optional favicon hook)

`installTabAttentionWatcher()` wires:

- `document.visibilitychange` listener — clears attention when tab becomes visible
- `subscribeToasts` listener — sets attention when a toast fires while tab is hidden
- Rewrites `document.title` with your prefix (default `🔔 `) when attention is set
- Fires an `onAttentionChange(hasAttn)` callback for favicon / Angular signals / anything else

```ts
installTabAttentionWatcher({
  titlePrefix: '🔔 ',
  computeBaseTitle: () => myCleanTitle(),
  onAttentionChange: (hasAttn) => {
    // Drive your favicon from here. The library doesn't own the favicon
    // because every SPA composes its own signal set (unread, thinking,
    // awaiting-clars, pending-order, …) — pass that composition through
    // whatever favicon pipeline you prefer.
    void setMyFaviconAttention(hasAttn);
  },
});
```

Omit `computeBaseTitle` to opt out of title mutation entirely (the library won't touch it).

**Why no OS notifications.** The lib deliberately does NOT call `new Notification(...)`. The permission prompt is user-hostile, most users decline, and OS notifications exit the browser (breaking click-to-jump into your UI). Tab title + favicon are passive and live where the user is going to look anyway.

---

## Favicon integration (your pipeline, library's cue)

The library hands you a boolean (`hasAttn`) and expects your SPA to manage the favicon frames. The reference pipeline from the extraction source (IT-F2-353 commit `985acb01`, revised `f6985ed6`):

1. Load the base SVG into an `<img>` once at startup.
2. Draw onto a canvas. For each state × border × glyph combination, compose a frame and cache as `data:image/png;base64,…`. **Pre-render all frames** — don't generate on-demand. (Chrome's DevTools Network panel logs every favicon load; generating in real time looks like a bug when it's actually working.)
3. For animated states (thinking / attention), rotate frames via `setInterval` at ~500ms intervals; each tick does `<link rel="icon">`'s `.href = frames[i]`.
4. Stop the interval when attention clears; snap back to the base frame.

Subscribe to your own state (`hasThinking`, `hasUnread`, `awaitingAttn`) AND to the library's `onAttentionChange` to decide the composite state.

```ts
installTabAttentionWatcher({
  onAttentionChange: () => recomputeFaviconState(),
});
subscribeToYourOtherSignals(() => recomputeFaviconState());

function recomputeFaviconState() {
  const corners = /* 'base' | 'thinking' | 'badge' | 'both' */;
  const border  = hasUnread ? 'red' : 'none';
  void setFaviconBadge(corners, border);
}
```

---

## Common pitfalls (what NOT to do)

- **Don't fire a chime without a toast.** Users forget what the beep was for. Audio pulls attention; the in-page toast is the explanation.
- **Don't fire a toast without a chime.** The whole point of audio is to pull attention over to the toast; without the ping they'll miss it (which is why `notifyAlert` always fires both).
- **Don't skip the dedup.** A re-emitting signal (status loop every 15s) covers the screen in duplicates within a minute. The library dedups by `(key, reason)` for you — don't re-emit with a new reason just to bypass that.
- **Don't flip favicon frames faster than ~500ms.** Each `<link>.href = '...'` logs a Network entry. Faster = debuggable noise.
- **Don't autoplay the first chime.** `localStorage.<prefix>:sound-on` defaults to unset; the user opts in explicitly. The library already respects this.
- **Don't share one AudioContext across tabs.** Each tab lazy-creates its own. If two tabs are both playing, the user hears both — correct (two tabs, two conversations). Coordinating via `BroadcastChannel` is a trap.
- **Don't call `playChime` outside `notifyAlert`.** Direct `playChime` skips mute checks and toast emission. The one legit exception is a preview UI ("hear this ticket's voice"), which should bypass the fleet-enabled gate deliberately.
- **Don't let the SPA's own `setTimeout` dismiss toasts.** The library already schedules auto-dismiss on `toastTtlMs`. Add your own on top and you double-dismiss.

---

## API summary

### Setup
- `configureAlerts(config?)` — call once at startup. Config is optional; all fields have sensible defaults.
- `installTabAttentionWatcher(config)` — optional title + favicon hook watcher. Returns uninstall fn.

### Firing an alert
- `notifyAlert(spec)` → `string` — the single call site. Returns toast id or `''`.
- `emitToast(spec)` → `string` — toast + history only, no chime.
- `playChime(key, override?)` — chime only (for preview UIs).

### State
- `setChimeEnabled(bool)` / `isChimeEnabled()`
- `setChimeMasterGain(0..1)` / `getChimeMasterGain()`
- `setKeyAudio(key, patch | null)` / `getKeyAudio(key)`
- `setReasonMuted(key, reason, expiresAt)` / `clearReasonMute(key, reason)` / `isReasonMuted(key, reason)`
- `voiceForKey(key)` → `{wave, freq, label}` — for preview UI

### Toast queue
- `subscribeToasts(cb)` → unsubscribe fn
- `getToasts()` → `AlertToast[]`
- `dismissToast(id)` / `dismissToastsMatching(filter)`
- `subscribeToastHistory(cb)` / `getToastHistory()` / `clearToastHistory()` / `removeToastHistoryEntry(id)`

---

## Per-customer configured sound (brand-config driven)

The sections above describe the **hash-driven** library — one call site, voice derived deterministically from a `key` hash, no per-customer tuning. There is a sibling pattern used by `/admin/error-reports` where the admin explicitly picks the instrument + note **per customer** on the backend, and every SPA that cares plays that same configured tone whenever an event for that customer lands. This pattern is portable to any customer-aware SPA — the lib is customer and scanner agnostic; the SPA just supplies a customer slug.

Extracted from `f2-admin/src/app/admin/shared/sound-player.service.ts` + `sound-settings-dialog.component.ts` into `f2tech-shared/src/brand-alert-sound.{d.ts,js}` + `brand-sound-settings-dialog.{component.ts,tsx}` per IT-F2-451 (Mike chat 2026-10-22).

### Install (one-time)

```ts
import {
  configureBrandSound,
  playForCustomer,
  isBrandSoundMuted,
  setBrandSoundMuted,
  getBrandSoundVolume,
  setBrandSoundVolume,
} from 'f2tech-shared/brand-alert-sound';

// Call ONCE at app startup — e.g. React root or Angular AppComponent constructor.
configureBrandSound({
  apiUrl: '/rest',          // base path up to and including /rest (same-origin) or 'https://admin.f2-tech.ai/rest' (cross-origin)
  storagePrefix: 'myapp',   // namespaces the mute + volume localStorage keys
  // Everything else is optional with sensible defaults:
  // configField: 'error_alert_sound',  // field on brand-config to read; swap for a sibling sub-doc if a parallel channel is needed
  // cacheTtlMs: 60_000,
  // autoReleaseMs: 5000,
  // warmupDelayS: 1.0,
  // defaultVolume: 70,
  // defaultMuted: false,
  // defaultSlug: 'f2',
});
```

`configureBrandSound()` is idempotent; call it again anytime to re-tune. It re-hydrates persisted mute + volume state against the possibly-new storagePrefix.

### Firing a sound

```ts
// Per customer-scoped event. Fire-and-forget. No-ops when muted / brand-config
// returns null-or-disabled / autoplay blocked / SSR.
playForCustomer(customer.slug);

// Reports that lack a customer slug fall through to defaultSlug ('f2' by default),
// so uncategorized rows still make a sound if the admin enabled it on the f2 row.
playForCustomer(null);  // → tries 'f2' company doc
```

The library:

1. Checks the operator mute toggle (`isBrandSoundMuted`).
2. Fetches `/rest/api/brand-config?slug=<slug>` and reads `.error_alert_sound` (or the custom `configField`).
3. If the sub-doc is `{ enabled: true, instrument, note }`, synthesizes a one-shot ADSR tone via Web Audio.
4. Scales the output by the operator's volume (0..100).
5. Caches the brand-config result for 60s so a burst of events for the same customer doesn't hammer the API.
6. Auto-releases the AudioContext after 5s of silence so the OS "tab is playing sound" indicator clears.

### Toolbar mute + volume (two-element pattern)

Any SPA that wires this feature should surface two operator controls up in the toolbar: a mute toggle and a volume slider. These live in `localStorage` under the configured prefix, so every operator can tune their own ears without touching backend config.

Angular:

```ts
import {
  isBrandSoundMuted,
  setBrandSoundMuted,
  getBrandSoundVolume,
  setBrandSoundVolume,
} from 'f2tech-shared/brand-alert-sound';

@Component({ /* ... */ })
export class MyPageComponent {
  get muted() { return isBrandSoundMuted(); }
  toggleMute() { setBrandSoundMuted(!this.muted); }
  volume() { return getBrandSoundVolume(); }
  onVolumeChange(v: number) { setBrandSoundVolume(v); }
}
```

Template:

```html
<button type="button" (click)="toggleMute()" [title]="muted ? 'Unmute alert sounds' : 'Mute alert sounds'">
  <i class="fa-solid" [class.fa-volume-high]="!muted" [class.fa-volume-xmark]="muted"></i>
</button>
<input type="range" min="0" max="100" step="1"
       [value]="volume()" (input)="onVolumeChange(+$any($event.target).value)" />
```

React (similar shape, read current state on each render):

```tsx
import {
  isBrandSoundMuted,
  setBrandSoundMuted,
  getBrandSoundVolume,
  setBrandSoundVolume,
} from 'f2tech-shared/brand-alert-sound';

function SoundToolbar() {
  const [, bump] = useState(0);
  const rerender = () => bump((n) => n + 1);
  return (
    <>
      <button onClick={() => { setBrandSoundMuted(!isBrandSoundMuted()); rerender(); }}>
        {isBrandSoundMuted() ? '🔇' : '🔔'}
      </button>
      <input type="range" min={0} max={100} value={getBrandSoundVolume()}
             onChange={(e) => { setBrandSoundVolume(+e.currentTarget.value); rerender(); }} />
    </>
  );
}
```

### Settings dialog (operator-facing)

The library ships a ready-to-mount Settings dialog that lists every customer and lets the operator pick instrument + note per row with live preview + debounced auto-save. Mount from a toolbar button next to the mute toggle.

Angular (standalone import):

```ts
import { BrandSoundSettingsDialogComponent } from 'f2tech-shared/brand-sound-settings-dialog.component';

@Component({ imports: [BrandSoundSettingsDialogComponent, /* ... */] })
export class MyPageComponent {
  showSoundSettings = false;
  openSoundSettings() { this.showSoundSettings = true; }
}
```

Template:

```html
<button type="button" (click)="openSoundSettings()" title="Sound settings">
  <i class="fa-solid fa-music"></i>
</button>

<brand-sound-settings-dialog
  *ngIf="showSoundSettings"
  apiBase="/rest"
  customersListPath="/admin/customer-directory/"
  customerPutPathPrefix="/admin/customer-directory/"
  (close)="showSoundSettings = false">
</brand-sound-settings-dialog>
```

React:

```tsx
import { useState } from 'react';
import { BrandSoundSettingsDialog } from 'f2tech-shared/brand-sound-settings-dialog';

function MyPage() {
  const [soundOpen, setSoundOpen] = useState(false);
  return (
    <>
      <button onClick={() => setSoundOpen(true)}>🎵</button>
      {soundOpen && (
        <BrandSoundSettingsDialog
          apiBase="/rest"
          customersListPath="/admin/customer-directory/"
          customerPutPathPrefix="/admin/customer-directory/"
          onClose={() => setSoundOpen(false)}
        />
      )}
    </>
  );
}
```

The dialog honors the `configField` prop if a consumer needs the sub-doc stored under a different field (e.g. `scanner_alert_sound` for scanner-scoped alerts). On every save it invalidates the per-slug brand-config cache so the next `playForCustomer` for that customer picks up the new tone immediately.

### Backend contract — what the Customer doc stores

Every row in `F2-ADMIN.Customers` can carry:

```json
{
  "_id": "<customer slug>",
  "name": "Display Name",
  "error_alert_sound": {
    "enabled": true,
    "instrument": "acoustic_grand_piano",
    "note": "C5"
  }
}
```

The `f2` row acts as the fleet default — admins should configure it so events without a customer slug still make a distinguishable sound. `instrument` is one of the keys in `BRAND_SOUND_INSTRUMENTS`; `note` is one of `BRAND_SOUND_NOTES` (three octaves of naturals + sharps).

`/rest/api/brand-config?slug=<slug>` already surfaces this sub-doc in the admin SPA's extraction source; the Settings dialog PUTs to `/rest/admin/customer-directory/<slug>` with a minimal body `{ error_alert_sound: {...} }`. The backend's `update()` normalizes `$set` only on the supplied field, so other Customer-doc fields are undisturbed.

### Instrument + note knobs

The 12 instruments map to Web Audio oscillator type + ADSR envelope so operators can pick timbres that are distinguishable without the bundle weight of a sampler library. Current voices:

| Instrument | Oscillator | Attack | Release | Peak gain |
|---|---|---|---|---|
| Piano (default) | triangle | 5ms | 1.0s | 0.40 |
| Tubular bells | sine | 5ms | 1.8s | 0.30 |
| Marimba | sine | 5ms | 0.4s | 0.40 |
| Xylophone | sine | 2ms | 0.25s | 0.50 |
| Glockenspiel | triangle | 5ms | 1.2s | 0.30 |
| Vibraphone | sine | 30ms | 2.0s | 0.30 |
| Celesta | triangle | 5ms | 0.8s | 0.40 |
| Music box | triangle | 5ms | 0.6s | 0.35 |
| Kalimba | sine | 5ms | 0.8s | 0.40 |
| Steel drums | triangle | 10ms | 1.0s | 0.40 |
| Church organ | sawtooth | 50ms | 0.4s | 0.20 |
| Harpsichord | square | 5ms | 0.35s | 0.20 |

Notes span C3 → B6 (four octaves of 12 naturals + sharps). Pairs of instrument × note give the admin ~576 distinguishable per-customer slots.

### Customer + scanner agnostic

Nothing in the library assumes a specific customer or scanner — the slug is just a cache key + the lookup argument on brand-config. The same install pattern works for:

- Admin event feeds (error-reports — the extraction source)
- Per-scanner tape SPAs (any customer the user is entitled to)
- Multi-tenant operator surfaces (e.g. a client_admin viewing their own customer's events)
- Fleet-wide dashboards (fall through `playForCustomer(null)` to the `f2` default row)

Each SPA picks its own `storagePrefix` so operator-level mute + volume don't bleed across SPAs, but the brand-config they read is shared — one admin tune reaches every SPA that reads the same field.

### Which pattern should I pick?

If every signal in your SPA already carries a stable **key** (an object id, ticket id, asset id) and the user wants ear-memory for that object, use the hash-driven lib described earlier in this doc — `notifyAlert({ key, label, summary, reason })`.

If signals are grouped by **customer** (or any other operator-tuned axis) and the operator wants to pick the tone explicitly, use `brand-alert-sound` with the Settings dialog. The two patterns coexist cleanly — one SPA can import both and route different event sources through each.

---

## Original design origin

Extracted from IT-F2-353 (F2 Issue Tracker) after ~40 iteration items — chronological highlights so you can `git blame` or ticket-drill the "why" on any sharp edge:

| cid | What |
|---|---|
| `ff779e52` | 1.5–2s decay (picked 1.75s midpoint, 20ms attack) |
| `9fd46691` | AudioContext idle-suspend after 10s silence |
| `94c7a86b` | Toast dismissals sync cross-browser via WS |
| `3a70d2a0` | Dedup pulse + `×N` counter pill on same-key repeat |
| `b453100b` | BellOff per-(key, reason) with 4h TTL |
| `50d8066f` | CSS keyframe + key-remount on `pulseTs` for fresh animation |
| `c7011e88` | Rolling history ring with bell-icon dropdown surface |
| `985acb01` → `f6985ed6` | Favicon pipeline (SVG → canvas → PNG data: URL, pre-rendered frames) |

If something feels wrong in production, cross-reference the cid against the extraction source `f2-tracker/src/App.tsx` for the complete comment-block context behind the decision. The library at `src/alert-sound.{d.ts,js}` is the stable surface; the tracker is the lab notebook.
