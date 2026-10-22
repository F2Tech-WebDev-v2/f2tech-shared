// Per-customer brand-config-driven alert sound.
// See docs/ALERT_SOUND_RECIPE.md section "Per-customer configured sound".
//
// Different pattern from alert-sound.{js,d.ts} — this one reads the tone
// FROM the backend per customer slug rather than deriving it from a key hash.

export interface BrandSoundConfig {
  /**
   * Base URL up to and including `/rest`. Example: 'https://admin.f2-tech.ai/rest'
   * or '/rest' when the SPA is same-origin with its API.
   */
  apiUrl?: string;
  /**
   * localStorage namespace. Default 'f2bas' (f2 brand alert sound).
   * Pick a per-SPA value to avoid cross-SPA bleed when both are open on
   * the same browser profile. Keys written: `<prefix>:muted`, `<prefix>:volume`.
   */
  storagePrefix?: string;
  /**
   * Field on `/rest/api/brand-config?slug=<slug>` that holds the per-customer
   * `{ enabled, instrument, note }` sub-doc. Default `error_alert_sound`
   * (matches the admin error-reports extraction source).
   */
  configField?: string;
  /** Brand-config fetch cache TTL in ms. Default 60_000. */
  cacheTtlMs?: number;
  /** AudioContext auto-release idle threshold in ms. Default 5000. */
  autoReleaseMs?: number;
  /** Cold-start warm-up delay in seconds. Default 1.0. */
  warmupDelayS?: number;
  /** Operator volume 0..100 when nothing is persisted. Default 70. */
  defaultVolume?: number;
  /** Mute state when nothing is persisted. Default false. */
  defaultMuted?: boolean;
  /**
   * Slug used when the caller passes null/undefined — maps to the 'f2'
   * company doc's default sound (configured by admin as "Default /
   * non-customer reports"). Default 'f2'.
   */
  defaultSlug?: string;
}

export interface BrandSoundValue {
  enabled: boolean;
  instrument: string;
  note: string;
}

/** Call once at app startup. Subsequent calls merge-patch the config. */
export function configureBrandSound(config?: BrandSoundConfig): void;

/** Play the configured tone for a customer slug. Fire-and-forget. No-ops when
 *  muted / no config / brand-config disabled / autoplay blocked / SSR. */
export function playForCustomer(customerSlug: string | null | undefined): Promise<void>;

/** Preview a sound directly (bypasses cache + brand-config). Used by the
 *  Settings dialog's Preview button. */
export function previewBrandSound(instrument: string, note: string): void;

/** Drop a slug's cached brand-config so the next `playForCustomer` refetches.
 *  Call after a Settings-dialog save. */
export function invalidateBrandSoundCustomer(slug: string): void;

/** Operator mute toggle. Persisted. */
export function setBrandSoundMuted(muted: boolean): void;
export function isBrandSoundMuted(): boolean;

/** Operator volume 0..100 (clamped). Persisted. */
export function setBrandSoundVolume(v: number): void;
export function getBrandSoundVolume(): number;

/** Instrument + display label pairs for settings-dialog dropdowns. */
export const BRAND_SOUND_INSTRUMENTS: ReadonlyArray<{ value: string; label: string }>;

/** Three-octave range of naturals + sharps for the note picker. */
export const BRAND_SOUND_NOTES: ReadonlyArray<string>;
