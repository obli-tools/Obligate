import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { cn } from '../../utils/cn';

const COLLAPSED_KEY = 'obligate:groupPanelCollapsed';

export function AppLayout() {
  // Mobile drawer (off-canvas) — only used below `lg`. On desktop the sidebar
  // is always visible, in either expanded (260 px) or collapsed (64 px) form.
  const [mobileOpen, setMobileOpen] = useState(false);

  // Persisted collapsed flag — same key prefix the rest of the Obli suite
  // uses (`<app>:groupPanelCollapsed`) so the choice carries across apps.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-primary">
      {/* Topbar — full viewport width, sits ABOVE the sidebar so the logo +
          app switcher stay visible regardless of sidebar state.
          Shared Obli layout: topbar on top, sidebar below. */}
      <Header onToggleMobile={() => setMobileOpen(o => !o)} />

      <div className="flex flex-1 overflow-hidden">
        {/* Mobile overlay */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}

        {/* Sidebar — fixed on mobile (off-canvas), inline on desktop */}
        <aside
          className={cn(
            'z-50 flex-shrink-0 bg-bg-secondary transition-all duration-200',
            'fixed inset-y-0 left-0 lg:static',
            mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
            collapsed ? 'w-16' : 'w-[260px]',
          )}
          style={{ top: 'var(--topbar-h, 52px)' }}
        >
          <Sidebar
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed(c => !c)}
            onNavigate={() => setMobileOpen(false)}
          />
        </aside>

        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
