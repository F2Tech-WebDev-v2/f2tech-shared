/**
 * Map an English country name (any common alias) to its ISO 3166-1
 * alpha-2 code. Case-insensitive, trims whitespace.
 */
export function iso2ForCountryName(name: string | null | undefined): string | undefined;

/**
 * Canonical short English name for an ISO 3166-1 alpha-2 code.
 */
export function nameForIso2(iso: string | null | undefined): string | undefined;

/** Read-only alias map — exposed so consumers can extend with locale-
 *  specific synonyms via a wrapping table without forking this module. */
export const COUNTRY_NAME_ALIASES: Readonly<Record<string, string>>;
