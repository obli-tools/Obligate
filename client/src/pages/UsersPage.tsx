import { useEffect, useMemo, useState } from 'react';
import { Plus, Shield, User, Pencil, Trash2, Check, Key, ShieldCheck, Search, ChevronDown, KeyRound, Clock, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import apiClient from '../api/client';
import { useAuthStore } from '../store/authStore';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import type { ObligateUser, PermissionGroup } from '@obligate/shared';
import { cn } from '../utils/cn';

interface ActivityDetail {
  obligateLastLogin: string | null;
  totpEnabled: boolean;
  require2faSetup: boolean;
  createdAt: string;
  apps: Array<{
    appId: number;
    appType: string;
    name: string;
    color: string | null;
    firstLoginAt: string | null;
    lastLoginAt: string | null;
    enabled: boolean;
    linked: boolean;
  }>;
}

interface ActivitySummary {
  lastActivityAt: string;
  lastActivityApp: string;
}

function formatRelative(iso: string, locale: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return t('users.activity.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('users.activity.minutesAgo', { count: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('users.activity.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('users.activity.daysAgo', { count: days });
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function formatAbsolute(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

export function UsersPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { user: currentUser } = useAuthStore();
  const isAdmin = currentUser?.role === 'admin';
  const [users, setUsers] = useState<ObligateUser[]>([]);
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [managedGroups, setManagedGroups] = useState<PermissionGroup[]>([]);
  const [actionableMap, setActionableMap] = useState<Record<number, boolean>>({});
  const [userGroupMap, setUserGroupMap] = useState<Record<number, PermissionGroup[]>>({});
  const [activityMap, setActivityMap] = useState<Record<number, ActivitySummary | null>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [activityCache, setActivityCache] = useState<Record<number, ActivityDetail>>({});
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: '', email: '', displayName: '', password: '', role: 'user' as 'admin' | 'user', groupIds: [] as number[] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Search & filter
  const [search, setSearch] = useState('');
  const [filterGroupId, setFilterGroupId] = useState<number | ''>('');

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ email: '', displayName: '', role: 'user' as 'admin' | 'user' });

  // Password change
  const [pwUserId, setPwUserId] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState('');

  // Group assignment — inline, expanded per user
  const [groupPanelUserId, setGroupPanelUserId] = useState<number | null>(null);
  const [groupPanelGroups, setGroupPanelGroups] = useState<PermissionGroup[]>([]);

  const load = async () => {
    const [u, g, mg] = await Promise.all([
      apiClient.get('/admin/users'),
      apiClient.get('/admin/permission-groups'),
      apiClient.get('/admin/my-managed-groups'),
    ]);
    if (u.data.success) {
      setUsers(u.data.data);
      if (u.data.userGroups) setUserGroupMap(u.data.userGroups);
      if (u.data.activity) setActivityMap(u.data.activity);
      if (u.data.actionable) setActionableMap(u.data.actionable);
    }
    if (g.data.success) setGroups(g.data.data);
    if (mg.data.success) setManagedGroups(mg.data.data);
  };

  const toggleExpand = async (userId: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
    if (!activityCache[userId]) {
      try {
        const { data } = await apiClient.get(`/admin/users/${userId}/activity`);
        if (data.success) {
          setActivityCache(prev => ({ ...prev, [userId]: data.data }));
        }
      } catch { /* silent */ }
    }
  };

  useEffect(() => { load(); }, []);

  // Filtered users
  const filteredUsers = useMemo(() => {
    let list = users;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(u =>
        u.username.toLowerCase().includes(q) ||
        (u.displayName?.toLowerCase().includes(q)) ||
        (u.email?.toLowerCase().includes(q))
      );
    }
    if (filterGroupId !== '') {
      list = list.filter(u => userGroupMap[u.id]?.some(g => g.id === filterGroupId));
    }
    return list;
  }, [users, search, filterGroupId, userGroupMap]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // A non-admin manager MUST pick at least one of their managed groups.
    // For admins, group selection is optional (kept as a convenience) but the
    // server now also accepts a groupIds[] field — admins can skip it.
    if (!isAdmin && form.groupIds.length === 0) {
      setError(t('users.errorGroupRequired'));
      return;
    }

    setSaving(true);
    try {
      const { data } = await apiClient.post('/admin/users', form);
      if (data.success) {
        setShowForm(false);
        setForm({ username: '', email: '', displayName: '', password: '', role: 'user', groupIds: [] });
        load();
      } else setError(data.error || 'Failed');
    } catch { setError('Connection error'); }
    finally { setSaving(false); }
  };

  const toggleFormGroup = (groupId: number) => {
    setForm(f => ({
      ...f,
      groupIds: f.groupIds.includes(groupId)
        ? f.groupIds.filter(id => id !== groupId)
        : [...f.groupIds, groupId],
    }));
  };

  const startEdit = (u: ObligateUser) => {
    setEditingId(u.id);
    setEditForm({ email: u.email || '', displayName: u.displayName || '', role: u.role });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    await apiClient.put(`/admin/users/${editingId}`, editForm);
    setEditingId(null);
    load();
  };

  const toggleActive = async (u: ObligateUser) => {
    await apiClient.put(`/admin/users/${u.id}`, { isActive: !u.isActive });
    load();
  };

  const deleteUser = async (id: number) => {
    if (!confirm('Delete this user permanently?')) return;
    await apiClient.delete(`/admin/users/${id}`);
    load();
  };

  const changePassword = async () => {
    if (!pwUserId || !newPassword) return;
    try {
      const { data } = await apiClient.put(`/admin/users/${pwUserId}/password`, { password: newPassword });
      if (!data.success) { toast.error(data.error || t('users.errorPasswordChange')); return; }
      setPwUserId(null);
      setNewPassword('');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('users.errorPasswordChange'));
    }
  };

  const reset2fa = async (u: ObligateUser) => {
    if (!confirm(t('users.reset2faConfirm', { name: u.username }))) return;
    try {
      const { data } = await apiClient.post(`/admin/users/${u.id}/2fa/reset`);
      if (!data.success) { toast.error(data.error || t('users.errorReset2fa')); return; }
      toast.success(t('users.reset2faSuccess', { name: u.username }));
      // Refresh the cached activity detail so the expanded panel stays accurate.
      try {
        const detail = await apiClient.get(`/admin/users/${u.id}/activity`);
        if (detail.data.success) setActivityCache(prev => ({ ...prev, [u.id]: detail.data.data }));
      } catch { /* silent */ }
      load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('users.errorReset2fa'));
    }
  };

  const openGroups = async (userId: number) => {
    if (groupPanelUserId === userId) {
      setGroupPanelUserId(null);
      return;
    }
    setGroupPanelUserId(userId);
    setGroupPanelGroups([]);
    const { data } = await apiClient.get(`/admin/users/${userId}/groups`);
    if (data.success) setGroupPanelGroups(data.data);
  };

  const toggleGroup = async (groupId: number, assigned: boolean) => {
    if (!groupPanelUserId) return;
    if (assigned) {
      await apiClient.delete(`/admin/users/${groupPanelUserId}/groups/${groupId}`);
    } else {
      await apiClient.post(`/admin/users/${groupPanelUserId}/groups/${groupId}`);
    }
    const { data } = await apiClient.get(`/admin/users/${groupPanelUserId}/groups`);
    if (data.success) setGroupPanelGroups(data.data);
    load();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('users.title')}</h1>
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus size={16} className="mr-1.5" /> {t('users.addUser')}
        </Button>
      </div>

      {/* Search & filter bar */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder={t('users.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-md border border-border bg-bg-tertiary text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent placeholder:text-text-muted"
          />
        </div>
        <select
          value={filterGroupId}
          onChange={e => setFilterGroupId(e.target.value ? parseInt(e.target.value, 10) : '')}
          className="rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">{t('users.allGroups')}</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        {(search || filterGroupId !== '') && (
          <span className="self-center text-xs text-text-muted">
            {t('users.filterCount', { filtered: filteredUsers.length, total: users.length })}
          </span>
        )}
      </div>

      {/* Create form */}
      {showForm && (
        <div className="bg-bg-secondary border border-border rounded-lg p-5 mb-6">
          <h2 className="text-lg font-medium text-text-primary mb-4">{t('users.createUser')}</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label={t('users.username')} value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} required />
              <Input label={t('users.email')} type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              <Input label={t('users.displayName')} value={form.displayName} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} />
              <Input label={t('users.password')} type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required />
            </div>
            {isAdmin && (
              <div className="space-y-1">
                <label className="block text-sm font-medium text-text-secondary">{t('users.role')}</label>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as 'admin' | 'user' }))}
                  className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent">
                  <option value="user">{t('common.user')}</option>
                  <option value="admin">{t('common.admin')}</option>
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-text-secondary">
                {isAdmin ? t('users.groupsOptional') : t('users.groupsRequired')}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {managedGroups.map(g => {
                  const selected = form.groupIds.includes(g.id);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => toggleFormGroup(g.id)}
                      className={cn(
                        'inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors',
                        selected
                          ? 'bg-accent/10 text-accent border-accent/40'
                          : 'bg-bg-tertiary text-text-secondary border-border hover:bg-bg-hover',
                      )}
                    >
                      <ShieldCheck size={11} />{g.name}
                    </button>
                  );
                })}
                {managedGroups.length === 0 && (
                  <p className="text-xs text-text-muted italic">{t('users.noGroupsAvailable')}</p>
                )}
              </div>
            </div>
            {error && <div className="bg-status-down-bg border border-status-down/30 rounded-md p-3 text-sm text-status-down">{error}</div>}
            <div className="flex gap-2">
              <Button type="submit" loading={saving}>{t('common.create')}</Button>
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
            </div>
          </form>
        </div>
      )}

      {/* Password change modal */}
      {pwUserId && (
        <div className="bg-bg-secondary border border-border rounded-lg p-5 mb-6">
          <h2 className="text-lg font-medium text-text-primary mb-4">{t('users.changePasswordFor', { name: users.find(u => u.id === pwUserId)?.username })}</h2>
          <div className="flex gap-2 items-end">
            <Input label={t('users.newPassword')} type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
            <Button size="md" onClick={changePassword} disabled={!newPassword}>{t('common.save')}</Button>
            <Button size="md" variant="ghost" onClick={() => { setPwUserId(null); setNewPassword(''); }}>{t('common.cancel')}</Button>
          </div>
        </div>
      )}

      {/* Users list */}
      <div className="space-y-2">
        {filteredUsers.map(u => {
          const assignedGroups = userGroupMap[u.id] ?? [];
          const activity = activityMap[u.id] ?? null;
          const isExpanded = expanded.has(u.id);
          const detail = activityCache[u.id];
          const canAct = isAdmin || (actionableMap[u.id] ?? false);
          const showGroupPanel = groupPanelUserId === u.id;
          return (
            <div key={u.id} className="bg-bg-secondary border border-border rounded-lg overflow-hidden">
              <div className="px-5 py-4">
              {editingId === u.id ? (
                /* Edit mode */
                <div className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <Input label={t('users.displayName')} value={editForm.displayName} onChange={e => setEditForm(f => ({ ...f, displayName: e.target.value }))} />
                    <Input label={t('users.email')} value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} />
                    <div className="space-y-1">
                      <label className="block text-sm font-medium text-text-secondary">{t('users.role')}</label>
                      <select value={editForm.role} onChange={e => setEditForm(f => ({ ...f, role: e.target.value as 'admin' | 'user' }))}
                        className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none">
                        <option value="user">{t('common.user')}</option>
                        <option value="admin">{t('common.admin')}</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveEdit}><Check size={14} className="mr-1" />{t('common.save')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>{t('common.cancel')}</Button>
                  </div>
                </div>
              ) : (
                /* View mode */
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {u.role === 'admin' ? <Shield size={18} className="text-accent shrink-0" /> : <User size={18} className="text-text-muted shrink-0" />}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-text-primary font-medium">{u.displayName || u.username}</span>
                        {u.displayName && <span className="text-xs text-text-muted">@{u.username}</span>}
                        {u.role === 'admin' && <span className="text-xs bg-accent/20 text-accent px-1.5 py-0.5 rounded">admin</span>}
                      </div>
                      <p className="text-xs text-text-muted mt-0.5">
                        {u.authSource === 'ldap' ? t('users.ldap') : t('users.local')}
                        {u.email && <span className="ml-2">{u.email}</span>}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px]">
                        {u.totpEnabled ? (
                          <span className="inline-flex items-center gap-1 text-status-up" title={t('users.activity.twoFactorEnabled')}>
                            <KeyRound size={11} />{t('users.activity.twoFactor')}
                          </span>
                        ) : u.require2faSetup ? (
                          <span className="inline-flex items-center gap-1 text-status-warning" title={t('users.activity.twoFactorResetPendingHint')}>
                            <ShieldOff size={11} />{t('users.activity.twoFactorResetPending')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-text-muted" title={t('users.activity.twoFactorDisabled')}>
                            <KeyRound size={11} />{t('users.activity.noTwoFactor')}
                          </span>
                        )}
                        {activity ? (
                          <span className="inline-flex items-center gap-1 text-text-secondary" title={formatAbsolute(activity.lastActivityAt, locale)}>
                            <Clock size={11} />
                            {t('users.activity.lastActivity', {
                              when: formatRelative(activity.lastActivityAt, locale, t),
                              app: activity.lastActivityApp === 'obligate'
                                ? t('users.activity.onObligate')
                                : t('users.activity.onApp', { app: activity.lastActivityApp }),
                            })}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-text-muted">
                            <Clock size={11} />{t('users.activity.neverLoggedIn')}
                          </span>
                        )}
                      </div>
                      {assignedGroups.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {assignedGroups.map(g => (
                            <span
                              key={g.id}
                              className="inline-flex items-center gap-1 text-[11px] bg-bg-tertiary text-text-secondary border border-border px-1.5 py-0.5 rounded"
                            >
                              <ShieldCheck size={10} className="text-text-muted" />
                              {g.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => canAct && toggleActive(u)}
                      disabled={!canAct}
                      title={canAct ? undefined : t('users.outOfScopeAction')}
                      className={cn(
                        'text-xs px-2 py-1 rounded',
                        u.isActive ? 'text-status-up bg-status-up-bg' : 'text-status-down bg-status-down-bg',
                        !canAct && 'opacity-40 cursor-not-allowed',
                      )}>
                      {u.isActive ? t('users.active') : t('common.disabled')}
                    </button>
                    <Button size="sm" variant="ghost" disabled={!canAct} onClick={() => openGroups(u.id)} title={canAct ? t('users.groups') : t('users.outOfScopeAction')}><ShieldCheck size={14} /></Button>
                    <Button size="sm" variant="ghost" disabled={!canAct} onClick={() => setPwUserId(u.id)} title={canAct ? t('users.changePassword') : t('users.outOfScopeAction')}><Key size={14} /></Button>
                    {u.totpEnabled && (
                      <Button size="sm" variant="ghost" disabled={!canAct} onClick={() => reset2fa(u)} title={canAct ? t('users.reset2fa') : t('users.outOfScopeAction')}><ShieldOff size={14} /></Button>
                    )}
                    {isAdmin && <Button size="sm" variant="ghost" onClick={() => startEdit(u)} title={t('common.edit')}><Pencil size={14} /></Button>}
                    {isAdmin && <Button size="sm" variant="ghost" onClick={() => deleteUser(u.id)} title={t('common.delete')}><Trash2 size={14} className="text-status-down" /></Button>}
                    <Button size="sm" variant="ghost" onClick={() => toggleExpand(u.id)} title={t('users.activity.details')}>
                      <ChevronDown size={14} className={cn('transition-transform', isExpanded && 'rotate-180')} />
                    </Button>
                  </div>
                </div>
              )}
              </div>
              {showGroupPanel && (
                <div className="border-t border-border bg-bg-tertiary/40 px-5 py-4">
                  <div className="text-xs text-text-muted mb-2">
                    {t('users.permissionGroupsFor', { name: u.displayName || u.username })}
                  </div>
                  <div className="space-y-1.5">
                    {(isAdmin ? groups : managedGroups).map(g => {
                      const assigned = groupPanelGroups.some(ug => ug.id === g.id);
                      return (
                        <button
                          key={g.id}
                          onClick={() => toggleGroup(g.id, assigned)}
                          className={cn(
                            'w-full flex items-center justify-between px-3 py-1.5 rounded-md text-sm transition-colors',
                            assigned ? 'bg-accent/10 text-accent border border-accent/30' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover border border-transparent',
                          )}
                        >
                          <span>{g.name}</span>
                          {assigned && <Check size={14} />}
                        </button>
                      );
                    })}
                    {/* For non-admin managers, also surface the user's existing groups that they cannot manage (read-only) */}
                    {!isAdmin && groupPanelGroups.filter(g => !managedGroups.some(mg => mg.id === g.id)).map(g => (
                      <div
                        key={`ro-${g.id}`}
                        className="w-full flex items-center justify-between px-3 py-1.5 rounded-md text-sm bg-bg-tertiary/40 text-text-muted border border-border italic"
                        title={t('users.outOfScopeGroup')}
                      >
                        <span>{g.name}</span>
                        <Check size={14} />
                      </div>
                    ))}
                    {(isAdmin ? groups : managedGroups).length === 0 && (
                      <p className="text-xs text-text-muted">{t('users.noGroupsCreated')}</p>
                    )}
                  </div>
                </div>
              )}
              {isExpanded && (
                <div className="border-t border-border bg-bg-tertiary/40 px-5 py-4 space-y-3">
                  {!detail ? (
                    <p className="text-xs text-text-muted">{t('common.loading')}</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                        <div>
                          <div className="text-text-muted">{t('users.activity.obligateLogin')}</div>
                          <div className="text-text-primary mt-0.5">
                            {detail.obligateLastLogin ? formatAbsolute(detail.obligateLastLogin, locale) : t('common.noData')}
                          </div>
                        </div>
                        <div>
                          <div className="text-text-muted">{t('users.activity.twoFactorStatus')}</div>
                          <div className="text-text-primary mt-0.5">
                            {detail.totpEnabled
                              ? t('common.enabled')
                              : detail.require2faSetup
                                ? t('users.activity.twoFactorResetPending')
                                : t('common.disabled')}
                          </div>
                        </div>
                        <div>
                          <div className="text-text-muted">{t('users.activity.accountCreated')}</div>
                          <div className="text-text-primary mt-0.5">{formatAbsolute(detail.createdAt, locale)}</div>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-text-muted mb-1.5">{t('users.activity.perAppHeader')}</div>
                        {detail.apps.length === 0 ? (
                          <p className="text-xs text-text-muted italic">{t('users.activity.noAppLogins')}</p>
                        ) : (
                          <div className="space-y-1">
                            {detail.apps.map(a => (
                              <div key={a.appId} className="flex items-center justify-between gap-3 px-2.5 py-1.5 rounded bg-bg-secondary/60 text-xs">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: a.color || '#888' }} />
                                  <span className="text-text-primary font-medium truncate">{a.name}</span>
                                  {!a.enabled && (
                                    <span className="text-[10px] text-status-down bg-status-down-bg px-1.5 py-0.5 rounded">
                                      {t('common.disabled')}
                                    </span>
                                  )}
                                </div>
                                <div className="text-text-secondary text-right shrink-0">
                                  {a.lastLoginAt ? (
                                    <span title={formatAbsolute(a.lastLoginAt, locale)}>
                                      {formatRelative(a.lastLoginAt, locale, t)}
                                    </span>
                                  ) : (
                                    <span className="text-text-muted italic">{t('users.activity.never')}</span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {filteredUsers.length === 0 && users.length > 0 && (
          <p className="text-center text-text-muted py-12 text-sm">{t('users.noMatch')}</p>
        )}
        {users.length === 0 && <p className="text-center text-text-muted py-12 text-sm">{t('users.noUsers')}</p>}
      </div>
    </div>
  );
}
