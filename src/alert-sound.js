// Trigger-driven alert sound + toast library (framework-agnostic).
//
// See docs/ALERT_SOUND_RECIPE.md for the walkthrough. Browser-only; the
// first call to any public fn is a no-op when `typeof window === 'undefined'`
// so SSR consumers won't crash.
//
// Design: one module-level singleton per concern (AudioContext, toast queue,
// mute maps). Consumer calls configureAlerts() once, then notifyAlert(spec)
// per event. Toast rendering stays in the consumer SPA — subscribeToasts()
// + getToasts() hand off the data model; the SPA renders whatever UI it
// likes from that.

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------
const DEFAULTS = {
  storagePrefix: 'f2a',
  defaultMasterGain: 0.18,
  idleSuspendMs: 10_000,
  releaseS: 1.75,
  attackS: 0.02,
  visibleCap: 5,
  historyCap: 50,
  toastTtlMs: 15_000,
  dedupPulseMs: 1_500,
};
let _config = { ...DEFAULTS };

export function configureAlerts(patch) {
  if (patch && typeof patch === 'object') {
    _config = { ...DEFAULTS, ..._config, ...patch };
  }
  // Re-read persisted values under the (possibly new) prefix.
  _hydratePersistedState();
}

const _ssKey = (name) => `${_config.storagePrefix}:${name}`;

// --------------------------------------------------------------------------
// AudioContext lifecycle (lazy init + idle-suspend)
// --------------------------------------------------------------------------
let _audioCtx = null;
function _ensureAudioCtx() {
  if (typeof window === 'undefined') return null;
  if (_audioCtx) return _audioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    _audioCtx = new Ctx();
  } catch { _audioCtx = null; }
  return _audioCtx;
}

let _audioIdleTimer = null;
function _scheduleAudioIdleSuspend() {
  if (typeof window === 'undefined') return;
  if (_audioIdleTimer) clearTimeout(_audioIdleTimer);
  _audioIdleTimer = setTimeout(() => {
    _audioIdleTimer = null;
    if (_audioCtx && _audioCtx.state === 'running') {
      _audioCtx.suspend().catch(() => { /* next play resumes anyway */ });
    }
  }, _config.idleSuspendMs);
}

// --------------------------------------------------------------------------
// Deterministic voice: djb2 hash → wave × octave × semitone
// --------------------------------------------------------------------------
const _WAVES = ['sine', 'triangle', 'square', 'sawtooth'];
const _OCTAVES = [3, 4, 5, 6, 7];
const _SEMITONE_RATIO = Math.pow(2, 1 / 12);
const _C0_HZ = 16.35;
const _NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function _hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export function voiceForKey(key) {
  const override = _keyAudio[key];
  const h = _hashStr(key);
  const wave     = override?.wave     ?? _WAVES[h % _WAVES.length];
  const octave   = override?.octave   ?? _OCTAVES[(h >>> 4) % _OCTAVES.length];
  const semitone = override?.semitone ?? (h >>> 8) % 12;
  const freq = _C0_HZ * Math.pow(2, octave) * Math.pow(_SEMITONE_RATIO, semitone);
  return { wave, freq, label: `${wave} · ${_NOTE_NAMES[semitone]}${octave}` };
}

// --------------------------------------------------------------------------
// Chime enable + master gain (persisted)
// --------------------------------------------------------------------------
let _chimeEnabled = false;
let _chimeMasterGain = DEFAULTS.defaultMasterGain;

function _hydratePersistedState() {
  if (typeof window === 'undefined') return;
  try {
    _chimeEnabled = localStorage.getItem(_ssKey('sound-on')) === '1';
  } catch { /* privacy mode */ }
  try {
    const g = localStorage.getItem(_ssKey('gain'));
    if (g != null) {
      const n = Number(g);
      if (Number.isFinite(n)) _chimeMasterGain = Math.max(0, Math.min(1, n));
    } else {
      _chimeMasterGain = _config.defaultMasterGain;
    }
  } catch { /* privacy mode */ }
  try {
    const raw = localStorage.getItem(_ssKey('key-mute'));
    _keyAudio = raw ? (JSON.parse(raw) || {}) : {};
    if (typeof _keyAudio !== 'object' || _keyAudio == null) _keyAudio = {};
  } catch { _keyAudio = {}; }
  try {
    const raw = localStorage.getItem(_ssKey('reason-mute'));
    _reasonMute = raw ? (JSON.parse(raw) || {}) : {};
    if (typeof _reasonMute !== 'object' || _reasonMute == null) _reasonMute = {};
  } catch { _reasonMute = {}; }
}
_hydratePersistedState();

