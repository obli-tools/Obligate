import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard, AppWindow, Users, ShieldCheck, FolderTree,
  UserCircle, Settings, ChevronsLeft, ChevronsRight, LogOut,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import { useAuthStore } from '../../store/authStore';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNavigate: () => void;
}

interface NavItem {
  path: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  admin?: boolean;
}

export function Sidebar({ collapsed, onToggleCollapsed, onNavigate }: SidebarProps) {
  const location = useLocation();
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const isAdmin = user?.role === 'admin';
  const isManager = !isAdmin && !!user?.isGroupManager;
  const showAdminSection = isAdmin || isManager;

  const mainItems: NavItem[] = [
    { path: '/',         icon: LayoutDashboard, label: t('sidebar.myApps') },
    { path: '/account',  icon: UserCircle,      label: t('sidebar.myAccount') },
  ];

  const adminItems: NavItem[] = isAdmin
    ? [
        { path: '/apps',        icon: AppWindow,   label: t('sidebar.connectedApps') },
        { path: '/users',       icon: Users,       label: t('sidebar.users') },
        { path: '/groups',      icon: ShieldCheck, label: t('sidebar.permissionGroups') },
        { path: '/directories', icon: FolderTree,  label: t('sidebar.directories') },
        { path: '/settings',    icon: Settings,    label: t('sidebar.settings') },
      ]
    : [
        // Managers: scoped user management + read-only group visibility.
        { path: '/users',  icon: Users,       label: t('sidebar.users') },
        { path: '/groups', icon: ShieldCheck, label: t('sidebar.permissionGroups') },
      ];

  const isActive = (path: string) =>
    location.pathname === path || (path !== '/' && location.pathname.startsWith(path + '/'));

  const username = user?.username ?? '';
  const displayed = username.startsWith('og_') ? username.slice(3) : username;
  const display = user?.displayName || displayed;

  return (
    <div className="flex h-full w-full flex-col">
      {/* Head — collapse toggle only (logo lives in topbar). */}
      <div className="flex h-9 shrink-0 items-center justify-end px-3 pt-2">
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? t('sidebar.expand', 'Expand') : t('sidebar.collapse', 'Collapse')}
          className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          {collapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
        </button>
      </div>

      {/* Main nav */}
      <nav className={cn('flex-1 overflow-y-auto px-2 pt-2 space-y-1', collapsed && 'px-2')}>
        <NavSection collapsed={collapsed} items={mainItems} isActive={isActive} onNavigate={onNavigate} />

        {showAdminSection && (
          <>
            {!collapsed && (
              <div className="mt-4 px-2 pb-1.5 pt-1 text-[11px] font-mono font-medium uppercase tracking-[0.14em] text-text-muted">
                {isAdmin ? t('sidebar.administration', 'Administration') : t('sidebar.management', 'Management')}
              </div>
            )}
            {collapsed && (
              <div className="mx-2 my-3 h-px bg-border" />
            )}
            <NavSection collapsed={collapsed} items={adminItems} isActive={isActive} onNavigate={onNavigate} />
          </>
        )}
      </nav>

      {/* Footer — user + logout */}
      <div className="shrink-0 border-t border-border p-2 space-y-1">
        {!collapsed ? (
          <Link
            to="/account"
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
              isActive('/account')
                ? 'bg-bg-active text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            {user?.profilePhotoUrl ? (
              <img
                src={user.profilePhotoUrl}
                alt={display}
                className="h-8 w-8 shrink-0 rounded-full object-cover"
              />
            ) : (
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white"
                style={{ background: 'linear-gradient(135deg, rgba(45,78,201,0.7), rgba(90,120,232,0.45))' }}
              >
                {(display?.[0] ?? '?').toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-text-primary">{display}</div>
              <div className="truncate font-mono text-[10px] uppercase tracking-wider text-text-muted">
                {displayed} · {user?.role}
              </div>
            </div>
          </Link>
        ) : (
          <Link
            to="/account"
            title={display}
            onClick={onNavigate}
            className={cn(
              'flex h-10 w-full items-center justify-center rounded-md transition-colors',
              isActive('/account')
                ? 'bg-bg-active text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            {user?.profilePhotoUrl ? (
              <img
                src={user.profilePhotoUrl}
                alt={display}
                className="h-6 w-6 rounded-full object-cover"
              />
            ) : (
              <UserCircle size={18} />
            )}
          </Link>
        )}

        <button
          onClick={logout}
          title={t('common.logout')}
          className={cn(
            'flex w-full items-center gap-3 rounded-md px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary',
            collapsed && 'h-10 justify-center px-0 py-0',
          )}
        >
          <LogOut size={collapsed ? 18 : 16} />
          {!collapsed && <span>{t('common.logout')}</span>}
        </button>
      </div>
    </div>
  );
}

function NavSection({
  items, collapsed, isActive, onNavigate,
}: {
  items: NavItem[];
  collapsed: boolean;
  isActive: (path: string) => boolean;
  onNavigate: () => void;
}) {
  return (
    <>
      {items.map(item => {
        const active = isActive(item.path);
        const Icon = item.icon;
        if (collapsed) {
          return (
            <Link
              key={item.path}
              to={item.path}
              title={item.label}
              onClick={onNavigate}
              className={cn(
                'flex h-10 w-full items-center justify-center rounded-md transition-colors',
                active
                  ? 'bg-accent/12 text-accent'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
              style={active ? { backgroundColor: 'rgb(var(--c-accent) / 0.12)' } : undefined}
            >
              <Icon size={18} />
            </Link>
          );
        }
        return (
          <Link
            key={item.path}
            to={item.path}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-[13px] transition-colors',
              active
                ? 'text-accent'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
            style={active ? { backgroundColor: 'rgb(var(--c-accent) / 0.12)' } : undefined}
          >
            <Icon size={18} />
            <span className="flex-1">{item.label}</span>
          </Link>
        );
      })}
    </>
  );
}
