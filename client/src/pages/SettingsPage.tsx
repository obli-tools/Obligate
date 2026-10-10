import { useEffect, useState } from 'react';
import { Lock, Mail, Eye, EyeOff, Save, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import apiClient from '../api/client';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { useAuthStore } from '../store/authStore';
import { cn } from '../utils/cn';

interface AppSettings {
  minPasswordLength: number;
  force2fa: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpTls: boolean;
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [showSmtpPass, setShowSmtpPass] = useState(false);
  const [testTo, setTestTo] = useState(user?.email ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [form, setForm] = useState<AppSettings>({
    minPasswordLength: 4,
    force2fa: false,
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPass: '',
    smtpFrom: '',
    smtpTls: true,
  });

  useEffect(() => {
    apiClient.get('/admin/settings').then(({ data }) => {
      if (data.success) {
        setSettings(data.data);
        setForm(data.data);
      }
    });
  }, []);

  if (user?.role !== 'admin') {
    return <p className="text-text-muted p-8">{t('settings.adminRequired')}</p>;
  }

  const save = async (section?: Partial<Record<string, string>>) => {
    setSaving(true);
    setSuccess('');
    try {
      const patch = section ?? {
        minPasswordLength: String(form.minPasswordLength),
        force2fa: String(form.force2fa),
        smtpHost: form.smtpHost,
        smtpPort: String(form.smtpPort),
        smtpUser: form.smtpUser,
        smtpPass: form.smtpPass,
        smtpFrom: form.smtpFrom,
        smtpTls: String(form.smtpTls),
      };
      const { data } = await apiClient.put('/admin/settings', patch);
      if (data.success) {
        setSettings(data.data);
        setForm(data.data);
        setSuccess(t('settings.saved'));
        setTimeout(() => setSuccess(''), 3000);
      }
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const smtpConfigured = !!(form.smtpHost && form.smtpFrom);

  const testSmtp = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await apiClient.post('/admin/settings/smtp-test', {
        smtpHost: form.smtpHost,
        smtpPort: form.smtpPort,
        smtpUser: form.smtpUser,
        smtpPass: form.smtpPass,
        smtpFrom: form.smtpFrom,
        smtpTls: form.smtpTls,
        to: testTo,
      });
      if (data.success) {
        setTestResult({ ok: true, msg: t('settings.smtpTestSuccess', { to: data.data.to }) });
      } else {
        setTestResult({ ok: false, msg: data.error || t('settings.smtpTestFailed') });
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? err?.message ?? t('settings.smtpTestFailed');
      setTestResult({ ok: false, msg });
    } finally {
      setTesting(false);
    }
  };

  if (!settings) return null;

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-semibold text-text-primary">{t('settings.title')}</h1>

      {success && (
        <div className="bg-status-up-bg border border-status-up/30 rounded-md p-3 text-sm text-status-up">{success}</div>
      )}

      <section className="bg-bg-secondary border border-border rounded-lg p-5">
        <div className="flex items-center gap-2 mb-4">
          <Lock size={18} className="text-text-muted" />
          <h2 className="text-lg font-medium text-text-primary">{t('settings.security')}</h2>
        </div>

        <div className="space-y-4">
          <div className="max-w-xs">
            <label className="block text-sm font-medium text-text-secondary mb-1">{t('settings.minPasswordLength')}</label>
            <input
              type="number"
              min={1}
              max={128}
              value={form.minPasswordLength}
              onChange={e => setForm(f => ({ ...f, minPasswordLength: parseInt(e.target.value, 10) || 4 }))}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent"
            />
            <p className="text-xs text-text-muted mt-1">{t('settings.minPasswordLengthHelp')}</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">{t('settings.force2fa')}</p>
              <p className="text-xs text-text-muted">{t('settings.force2faDescription')}</p>
            </div>
            <button
              onClick={() => setForm(f => ({ ...f, force2fa: !f.force2fa }))}
              className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                form.force2fa ? 'bg-accent' : 'bg-bg-hover')}
            >
              <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                form.force2fa ? 'translate-x-6' : 'translate-x-1')} />
            </button>
          </div>
        </div>
      </section>

      <section className="bg-bg-secondary border border-border rounded-lg p-5">
        <div className="flex items-center gap-2 mb-4">
          <Mail size={18} className="text-text-muted" />
          <h2 className="text-lg font-medium text-text-primary">{t('settings.smtp')}</h2>
          {smtpConfigured && (
            <span className="text-xs bg-status-up-bg text-status-up px-2 py-0.5 rounded border border-status-up/30">{t('settings.smtpConfigured')}</span>
          )}
        </div>

        <p className="text-xs text-text-muted mb-4">{t('settings.smtpDescription')}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label={t('settings.smtpHost')}
            value={form.smtpHost}
            onChange={e => setForm(f => ({ ...f, smtpHost: e.target.value }))}
            placeholder={t('settings.smtpHostPlaceholder')}
          />
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">{t('settings.smtpPort')}</label>
            <input
              type="number"
              value={form.smtpPort}
              onChange={e => setForm(f => ({ ...f, smtpPort: parseInt(e.target.value, 10) || 587 }))}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <Input
            label={t('settings.smtpUser')}
            value={form.smtpUser}
            onChange={e => setForm(f => ({ ...f, smtpUser: e.target.value }))}
            placeholder={t('settings.smtpUserPlaceholder')}
          />
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">{t('settings.smtpPass')}</label>
            <div className="relative">
              <input
                type={showSmtpPass ? 'text' : 'password'}
                value={form.smtpPass}
                onChange={e => setForm(f => ({ ...f, smtpPass: e.target.value }))}
                className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 pr-9 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent"
              />
              <button
                type="button"
                onClick={() => setShowSmtpPass(!showSmtpPass)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              >
                {showSmtpPass ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          <Input
            label={t('settings.smtpFrom')}
            value={form.smtpFrom}
            onChange={e => setForm(f => ({ ...f, smtpFrom: e.target.value }))}
            placeholder={t('settings.smtpFromPlaceholder')}
          />
          <div className="flex items-center gap-3 self-end pb-1">
            <button
              onClick={() => setForm(f => ({ ...f, smtpTls: !f.smtpTls }))}
              className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                form.smtpTls ? 'bg-accent' : 'bg-bg-hover')}
            >
              <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                form.smtpTls ? 'translate-x-6' : 'translate-x-1')} />
            </button>
            <span className="text-sm text-text-secondary">{t('settings.useTls')}</span>
          </div>
        </div>

        {/* Test SMTP row — sends a test email using the CURRENT (unsaved) form
            values, so admins can validate credentials before persisting them.
            If the pass field is empty, the server falls back to the saved
            value (useful when the field shows the masked placeholder). */}
        <div className="mt-5 pt-5 border-t border-border">
          <label className="block text-sm font-medium text-text-secondary mb-1">
            {t('settings.smtpTestLabel', 'Send a test email')}
          </label>
          <p className="text-xs text-text-muted mb-3">
            {t('settings.smtpTestHelp', 'Uses the values shown above (does not require saving first).')}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <input
              type="email"
              value={testTo}
              onChange={e => setTestTo(e.target.value)}
              placeholder={t('settings.smtpTestToPlaceholder', 'recipient@example.com')}
              className="flex-1 rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent"
            />
            <Button
              variant="secondary"
              onClick={testSmtp}
              loading={testing}
              disabled={!form.smtpHost || !form.smtpFrom || !testTo}
            >
              <Send size={14} className="mr-1.5" />
              {t('settings.smtpTest', 'Test')}
            </Button>
          </div>
          {testResult && (
            <div
              className={cn(
                'mt-3 rounded-md border px-3 py-2 text-sm',
                testResult.ok
                  ? 'bg-status-up-bg border-status-up/30 text-status-up'
                  : 'bg-status-down-bg border-status-down/30 text-status-down',
              )}
            >
              {testResult.msg}
            </div>
          )}
        </div>
      </section>

      <div className="flex justify-end">
        <Button onClick={() => save()} loading={saving}>
          <Save size={16} className="mr-1.5" /> {t('settings.saveSettings')}
        </Button>
      </div>
    </div>
  );
}
