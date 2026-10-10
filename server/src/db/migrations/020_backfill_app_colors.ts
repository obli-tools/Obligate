import type { Knex } from 'knex';

/**
 * Backfills `connected_apps.color` for the known app types with the accent
 * colors that used to be hardcoded (client APP_COLORS maps, now removed —
 * see migration 018 / the "apps discover each other dynamically" refactor).
 *
 * Without this, every app with no color set falls back to the same neutral
 * gray in every switcher across the suite — a visible regression from the
 * old per-app colors. Only fills NULL: an admin who already picked a color
 * via AppsPage keeps it. Any app type not listed here (including future
 * ones) is unaffected and simply needs a color set once in AppsPage.
 */
const KNOWN_COLORS: Record<string, string> = {
  obliview: '#19E2FF',
  obliguard: '#FFA515',
  oblimap: '#8DC63F',
  obliance: '#C2001B',
  obliplan: '#7c6cff',
  oblidesk: '#22b8f5',
  oblihub: '#2d4ec9',
  oblifield: '#AEEA00',
  obliwan: '#90A4AE',
};

export async function up(knex: Knex): Promise<void> {
  for (const [appType, color] of Object.entries(KNOWN_COLORS)) {
    await knex('connected_apps').where({ app_type: appType, color: null }).update({ color });
  }
}

export async function down(): Promise<void> {
  // Data backfill only — no schema change, nothing to revert. Colors are
  // still editable per app in AppsPage regardless.
}
