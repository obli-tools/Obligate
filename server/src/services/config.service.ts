import { db } from '../db';

export interface ObligateAppConfig {
  minPasswordLength: number;
  force2fa: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpTls: boolean;
}

export const configService = {
  async get(key: string): Promise<string | null> {
    const row = await db('obligate_config').where({ key }).first('value');
    return row?.value ?? null;
  },

  async set(key: string, value: string): Promise<void> {
    await db('obligate_config')
      .insert({ key, value, updated_at: new Date() })
      .onConflict('key')
      .merge({ value, updated_at: new Date() });
  },

  async getAll(): Promise<ObligateAppConfig> {
    const rows = await db('obligate_config').select('key', 'value') as Array<{ key: string; value: string | null }>;
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value ?? '';

    return {
      minPasswordLength: parseInt(map['min_password_length'] ?? '4', 10) || 4,
      force2fa: map['force_2fa'] === 'true',
      smtpHost: map['smtp_host'] ?? '',
      smtpPort: parseInt(map['smtp_port'] ?? '587', 10) || 587,
      smtpUser: map['smtp_user'] ?? '',
      smtpPass: map['smtp_pass'] ?? '',
      smtpFrom: map['smtp_from'] ?? '',
      smtpTls: map['smtp_tls'] !== 'false',
    };
  },

  async update(patch: Partial<Record<string, string>>): Promise<ObligateAppConfig> {
    const keyMap: Record<string, string> = {
      minPasswordLength: 'min_password_length',
      force2fa: 'force_2fa',
      smtpHost: 'smtp_host',
      smtpPort: 'smtp_port',
      smtpUser: 'smtp_user',
      smtpPass: 'smtp_pass',
      smtpFrom: 'smtp_from',
      smtpTls: 'smtp_tls',
    };
    for (const [camel, val] of Object.entries(patch)) {
      const dbKey = keyMap[camel];
      if (dbKey && val !== undefined) {
        await this.set(dbKey, val);
      }
    }
    return this.getAll();
  },

  /** Returns true if SMTP is fully configured (host + from at minimum). */
  async isSmtpConfigured(): Promise<boolean> {
    const cfg = await this.getAll();
    return !!(cfg.smtpHost && cfg.smtpFrom);
  },
};
