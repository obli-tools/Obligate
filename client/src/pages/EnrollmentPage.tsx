import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, LogOut } from 'lucide-react';
import apiClient from '../api/client';
import { safeReturnTo } from '../utils/safeReturnTo';
import { useAuthStore } from '../store/authStore';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Logo } from '../components/common/Logo';
import { ThemePicker } from '../components/ThemePicker';
import { cn } from '../utils/cn';
import { applyTheme } from '../utils/theme';

type Step = 'language' | 'profile' | 'alerts' | 'appearance';
const STEPS: Step[] = ['language', 'profile', 'alerts', 'appearance'];

const LANG_FLAGS: Record<string, string> = {
  en: '\u{1F1EC}\u{1F1E7}', fr: '\u{1F1EB}\u{1F1F7}', es: '\u{1F1EA}\u{1F1F8}', de: '\u{1F1E9}\u{1F1EA}', 'pt-BR': '\u{1F1E7}\u{1F1F7}',
  'zh-CN': '\u{1F1E8}\u{1F1F3}', ja: '\u{1F1EF}\u{1F1F5}', ko: '\u{1F1F0}\u{1F1F7}', ru: '\u{1F1F7}\u{1F1FA}', ar: '\u{1F1F8}\u{1F1E6}',
  it: '\u{1F1EE}\u{1F1F9}', nl: '\u{1F1F3}\u{1F1F1}', pl: '\u{1F1F5}\u{1F1F1}', tr: '\u{1F1F9}\u{1F1F7}', sv: '\u{1F1F8}\u{1F1EA}',
  da: '\u{1F1E9}\u{1F1F0}', cs: '\u{1F1E8}\u{1F1FF}', uk: '\u{1F1FA}\u{1F1E6}',
};

