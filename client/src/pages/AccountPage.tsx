import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Key, User, Palette, Bell, Shield, EyeOff, Camera } from 'lucide-react';
import apiClient from '../api/client';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { ThemePicker } from '../components/ThemePicker';
import { useAuthStore } from '../store/authStore';
import { cn } from '../utils/cn';
import { applyTheme } from '../utils/theme';

interface CommonPreferences {
  preferredTheme: string;
  toastEnabled: boolean;
  toastPosition: string;
  profilePhotoUrl: string | null;
  preferredLanguage: string;
  anonymousMode: boolean;
}

interface PreferenceSchema {
  key: string;
  label: string;
  fieldType: 'text' | 'select' | 'boolean' | 'number';
  options: string[] | null;
  defaultValue: string | null;
}

interface AppSection {
  appId: number;
  appName: string;
  appType: string;
  schemas: PreferenceSchema[];
  values: Record<string, string>;
}

interface AppStatus {
  appId: number;
  appType: string;
  name: string;
  baseUrl: string;
  linked: boolean;
  enabled: boolean;
  lastLoginAt: string | null;
}

function AlertPreviewSvg({ position }: { position: 'bottom-right' | 'top-center' }) {
  return (
    <svg viewBox="0 0 200 120" className="w-full max-w-xs mx-auto rounded-lg border border-border bg-bg-primary">
      <rect x="4" y="4" width="192" height="112" rx="6" fill="currentColor" className="text-bg-secondary" stroke="currentColor" strokeWidth="1" />
      <rect x="4" y="4" width="192" height="16" rx="6" fill="currentColor" className="text-bg-hover" />
      <rect x="8" y="8" width="40" height="8" rx="3" fill="currentColor" className="text-border" />
      <rect x="160" y="8" width="30" height="8" rx="3" fill="currentColor" className="text-border" />
      {[28, 38, 48, 58].map((y) => (
        <rect key={y} x="12" y={y} width={30 + (y % 20) * 2} height="5" rx="2" fill="currentColor" className="text-border opacity-50" />
      ))}
      {position === 'bottom-right' ? (
        <>
          <rect x="110" y="82" width="80" height="22" rx="4" fill="currentColor" className="text-accent" opacity="0.9" />
          <rect x="115" y="87" width="50" height="4" rx="2" fill="white" opacity="0.9" />
          <rect x="115" y="94" width="35" height="3" rx="2" fill="white" opacity="0.6" />
        </>
      ) : (
        <>
          <rect x="60" y="24" width="80" height="22" rx="4" fill="currentColor" className="text-accent" opacity="0.9" />
          <rect x="65" y="29" width="50" height="4" rx="2" fill="white" opacity="0.9" />
          <rect x="65" y="36" width="35" height="3" rx="2" fill="white" opacity="0.6" />
        </>
      )}
    </svg>
  );
}

