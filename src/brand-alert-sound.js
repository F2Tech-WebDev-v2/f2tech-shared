// Per-customer brand-config-driven alert sound (framework-agnostic).
//
// See docs/ALERT_SOUND_RECIPE.md section "Per-customer configured sound
// (brand-config driven)" for the walkthrough. Browser-only; every public fn
// is a no-op when `typeof window === 'undefined'` so SSR consumers won't crash.
//
// How this differs from alert-sound.js (hash-driven):
//   - alert-sound.js:  one call site (notifyAlert) → voice derived by key
//                      hash. Deterministic + customer-agnostic.
//   - brand-alert-sound.js (this): operator picks instrument + note PER
//                      CUSTOMER on the backend; SPA fetches brand-config
//                      and plays the configured tone whenever a customer-
//                      scoped event lands. Admins tune per-customer sounds
//                      in a shared settings dialog.
//
// Install: call configureBrandSound({ apiUrl, storagePrefix }) once at
// startup, then playForCustomer(slug) per event.
//
// Config shape on brand-config (from f2-admin-service customer-directory):
//   { enabled: boolean, instrument: string, note: string }
// Served under /rest/api/brand-config?slug=<slug>.error_alert_sound by
// default; override the field path via configureBrandSound({ configField }).

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------
const DEFAULTS = {
  // POST/GET base. Must include the full prefix up to and including /rest.
  // E.g. 'https://admin.f2-tech.ai/rest' or '/rest' when same-origin.
  apiUrl: '',
  // localStorage namespace. 'f2bas' = f2 brand alert sound. Each SPA should
  // pick its own so a Chrome user with multiple F2 SPAs open gets their own
  // per-SPA mute + volume preferences.
  storagePrefix: 'f2bas',
  // Field on brand-config to read. Default matches the admin error-reports
  // extraction source; override to point at another sub-doc (e.g. a scanner-
  // scoped field) if a consumer needs a parallel sound config.
  configField: 'error_alert_sound',
  // Brand-config cache TTL. Matches the fleet-wide 60s default used elsewhere.
  cacheTtlMs: 60 * 1000,
  // AudioContext auto-release threshold (idle silence). Chrome / some OSes
  // mark the audio session active while a context exists; auto-release
  // closes it so the tab's "playing sound" indicator clears.
  autoReleaseMs: 5000,
  // Cold-start warm-up delay (seconds). First oscillator after a fresh
  // AudioContext can be silently dropped if scheduled too soon — delay by
  // ~1s so the OS audio session is ready.
  warmupDelayS: 1.0,
  // Default per-operator volume 0..100 when nothing is persisted.
  defaultVolume: 70,
  // Default mute state when nothing is persisted.
  defaultMuted: false,
  // Slug used when the caller passes null/undefined — maps to the f2 company
  // doc's default sound. Admins configure this row as "Default / non-customer".
  defaultSlug: 'f2',
};
let _config = { ...DEFAULTS };

export function configureBrandSound(patch) {
  if (patch && typeof patch === 'object') {
    _config = { ...DEFAULTS, ..._config, ...patch };
  }
  _hydratePersistedState();
}

const _ssKey = (name) => `${_config.storagePrefix}:${name}`;

// --------------------------------------------------------------------------
// Operator-level mute + volume (localStorage, independent of brand-config)
// --------------------------------------------------------------------------
let _muted = DEFAULTS.defaultMuted;
let _volume = DEFAULTS.defaultVolume;

function _hydratePersistedState() {
  if (typeof window === 'undefined') return;
  try {
    const m = window.localStorage.getItem(_ssKey('muted'));
    if (m !== null) _muted = m === '1';
    else _muted = _config.defaultMuted === true;
  } catch { _muted = _config.defaultMuted === true; }
  try {
    const v = window.localStorage.getItem(_ssKey('volume'));
    const n = v === null ? NaN : Number(v);
    _volume = Number.isFinite(n) && n >= 0 && n <= 100 ? n : _config.defaultVolume;
  } catch { _volume = _config.defaultVolume; }
}
_hydratePersistedState();