export function setChimeEnabled(v) {
  _chimeEnabled = !!v;
  if (typeof window === 'undefined') return;
  try {
    if (v) localStorage.setItem(_ssKey('sound-on'), '1');
    else   localStorage.removeItem(_ssKey('sound-on'));
  } catch { /* quota */ }
}
export function isChimeEnabled() { return _chimeEnabled; }

export function setChimeMasterGain(g) {
  const n = Math.max(0, Math.min(1, Number(g) || 0));
  _chimeMasterGain = n;
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(_ssKey('gain'), String(n)); } catch { /* quota */ }
}
export function getChimeMasterGain() { return _chimeMasterGain; }

// --------------------------------------------------------------------------
// Per-key audio override (persisted)
// --------------------------------------------------------------------------
let _keyAudio = {};
const _keyAudioSubs = new Set();

export function setKeyAudio(key, patch) {
  if (!key) return;
  if (patch === null) {
    delete _keyAudio[key];
  } else {
    const next = { ..._keyAudio[key], ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    const empty = !next.muted && next.wave == null && next.octave == null && next.semitone == null;
    if (empty) delete _keyAudio[key];
    else _keyAudio[key] = next;
  }
  _persistKeyAudio();
  _keyAudioSubs.forEach((cb) => { try { cb(); } catch { /* subscriber threw */ } });
}
export function getKeyAudio(key) { return _keyAudio[key] || {}; }

function _persistKeyAudio() {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(_ssKey('key-mute'), JSON.stringify(_keyAudio)); }
  catch { /* quota */ }
}

// --------------------------------------------------------------------------
// Per-(key, reason) mute with TTL
// --------------------------------------------------------------------------
let _reasonMute = {};

export function setReasonMuted(key, reason, expiresAt) {
  if (!key || !reason) return;
  const now = Date.now();
  if (!(expiresAt > now)) return;
  _reasonMute[`${key}:${reason}`] = expiresAt;
  _persistReasonMute();
}
export function clearReasonMute(key, reason) {
  if (!key || !reason) return;
  delete _reasonMute[`${key}:${reason}`];
  _persistReasonMute();
}
export function isReasonMuted(key, reason) {
  const exp = _reasonMute[`${key}:${reason}`];
  if (!exp) return false;
  if (exp < Date.now()) { delete _reasonMute[`${key}:${reason}`]; _persistReasonMute(); return false; }
  return true;
}
function _persistReasonMute() {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(_ssKey('reason-mute'), JSON.stringify(_reasonMute)); }
  catch { /* quota */ }
}

// --------------------------------------------------------------------------
// Chime playback
// --------------------------------------------------------------------------
let _activeChime = null;

function _cutoffActiveChime(ctx) {
  if (!_activeChime) return;
  const { osc, gain } = _activeChime;
  _activeChime = null;
  try {
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0.0001, now + 0.03);
    osc.stop(now + 0.04);
  } catch { /* already stopped */ }
}

export function playChime(key, override) {
  if (!_chimeEnabled) return;
  if (_keyAudio[key]?.muted) return;
  const ctx = _ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => { /* first-gesture race; next chime succeeds */ });
  }
  _cutoffActiveChime(ctx);

  const base = voiceForKey(key);
  const wave = override?.wave ?? base.wave;
  const freq = (override?.octave != null || override?.semitone != null)
    ? _C0_HZ * Math.pow(2, override.octave ?? _OCTAVES[(_hashStr(key) >>> 4) % _OCTAVES.length])
             * Math.pow(_SEMITONE_RATIO, override.semitone ?? (_hashStr(key) >>> 8) % 12)
    : base.freq;

  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(_chimeMasterGain, now + _config.attackS);
  gain.gain.exponentialRampToValueAtTime(0.001, now + _config.releaseS);

  const osc = ctx.createOscillator();
  osc.type = wave;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + _config.releaseS + 0.05);
  _activeChime = { osc, gain };
  osc.onended = () => {
    if (_activeChime && _activeChime.osc === osc) _activeChime = null;
    try { osc.disconnect(); gain.disconnect(); } catch { /* noop */ }
  };
  _scheduleAudioIdleSuspend();
}

// --------------------------------------------------------------------------
// Toast queue
// --------------------------------------------------------------------------
let _toasts = [];
let _history = [];
const _toastSubs = new Set();
const _historySubs = new Set();

function _notifyToasts() { _toastSubs.forEach((cb) => { try { cb(); } catch {} }); }
function _notifyHistory() { _historySubs.forEach((cb) => { try { cb(); } catch {} }); }

