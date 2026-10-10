import { useEffect, useMemo, useState } from 'react';
import { AppWindow, Users, ShieldCheck, ExternalLink, Activity, KeyRound, LogIn } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import apiClient from '../api/client';
import { useAuthStore } from '../store/authStore';

interface AppInfo {
  appId: number;
  appType: string;
  name: string;
  baseUrl: string;
  icon: string | null;
  color: string | null;
  linked: boolean;
  enabled: boolean;
  lastLoginAt: string | null;
  /** Not an Obli* app: shown in a separate "Other apps" section. */
  thirdParty?: boolean;
}

interface DashboardStats {
  [appId: number]: {
    stats: Array<{ label: string; value: string | number; color?: string }>;
  };
}

interface PlatformStats {
  users: { total: number; active: number; with2fa: number; ldap: number };
  apps: { total: number; active: number };
  groups: number;
  logins: {
    last24h: number;
    perHour: number[];
    perApp: Array<{ appType: string; name: string; color: string | null; count: number }>;
  };
  recent: Array<{
    userId: number; username: string; displayName: string | null;
    appType: string; appName: string; appColor: string | null; at: string;
  }>;
}

/** Neutral fallback for an app with no accent color set in AppsPage (admin). */
const FALLBACK_APP_COLOR = '#8B949E';