export function setBrandSoundMuted(v) {
  _muted = !!v;
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(_ssKey('muted'), _muted ? '1' : '0'); } catch { /* ignore */ }
}
export function isBrandSoundMuted() { return _muted; }

export function setBrandSoundVolume(v) {
  const clamped = Math.max(0, Math.min(100, Number(v) || 0));
  _volume = clamped;
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(_ssKey('volume'), String(clamped)); } catch { /* ignore */ }
}
export function getBrandSoundVolume() { return _volume; }

// --------------------------------------------------------------------------
// Brand-config cache (per customer slug)
// --------------------------------------------------------------------------
const _cache = new Map();  // slug → { config: {enabled, instrument, note} | null, expiresAt }

/** Drop a single customer's cached config so the next lookup refetches.
 *  Call after a save from the Settings dialog so subsequent events pick up
 *  the new tone immediately. */
export function invalidateBrandSoundCustomer(slug) {
  if (slug) _cache.delete(slug);
}

async function _resolveConfig(slug) {
  if (typeof window === 'undefined') return null;
  const now = Date.now();
  const hit = _cache.get(slug);
  if (hit && hit.expiresAt > now) return hit.config;
  try {
    const url = `${_config.apiUrl}/api/brand-config?slug=${encodeURIComponent(slug)}`;
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) {
      _cache.set(slug, { config: null, expiresAt: now + _config.cacheTtlMs });
      return null;
    }
    const r = await res.json();
    const raw = r && typeof r === 'object' ? r[_config.configField] : null;
    const cfg = raw && typeof raw === 'object'
      ? {
          enabled: !!raw.enabled,
          instrument: String(raw.instrument || 'acoustic_grand_piano'),
          note: String(raw.note || 'C5'),
        }
      : null;
    _cache.set(slug, { config: cfg, expiresAt: now + _config.cacheTtlMs });
    return cfg;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// AudioContext lifecycle (lazy init + auto-release + cold-start warmup)
// --------------------------------------------------------------------------
let _ctx = null;
let _releaseTimer = null;
let _warm = false;

function _scheduleRelease(delayMs) {
  if (_releaseTimer) {
    clearTimeout(_releaseTimer);
    _releaseTimer = null;
  }
  _releaseTimer = setTimeout(() => {
    _releaseTimer = null;
    const ctx = _ctx;
    if (!ctx) return;
    _ctx = null;
    _warm = false;
    try { void ctx.close(); } catch { /* ignore */ }
  }, Math.max(0, delayMs));
}

// --------------------------------------------------------------------------
// Playback
// --------------------------------------------------------------------------
/**
 * Fire-and-forget. Looks up brand-config (cached) and plays the configured
 * tone. No-op when muted / no config / brand-config disabled / autoplay
 * blocked / SSR.
 *
 * customerSlug: string | null | undefined → null/undefined routes to the
 * defaultSlug ('f2' company doc) so uncategorized reports still make a sound.
 */
export async function playForCustomer(customerSlug) {
  if (typeof window === 'undefined') return;
  if (_muted) return;
  const slug = (customerSlug && typeof customerSlug === 'string') ? customerSlug : _config.defaultSlug;
  const cfg = await _resolveConfig(slug);
  if (!cfg || !cfg.enabled) return;
  _playNote(cfg.instrument, cfg.note);
}

/**
 * Preview a sound directly — admin picker's Preview button. Bypasses cache
 * and brand-config, honors the operator's volume (and mute).
 */
export function previewBrandSound(instrument, note) {
  if (typeof window === 'undefined') return;
  _playNote(instrument, note);
}

function _playNote(instrument, note) {
  if (_volume <= 0) return;
  try {
    if (!_ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      _ctx = new Ctx();
    }
    const ctx = _ctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const freq = _noteToFreq(note);
    const env = _envelopeFor(instrument);
    const peak = Math.max(0.0002, env.peak * (_volume / 100));
    const startAt = _warm ? ctx.currentTime : ctx.currentTime + _config.warmupDelayS;
    _warm = true;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = env.type;
    osc.frequency.setValueAtTime(freq, startAt);
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(peak, startAt + env.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + env.attack + env.release);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + env.attack + env.release + 0.05);
    const warmupDelay = startAt - ctx.currentTime;
    const tailEndsAt = warmupDelay + env.attack + env.release + 0.05;  // seconds
    _scheduleRelease(tailEndsAt * 1000 + _config.autoReleaseMs);
  } catch {
    /* fail-silent — sound is non-essential */
  }
}

