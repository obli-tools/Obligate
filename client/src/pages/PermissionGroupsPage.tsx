import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ChevronDown, ChevronRight, Power, Check, Lock, Unlock, Pencil, UserCog, X } from 'lucide-react';
import apiClient from '../api/client';
import { useAuthStore } from '../store/authStore';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { cn } from '../utils/cn';
import type { PermissionGroup, PermissionGroupAppMapping, ConnectedApp, ObligateUser } from '@obligate/shared';

interface RemoteAppInfo {
  roles: string[];
  teams: Array<{ id: number; name: string; tenantSlug: string; tenantName: string }>;
  tenants: Array<{ slug: string; name: string }>;
  permissionSets?: Array<{ id: number; name: string; slug: string; capabilities: string[]; isDefault: boolean }>;
}

/** Neutral fallback for an app with no accent color set in AppsPage (admin). */
const FALLBACK_APP_COLOR = '#8B949E';

export function PermissionGroupsPage() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuthStore();
  const isAdmin = currentUser?.role === 'admin';
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [groupManagers, setGroupManagers] = useState<Record<number, number[]>>({});
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [allUsers, setAllUsers] = useState<ObligateUser[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [mappings, setMappings] = useState<PermissionGroupAppMapping[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', force2faExempt: false });
  const [saving, setSaving] = useState(false);
  const [expandedTenants, setExpandedTenants] = useState<Set<string>>(new Set());

  // Rename state — one group at a time
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Managers picker state
  const [managersPickerOpen, setManagersPickerOpen] = useState<number | null>(null);

  // Remote info cache per app (roles + tenants + teams + permission sets)
  const [remoteInfoMap, setRemoteInfoMap] = useState<Record<number, RemoteAppInfo | null>>({});
  const [loadingApps, setLoadingApps] = useState<Set<number>>(new Set());
  const fetchedRef = useRef<Set<number>>(new Set());

  const load = async () => {
    const [g, a, u] = await Promise.all([
      apiClient.get('/admin/permission-groups'),
      isAdmin ? apiClient.get('/admin/apps').catch(() => ({ data: { success: false } })) : Promise.resolve({ data: { success: true, data: [] } }),
      isAdmin ? apiClient.get('/admin/users').catch(() => ({ data: { success: false } })) : Promise.resolve({ data: { success: true, data: [] } }),
    ]);
    if (g.data.success) {
      setGroups(g.data.data);
      if (g.data.managers) setGroupManagers(g.data.managers);
    }
    if (a.data.success) setApps(a.data.data);
    if (u.data.success) setAllUsers(u.data.data);
  };

  const handleRenameStart = (g: PermissionGroup) => {
    setRenamingId(g.id);
    setRenameValue(g.name);
  };

  const handleRenameSave = async (id: number) => {
    if (!renameValue.trim()) { setRenamingId(null); return; }
    await apiClient.put(`/admin/permission-groups/${id}`, { name: renameValue.trim() });
    setRenamingId(null);
    load();
  };

  const toggleManager = async (groupId: number, userId: number) => {
    const current = groupManagers[groupId] ?? [];
    const next = current.includes(userId)
      ? current.filter(id => id !== userId)
      : [...current, userId];
    await apiClient.put(`/admin/permission-groups/${groupId}/managers`, { userIds: next });
    setGroupManagers(prev => ({ ...prev, [groupId]: next }));
  };

  useEffect(() => { load(); }, []);

  const fetchRemoteInfo = async (appId: number) => {
    if (fetchedRef.current.has(appId)) return;
    fetchedRef.current.add(appId);
    setLoadingApps(prev => new Set(prev).add(appId));
    try {
      const ri = await apiClient.get(`/admin/apps/${appId}/remote-info`);
      setRemoteInfoMap(prev => ({ ...prev, [appId]: ri.data.success ? ri.data.data : null }));
    } catch {
      setRemoteInfoMap(prev => ({ ...prev, [appId]: null }));
    }
    setLoadingApps(prev => { const s = new Set(prev); s.delete(appId); return s; });
  };

  const toggleExpand = async (id: number) => {
    if (expanded === id) { setExpanded(null); return; }
    const { data } = await apiClient.get(`/admin/permission-groups/${id}/mappings`);
    if (data.success) setMappings(data.data);
    setExpanded(id);
    apps.forEach(a => fetchRemoteInfo(a.id));
  };

  const reloadMappings = async (groupId: number) => {
    const { data } = await apiClient.get(`/admin/permission-groups/${groupId}/mappings`);
    if (data.success) setMappings(data.data);
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { data } = await apiClient.post('/admin/permission-groups', form);
      if (data.success) { setShowForm(false); setForm({ name: '', description: '', force2faExempt: false }); load(); }
    } finally { setSaving(false); }
  };

  const toggleForce2faExempt = async (group: PermissionGroup) => {
    const { data } = await apiClient.put(`/admin/permission-groups/${group.id}`, { force2faExempt: !group.force2faExempt });
    if (data.success) setGroups(prev => prev.map(g => g.id === group.id ? data.data : g));
  };

  const handleDeleteGroup = async (id: number) => {
    if (!confirm(t('groups.deleteConfirm'))) return;
    await apiClient.delete(`/admin/permission-groups/${id}`);
    if (expanded === id) setExpanded(null);
    load();
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const getMappingsForApp = (appId: number) => mappings.filter(m => m.appId === appId);
  const isAppEnabled = (appId: number) => getMappingsForApp(appId).length > 0;
  const hasGlobalMapping = (appId: number) => getMappingsForApp(appId).some(m => !m.tenantSlug);

  const getEnabledTenants = (appId: number): Set<string> => {
    const slugs = new Set<string>();
    for (const m of getMappingsForApp(appId)) {
      if (m.tenantSlug) slugs.add(m.tenantSlug);
    }
    return slugs;
  };

  const getEnabledTeams = (appId: number): Set<string> => {
    const names = new Set<string>();
    for (const m of getMappingsForApp(appId)) {
      if (m.teamName) names.add(m.teamName);
    }
    return names;
  };

  // Get the base (non-team) mapping for a specific tenant
  const getTenantBaseMapping = (appId: number, tenantSlug: string) =>
    getMappingsForApp(appId).find(m => m.tenantSlug === tenantSlug && !m.teamName);

  // Get role for a specific tenant (from its base mapping)
  const getTenantRole = (appId: number, tenantSlug: string): string =>
    getTenantBaseMapping(appId, tenantSlug)?.appRole ?? 'user';

  // ── Actions ─────────────────────────────────────────────────────────────────

  const toggleApp = async (groupId: number, appId: number) => {
    if (isAppEnabled(appId)) {
      for (const m of getMappingsForApp(appId)) {
        await apiClient.delete(`/admin/permission-groups/${groupId}/mappings/${m.id}`);
      }
    } else {
      const info = remoteInfoMap[appId];
      if (info?.tenants.length) {
        for (const tn of info.tenants) {
          await apiClient.post(`/admin/permission-groups/${groupId}/mappings`, {
            appId, appRole: 'user', tenantSlug: tn.slug, teamName: null,
          });
        }
      } else {
        await apiClient.post(`/admin/permission-groups/${groupId}/mappings`, {
          appId, appRole: 'user', tenantSlug: null, teamName: null,
        });
      }
    }
    await reloadMappings(groupId);
  };

  const toggleTenant = async (groupId: number, appId: number, tenantSlug: string) => {
    const info = remoteInfoMap[appId];

    if (hasGlobalMapping(appId)) {
      // Switch from global to individual — deselect this tenant
      for (const m of getMappingsForApp(appId)) {
        await apiClient.delete(`/admin/permission-groups/${groupId}/mappings/${m.id}`);
      }
      if (info?.tenants.length) {
        for (const tn of info.tenants) {
          if (tn.slug !== tenantSlug) {
            await apiClient.post(`/admin/permission-groups/${groupId}/mappings`, {
              appId, appRole: 'user', tenantSlug: tn.slug, teamName: null,
            });
          }
        }
      }
      await reloadMappings(groupId);
      return;
    }

    const existing = getMappingsForApp(appId).filter(m => m.tenantSlug === tenantSlug);
    if (existing.length > 0) {
      for (const m of existing) {
        await apiClient.delete(`/admin/permission-groups/${groupId}/mappings/${m.id}`);
      }
    } else {
      await apiClient.post(`/admin/permission-groups/${groupId}/mappings`, {
        appId, appRole: 'user', tenantSlug, teamName: null,
      });
    }
    await reloadMappings(groupId);
  };

  const toggleAllTenants = async (groupId: number, appId: number) => {
    if (hasGlobalMapping(appId)) {
      const info = remoteInfoMap[appId];
      const globalMapping = getMappingsForApp(appId).find(m => !m.tenantSlug);
      const role = globalMapping?.appRole ?? 'user';
      for (const m of getMappingsForApp(appId)) {
        await apiClient.delete(`/admin/permission-groups/${groupId}/mappings/${m.id}`);
      }
      if (info?.tenants.length) {
        for (const tn of info.tenants) {
          await apiClient.post(`/admin/permission-groups/${groupId}/mappings`, {
            appId, appRole: role, tenantSlug: tn.slug, teamName: null,
          });
        }
      }
    } else {
      const firstMapping = getMappingsForApp(appId)[0];
      const role = firstMapping?.appRole ?? 'user';
      for (const m of getMappingsForApp(appId)) {
        await apiClient.delete(`/admin/permission-groups/${groupId}/mappings/${m.id}`);
      }
      await apiClient.post(`/admin/permission-groups/${groupId}/mappings`, {
        appId, appRole: role, tenantSlug: null, teamName: null,
      });
    }
    await reloadMappings(groupId);
  };

  const changeTenantRole = async (groupId: number, appId: number, tenantSlug: string | null, newRole: string) => {
    // Update all mappings for this tenant (base + team mappings)
    const targetMappings = getMappingsForApp(appId).filter(m =>
      tenantSlug === null ? !m.tenantSlug : m.tenantSlug === tenantSlug
    );
    for (const m of targetMappings) {
      await apiClient.put(`/admin/permission-groups/${groupId}/mappings/${m.id}`, { appRole: newRole });
    }
    await reloadMappings(groupId);
  };

  // Teams are matched cross-tenant by name: enabling one mapping enables every
  // tenant that has a team with the same name. Toggle is symmetric — check
  // creates the missing mappings, uncheck removes all of them at once.
  const toggleTeam = async (groupId: number, appId: number, teamName: string) => {
    const info = remoteInfoMap[appId];
    if (!info) return;
    const existing = getMappingsForApp(appId).filter(m => m.teamName === teamName);

    if (existing.length > 0) {
      for (const m of existing) {
        await apiClient.delete(`/admin/permission-groups/${groupId}/mappings/${m.id}`);
      }
    } else {
      const targets = info.teams.filter(tm => tm.name === teamName);
      for (const tm of targets) {
        const role = getTenantRole(appId, tm.tenantSlug);
        await apiClient.post(`/admin/permission-groups/${groupId}/mappings`, {
          appId, appRole: role, tenantSlug: tm.tenantSlug, teamName,
        });
      }
    }
    await reloadMappings(groupId);
  };

  const toggleTenantExpand = (appId: number, tenantSlug: string) => {
    setExpandedTenants(prev => {
      const key = `${appId}-${tenantSlug}`;
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  const renderRoleSelector = (groupId: number, appId: number, tenantSlug: string | null, currentRole: string) => {
    const info = remoteInfoMap[appId];
    const permSets = info?.permissionSets;
    // Use permission sets from app if available, fallback to hardcoded roles
    const roles = permSets?.length ? permSets.map(ps => ps.slug) : ['admin', 'user', 'viewer'];
    const roleLabels = permSets?.length
      ? Object.fromEntries(permSets.map(ps => [ps.slug, ps.name]))
      : { admin: 'admin', user: 'user', viewer: 'viewer' };

    return (
    <div className="flex items-center gap-1 flex-wrap">
      {roles.map(r => (
        <button
          key={r}
          onClick={() => changeTenantRole(groupId, appId, tenantSlug, r)}
          className={cn(
            'px-2 py-0.5 rounded text-[10px] font-medium transition-colors',
            currentRole === r
              ? 'bg-accent/20 text-accent border border-accent/40'
              : 'bg-bg-hover text-text-muted hover:text-text-primary border border-transparent',
          )}
        >
          {roleLabels[r] ?? r}
        </button>
      ))}
    </div>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('groups.title')}</h1>
        {isAdmin && (
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus size={16} className="mr-1.5" /> {t('groups.addGroup')}
          </Button>
        )}
      </div>

      {showForm && isAdmin && (
        <div className="bg-bg-secondary border border-border rounded-lg p-5 mb-6">
          <h2 className="text-lg font-medium text-text-primary mb-4">{t('groups.createGroup')}</h2>
          <form onSubmit={handleCreateGroup} className="space-y-4">
            <Input label={t('groups.name')} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t('groups.namePlaceholder')} required />
            <Input label={t('groups.description')} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder={t('groups.descriptionPlaceholder')} />
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.force2faExempt}
                onChange={e => setForm(f => ({ ...f, force2faExempt: e.target.checked }))}
                className="mt-0.5 rounded border-border bg-bg-tertiary text-accent focus:ring-accent"
              />
              <span>
                <span className="block text-sm font-medium text-text-secondary">{t('groups.force2faExempt') || 'Exempt from forced 2FA'}</span>
                <span className="block text-xs text-text-muted">{t('groups.force2faExemptHelp') || 'Only takes effect if every one of the member\'s groups is exempt — a single non-exempt group still forces 2FA for them.'}</span>
              </span>
            </label>
            <div className="flex gap-2">
              <Button type="submit" loading={saving}>{t('common.create')}</Button>
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
            </div>
          </form>
        </div>
      )}

      <div className="space-y-2">
        {groups.map(group => (
          <div key={group.id} className="bg-bg-secondary border border-border rounded-lg overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between gap-2">
              <button
                onClick={() => isAdmin && toggleExpand(group.id)}
                disabled={!isAdmin}
                className={cn(
                  'flex items-center gap-2 text-left flex-1 min-w-0',
                  !isAdmin && 'cursor-default',
                )}
              >
                {isAdmin && (expanded === group.id ? <ChevronDown size={16} className="text-text-muted shrink-0" /> : <ChevronRight size={16} className="text-text-muted shrink-0" />)}
                <div className="min-w-0">
                  {renamingId === group.id ? (
                    <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleRenameSave(group.id);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        className="rounded-md border border-border bg-bg-tertiary px-2 py-1 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent"
                      />
                      <button onClick={() => handleRenameSave(group.id)} className="text-status-up hover:opacity-80"><Check size={14} /></button>
                      <button onClick={() => setRenamingId(null)} className="text-text-muted hover:text-text-primary"><X size={14} /></button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-text-primary font-medium">{group.name}</span>
                        {!isAdmin && currentUser && (groupManagers[group.id] ?? []).includes(currentUser.id) && (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-accent bg-accent/10 border border-accent/30 px-1.5 py-0.5 rounded">
                            <UserCog size={10} />{t('groups.youManage')}
                          </span>
                        )}
                        {group.force2faExempt && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-muted bg-bg-hover border border-border px-1.5 py-0.5 rounded"
                            title={t('groups.force2faExemptHelp') || 'Only takes effect if every one of the member\'s groups is exempt — a single non-exempt group still forces 2FA for them.'}
                          >
                            <Unlock size={10} />{t('groups.force2faExemptBadge') || '2FA exempt'}
                          </span>
                        )}
                      </div>
                      {group.description && <p className="text-xs text-text-muted mt-0.5">{group.description}</p>}
                    </>
                  )}
                </div>
              </button>
              {isAdmin && renamingId !== group.id && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => toggleForce2faExempt(group)}
                    title={group.force2faExempt
                      ? (t('groups.force2faExemptOn') || 'Exempt from forced 2FA (click to require it again)')
                      : (t('groups.force2faExemptOff') || 'Subject to forced 2FA (click to exempt this group)')}
                  >
                    {group.force2faExempt ? <Unlock size={14} className="text-text-muted" /> : <Lock size={14} />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleRenameStart(group)} title={t('groups.rename')}>
                    <Pencil size={14} />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleDeleteGroup(group.id)} title={t('common.delete')}>
                    <Trash2 size={14} className="text-status-down" />
                  </Button>
                </>
              )}
            </div>

            {expanded === group.id && (
              <div className="border-t border-border px-5 py-4 bg-bg-primary/50">
                {/* Managers section — admin only */}
                {isAdmin && (
                  <div className="mb-5">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-text-secondary font-medium inline-flex items-center gap-1.5">
                        <UserCog size={12} /> {t('groups.managers')}
                      </p>
                      <button
                        onClick={() => setManagersPickerOpen(managersPickerOpen === group.id ? null : group.id)}
                        className="text-xs text-accent hover:underline"
                      >
                        {managersPickerOpen === group.id ? t('common.close') : t('groups.editManagers')}
                      </button>
                    </div>
                    {(() => {
                      const managerIds = groupManagers[group.id] ?? [];
                      const managerUsers = allUsers.filter(u => managerIds.includes(u.id));
                      if (managerUsers.length === 0 && managersPickerOpen !== group.id) {
                        return <p className="text-xs text-text-muted italic">{t('groups.noManagers')}</p>;
                      }
                      return (
                        <div className="flex flex-wrap gap-1.5">
                          {managerUsers.map(u => (
                            <span key={u.id} className="inline-flex items-center gap-1 text-[11px] bg-accent/10 text-accent border border-accent/30 px-2 py-0.5 rounded">
                              {u.displayName || u.username}
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                    {managersPickerOpen === group.id && (
                      <div className="mt-3 rounded-md border border-border bg-bg-tertiary/40 p-2 max-h-56 overflow-y-auto space-y-1">
                        {allUsers
                          .filter(u => u.role !== 'admin' && u.isActive)
                          .map(u => {
                            const checked = (groupManagers[group.id] ?? []).includes(u.id);
                            return (
                              <button
                                key={u.id}
                                onClick={() => toggleManager(group.id, u.id)}
                                className={cn(
                                  'w-full flex items-center justify-between px-2 py-1 rounded text-xs transition-colors',
                                  checked ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-hover',
                                )}
                              >
                                <span>{u.displayName || u.username} <span className="text-text-muted">@{u.username}</span></span>
                                {checked && <Check size={12} />}
                              </button>
                            );
                          })}
                        {allUsers.filter(u => u.role !== 'admin' && u.isActive).length === 0 && (
                          <p className="text-xs text-text-muted italic">{t('groups.noEligibleManagers')}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <p className="text-xs text-text-secondary font-medium mb-4">{t('groups.appMappings')}</p>

                {apps.length === 0 ? (
                  <p className="text-xs text-text-muted">{t('groups.noMappings')}</p>
                ) : (
                  <div className="space-y-3">
                    {apps.map(app => {
                      const enabled = isAppEnabled(app.id);
                      const info = remoteInfoMap[app.id];
                      const isLoading = loadingApps.has(app.id);
                      const color = app.color || FALLBACK_APP_COLOR;
                      const enabledTenants = getEnabledTenants(app.id);
                      const enabledTeams = getEnabledTeams(app.id);
                      const globalAccess = hasGlobalMapping(app.id);
                      const globalMapping = getMappingsForApp(app.id).find(m => !m.tenantSlug && !m.teamName);

                      return (
                        <div
                          key={app.id}
                          className={cn(
                            'rounded-lg border overflow-hidden transition-all',
                            enabled ? 'border-border-light bg-bg-secondary' : 'border-border bg-bg-tertiary/30 opacity-60',
                          )}
                        >
                          {/* App header — power toggle only (no global role) */}
                          <div className="px-4 py-3 flex items-center gap-3" style={{ borderLeft: `3px solid ${enabled ? color : 'transparent'}` }}>
                            <button
                              onClick={() => toggleApp(group.id, app.id)}
                              className={cn(
                                'w-8 h-8 rounded-md flex items-center justify-center transition-colors flex-shrink-0',
                                enabled ? 'bg-status-up/20 text-status-up' : 'bg-bg-hover text-text-muted hover:text-text-primary',
                              )}
                              title={enabled ? t('common.enabled') : t('common.disabled')}
                            >
                              <Power size={16} />
                            </button>
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium text-text-primary">{app.name}</span>
                              <span className="text-xs text-text-muted ml-2">{app.appType}</span>
                            </div>
                          </div>

                          {/* Tenants + Teams */}
                          {enabled && (
                            <div className="border-t border-border px-4 py-3">
                              {isLoading ? (
                                <p className="text-xs text-text-muted">{t('common.loading')}</p>
                              ) : !info ? (
                                <p className="text-xs text-status-down">{t('groups.appConnectionError')}</p>
                              ) : (
                                <div className="space-y-2">
                                  {/* All tenants toggle (global mode) */}
                                  {info.tenants.length > 0 && (
                                    <div className="flex items-center gap-2 mb-1">
                                      <button
                                        onClick={() => toggleAllTenants(group.id, app.id)}
                                        className={cn(
                                          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors border',
                                          globalAccess
                                            ? 'bg-accent/15 text-accent border-accent/30'
                                            : 'bg-bg-hover text-text-muted border-border hover:border-border-light',
                                        )}
                                      >
                                        {globalAccess && <Check size={12} />}
                                        {t('groups.allTenants')}
                                      </button>
                                      {/* Global role when in global mode */}
                                      {globalAccess && renderRoleSelector(group.id, app.id, null, globalMapping?.appRole ?? 'user')}
                                    </div>
                                  )}

                                  {/* No tenants — show role on the single mapping */}
                                  {info.tenants.length === 0 && (
                                    <div className="flex items-center gap-2 flex-wrap">
                                      {renderRoleSelector(group.id, app.id, null, globalMapping?.appRole ?? 'user')}
                                    </div>
                                  )}

                                  {/* Per-tenant accordion */}
                                  {info.tenants.map(tn => {
                                    const tenantActive = enabledTenants.has(tn.slug) || globalAccess;
                                    const tenantTeams = info.teams.filter(tm => tm.tenantSlug === tn.slug);
                                    const tenantKey = `${app.id}-${tn.slug}`;
                                    const isExpanded = expandedTenants.has(tenantKey);
                                    const baseMapping = getTenantBaseMapping(app.id, tn.slug);
                                    const tenantRole = baseMapping?.appRole ?? (globalAccess ? (globalMapping?.appRole ?? 'user') : 'user');
                                    const tenantEnabledTeams = tenantTeams.filter(tm => enabledTeams.has(tm.name));

                                    return (
                                      <div key={tn.slug} className={cn(
                                        'rounded-md border overflow-hidden',
                                        tenantActive ? 'border-border-light' : 'border-border opacity-50',
                                      )}>
                                        {/* Tenant header */}
                                        <div className="flex items-center gap-2 px-3 py-2 bg-bg-tertiary/50 flex-wrap">
                                          {/* Checkbox */}
                                          <button
                                            onClick={() => toggleTenant(group.id, app.id, tn.slug)}
                                            className={cn(
                                              'w-5 h-5 rounded flex items-center justify-center flex-shrink-0 border transition-colors',
                                              tenantActive
                                                ? 'bg-accent/20 border-accent/40 text-accent'
                                                : 'bg-bg-hover border-border text-transparent hover:border-border-light',
                                            )}
                                          >
                                            {tenantActive && <Check size={12} />}
                                          </button>

                                          {/* Name + expand toggle */}
                                          <button
                                            onClick={() => toggleTenantExpand(app.id, tn.slug)}
                                            className="flex items-center gap-1 min-w-0"
                                          >
                                            {tenantTeams.length > 0 && (
                                              isExpanded
                                                ? <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
                                                : <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
                                            )}
                                            <span className={cn('text-xs font-medium', tenantActive ? 'text-text-primary' : 'text-text-muted')}>
                                              {tn.name}
                                            </span>
                                          </button>

                                          {/* Per-tenant role selector (only when not global) */}
                                          {tenantActive && !globalAccess && (
                                            renderRoleSelector(group.id, app.id, tn.slug, tenantRole)
                                          )}

                                          {/* Team count */}
                                          {tenantTeams.length > 0 && (
                                            <span className={cn(
                                              'text-[10px] px-1.5 py-0.5 rounded ml-auto',
                                              tenantEnabledTeams.length > 0 ? 'bg-accent/15 text-accent' : 'bg-bg-hover text-text-muted',
                                            )}>
                                              {tenantEnabledTeams.length}/{tenantTeams.length} teams
                                            </span>
                                          )}
                                        </div>

                                        {/* Expanded: teams */}
                                        {isExpanded && tenantTeams.length > 0 && (
                                          <div className="px-3 py-2 space-y-1 border-t border-border bg-bg-primary/30">
                                            {tenantEnabledTeams.length === 0 && (
                                              <div className="flex items-center gap-1.5 text-[10px] text-text-muted/70 py-1">
                                                <Lock size={10} />
                                                {t('groups.noTeamAccess')}
                                              </div>
                                            )}
                                            {tenantTeams.map(tm => {
                                              const teamActive = enabledTeams.has(tm.name);
                                              return (
                                                <button
                                                  key={tm.name}
                                                  onClick={() => toggleTeam(group.id, app.id, tm.name)}
                                                  className={cn(
                                                    'w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors',
                                                    teamActive ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
                                                  )}
                                                >
                                                  <span className={cn(
                                                    'w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border transition-colors',
                                                    teamActive ? 'bg-accent/20 border-accent/40 text-accent' : 'bg-bg-hover border-border text-transparent',
                                                  )}>
                                                    {teamActive && <Check size={10} />}
                                                  </span>
                                                  <span className="flex-1 text-left">{tm.name}</span>
                                                  {!teamActive && <Lock size={10} className="text-text-muted/40" />}
                                                </button>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}

                                  {info.tenants.length === 0 && info.teams.length === 0 && (
                                    <p className="text-xs text-text-muted italic">{t('groups.noMappings')}</p>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {groups.length === 0 && (
          <p className="text-center text-text-muted py-12 text-sm">{t('groups.noGroups')}</p>
        )}
      </div>
    </div>
  );
}
