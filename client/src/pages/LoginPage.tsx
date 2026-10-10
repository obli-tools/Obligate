import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Logo } from '../components/common/Logo';
import { useAuthStore } from '../store/authStore';
import apiClient from '../api/client';
import { safeReturnTo } from '../utils/safeReturnTo';

type Step = 'credentials' | '2fa';

export function LoginPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { login, checkSession } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [step, setStep] = useState<Step>('credentials');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);

  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  // An app asked for a fresh sign-in (OAuth prompt=login / max_age):
  // the password and a NEW authentication code are required even though this
  // browser may already be signed in. The banner explains it to a signed-in
  // user; the username is prefilled.
  const reauthRequested = searchParams.get('reauth') === '1';
  const [reauthUser, setReauthUser] = useState<string | null>(null);
  // The one-time ticket of that request (in returnTo): sent with the sign-in,
  // so this sign-in satisfies that request only.
  const reauthTicket = (() => {
    if (!reauthRequested || !returnTo) return null;
    try {
      const v = new URL(returnTo, window.location.origin).searchParams.get('reauth_ticket');
      return v && /^[0-9a-f]{32}$/.test(v) ? v : null;
    } catch { return null; }
  })();

  useEffect(() => {
    if (!reauthRequested) return;
    let cancelled = false;
    apiClient.get('/auth/me')
      .then(({ data }) => {
        const name = data?.data?.user?.username;
        if (!cancelled && typeof name === 'string' && name) {
          setReauthUser(name);
          setUsername((u) => u || name);
        }
      })
      .catch(() => { /* not signed in: plain sign-in */ });
    return () => { cancelled = true; };
  }, [reauthRequested]);

  const goToApp = () => {
    if (returnTo) {
      window.location.href = returnTo;
    } else {
      navigate('/');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await login(username, password, reauthTicket);
    setLoading(false);

    if (!result.success) {
      setError(result.error || t('login.loginFailed'));
      return;
    }

    if (result.requires2fa) {
      setStep('2fa');
      setMfaCode('');
      return;
    }

    goToApp();
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMfaLoading(true);
    try {
      const { data } = await apiClient.post('/profile/2fa/verify', { code: mfaCode });
      if (data.success) {
        await checkSession();
        goToApp();
      } else {
        setError(data.error || t('login.invalidCode'));
      }
    } catch (err: unknown) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'signInAgain') {
        // Too many wrong codes, or the sign-in expired: the password step starts over
        setStep('credentials');
        setPassword('');
        setMfaCode('');
        setError(t('login.signInAgain') || 'Sign in again: enter your password, then a new code.');
      } else if (code === 'tooManyAttempts') {
        setError(t('login.tooManyAttempts') || 'Too many wrong codes. Try again later.');
      } else {
        setError(code === 'codeUsed'
          ? (t('login.codeUsed') || 'This code has already been used. Wait for the next code.')
          : t('login.invalidCode'));
      }
    } finally {
      setMfaLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Logo className="mx-auto mb-3" style={{ height: '72px', width: 'auto' }} />
        </div>

        <div className="bg-bg-secondary border border-border rounded-lg p-6">
          {reauthUser && (
            <div className="mb-4 bg-bg-tertiary border border-border rounded-md p-3">
              <p className="text-sm font-medium text-text-primary mb-1">{t('login.reauthTitle') || 'Confirm your identity'}</p>
              <p className="text-xs text-text-muted">
                {t('login.reauthHelp') || 'An application asks you to sign in again. Enter your password, then a new code from your authenticator app if you are asked for one.'}
              </p>
            </div>
          )}
          {step === 'credentials' ? (
            <form onSubmit={handleSubmit} className="space-y-4" name="login" autoComplete="on">
              <Input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                spellCheck={false}
                autoCapitalize="none"
                label={t('login.username')}
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder={t('login.usernamePlaceholder')}
                autoFocus
                required
              />
              <Input
                id="current-password"
                name="password"
                type="password"
                autoComplete="current-password"
                label={t('login.password')}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('login.password')}
                required
              />
              {error && (
                <div className="bg-status-down-bg border border-status-down/30 rounded-md p-3 text-sm text-status-down">
                  {error}
                </div>
              )}
              <Button type="submit" loading={loading} className="w-full">
                {t('login.signIn')}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleMfaSubmit} className="space-y-4" name="mfa" autoComplete="on">
              <div>
                <p className="text-sm font-medium text-text-primary mb-1">{t('login.twoFactor')}</p>
                <p className="text-xs text-text-muted">{t('login.twoFactorDescription')}</p>
              </div>
              <Input
                id="otp"
                name="otp"
                label={t('login.authCode')}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={e => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                autoFocus
                required
              />
              {error && (
                <div className="bg-status-down-bg border border-status-down/30 rounded-md p-3 text-sm text-status-down">
                  {error}
                </div>
              )}
              <Button type="submit" loading={mfaLoading} className="w-full">
                {t('login.verify')}
              </Button>
              <button
                type="button"
                onClick={() => { setStep('credentials'); setError(''); }}
                className="w-full text-center text-xs text-text-muted hover:text-text-primary"
              >
                {t('login.backToLogin')}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