export function AccountPage() {
  const { t } = useTranslation();
  const { user, checkSession } = useAuthStore();
  const [apps, setApps] = useState<AppStatus[]>([]);
  const [common, setCommon] = useState<CommonPreferences | null>(null);
  const [appSections, setAppSections] = useState<AppSection[]>([]);
  useEffect(() => {
    apiClient.get('/account/apps').then(({ data }) => {
      if (data.success) setApps(data.data);
    });
    apiClient.get('/account/preferences').then(({ data }) => {
      if (data.success) {
        setCommon(data.data.common);
        setAppSections(data.data.appSections);
      }
    });
  }, []);

  const saveCommon = async (patch: Partial<CommonPreferences>) => {
    try {
      const { data } = await apiClient.put('/account/preferences/common', patch);
      if (data.success) {
        setCommon(data.data);
        if (patch.preferredTheme) applyTheme(patch.preferredTheme);
        // Refresh authStore so Header/Sidebar pick up the new photo / display name
        if (patch.profilePhotoUrl !== undefined) await checkSession();
      }
    } catch { /* ignore */ }
  };

  const saveAppPref = async (appId: number, key: string, value: string) => {
    await apiClient.put(`/account/preferences/app/${appId}`, { [key]: value });
    setAppSections(prev => prev.map(s =>
      s.appId === appId ? { ...s, values: { ...s.values, [key]: value } } : s
    ));
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-semibold text-text-primary">{t('account.title')}</h1>

      {/* ── Profile ────────────────────────────────────────────── */}
      <section className="bg-bg-secondary border border-border rounded-lg p-5">
        <div className="flex items-center gap-2 mb-4">
          <User size={18} className="text-text-muted" />
          <h2 className="text-lg font-medium text-text-primary">{t('account.profile')}</h2>
        </div>
        <div className="flex items-start gap-5">
          <ProfilePhotoUpload currentUrl={common?.profilePhotoUrl ?? null} onSaved={url => saveCommon({ profilePhotoUrl: url })} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm flex-1">
            <div>
              <span className="text-text-muted">{t('account.username')}</span>
              <p className="text-text-primary font-medium">{user?.username}</p>
            </div>
            <div>
              <span className="text-text-muted">{t('account.displayName')}</span>
              <p className="text-text-primary font-medium">{user?.displayName || t('common.noData')}</p>
            </div>
            <div>
              <span className="text-text-muted">{t('account.email')}</span>
              <p className="text-text-primary font-medium">{user?.email || t('common.noData')}</p>
            </div>
            <div>
              <span className="text-text-muted">{t('account.authSource')}</span>
              <p className="text-text-primary font-medium">{user?.authSource === 'ldap' ? t('account.ldap') : t('account.local')}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Password ───────────────────────────────────────────── */}
      <ChangePasswordSection />

      {/* ── Two-Factor Authentication ──────────────────────────── */}
      <TotpSection />

      {/* ── Appearance ─────────────────────────────────────────── */}
      {common && (
        <section className="bg-bg-secondary border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-4">
            <Palette size={18} className="text-text-muted" />
            <h2 className="text-lg font-medium text-text-primary">{t('account.appearance')}</h2>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-2">{t('account.theme')}</label>
              <ThemePicker
                value={common.preferredTheme}
                onChange={theme => saveCommon({ preferredTheme: theme })}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-2">{t('account.language')}</label>
              <select
                value={common.preferredLanguage}
                onChange={e => saveCommon({ preferredLanguage: e.target.value })}
                className="rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="en">English</option>
                <option value="fr">Francais</option>
                <option value="es">Espanol</option>
                <option value="de">Deutsch</option>
                <option value="pt-BR">Portugues (BR)</option>
                <option value="zh-CN">Chinese</option>
                <option value="ja">Japanese</option>
                <option value="ru">Russian</option>
                <option value="ko">Korean</option>
                <option value="ar">Arabic</option>
                <option value="it">Italiano</option>
                <option value="nl">Nederlands</option>
                <option value="pl">Polski</option>
                <option value="tr">Turkce</option>
                <option value="sv">Svenska</option>
                <option value="da">Dansk</option>
                <option value="cs">Cestina</option>
                <option value="uk">Ukrainian</option>
              </select>
            </div>
          </div>
        </section>
      )}

      {/* ── Notifications ──────────────────────────────────────── */}
      {common && (
        <section className="bg-bg-secondary border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-4">
            <Bell size={18} className="text-text-muted" />
            <h2 className="text-lg font-medium text-text-primary">{t('account.notifications')}</h2>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">{t('account.toastNotifications')}</p>
                <p className="text-xs text-text-muted">{t('account.toastHelp')}</p>
              </div>
              <button
                onClick={() => saveCommon({ toastEnabled: !common.toastEnabled })}
                className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                  common.toastEnabled ? 'bg-accent' : 'bg-bg-hover')}
              >
                <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                  common.toastEnabled ? 'translate-x-6' : 'translate-x-1')} />
              </button>
            </div>

            {common.toastEnabled && (
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-2">{t('account.toastPosition')}</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { value: 'bottom-right', label: t('account.bottomRight') },
                    { value: 'top-center', label: t('account.topCenter') },
                  ].map(p => (
                    <button
                      key={p.value}
                      onClick={() => saveCommon({ toastPosition: p.value })}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors',
                        common.toastPosition === p.value
                          ? 'border-accent bg-accent/10'
                          : 'border-border hover:border-accent/50 hover:bg-bg-hover',
                      )}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <div className={cn('h-4 w-4 rounded-full border-2 flex items-center justify-center',
                          common.toastPosition === p.value ? 'border-accent' : 'border-border')}>
                          {common.toastPosition === p.value && <div className="h-2 w-2 rounded-full bg-accent" />}
                        </div>
                        <span className="text-sm font-medium text-text-primary">{p.label}</span>
                      </div>
                      <p className="text-xs text-text-muted mb-3">
                        {p.value === 'bottom-right'
                          ? t('account.bottomRightHelp')
                          : t('account.topCenterHelp')}
                      </p>
                      <AlertPreviewSvg position={p.value as 'bottom-right' | 'top-center'} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Privacy ────────────────────────────────────────────── */}
      {common && (
        <section className="bg-bg-secondary border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-4">
            <EyeOff size={18} className="text-text-muted" />
            <h2 className="text-lg font-medium text-text-primary">{t('account.privacy')}</h2>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">{t('account.anonymousMode')}</p>
              <p className="text-xs text-text-muted">{t('account.anonymousModeHelp')}</p>
            </div>
            <button
              onClick={() => saveCommon({ anonymousMode: !common.anonymousMode })}
              className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                common.anonymousMode ? 'bg-accent' : 'bg-bg-hover')}
            >
              <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                common.anonymousMode ? 'translate-x-6' : 'translate-x-1')} />
            </button>
          </div>
        </section>
      )}

      {/* ── App-Specific Preferences ───────────────────────────── */}
      {appSections.map(section => (
        <section key={section.appId} className="bg-bg-secondary border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-4">
            <Shield size={18} className="text-text-muted" />
            <h2 className="text-lg font-medium text-text-primary">{t('account.appPreferences', { name: section.appName })}</h2>
            <span className="text-xs text-text-muted bg-bg-tertiary px-2 py-0.5 rounded">{section.appType}</span>
          </div>

          <div className="space-y-3">
            {section.schemas.map(schema => (
              <AppPreferenceField
                key={schema.key}
                schema={schema}
                value={section.values[schema.key] ?? schema.defaultValue ?? ''}
                onChange={value => saveAppPref(section.appId, schema.key, value)}
              />
            ))}
            {section.schemas.length === 0 && (
              <p className="text-xs text-text-muted">{t('account.noAppPrefs')}</p>
            )}
          </div>
        </section>
      ))}

      {/* ── Connected Apps ─────────────────────────────────────── */}
      <section className="bg-bg-secondary border border-border rounded-lg p-5">
        <h2 className="text-lg font-medium text-text-primary mb-4">{t('account.connectedApps')}</h2>
        <div className="space-y-2">
          {apps.map(app => (
            <div key={app.appId} className="flex items-center justify-between bg-bg-tertiary rounded-lg px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-text-primary font-medium">{app.name}</span>
                  <span className="text-xs text-text-muted">{app.appType}</span>
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  {app.linked ? t('account.accountLinked') : t('account.notLinked')}
                  {app.lastLoginAt && <span className="ml-2">Last login: {new Date(app.lastLoginAt).toLocaleDateString()}</span>}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs ${app.enabled ? 'text-status-up' : 'text-status-down'}`}>
                  {app.enabled ? t('common.enabled') : t('common.disabled')}
                </span>
                <a href={app.baseUrl} target="_blank" rel="noopener noreferrer" className="text-text-muted hover:text-text-primary">
                  <ExternalLink size={14} />
                </a>
              </div>
            </div>
          ))}
          {apps.length === 0 && (
            <p className="text-center text-text-muted py-8 text-sm">{t('account.noConnectedApps')}</p>
          )}
        </div>
      </section>
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────────

function AppPreferenceField({ schema, value, onChange }: {
  schema: PreferenceSchema; value: string; onChange: (v: string) => void;
}) {
  if (schema.fieldType === 'boolean') {
    return (
      <div className="flex items-center justify-between">
        <label className="text-sm text-text-primary">{schema.label}</label>
        <button
          onClick={() => onChange(value === 'true' ? 'false' : 'true')}
          className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
            value === 'true' ? 'bg-accent' : 'bg-bg-hover')}
        >
          <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
            value === 'true' ? 'translate-x-6' : 'translate-x-1')} />
        </button>
      </div>
    );
  }

  if (schema.fieldType === 'select' && schema.options) {
    return (
      <div className="space-y-1">
        <label className="block text-sm font-medium text-text-secondary">{schema.label}</label>
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">— Select —</option>
          {schema.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-text-secondary">{schema.label}</label>
      <input
        type={schema.fieldType === 'number' ? 'number' : 'text'}
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={e => onChange(e.target.value)}
        className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent"
      />
    </div>
  );
}

function ChangePasswordSection() {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSuccess(false);
    if (newPassword.length < 4) { setError(t('account.passwordTooShort', { min: 4 })); return; }
    if (newPassword !== confirm) { setError(t('account.passwordMismatch')); return; }
    setSaving(true);
    try {
      const { data } = await apiClient.put('/account/password', { currentPassword, newPassword });
      if (data.success) { setSuccess(true); setCurrentPassword(''); setNewPassword(''); setConfirm(''); }
      else setError(data.error || 'Failed');
    } catch (err: unknown) {
      const resp = (err as { response?: { status?: number; data?: { error?: string; code?: string } } })?.response;
      if (resp?.data?.code === 'currentPasswordRequired') {
        setError(t('account.currentPasswordRequired') || 'Enter your current password.');
      } else if (resp?.data?.code === 'currentPasswordInvalid') {
        setError(t('account.currentPasswordInvalid') || 'The current password is incorrect.');
      } else if (resp?.status === 429) {
        setError(t('account.tooManyAttempts') || 'Too many attempts. Try again later.');
      } else {
        setError(resp?.data?.error || t('account.passwordChangeFailed') || 'Failed to change password');
      }
    } finally { setSaving(false); }
  };

  return (
    <section className="bg-bg-secondary border border-border rounded-lg p-5">
      <div className="flex items-center gap-2 mb-4">
        <Key size={18} className="text-text-muted" />
        <h2 className="text-lg font-medium text-text-primary">{t('account.changePassword')}</h2>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3 max-w-sm">
        <Input label={t('account.currentPassword')} type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required />
        <Input label={t('account.newPassword')} type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
        <Input label={t('account.confirmPassword')} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
        {error && <div className="bg-status-down-bg border border-status-down/30 rounded-md p-3 text-sm text-status-down">{error}</div>}
        {success && <div className="bg-status-up-bg border border-status-up/30 rounded-md p-3 text-sm text-status-up">{t('account.passwordChanged')}</div>}
        <Button type="submit" loading={saving} size="sm">{t('account.updatePassword')}</Button>
      </form>
    </section>
  );
}

function TotpSection() {
  const { t } = useTranslation();
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [setupData, setSetupData] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);
  // Disabling requires a current code of the active authenticator (server-enforced).
  const [disabling, setDisabling] = useState(false);
  const [disableCode, setDisableCode] = useState('');

  useEffect(() => {
    apiClient.get('/profile/2fa/status').then(({ data }) => {
      if (data.success) {
        setTotpEnabled(data.data.totpEnabled);
        setChecked(true);
      }
    }).catch(() => setChecked(true));
  }, []);

  const startSetup = async () => {
    setError('');
    try {
      const { data } = await apiClient.post('/profile/2fa/totp/setup');
      if (data.success) setSetupData(data.data);
    } catch (err: unknown) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      setError(code === 'totpAlreadyEnabled'
        ? (t('account.totpAlreadyEnabled') || 'Two-factor authentication is already enabled. Disable it first to replace your authenticator.')
        : (t('account.setup2faFailed') || 'Failed to start setup'));
    }
  };

  const enableTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await apiClient.post('/profile/2fa/totp/enable', { code });
      if (data.success) {
        setTotpEnabled(true);
        setSetupData(null);
        setCode('');
      } else {
        setError(t('login.invalidCode'));
      }
    } catch (err: unknown) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      setError(code === 'totpAlreadyEnabled'
        ? (t('account.totpAlreadyEnabled') || 'Two-factor authentication is already enabled. Disable it first to replace your authenticator.')
        : t('login.invalidCode'));
    } finally { setLoading(false); }
  };

  const disableTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await apiClient.delete('/profile/2fa/totp', { data: { code: disableCode } });
      setTotpEnabled(false);
      setDisabling(false);
      setDisableCode('');
    } catch (err: unknown) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'codeUsed') setError(t('account.codeUsed') || 'This code has already been used. Wait for the next code.');
      else if (code === 'tooManyAttempts') setError(t('account.tooManyAttempts') || 'Too many attempts. Try again later.');
      else if (code === 'invalidCode' || code === 'codeRequired') setError(t('login.invalidCode'));
      else setError(t('account.disable2faFailed') || 'Failed to disable two-factor authentication');
    } finally { setLoading(false); }
  };

  if (!checked) return null;

  return (
    <section className="bg-bg-secondary border border-border rounded-lg p-5">
      <div className="flex items-center gap-2 mb-4">
        <Shield size={18} className="text-text-muted" />
        <h2 className="text-lg font-medium text-text-primary">{t('account.twoFactor')}</h2>
        {totpEnabled && (
          <span className="text-xs bg-status-up-bg text-status-up px-2 py-0.5 rounded border border-status-up/30">{t('common.enabled')}</span>
        )}
      </div>

      {totpEnabled ? (
        disabling ? (
          <form onSubmit={disableTotp} className="space-y-3 max-w-sm">
            <p className="text-sm text-text-muted">
              {t('account.disable2faConfirm') || 'Disabling two-factor authentication makes your account less secure. Enter a current code from your authenticator app to confirm.'}
            </p>
            <Input
              label={t('account.verificationCode')}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={disableCode}
              onChange={e => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              autoFocus
              required
            />
            {error && <div className="bg-status-down-bg border border-status-down/30 rounded-md p-3 text-sm text-status-down">{error}</div>}
            <div className="flex gap-2">
              <Button type="submit" variant="danger" loading={loading} size="sm">{t('account.disable2fa')}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setDisabling(false); setDisableCode(''); setError(''); }}>{t('common.cancel')}</Button>
            </div>
          </form>
        ) : (
          <div>
            <p className="text-sm text-text-muted mb-3">{t('account.twoFactorActive')}</p>
            <Button size="sm" variant="danger" onClick={() => { setDisabling(true); setError(''); }}>{t('account.disable2fa')}</Button>
          </div>
        )
      ) : setupData ? (
        <form onSubmit={enableTotp} className="space-y-4">
          <p className="text-sm text-text-muted">{t('account.scanQrHelp')}</p>
          <div className="flex justify-center">
            <img src={setupData.qrDataUrl} alt="TOTP QR Code" className="rounded-lg" width={200} height={200} />
          </div>
          <div>
            <p className="text-xs text-text-muted mb-1">{t('account.manualSecret')}</p>
            <code className="block bg-bg-tertiary px-3 py-2 rounded text-sm font-mono text-text-primary break-all select-all">{setupData.secret}</code>
          </div>
          <Input
            label={t('account.verificationCode')}
            type="text"
            inputMode="numeric"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            required
          />
          {error && <div className="bg-status-down-bg border border-status-down/30 rounded-md p-3 text-sm text-status-down">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit" loading={loading} size="sm">{t('account.enable2fa')}</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSetupData(null)}>{t('common.cancel')}</Button>
          </div>
        </form>
      ) : (
        <div>
          <p className="text-sm text-text-muted mb-3">{t('account.setup2faHelp')}</p>
          {error && <div className="bg-status-down-bg border border-status-down/30 rounded-md p-3 text-sm text-status-down mb-3">{error}</div>}
          <Button size="sm" onClick={startSetup}>{t('account.setup2fa')}</Button>
        </div>
      )}
    </section>
  );
}

function ProfilePhotoUpload({ currentUrl, onSaved }: { currentUrl: string | null; onSaved: (url: string | null) => void }) {
  const { t } = useTranslation();
  const [uploading, setUploading] = useState(false);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 512 * 1024) { alert(t('account.imageTooLarge')); return; }

    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        onSaved(dataUrl);
        setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch {
      setUploading(false);
    }
  };

  return (
    <div className="relative shrink-0">
      {currentUrl ? (
        <img src={currentUrl} alt="Profile" className="h-16 w-16 rounded-full object-cover border border-border" />
      ) : (
        <div className="h-16 w-16 rounded-full bg-bg-tertiary border border-border flex items-center justify-center">
          <User size={24} className="text-text-muted" />
        </div>
      )}
      <label className={cn(
        'absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-accent flex items-center justify-center cursor-pointer',
        'hover:bg-accent-hover transition-colors border-2 border-bg-secondary',
        uploading && 'opacity-50 pointer-events-none',
      )}>
        <Camera size={12} className="text-white" />
        <input type="file" accept="image/*" className="hidden" onChange={handleFile} />
      </label>
      {currentUrl && (
        <button
          onClick={() => onSaved(null)}
          className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-status-down flex items-center justify-center text-white text-xs border-2 border-bg-secondary hover:bg-status-down/80"
          title={t('account.removePhoto')}
        >
          ×
        </button>
      )}
    </div>
  );
}
