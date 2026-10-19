// Trigger-driven alert sound + toast library. See
// docs/ALERT_SOUND_RECIPE.md for the full walkthrough.
//
// Browser-only. All state lives in module-level singletons; call
// configureAlerts() once at app startup, then fire notifyAlert() per event.
// Toast rendering stays in the consumer SPA — subscribeToasts() + getToasts()
// expose the queue; the SPA renders whatever UI it wants from that data.

export type AlertSoundConfig = {
  /**
   * Prefix for every localStorage key the lib writes. Default 'f2a'
   * (f2 alerts). Set per-SPA to avoid cross-SPA bleed on a shared
   * domain. Keys written: `<prefix>:sound-on`, `<prefix>:gain`,
   * `<prefix>:key-mute`, `<prefix>:reason-mute`.
   */
  storagePrefix?: string;
  /**
   * Default master gain (0..1). Default 0.18 — audible over background
   * music without blowing eardrums. User-adjustable via setChimeMasterGain.
   */
  defaultMasterGain?: number;
  /** AudioContext idle-suspend threshold in ms. Default 10_000. */
  idleSuspendMs?: number;
  /** Chime exponential-release in seconds. Default 1.75. */
  releaseS?: number;
  /** Chime attack ramp in seconds. Default 0.02. */
  attackS?: number;
  /** Toast queue cap for the visible stack. Default 5. */
  visibleCap?: number;
  /** Toast queue cap for the rolling history. Default 50. */
  historyCap?: number;
  /** Toast auto-dismiss TTL in ms. Default 15_000. */
  toastTtlMs?: number;
  /** Dedup pulse animation hint in ms (consumer honours via pulseTs). Default 1_500. */
  dedupPulseMs?: number;
};

export type ChimeVoice = {
  wave: OscillatorType;
  freq: number;
  label: string;        // human-readable, e.g. "sine · A4"
};

export type KeyAudioOverride = {
  muted?: boolean;
  wave?: OscillatorType;
  octave?: number;      // 3..7
  semitone?: number;    // 0..11
};

export type AlertSpec = {
  /**
   * Deterministic voice key. Any string — the library hashes it (djb2)
   * to pick a waveform × octave × semitone, so repeated alerts on the
   * same key sound identical and the user builds ear-memory.
   */
  key: string;
  /** Short label for the toast header (e.g. an issue key or asset ID). */
  label: string;
  /** Longer context under the label. */
  summary: string;
  /**
   * Dedup component. Same (key, reason) tuple does NOT push a duplicate
   * toast — it bumps the existing row's repeatCount + pulseTs instead.
   */
  reason: string;
  /** Optional anchor data the consumer can read on toast click. */
  anchor?: {
    selector?: string;
    sectionId?: string;
    [k: string]: unknown;
  };
  /** Optional per-toast override of the voice (bypasses hash). */
  voiceOverride?: KeyAudioOverride;
};

export type AlertToast = {
  id: string;
  key: string;
  label: string;
  summary: string;
  reason: string;
  anchor?: AlertSpec['anchor'];
  ts: number;
  repeatCount: number;
  pulseTs: number;
};

/** Call once at app startup. Subsequent calls merge-patch the config. */
export function configureAlerts(config?: AlertSoundConfig): void;

// ----- Chime -----

/** Lazy-create AudioContext + play one chime for the given key. */
export function playChime(key: string, override?: KeyAudioOverride): void;

/** Fleet enable flag. Persisted. Default OFF. */
export function setChimeEnabled(v: boolean): void;
export function isChimeEnabled(): boolean;

/** Master gain, 0..1 (clamped). Persisted. */
export function setChimeMasterGain(g: number): void;
export function getChimeMasterGain(): number;

/** Per-key mute (persistent). Set null patch to clear. */
export function setKeyAudio(key: string, patch: KeyAudioOverride | null): void;
export function getKeyAudio(key: string): KeyAudioOverride;

/** Per-(key, reason) temporary mute with TTL. expiresAt = epoch ms. */
export function setReasonMuted(key: string, reason: string, expiresAt: number): void;
export function clearReasonMute(key: string, reason: string): void;
export function isReasonMuted(key: string, reason: string): boolean;

/** Deterministic voice resolution for a key (useful for preview UI). */
export function voiceForKey(key: string): ChimeVoice;

// ----- Toasts -----

/**
 * Push a toast + chime. Honours all mute controls + dedup. Returns the
 * toast id (new row OR the existing row's id on dedup).
 */
export function notifyAlert(spec: AlertSpec): string;

/** Lower-level: emit toast + history row only, no chime. */
export function emitToast(spec: AlertSpec): string;

export function subscribeToasts(cb: () => void): () => void;
export function getToasts(): AlertToast[];
export function dismissToast(id: string): void;
export function dismissToastsMatching(filter: (t: AlertToast) => boolean): void;

export function subscribeToastHistory(cb: () => void): () => void;
export function getToastHistory(): AlertToast[];
export function clearToastHistory(): void;
export function removeToastHistoryEntry(id: string): void;

// ----- Tab attention -----

export type TabAttentionConfig = {
  /** Emoji / string prepended to document.title while backgrounded. Default '🔔 '. */
  titlePrefix?: string;
  /**
   * Fn returning the "clean" title the lib should prefix. Called on every
   * toast change + visibilitychange. The lib does `document.title =
   * (bgAttention ? titlePrefix : '') + computeBaseTitle()`. Omit to opt
   * out — the lib won't touch document.title at all.
   */
  computeBaseTitle?: () => string;
  /**
   * Fired on every attention state transition. Consumer can use this to
   * drive favicon changes etc. The lib does NOT manage the favicon itself.
   */
  onAttentionChange?: (hasAttention: boolean) => void;
};

/**
 * Installs visibilitychange + subscribeToasts listeners. Call once after
 * configureAlerts(). Returns an uninstall fn.
 */
export function installTabAttentionWatcher(config: TabAttentionConfig): () => void;