function _noteToFreq(note) {
  const semis = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(String(note || '').trim());
  if (!m) return 523.25;  // C5 default
  const base = semis[m[1]] ?? 0;
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = parseInt(m[3], 10);
  const midi = (octave + 1) * 12 + base + accidental;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function _envelopeFor(instrument) {
  switch (instrument) {
    case 'tubular_bells':   return { type: 'sine',     attack: 0.005, release: 1.8, peak: 0.30 };
    case 'marimba':         return { type: 'sine',     attack: 0.005, release: 0.40, peak: 0.40 };
    case 'xylophone':       return { type: 'sine',     attack: 0.002, release: 0.25, peak: 0.50 };
    case 'glockenspiel':    return { type: 'triangle', attack: 0.005, release: 1.2,  peak: 0.30 };
    case 'vibraphone':      return { type: 'sine',     attack: 0.030, release: 2.0,  peak: 0.30 };
    case 'celesta':         return { type: 'triangle', attack: 0.005, release: 0.80, peak: 0.40 };
    case 'music_box':       return { type: 'triangle', attack: 0.005, release: 0.60, peak: 0.35 };
    case 'kalimba':         return { type: 'sine',     attack: 0.005, release: 0.80, peak: 0.40 };
    case 'steel_drums':     return { type: 'triangle', attack: 0.010, release: 1.00, peak: 0.40 };
    case 'church_organ':    return { type: 'sawtooth', attack: 0.050, release: 0.40, peak: 0.20 };
    case 'harpsichord':     return { type: 'square',   attack: 0.005, release: 0.35, peak: 0.20 };
    case 'acoustic_grand_piano':
    default:                return { type: 'triangle', attack: 0.005, release: 1.0,  peak: 0.40 };
  }
}

// --------------------------------------------------------------------------
// Options surfaces (for building settings dialogs)
// --------------------------------------------------------------------------
/** Instrument options for a settings dialog's dropdown. Pairs the key the
 *  library understands with a display label. */
export const BRAND_SOUND_INSTRUMENTS = [
  { value: 'acoustic_grand_piano', label: 'Piano' },
  { value: 'tubular_bells',        label: 'Tubular bells' },
  { value: 'marimba',              label: 'Marimba' },
  { value: 'xylophone',            label: 'Xylophone' },
  { value: 'glockenspiel',         label: 'Glockenspiel' },
  { value: 'vibraphone',           label: 'Vibraphone' },
  { value: 'celesta',              label: 'Celesta' },
  { value: 'music_box',            label: 'Music box' },
  { value: 'kalimba',              label: 'Kalimba' },
  { value: 'steel_drums',          label: 'Steel drums' },
  { value: 'church_organ',         label: 'Church organ' },
  { value: 'harpsichord',          label: 'Harpsichord' },
];

/** Three-octave range of naturals + sharps for the note picker. */
export const BRAND_SOUND_NOTES = (() => {
  const out = [];
  const order = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (const oct of [3, 4, 5, 6]) for (const n of order) out.push(`${n}${oct}`);
  return out;
})();
