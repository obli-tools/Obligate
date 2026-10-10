import { THEME_CATALOG, DEFAULT_THEME_ID } from '@obligate/shared';

const KNOWN_THEME_IDS = new Set(THEME_CATALOG.map(t => t.id));

/**
 * Return the given theme id if it matches a known theme in the catalog,
 * otherwise fall back to the platform default. Never returns null/undefined.
 *
 * Used on write (reject garbage before persisting) AND on read (coerce any
 * legacy or corrupted row value before it reaches the client). Defense in
 * depth — even if a bad value slipped in from an older code path or a bug
 * on a spoke app, the client always sees a valid id.
 */
export function sanitizeThemeId(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return DEFAULT_THEME_ID;
  return KNOWN_THEME_IDS.has(value) ? value : DEFAULT_THEME_ID;
}