function _mkToastId() { return Math.random().toString(36).slice(2, 10); }

function _dedupKey(key, reason) { return `${key}::${reason}`; }

function _pushHistory(entry) {
  // Dedup by (key, reason) in history too — if a prior entry exists,
  // bump its repeatCount + move to front.
  const dkey = _dedupKey(entry.key, entry.reason);
  const idx = _history.findIndex((h) => _dedupKey(h.key, h.reason) === dkey);
  if (idx >= 0) {
    const prior = _history[idx];
    _history.splice(idx, 1);
    _history.unshift({ ...entry, repeatCount: (prior.repeatCount || 1) + 1 });
  } else {
    _history.unshift(entry);
  }
  if (_history.length > _config.historyCap) _history = _history.slice(0, _config.historyCap);
  _notifyHistory();
}

export function emitToast(spec) {
  if (!spec || !spec.key) return '';
  if (isReasonMuted(spec.key, spec.reason)) return '';
  if (_keyAudio[spec.key]?.muted) return '';

  const dkey = _dedupKey(spec.key, spec.reason);
  const now = Date.now();
  // Dedup in visible stack: bump existing row's pulseTs + repeatCount.
  const existing = _toasts.find((t) => _dedupKey(t.key, t.reason) === dkey);
  if (existing) {
    existing.pulseTs = now;
    existing.repeatCount += 1;
    existing.summary = spec.summary || existing.summary;
    _notifyToasts();
    _pushHistory({ ...existing });
    return existing.id;
  }

  const entry = {
    id: _mkToastId(),
    key: spec.key,
    label: spec.label,
    summary: spec.summary,
    reason: spec.reason,
    anchor: spec.anchor,
    ts: now,
    repeatCount: 1,
    pulseTs: now,
  };
  _toasts.push(entry);
  // Trim to visible cap, dropping oldest.
  if (_toasts.length > _config.visibleCap) _toasts = _toasts.slice(-_config.visibleCap);
  _notifyToasts();
  _pushHistory({ ...entry });

  // Auto-dismiss on TTL.
  if (_config.toastTtlMs > 0) {
    setTimeout(() => dismissToast(entry.id), _config.toastTtlMs);
  }
  return entry.id;
}

export function notifyAlert(spec) {
  if (!spec || !spec.key) return '';
  // Mute checks happen in both playChime + emitToast; emit first so
  // the toast lands even if sound is OFF.
  const id = emitToast(spec);
  if (id) playChime(spec.key, spec.voiceOverride);
  return id;
}

export function subscribeToasts(cb) { _toastSubs.add(cb); return () => _toastSubs.delete(cb); }
export function getToasts() { return _toasts.slice(); }

export function dismissToast(id) {
  const before = _toasts.length;
  _toasts = _toasts.filter((t) => t.id !== id);
  if (_toasts.length !== before) _notifyToasts();
}
export function dismissToastsMatching(filter) {
  const before = _toasts.length;
  _toasts = _toasts.filter((t) => !filter(t));
  if (_toasts.length !== before) _notifyToasts();
}

export function subscribeToastHistory(cb) { _historySubs.add(cb); return () => _historySubs.delete(cb); }
export function getToastHistory() { return _history.slice(); }
export function clearToastHistory() { _history = []; _notifyHistory(); }
export function removeToastHistoryEntry(id) {
  const before = _history.length;
  _history = _history.filter((h) => h.id !== id);
  if (_history.length !== before) _notifyHistory();
}

// --------------------------------------------------------------------------
// Tab attention watcher (optional)
// --------------------------------------------------------------------------
export function installTabAttentionWatcher(config) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const prefix = config.titlePrefix ?? '🔔 ';
  let hasAttention = false;

  const apply = () => {
    config.onAttentionChange?.(hasAttention);
    if (config.computeBaseTitle) {
      const base = config.computeBaseTitle();
      document.title = (hasAttention ? prefix : '') + base;
    }
  };

  const onVis = () => {
    if (document.visibilityState === 'visible' && hasAttention) {
      hasAttention = false;
      apply();
    }
  };
  const onToast = () => {
    if (document.visibilityState === 'hidden' && _toasts.length > 0 && !hasAttention) {
      hasAttention = true;
      apply();
    }
  };

  document.addEventListener('visibilitychange', onVis);
  const unsubToasts = subscribeToasts(onToast);
  apply();

  return () => {
    document.removeEventListener('visibilitychange', onVis);
    unsubToasts();
  };
}