export function DashboardPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [stats, setStats] = useState<DashboardStats>({});
  const [platformStats, setPlatformStats] = useState<PlatformStats | null>(null);

  useEffect(() => {
    apiClient.get('/account/apps').then(({ data }) => {
      if (data.success) {
        // Already sorted by sort_order (AppsPage) server-side — no local re-sort.
        const enabledApps = (data.data as AppInfo[]).filter(a => a.enabled);
        setApps(enabledApps);

        for (const app of enabledApps) {
          apiClient.get(`/admin/apps/${app.appId}/dashboard-stats`).then(({ data: sd }) => {
            if (sd.success && sd.data) {
              setStats(prev => ({ ...prev, [app.appId]: { stats: sd.data.stats } }));
            }
          }).catch(() => {});
        }
      }
    });

    if (isAdmin) {
      apiClient.get('/admin/platform-stats').then(({ data }) => {
        if (data.success) setPlatformStats(data.data);
      }).catch(() => {});
    }
  }, [isAdmin]);

  // Sparkline path for the 24h login chart
  const chartPath = useMemo(() => {
    if (!platformStats?.logins.perHour) return { line: '', area: '', max: 0 };
    const values = platformStats.logins.perHour;
    const max = Math.max(1, ...values);
    const W = 100, H = 40;
    const step = W / (values.length - 1);
    const points = values.map((v, i) => `${(i * step).toFixed(2)} ${(H - (v / max) * H * 0.85).toFixed(2)}`);
    const line = `M ${points.join(' L ')}`;
    const area = `${line} L ${W} ${H} L 0 ${H} Z`;
    return { line, area, max };
  }, [platformStats]);

  // Donut arc computations for the "logins per app" ring
  const donutSegments = useMemo(() => {
    if (!platformStats?.logins.perApp?.length) return [];
    const total = platformStats.logins.perApp.reduce((s, a) => s + a.count, 0);
    if (total === 0) return [];
    let acc = 0;
    const r = 34, cx = 50, cy = 50;
    return platformStats.logins.perApp.slice(0, 6).map(a => {
      const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
      acc += a.count;
      const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
      const large = end - start > Math.PI ? 1 : 0;
      const x1 = cx + r * Math.cos(start);
      const y1 = cy + r * Math.sin(start);
      const x2 = cx + r * Math.cos(end);
      const y2 = cy + r * Math.sin(end);
      return {
        d: `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`,
        color: a.color || FALLBACK_APP_COLOR,
        name: a.name,
        count: a.count,
      };
    });
  }, [platformStats]);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-text-primary mb-6">
        {isAdmin ? t('dashboard.adminTitle') : t('dashboard.title')}
      </h1>

      {isAdmin && platformStats && (
        <>
          {/* KPI strip — 5 platform-wide indicators */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
            <KpiCard
              label={t('dashboard.kpi.activeUsers', 'Active users')}
              value={platformStats.users.active}
              foot={t('dashboard.kpi.ofTotal', 'of {{n}} total', { n: platformStats.users.total })}
              icon={Users}
              onClick={() => navigate('/users')}
            />
            <KpiCard
              label={t('dashboard.kpi.logins24h', 'SSO logins / 24h')}
              value={platformStats.logins.last24h}
              foot={platformStats.logins.perApp[0]?.name
                ? t('dashboard.kpi.topApp', 'top: {{app}}', { app: platformStats.logins.perApp[0].name })
                : '—'}
              icon={LogIn}
            />
            <KpiCard
              label={t('dashboard.kpi.apps', 'Connected apps')}
              value={platformStats.apps.active}
              foot={t('dashboard.kpi.ofTotal', 'of {{n}} total', { n: platformStats.apps.total })}
              icon={AppWindow}
              onClick={() => navigate('/apps')}
            />
            <KpiCard
              label={t('dashboard.kpi.groups', 'Permission groups')}
              value={platformStats.groups}
              foot=""
              icon={ShieldCheck}
              onClick={() => navigate('/groups')}
            />
            <KpiCard
              label={t('dashboard.kpi.twoFa', '2FA adoption')}
              value={platformStats.users.total > 0
                ? `${Math.round((platformStats.users.with2fa / platformStats.users.total) * 100)}%`
                : '—'}
              foot={t('dashboard.kpi.usersEnrolled', '{{n}} users', { n: platformStats.users.with2fa })}
              icon={KeyRound}
            />
          </div>

          {/* Two-column: line chart + donut */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
            <div className="lg:col-span-2 bg-bg-secondary border border-border rounded-lg p-5">
              <div className="flex items-baseline justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">{t('dashboard.chart.title', 'SSO logins — last 24h')}</h3>
                  <p className="text-xs text-text-muted mt-0.5">{t('dashboard.chart.sub', 'hourly buckets')}</p>
                </div>
                <span className="font-mono text-xs text-text-muted">peak {chartPath.max}</span>
              </div>
              <svg viewBox="0 0 100 44" preserveAspectRatio="none" className="w-full h-32">
                <defs>
                  <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgb(var(--c-accent))" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="rgb(var(--c-accent))" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={chartPath.area} fill="url(#chart-fill)" />
                <path d={chartPath.line} fill="none" stroke="rgb(var(--c-accent))" strokeWidth="0.8" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
              <div className="flex justify-between mt-1 text-[10px] font-mono text-text-muted">
                <span>-24h</span><span>-18h</span><span>-12h</span><span>-6h</span><span>now</span>
              </div>
            </div>

            <div className="bg-bg-secondary border border-border rounded-lg p-5">
              <h3 className="text-sm font-semibold text-text-primary mb-3">{t('dashboard.donut.title', 'Logins per app')}</h3>
              {donutSegments.length === 0 ? (
                <p className="text-xs text-text-muted italic">{t('dashboard.donut.empty', 'No SSO logins in the last 24h.')}</p>
              ) : (
                <div className="flex items-center gap-4">
                  <svg viewBox="0 0 100 100" className="h-24 w-24 shrink-0">
                    {donutSegments.map((s, i) => (
                      <path key={i} d={s.d} fill={s.color} />
                    ))}
                    <circle cx="50" cy="50" r="20" fill="rgb(var(--c-bg-secondary))" />
                  </svg>
                  <ul className="flex-1 space-y-1 text-xs">
                    {donutSegments.map((s, i) => (
                      <li key={i} className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: s.color }} />
                          <span className="text-text-secondary truncate">{s.name}</span>
                        </span>
                        <span className="font-mono text-text-primary">{s.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {/* Recent activity */}
          {platformStats.recent.length > 0 && (
            <div className="bg-bg-secondary border border-border rounded-lg p-5 mb-8">
              <h3 className="text-sm font-semibold text-text-primary mb-3">{t('dashboard.activity.title', 'Recent activity')}</h3>
              <ul className="divide-y divide-border">
                {platformStats.recent.map((r, i) => {
                  const color = r.appColor || FALLBACK_APP_COLOR;
                  const when = new Date(r.at);
                  const diff = Math.floor((Date.now() - when.getTime()) / 60000);
                  const rel = diff < 1 ? t('dashboard.activity.justNow', 'just now')
                    : diff < 60 ? `${diff}m`
                    : diff < 1440 ? `${Math.floor(diff / 60)}h`
                    : `${Math.floor(diff / 1440)}d`;
                  return (
                    <li key={i} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
                        <span className="text-sm text-text-primary truncate">{r.displayName || r.username}</span>
                        <span className="text-xs text-text-muted truncate">@{r.username}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-text-secondary shrink-0">
                        <span>{r.appName}</span>
                        <span className="font-mono text-text-muted">{rel}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {apps.filter(a => !a.thirdParty).map(renderCard)}

        {apps.length === 0 && (
          <div className="col-span-full text-center py-16">
            <AppWindow size={40} className="text-text-muted mx-auto mb-3" />
            <p className="text-text-muted">{t('dashboard.noApps')}</p>
          </div>
        )}
      </div>

      {/* Third-party apps signing in through Obligate (e.g. Passly) — apart from the Obli suite. */}
      {apps.some(a => a.thirdParty) && (
        <>
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mt-8 mb-3">{t('dashboard.otherApps', 'Other apps')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {apps.filter(a => a.thirdParty).map(renderCard)}
          </div>
        </>
      )}
    </div>
  );

  function renderCard(app: AppInfo) {
          const color = app.color || FALLBACK_APP_COLOR;
          const appStats = stats[app.appId]?.stats;

          return (
            <a
              key={app.appId}
              href={`${app.baseUrl}/auth/sso-redirect`}
              className="group bg-bg-secondary border border-border rounded-xl p-5 hover:border-border-light transition-all hover:shadow-lg cursor-pointer"
              style={{ borderTopColor: color, borderTopWidth: '3px' }}
            >
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-lg font-semibold text-text-primary group-hover:text-accent transition-colors">
                    {app.name}
                  </h3>
                  <p className="text-xs text-text-muted">{app.appType}</p>
                </div>
                <ExternalLink size={16} className="text-text-muted group-hover:text-accent transition-colors" />
              </div>

              {appStats && appStats.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 mt-3">
                  {appStats.map((s, i) => (
                    <div key={i} className="bg-bg-tertiary rounded-md px-3 py-2">
                      <div className="text-lg font-bold" style={{ color: s.color || color }}>{s.value}</div>
                      <div className="text-xs text-text-muted">{s.label}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-3 text-xs text-text-muted">
                  <Activity size={12} />
                  <span>
                    {app.lastLoginAt
                      ? t('dashboard.lastLogin', { date: new Date(app.lastLoginAt).toLocaleDateString() })
                      : t('dashboard.notConnected')}
                  </span>
                </div>
              )}
            </a>
          );
  }
}

interface KpiCardProps {
  label: string;
  value: string | number;
  foot: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  onClick?: () => void;
}

function KpiCard({ label, value, foot, icon: Icon, onClick }: KpiCardProps) {
  const inner = (
    <>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">{label}</span>
        <Icon size={13} className="text-text-muted" />
      </div>
      <div className="font-mono text-2xl font-semibold text-text-primary leading-none">{value}</div>
      {foot && <div className="mt-1.5 text-[11px] text-text-muted">{foot}</div>}
    </>
  );
  if (onClick) {
    return (
      <button
        onClick={onClick}
        className="text-left bg-bg-secondary border border-border rounded-lg p-4 hover:border-border-light transition-colors"
      >
        {inner}
      </button>
    );
  }
  return (
    <div className="bg-bg-secondary border border-border rounded-lg p-4">
      {inner}
    </div>
  );
}
