import { db } from '../db';
import { sanitizeThemeId } from '../utils/theme';

export interface PreferenceSchema {
  key: string;
  label: string;
  fieldType: 'text' | 'select' | 'boolean' | 'number';
  options: string[] | null;
  defaultValue: string | null;
  sortOrder: number;
}

export interface CommonPreferences {
  preferredTheme: string;
  toastEnabled: boolean;
  toastPosition: string;
  profilePhotoUrl: string | null;
  preferredLanguage: string;
  anonymousMode: boolean;
}

export const preferencesService = {
  // ── Common preferences ─────────────────────────────────────

  async getCommonPreferences(userId: number): Promise<CommonPreferences> {
    const row = await db('users')
      .where({ id: userId })
      .select('preferred_theme', 'toast_enabled', 'toast_position', 'profile_photo_url', 'preferred_language', 'anonymous_mode')
      .first() as {
        preferred_theme: string; toast_enabled: boolean; toast_position: string;
        profile_photo_url: string | null; preferred_language: string; anonymous_mode: boolean;
      } | undefined;

    return {
      preferredTheme: sanitizeThemeId(row?.preferred_theme),
      toastEnabled: row?.toast_enabled ?? true,
      toastPosition: row?.toast_position ?? 'bottom-right',
      profilePhotoUrl: row?.profile_photo_url ?? null,
      preferredLanguage: row?.preferred_language ?? 'en',
      anonymousMode: row?.anonymous_mode ?? false,
    };
  },

  async updateCommonPreferences(userId: number, data: Partial<CommonPreferences>): Promise<void> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    // Coerce unknown theme ids to the platform default before persisting —
    // prevents any bug on Obligate itself or on a spoke app from polluting
    // the row with a value the client can't render.
    if (data.preferredTheme !== undefined) update.preferred_theme = sanitizeThemeId(data.preferredTheme);
    if (data.toastEnabled !== undefined) update.toast_enabled = data.toastEnabled;
    if (data.toastPosition !== undefined) update.toast_position = data.toastPosition;
    if (data.profilePhotoUrl !== undefined) update.profile_photo_url = data.profilePhotoUrl;
    if (data.preferredLanguage !== undefined) update.preferred_language = data.preferredLanguage;
    if (data.anonymousMode !== undefined) update.anonymous_mode = data.anonymousMode;
    await db('users').where({ id: userId }).update(update);
  },

  // ── App-specific preference schemas ────────────────────────

  async syncSchemas(appId: number, schemas: PreferenceSchema[]): Promise<void> {
    // Delete schemas no longer declared by the app
    const declaredKeys = schemas.map(s => s.key);
    await db('app_preference_schemas')
      .where({ app_id: appId })
      .whereNotIn('key', declaredKeys)
      .del();

    // Upsert each schema
    for (const s of schemas) {
      await db('app_preference_schemas')
        .insert({
          app_id: appId,
          key: s.key,
          label: s.label,
          field_type: s.fieldType,
          options: s.options ? JSON.stringify(s.options) : null,
          default_value: s.defaultValue,
          sort_order: s.sortOrder,
        })
        .onConflict(['app_id', 'key'])
        .merge({
          label: s.label,
          field_type: s.fieldType,
          options: s.options ? JSON.stringify(s.options) : null,
          default_value: s.defaultValue,
          sort_order: s.sortOrder,
        });
    }
  },

  async getSchemasForApp(appId: number): Promise<PreferenceSchema[]> {
    const rows = await db('app_preference_schemas')
      .where({ app_id: appId })
      .orderBy('sort_order') as Array<{
        key: string; label: string; field_type: string; options: string | null;
        default_value: string | null; sort_order: number;
      }>;

    return rows.map(r => ({
      key: r.key,
      label: r.label,
      fieldType: r.field_type as PreferenceSchema['fieldType'],
      options: r.options ? JSON.parse(r.options) : null,
      defaultValue: r.default_value,
      sortOrder: r.sort_order,
    }));
  },

  async getAllSchemasGroupedByApp(): Promise<Array<{ appId: number; appName: string; appType: string; schemas: PreferenceSchema[] }>> {
    const rows = await db('app_preference_schemas as aps')
      .join('connected_apps as ca', 'ca.id', 'aps.app_id')
      .where('ca.is_active', true)
      .select('aps.*', 'ca.name as app_name', 'ca.app_type')
      .orderBy('ca.name')
      .orderBy('aps.sort_order') as Array<{
        app_id: number; key: string; label: string; field_type: string; options: string | null;
        default_value: string | null; sort_order: number; app_name: string; app_type: string;
      }>;

    const grouped = new Map<number, { appId: number; appName: string; appType: string; schemas: PreferenceSchema[] }>();
    for (const r of rows) {
      if (!grouped.has(r.app_id)) {
        grouped.set(r.app_id, { appId: r.app_id, appName: r.app_name, appType: r.app_type, schemas: [] });
      }
      grouped.get(r.app_id)!.schemas.push({
        key: r.key,
        label: r.label,
        fieldType: r.field_type as PreferenceSchema['fieldType'],
        options: r.options ? JSON.parse(r.options) : null,
        defaultValue: r.default_value,
        sortOrder: r.sort_order,
      });
    }
    return Array.from(grouped.values());
  },

  // ── User app-specific preference values ────────────────────

  async getAppPreferences(userId: number, appId: number): Promise<Record<string, string>> {
    const rows = await db('user_app_preferences')
      .where({ user_id: userId, app_id: appId }) as Array<{ key: string; value: string | null }>;
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.key] = r.value ?? '';
    }
    return result;
  },

  async getAllAppPreferences(userId: number): Promise<Record<number, Record<string, string>>> {
    const rows = await db('user_app_preferences')
      .where({ user_id: userId }) as Array<{ app_id: number; key: string; value: string | null }>;
    const result: Record<number, Record<string, string>> = {};
    for (const r of rows) {
      if (!result[r.app_id]) result[r.app_id] = {};
      result[r.app_id][r.key] = r.value ?? '';
    }
    return result;
  },

  async setAppPreference(userId: number, appId: number, key: string, value: string): Promise<void> {
    await db('user_app_preferences')
      .insert({ user_id: userId, app_id: appId, key, value })
      .onConflict(['user_id', 'app_id', 'key'])
      .merge({ value });
  },

  async setAppPreferences(userId: number, appId: number, prefs: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(prefs)) {
      await this.setAppPreference(userId, appId, key, value);
    }
  },
};
