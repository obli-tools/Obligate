import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Shield, LogOut } from 'lucide-react';
import apiClient from '../api/client';
import { useAuthStore } from '../store/authStore';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { safeReturnTo } from '../utils/safeReturnTo';

export function Setup2faPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // An app sign-in (/authorize) waiting for the second factor to be set up
  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  const { t } = useTranslation();
  const { user, logout, checkSession } = useAuthStore();
  const [setupData, setSetupData] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);

  const startSetup = async () => {
    setError('');
    setStarting(true);
    try {
      const { data } = await apiClient.post('/profile/2fa/totp/setup');
      if (data.success) setSetupData(data.data);
      else setError(t('setup2fa.setupFailed'));
    } catch { setError(t('setup2fa.setupFailed')); }
    finally { setStarting(false); }
  };

  const enableTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await apiClient.post('/profile/2fa/totp/enable', { code });
      if (data.success) {
        await checkSession();
        if (returnTo) window.location.href = returnTo;
        else navigate('/', { replace: true });
      } else {
        setError(data.error || t('setup2fa.invalidCode'));
      }
    } catch {
      setError(t('setup2fa.invalidCode'));
    } finally { setLoading(false); }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-bg-primary flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Shield size={32} className="text-accent flex-shrink-0" />
            <div>
              <h1 className="text-xl font-bold text-text-primary">{t('setup2fa.title')}</h1>
              <p className="text-xs text-text-secondary">{t('setup2fa.subtitle')}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors whitespace-nowrap"
          >
            <LogOut size={14} />
            {t('setup2fa.signOut')}
          </button>
        </div>

        <div className="rounded-xl border border-border bg-bg-secondary p-6 space-y-5">
          {!setupData ? (
            <div className="text-center">
              {user?.require2faSetup && (
                <p className="text-sm text-status-warning mb-3">{t('setup2fa.resetNotice')}</p>
              )}
              <p className="text-sm text-text-muted mb-4">
                {t('setup2fa.description')}
              </p>
              <Button onClick={startSetup} loading={starting}>{t('setup2fa.startSetup')}</Button>
            </div>
          ) : (
            <form onSubmit={enableTotp} className="space-y-4">
              <p className="text-sm text-text-muted">{t('setup2fa.scanQr')}</p>
              <div className="flex justify-center">
                <img src={setupData.qrDataUrl} alt="TOTP QR Code" className="rounded-lg" width={200} height={200} />
              </div>
              <div>
                <p className="text-xs text-text-muted mb-1">{t('setup2fa.manualSecret')}</p>
                <code className="block bg-bg-tertiary px-3 py-2 rounded text-sm font-mono text-text-primary break-all select-all">{setupData.secret}</code>
              </div>
              <Input
                label={t('setup2fa.verificationCode')}
                type="text"
                inputMode="numeric"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                required
              />
              {error && <div className="bg-status-down-bg border border-status-down/30 rounded-md p-3 text-sm text-status-down">{error}</div>}
              <Button type="submit" loading={loading} className="w-full">{t('setup2fa.enable2fa')}</Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