const LANGUAGES = [
  { code: 'en', name: 'English' }, { code: 'fr', name: 'Francais' },
  { code: 'es', name: 'Espanol' }, { code: 'de', name: 'Deutsch' },
  { code: 'pt-BR', name: 'Portugues (BR)' }, { code: 'zh-CN', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' }, { code: 'ru', name: 'Russian' },
  { code: 'ko', name: 'Korean' }, { code: 'ar', name: 'Arabic' },
  { code: 'it', name: 'Italiano' }, { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' }, { code: 'tr', name: 'Turkce' },
  { code: 'sv', name: 'Svenska' }, { code: 'da', name: 'Dansk' },
  { code: 'cs', name: 'Cestina' }, { code: 'uk', name: 'Ukrainian' },
];

// ── Alert position preview SVG ───────────────────────────────────────────────
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

export function EnrollmentPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, checkSession, logout } = useAuthStore();
  const returnTo = safeReturnTo(searchParams.get('returnTo'));

  const STEP_LABELS: Record<Step, string> = {
    language: t('enrollment.language'),
    profile: t('enrollment.profile'),
    alerts: t('enrollment.notifications'),
    appearance: t('enrollment.appearance'),
  };

  const [step, setStep] = useState<Step>('language');
  const [data, setData] = useState({
    preferredLanguage: user?.preferredLanguage ?? 'en',
    displayName: user?.displayName ?? '',
    email: user?.email ?? '',
    preferredTheme: 'obli-operator',
    toastEnabled: true,
    toastPosition: 'bottom-right' as 'bottom-right' | 'top-center',
  });
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState('');

  const currentIdx = STEPS.indexOf(step);
  const isLastStep = step === STEPS[STEPS.length - 1];

  const completeEnrollment = async () => {
    setCompleting(true);
    setError('');
    try {
      await apiClient.post('/auth/enrollment', data);
      await checkSession();
      if (returnTo) {
        window.location.href = returnTo;
      } else {
        navigate('/', { replace: true });
      }
    } catch {
      setError('Failed to complete enrollment');
    } finally {
      setCompleting(false);
    }
  };

  const handleNext = async (e?: FormEvent) => {
    e?.preventDefault();
    setError('');
    if (step === 'language') { setStep('profile'); return; }
    if (step === 'profile') {
      if (!data.email) { setError('Email is required'); return; }
      setStep('alerts');
      return;
    }
    if (step === 'alerts') { setStep('appearance'); return; }
    if (step === 'appearance') { await completeEnrollment(); }
  };

  const handleBack = () => {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-bg-primary flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-xl">
        {/* Header with logout */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Logo className="h-14 w-14" />
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title={t('enrollment.signOut')}
          >
            <LogOut size={14} />
            {t('enrollment.signOut')}
          </button>
        </div>

        {/* Stepper */}
        <div className="flex items-center justify-center gap-0 mb-8">
          {STEPS.map((s, idx) => (
            <div key={s} className="flex items-center">
              <div className="flex flex-col items-center gap-1">
                <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold border-2 transition-colors ${
                  idx < currentIdx ? 'bg-accent border-accent text-white'
                    : idx === currentIdx ? 'border-accent text-accent bg-transparent'
                    : 'border-border text-text-muted bg-transparent'
                }`}>
                  {idx < currentIdx ? <Check size={14} /> : idx + 1}
                </div>
                <span className={`text-xs hidden sm:block ${idx === currentIdx ? 'text-text-primary font-medium' : 'text-text-muted'}`}>
                  {STEP_LABELS[s]}
                </span>
              </div>
              {idx < STEPS.length - 1 && (
                <div className={`w-10 sm:w-16 h-0.5 mx-1 mb-5 transition-colors ${idx < currentIdx ? 'bg-accent' : 'bg-border'}`} />
              )}
            </div>
          ))}
        </div>

        <form onSubmit={handleNext} className="rounded-xl border border-border bg-bg-secondary p-6 space-y-6">
          {/* Language step */}
          {step === 'language' && (
            <div>
              <h2 className="text-xl font-semibold text-text-primary mb-2">{t('enrollment.language')}</h2>
              <p className="text-sm text-text-muted mb-4">{t('enrollment.selectLanguage')}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {LANGUAGES.map(lang => (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => setData(d => ({ ...d, preferredLanguage: lang.code }))}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors text-left',
                      data.preferredLanguage === lang.code
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                    )}
                  >
                    <span>{LANG_FLAGS[lang.code] ?? ''}</span>
                    <span>{lang.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Profile step */}
          {step === 'profile' && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-text-primary mb-2">{t('enrollment.profile')}</h2>
              <p className="text-sm text-text-muted mb-4">{t('enrollment.profileHelp')}</p>
              <Input
                label={t('enrollment.displayName')}
                value={data.displayName}
                onChange={e => setData(d => ({ ...d, displayName: e.target.value }))}
                placeholder={t('enrollment.displayNamePlaceholder')}
              />
              <Input
                label={t('enrollment.email')}
                type="email"
                value={data.email}
                onChange={e => setData(d => ({ ...d, email: e.target.value }))}
                placeholder={t('enrollment.emailPlaceholder')}
                required
              />
            </div>
          )}

          {/* Alerts step — with SVG previews */}
          {step === 'alerts' && (
            <div>
              <h2 className="text-xl font-semibold text-text-primary mb-1">{t('enrollment.notifications')}</h2>
              <p className="text-sm text-text-muted mb-5">{t('enrollment.notificationsHelp')}</p>

              <label className="flex items-start gap-3 cursor-pointer mb-5">
                <div className="relative mt-0.5">
                  <input type="checkbox" className="sr-only peer" checked={data.toastEnabled} onChange={e => setData(d => ({ ...d, toastEnabled: e.target.checked }))} />
                  <div className="w-9 h-5 rounded-full border-2 border-border peer-checked:border-accent peer-checked:bg-accent bg-bg-hover transition-colors" />
                  <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
                </div>
                <div>
                  <div className="text-sm font-medium text-text-primary">{t('enrollment.enableToast')}</div>
                  <div className="text-xs text-text-muted">{t('enrollment.toastHelp')}</div>
                </div>
              </label>

              {data.toastEnabled && (
                <div className="space-y-3">
                  <p className="text-sm font-medium text-text-primary">{t('enrollment.toastPosition')}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(['bottom-right', 'top-center'] as const).map(pos => (
                      <button
                        key={pos}
                        type="button"
                        onClick={() => setData(d => ({ ...d, toastPosition: pos }))}
                        className={`rounded-lg border p-3 text-left transition-colors ${
                          data.toastPosition === pos ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50 hover:bg-bg-hover'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${data.toastPosition === pos ? 'border-accent' : 'border-border'}`}>
                            {data.toastPosition === pos && <div className="h-2 w-2 rounded-full bg-accent" />}
                          </div>
                          <span className="text-sm font-medium text-text-primary">
                            {pos === 'bottom-right' ? t('enrollment.bottomRight') : t('enrollment.topCenter')}
                          </span>
                        </div>
                        <p className="text-xs text-text-muted mb-3">
                          {pos === 'bottom-right'
                            ? t('enrollment.bottomRightHelp')
                            : t('enrollment.topCenterHelp')}
                        </p>
                        <AlertPreviewSvg position={pos} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Appearance step — with SVG theme previews */}
          {step === 'appearance' && (
            <div>
              <h2 className="text-xl font-semibold text-text-primary mb-1">{t('enrollment.appearance')}</h2>
              <p className="text-sm text-text-muted mb-5">{t('enrollment.appearanceHelp')}</p>
              <ThemePicker
                value={data.preferredTheme}
                onChange={theme => { setData(d => ({ ...d, preferredTheme: theme })); applyTheme(theme); }}
              />
            </div>
          )}

          {error && (
            <div className="bg-status-down-bg border border-status-down/30 rounded-md p-3 text-sm text-status-down">{error}</div>
          )}

          <div className="flex items-center justify-between pt-2">
            {currentIdx > 0 ? (
              <Button type="button" variant="ghost" onClick={handleBack}>{t('enrollment.previous')}</Button>
            ) : <div />}
            <Button type="submit" loading={completing}>
              {isLastStep ? t('enrollment.complete') : t('enrollment.next')}
            </Button>
          </div>
        </form>

        <p className="text-center text-xs text-text-muted mt-4">
          {t('enrollment.step', { current: currentIdx + 1, total: STEPS.length })}
        </p>
      </div>
    </div>
  );
}
