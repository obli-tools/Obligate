import { LogOut, Menu, Bell, MoreHorizontal, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/authStore';
import apiClient from '../../api/client';
import { Logo } from '../common/Logo';

interface HeaderProps {
  onToggleMobile: () => void;
}

// App pill switcher — order and accent colors come from Obligate's own
// connected_apps registry (AppsPage: sort_order, color, icon), never a local
// list here. A new app registered in AppsPage appears with zero code change.
//
// Obligate is the SSO gateway, not one of the spoke apps in the switcher — no
// pill is "current" here. Every app follows the same reachability rule:
// greyed out unless the user has a connected/enabled link to it.

interface ConnectedApp {
  appId: number;
  appType: string;
  name: string;
  baseUrl: string;
  icon: string;
  color: string | null;
  /** Not an Obli* app: listed in the "More…" dropdown, not in the main switcher. */
  thirdParty?: boolean;
  enabled?: boolean;
}

const FALLBACK_APP_COLOR = '#8B949E';
// Refetched periodically so an app registered meanwhile shows up without a reload.
const REFRESH_INTERVAL_MS = 5 * 60_000;

export function Header({ onToggleMobile }: HeaderProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const switcherWrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => apiClient.get('/account/apps').then(({ data }) => {
      if (data.success) {
        setApps((data.data as ConnectedApp[]).filter(a => a.enabled !== false));
      }
    }).catch(() => {});
    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const mainApps = apps.filter(a => !a.thirdParty);
  const moreApps = apps.filter(a => a.thirdParty);

  // Labelled pills while they fit, colored dots only once they don't —
  // measured against a hidden, always-labelled copy (see Oblihub's header).
  useEffect(() => {
    const el = switcherWrapRef.current;
    const measure = measureRef.current;
    if (!el || !measure) return;
    const update = () => setCollapsed(measure.scrollWidth > el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mainApps.length, moreApps.length]);

  // "More…" dropdown: outside click and Escape close it.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [moreOpen]);

  const goApp = (app: ConnectedApp) => {
    window.location.href = `${app.baseUrl}/auth/sso-redirect`;
  };

  const pill = (app: ConnectedApp, labelled: boolean) => (
    <button
      key={app.appId}
      type="button"
      onClick={() => goApp(app)}
      className={`flex shrink-0 items-center gap-2 rounded-md py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-active hover:text-text-primary ${labelled ? 'px-3' : 'px-1.5'}`}
      title={app.name}
      aria-label={app.name}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: app.color || FALLBACK_APP_COLOR }} />
      {labelled && app.name}
    </button>
  );

  const moreButton = (labelled: boolean, interactive: boolean) => (
    <button
      type="button"
      onClick={interactive ? () => setMoreOpen(v => !v) : undefined}
      tabIndex={interactive ? undefined : -1}
      aria-haspopup={interactive ? 'true' : undefined}
      aria-expanded={interactive ? moreOpen : undefined}
      className={`flex shrink-0 items-center gap-1.5 rounded-md py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-active hover:text-text-primary ${labelled ? 'px-3' : 'px-1.5'}`}
      title={t('header.moreApps', 'More…')}
    >
      <MoreHorizontal size={14} className="shrink-0" />
      {labelled && <span>{t('header.moreApps', 'More…')}</span>}
      {labelled && <ChevronDown size={12} className={`shrink-0 text-text-muted transition-transform ${moreOpen ? 'rotate-180' : ''}`} />}
    </button>
  );

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const username = user?.username ?? '';
  const displayed = username.startsWith('og_') ? username.slice(3) : username;
  const display = user?.displayName || displayed;

  return (
    <header
      className="relative flex shrink-0 items-center gap-3 bg-bg-secondary px-4"
      style={{ height: 52 }}
    >
      {/* Mobile menu button */}
      <button
        onClick={onToggleMobile}
        className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary lg:hidden"
        aria-label="Toggle navigation"
      >
        <Menu size={18} />
      </button>

      {/* Logo */}
      <Link to="/" className="flex shrink-0 items-center gap-2">
        <Logo className="h-8 w-auto max-w-[160px] object-contain" />
      </Link>

      {/* App switcher — container-grouped pills. Uses the same surface */}
      {/* (bg-bg-hover) as the user pill on the right so both "outlines" */}
      {/* match visually on every theme. No "active" state here since */}
      {/* Obligate isn't one of the 5 spoke apps (it's the SSO gateway). */}
      <div ref={switcherWrapRef} className="ml-2 hidden min-w-0 flex-1 items-center md:flex">
        {apps.length > 0 && (
          <nav className="flex items-center gap-1 rounded-lg bg-bg-hover p-1">
            {mainApps.map(app => pill(app, !collapsed))}
            {moreApps.length > 0 && (
              <div ref={moreRef} className="relative">
                {moreButton(!collapsed, true)}
                {moreOpen && (
                  <div className="absolute left-0 top-9 z-50 w-56 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl bg-bg-secondary shadow-2xl">
                    <div className="px-3 py-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t('header.moreAppsTitle', 'Other apps')}</p>
                    </div>
                    <div className="max-h-64 overflow-y-auto overscroll-contain py-1">
                      {moreApps.map(app => (
                        <button
                          key={app.appId}
                          type="button"
                          onClick={() => { setMoreOpen(false); goApp(app); }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text-primary transition-colors hover:bg-bg-hover"
                        >
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: app.color || FALLBACK_APP_COLOR }} />
                          <span className="truncate">{app.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </nav>
        )}
      </div>

      {/* Hidden measurer: the fully-labelled row, off-screen, never interactive. */}
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none absolute -z-10 flex items-center gap-1 p-1 opacity-0"
        style={{ top: -9999, left: -9999 }}
      >
        {mainApps.map(app => pill(app, true))}
        {moreApps.length > 0 && moreButton(true, false)}
      </div>

      {/* Right cluster */}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <button
          title={t('common.notifications', 'Notifications')}
          className="relative flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <Bell size={15} />
        </button>

        {user && (
          <>
            <Link
              to="/account"
              className="flex items-center gap-2 rounded-lg bg-bg-hover py-1 pl-1.5 pr-3 transition-colors hover:bg-bg-active"
            >
              {user.profilePhotoUrl ? (
                <img
                  src={user.profilePhotoUrl}
                  alt={display}
                  className="h-7 w-7 rounded-full object-cover"
                />
              ) : (
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                  style={{ background: 'linear-gradient(135deg, rgba(45,78,201,0.7), rgba(90,120,232,0.45))' }}
                >
                  {(display?.[0] ?? '?').toUpperCase()}
                </div>
              )}
              <span className="hidden text-[13px] font-medium text-text-primary sm:inline">{display}</span>
              {user.role === 'admin' && (
                <span className="hidden border-l border-border-light pl-2 font-mono text-[10px] uppercase tracking-wider text-accent sm:inline">
                  {t('common.admin')}
                </span>
              )}
            </Link>
            <button
              onClick={handleLogout}
              title={t('common.logout')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <LogOut size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
