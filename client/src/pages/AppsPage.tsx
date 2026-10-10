import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Plus, RotateCw, Trash2, Copy, Check, KeyRound, ShieldOff, AlertTriangle, Pencil, ShieldCheck, GripVertical, Palette, MoreHorizontal, ArrowUpToLine } from 'lucide-react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import apiClient from '../api/client';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import type { ConnectedApp, SsoSyncQueueStatus } from '@obligate/shared';

/** Server error message of an axios failure, if any. */
function apiError(err: unknown): { code?: string; error?: string; httpStatus?: number | null } {
  return (err as { response?: { data?: { code?: string; error?: string; httpStatus?: number | null } } })?.response?.data ?? {};
}

/**
 * The icon shown for an app: its admin-set override, else its own official
 * favicon.svg (every Obli* app serves one at its origin). Mirrors
 * `effectiveIcon()` in server/src/services/app.service.ts — the admin listing
 * (`listApps`) returns the raw `icon` column (possibly null) so this page can
 * tell "not customised" from "customised", unlike the cross-app feed which
 * always returns a usable URL.
 */
function effectiveIconUrl(app: Pick<ConnectedApp, 'baseUrl' | 'icon'>): string {
  return app.icon || `${app.baseUrl.replace(/\/+$/, '')}/favicon.svg`;
}

const DEFAULT_COLOR = '#8B949E';

export function AppsPage() {
  const { t } = useTranslation();
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ appType: '', name: '', baseUrl: '' });
  const [createError, setCreateError] = useState('');
  // A secret shown once: the API key (create / regenerate) or an inbound secret
  const [shownSecret, setShownSecret] = useState<{ kind: 'apiKey' | 'inboundSecret'; value: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  // Inline edit of an app's base URL (the only origin /authorize sends codes to)
  const [editing, setEditing] = useState<{ id: number; baseUrl: string } | null>(null);
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  // Inline edit of an app's icon override (the accent color is announced by the app itself)
  const [editingAppearance, setEditingAppearance] = useState<{ id: number; color: string; icon: string } | null>(null);
  const [appearanceSaving, setAppearanceSaving] = useState(false);
  // Result of an inbound secret activation, per app
  const [activation, setActivation] = useState<{ id: number; ok: boolean; message: string } | null>(null);
  const [activating, setActivating] = useState<number | null>(null);
  const [reordering, setReordering] = useState(false);

  // credentials-changed pushes given up after 24 h (device-bound step-up): shown as an alert
  const [syncQueue, setSyncQueue] = useState<SsoSyncQueueStatus | null>(null);
  const [syncBusy, setSyncBusy] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const load = async () => {
    const { data } = await apiClient.get('/admin/apps');
    if (data.success) setApps(data.data);
  };

  const loadSyncQueue = async () => {
    try {
      const { data } = await apiClient.get('/admin/sso-sync/queue');
      if (data.success) setSyncQueue(data.data);
    } catch { /* older server or transient error: no banner */ }
  };

  useEffect(() => { load(); loadSyncQueue(); }, []);

  const syncAction = async (id: number, action: 'retry' | 'dismiss') => {
    setSyncBusy(id);
    try {
      await apiClient.post(`/admin/sso-sync/queue/${id}/${action}`);
    } catch { /* refreshed below */ } finally {
      setSyncBusy(null);
      loadSyncQueue();
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError('');
    setSaving(true);
    try {
      const { data } = await apiClient.post('/admin/apps', form);
      if (data.success) {
        setShownSecret({ kind: 'apiKey', value: data.data.apiKey });
        setShowForm(false);
        setForm({ appType: '', name: '', baseUrl: '' });
        load();
      } else {
        setCreateError(data.error || t('common.error') || 'Error');
      }
    } catch (err) {
      setCreateError(apiError(err).error || t('common.error') || 'Error');
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm(t('apps.deleteConfirm') || 'Delete this app? Its user links, group mappings, device links and preferences are deleted with it.')) return;
    await apiClient.delete(`/admin/apps/${id}`);
    load();
  };

  const handleRegenKey = async (id: number) => {
    if (!confirm(t('apps.regenerateConfirm') || 'Regenerate the API key? The old key stops working immediately: set the new one on the app right away.')) return;
    const { data } = await apiClient.post(`/admin/apps/${id}/regenerate-key`);
    if (data.success) {
      setShownSecret({ kind: 'apiKey', value: data.data.apiKey });
      load();
    }
  };

  const startEdit = (app: ConnectedApp) => {
    setEditError('');
    setEditing({ id: app.id, baseUrl: app.baseUrl });
  };

  const saveBaseUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setEditError('');
    setEditSaving(true);
    try {
      const { data } = await apiClient.put(`/admin/apps/${editing.id}`, { baseUrl: editing.baseUrl });
      if (data.success) {
        setEditing(null);
        load();
      } else {
        setEditError(t('apps.baseUrlInvalid') || 'Invalid base URL: an absolute http(s) URL without credentials, query or fragment.');
      }
    } catch (err) {
      setEditError(apiError(err).error
        ? (t('apps.baseUrlInvalid') || 'Invalid base URL: an absolute http(s) URL without credentials, query or fragment.')
        : t('common.error') || 'Error');
    } finally { setEditSaving(false); }
  };

  const startEditAppearance = (app: ConnectedApp) => {
    setEditingAppearance({ id: app.id, color: app.color || DEFAULT_COLOR, icon: app.icon || '' });
  };

  const saveAppearance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAppearance) return;
    setAppearanceSaving(true);
    try {
      const { data } = await apiClient.put(`/admin/apps/${editingAppearance.id}`, {
        icon: editingAppearance.icon.trim() || null,
      });
      if (data.success) {
        setEditingAppearance(null);
        load();
      } else {
        toast.error(data.error || t('common.error') || 'Error');
      }
    } catch (err) {
      toast.error(apiError(err).error || t('common.error') || 'Error');
    } finally { setAppearanceSaving(false); }
  };

  // Secret Obligate presents when it calls the app (sso-user-sync, app-info,
  // dashboard-stats) instead of the API key. Generated PENDING: Obligate
  // switches to it only once the app accepts it (Activate).
  const handleGenerateInboundSecret = async (id: number) => {
    if (!confirm(t('apps.inboundSecretConfirm') || 'Generate an inbound secret? Set it on the app (Obliance, Oblimap, Oblihub: OBLIGATE_INBOUND_SECRET), restart the app, then click Activate: Obligate switches to it only once the app accepts it.')) return;
    setActivation(null);
    try {
      const { data } = await apiClient.post(`/admin/apps/${id}/inbound-secret`);
      if (data.success) {
        setShownSecret({ kind: 'inboundSecret', value: data.data.inboundSecret });
        load();
      }
    } catch (err) {
      const e = apiError(err);
      setActivation({ id, ok: false, message: e.code === 'inboundSecretUnsupported'
        ? (t('apps.inboundSecretUnsupported') || 'This app cannot be configured with an inbound secret: it only accepts its API key from Obligate.')
        : (e.error ?? (t('common.error') || 'Error')) });
    }
  };

  const handleActivateInboundSecret = async (id: number) => {
    setActivating(id);
    setActivation(null);
    try {
      const { data } = await apiClient.post(`/admin/apps/${id}/inbound-secret/activate`);
      if (data.success) {
        setActivation({ id, ok: true, message: t('apps.inboundSecretActivated') || 'Inbound secret active: the app accepted it.' });
        load();
      }
    } catch (err) {
      const e = apiError(err);
      const message = e.code === 'inboundSecretRefused'
        ? (t('apps.inboundSecretRefused', { status: e.httpStatus ?? '?' }) || `The app did not accept the secret (HTTP ${e.httpStatus ?? '?'}): set it on the app, restart it, then activate again. Obligate keeps using the previous credential.`)
        : e.code === 'inboundSecretUnreachable'
          ? (t('apps.inboundSecretUnreachable') || 'The app could not be reached at its base URL. Obligate keeps using the previous credential.')
          : (e.error ?? (t('common.error') || 'Error'));
      setActivation({ id, ok: false, message });
    } finally { setActivating(null); }
  };

  const handleClearInboundSecret = async (id: number) => {
    if (!confirm(t('apps.inboundSecretClearConfirm') || 'Remove the inbound secret? Obligate will present the API key again when it calls this app.')) return;
    const { data } = await apiClient.delete(`/admin/apps/${id}/inbound-secret`);
    if (data.success) { setActivation(null); load(); }
  };

  const copyKey = () => {
    if (shownSecret) {
      navigator.clipboard.writeText(shownSecret.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Obli* apps first, then the "More…" (third-party) group: each is sorted on
  // its own, and the persisted order is the two lists one after the other.
  const mainApps = apps.filter(a => !a.thirdParty);
  const moreApps = apps.filter(a => a.thirdParty);

  const persistOrder = async (ordered: ConnectedApp[]) => {
    setApps(ordered); // optimistic — every app across the suite reads this order
    setReordering(true);
    try {
      const { data } = await apiClient.put('/admin/apps/reorder', { ids: ordered.map(a => a.id) });
      if (data.success) setApps(data.data);
      else { toast.error(data.error || t('common.error') || 'Error'); load(); }
    } catch (err) {
      toast.error(apiError(err).error || t('common.error') || 'Error');
      load();
    } finally { setReordering(false); }
  };

  const dragEndIn = (group: 'main' | 'more') => (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const list = group === 'main' ? mainApps : moreApps;
    const oldIndex = list.findIndex(a => a.id === active.id);
    const newIndex = list.findIndex(a => a.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const moved = arrayMove(list, oldIndex, newIndex);
    persistOrder(group === 'main' ? [...moved, ...moreApps] : [...mainApps, ...moved]);
  };

  // Move an app between the main switcher and "More…" (appended at the end
  // of its new group).
  const toggleThirdParty = async (app: ConnectedApp) => {
    try {
      const { data } = await apiClient.put(`/admin/apps/${app.id}`, { thirdParty: !app.thirdParty });
      if (!data.success) { toast.error(data.error || t('common.error') || 'Error'); return; }
      const updated = { ...app, thirdParty: !app.thirdParty };
      const others = apps.filter(a => a.id !== app.id);
      const main = others.filter(a => !a.thirdParty);
      const more = others.filter(a => a.thirdParty);
      persistOrder(updated.thirdParty ? [...main, ...more, updated] : [...main, updated, ...more]);
    } catch (err) {
      toast.error(apiError(err).error || t('common.error') || 'Error');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('apps.title')}</h1>
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus size={16} className="mr-1.5" /> {t('apps.addApp')}
        </Button>
      </div>

      {/* credentials-changed pushes not delivered for 24 h (push queue) */}
      {syncQueue && syncQueue.failed.length > 0 && (
        <div className="bg-status-down-bg border border-status-down/30 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={16} className="text-status-down" />
            <p className="text-sm text-status-down font-medium">
              {t('apps.syncFailedTitle', { n: syncQueue.failed.length }) || `Credential changes not delivered (${syncQueue.failed.length})`}
            </p>
          </div>
          <p className="text-xs text-text-muted mb-3">
            {t('apps.syncFailedHelp') || 'These apps could not be told about a password, two-factor or activation change for 24 hours. Only Obliance re-checks the credentials at each sensitive use; in the other apps, the sessions opened before the change stay open until they expire. Check that the app is reachable at its base URL and that its API key (or inbound secret) is current, then retry.'}
          </p>
          <div className="space-y-2">
            {syncQueue.failed.map(f => (
              <div key={f.id} className="bg-bg-secondary border border-border rounded-md px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">
                    <span className="font-medium">{f.username ?? `#${f.userId}`}</span>
                    <span className="text-text-muted"> → </span>
                    <span>{f.appName ?? `#${f.appId}`}</span>
                  </p>
                  <p className="text-xs text-text-muted break-all">
                    {t('apps.syncFailedDetail', {
                      since: new Date(f.firstEnqueuedAt).toLocaleString(),
                      attempts: f.attempts,
                      error: f.lastError ?? '—',
                    }) || `${new Date(f.firstEnqueuedAt).toLocaleString()} · ${f.attempts} · ${f.lastError ?? '—'}`}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button size="sm" variant="secondary" loading={syncBusy === f.id} onClick={() => syncAction(f.id, 'retry')}>
                    {t('apps.syncRetry') || 'Retry'}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={syncBusy === f.id} onClick={() => syncAction(f.id, 'dismiss')}>
                    {t('common.dismiss')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Secret shown once (API key or inbound secret) */}
      {shownSecret && (
        <div className="bg-status-up-bg border border-status-up/30 rounded-lg p-4 mb-6">
          <p className="text-sm text-status-up font-medium mb-2">
            {shownSecret.kind === 'apiKey'
              ? t('apps.apiKeyShown')
              : (t('apps.inboundSecretShown') || 'Inbound secret (shown once — copy it now, set it on the app, restart the app, then click Activate)')}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-bg-tertiary px-3 py-2 rounded text-sm font-mono text-text-primary break-all">{shownSecret.value}</code>
            <Button size="sm" variant="secondary" onClick={copyKey}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
          </div>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setShownSecret(null)}>{t('common.dismiss')}</Button>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="bg-bg-secondary border border-border rounded-lg p-5 mb-6">
          <h2 className="text-lg font-medium text-text-primary mb-4">{t('apps.registerNew')}</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <Input
              label={t('apps.appType')}
              value={form.appType}
              onChange={e => setForm(f => ({ ...f, appType: e.target.value.toLowerCase() }))}
              placeholder="obliwan"
              pattern="[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?"
              required
            />
            <p className="text-xs text-text-muted -mt-2">{t('apps.appTypeHelp') || 'A short slug identifying this app (lowercase letters, digits, dash). Any app can be registered here — no code change needed elsewhere in the suite.'}</p>
            <Input label={t('apps.displayName')} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t('apps.displayNamePlaceholder')} required />
            <Input label={t('apps.baseUrl')} value={form.baseUrl} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))} placeholder={t('apps.baseUrlPlaceholder')} required />
            <p className="text-xs text-text-muted">{t('apps.baseUrlHelp') || 'The address users open the app at (scheme, host and port exactly): Obligate only sends sign-ins back to this origin.'}</p>
            <p className="text-xs text-text-muted">{t('apps.accentColorAnnounced') || 'The accent color is announced by the app itself the first time it starts with this API key — nothing to set here.'}</p>
            {createError && <div className="bg-status-down-bg border border-status-down/30 rounded-md p-3 text-sm text-status-down">{createError}</div>}
            <div className="flex gap-2">
              <Button type="submit" loading={saving}>{t('common.create')}</Button>
              <Button type="button" variant="ghost" onClick={() => { setShowForm(false); setCreateError(''); }}>{t('common.cancel')}</Button>
            </div>
          </form>
        </div>
      )}

      {/* Apps list — drag to reorder inside each group; the order applies to
          this dashboard AND every connected app's cross-app switcher (GET
          /api/apps/connected is already sorted by sort_order). */}
      {renderGroup('main', mainApps)}
      {apps.length === 0 && (
        <p className="text-center text-text-muted py-12 text-sm">{t('apps.noApps')}</p>
      )}

      {/* "More…": third-party apps using Obligate as SSO (e.g. Passly) —
          shown apart, in a "More…" dropdown, in every app's header. */}
      <div className="mt-8 mb-2 flex items-center gap-2">
        <MoreHorizontal size={16} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">{t('apps.moreSection') || 'More… (third-party apps)'}</h2>
      </div>
      <p className="text-xs text-text-muted mb-3">
        {t('apps.moreSectionHelp') || 'Apps that are not part of the Obli suite but sign in through Obligate. They appear in a separate "More…" menu in every header, not in the main app switcher. Use the button on a row to move an app between the two groups.'}
      </p>
      {moreApps.length > 0
        ? renderGroup('more', moreApps)
        : <p className="text-xs text-text-muted italic py-3">{t('apps.moreSectionEmpty') || 'No third-party app.'}</p>}
    </div>
  );

  function renderGroup(group: 'main' | 'more', list: ConnectedApp[]) {
    return (
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEndIn(group)}>
        <SortableContext items={list.map(a => a.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {list.map(app => (
              <AppRow
                key={app.id}
                app={app}
                t={t}
                dragDisabled={reordering}
                editing={editing}
                editError={editError}
                editSaving={editSaving}
                editingAppearance={editingAppearance}
                appearanceSaving={appearanceSaving}
                activation={activation}
                activating={activating}
                onStartEdit={startEdit}
                onEditingChange={setEditing}
                onSaveBaseUrl={saveBaseUrl}
                onCancelEdit={() => setEditing(null)}
                onStartEditAppearance={startEditAppearance}
                onAppearanceChange={setEditingAppearance}
                onSaveAppearance={saveAppearance}
                onCancelAppearance={() => setEditingAppearance(null)}
                onRegenKey={handleRegenKey}
                onGenerateInboundSecret={handleGenerateInboundSecret}
                onActivateInboundSecret={handleActivateInboundSecret}
                onClearInboundSecret={handleClearInboundSecret}
                onToggleThirdParty={toggleThirdParty}
                onDelete={handleDelete}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    );
  }
}

interface AppRowProps {
  app: ConnectedApp;
  t: (key: string, opts?: Record<string, unknown>) => string;
  dragDisabled: boolean;
  editing: { id: number; baseUrl: string } | null;
  editError: string;
  editSaving: boolean;
  editingAppearance: { id: number; color: string; icon: string } | null;
  appearanceSaving: boolean;
  activation: { id: number; ok: boolean; message: string } | null;
  activating: number | null;
  onStartEdit: (app: ConnectedApp) => void;
  onEditingChange: (v: { id: number; baseUrl: string } | null) => void;
  onSaveBaseUrl: (e: React.FormEvent) => void;
  onCancelEdit: () => void;
  onStartEditAppearance: (app: ConnectedApp) => void;
  onAppearanceChange: (v: { id: number; color: string; icon: string } | null) => void;
  onSaveAppearance: (e: React.FormEvent) => void;
  onCancelAppearance: () => void;
  onRegenKey: (id: number) => void;
  onGenerateInboundSecret: (id: number) => void;
  onActivateInboundSecret: (id: number) => void;
  onClearInboundSecret: (id: number) => void;
  onToggleThirdParty: (app: ConnectedApp) => void;
  onDelete: (id: number) => void;
}

function AppRow(props: AppRowProps) {
  const { app, t } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: app.id, disabled: props.dragDisabled });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };
  const isEditingAppearance = props.editingAppearance?.id === app.id;

  return (
    <div ref={setNodeRef} style={style} className="bg-bg-secondary border border-border rounded-lg px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="shrink-0 text-text-muted hover:text-text-secondary cursor-grab active:cursor-grabbing touch-none"
            title={t('apps.dragToReorder') || 'Drag to reorder'}
          >
            <GripVertical size={16} />
          </button>
          <img src={effectiveIconUrl(app)} alt="" className="h-6 w-6 rounded shrink-0" onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="text-sm font-medium px-1.5 py-0.5 rounded"
                style={{ color: app.color || DEFAULT_COLOR, backgroundColor: `${app.color || DEFAULT_COLOR}1a` }}
              >
                {app.appType}
              </span>
              <span className="text-text-primary font-medium">{app.name}</span>
              <span className="text-xs text-text-muted font-mono" title={t('apps.appIdHint') || 'App id (OAUTH_EXTRA_REDIRECT_ORIGINS, logs)'}>#{app.id}</span>
              {!app.isActive && <span className="text-xs bg-status-down-bg text-status-down px-1.5 py-0.5 rounded">{t('common.disabled')}</span>}
              {app.inboundSecretSet && (
                <span className="text-xs bg-bg-tertiary text-text-secondary px-1.5 py-0.5 rounded" title={t('apps.inboundSecretSetHint') || 'Obligate presents a distinct inbound secret (not the API key) when it calls this app'}>
                  {t('apps.inboundSecretSet') || 'Inbound secret'}
                </span>
              )}
              {app.inboundSecretPending && (
                <span className="text-xs bg-status-warning/10 text-status-warning px-1.5 py-0.5 rounded" title={t('apps.inboundSecretPendingHint') || 'Generated, not in use yet: set it on the app, then click Activate'}>
                  {t('apps.inboundSecretPending') || 'Inbound secret pending'}
                </span>
              )}
              {app.rawClientIdLastSeenAt && (
                <span className="text-xs bg-status-down-bg text-status-down px-1.5 py-0.5 rounded">
                  {t('apps.keyExposed') || 'API key exposed'}
                </span>
              )}
            </div>
            {props.editing?.id === app.id ? (
              <form onSubmit={props.onSaveBaseUrl} className="mt-2 flex flex-wrap items-start gap-2">
                <div className="flex-1 min-w-[16rem]">
                  <Input
                    value={props.editing.baseUrl}
                    onChange={e => props.onEditingChange({ id: app.id, baseUrl: e.target.value })}
                    placeholder={t('apps.baseUrlPlaceholder')}
                    aria-label={t('apps.baseUrl')}
                    error={props.editError || undefined}
                    autoFocus
                    required
                  />
                </div>
                <Button type="submit" size="sm" loading={props.editSaving}>{t('common.save') || 'Save'}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={props.onCancelEdit}>{t('common.cancel')}</Button>
              </form>
            ) : (
              <p className="text-xs text-text-muted mt-0.5 font-mono break-all">{app.baseUrl}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" variant="ghost" onClick={() => props.onStartEditAppearance(app)} title={t('apps.editAppearance') || 'Icon override (the accent color is announced by the app)'}>
            <Palette size={14} />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => props.onStartEdit(app)} title={t('apps.editBaseUrl') || 'Edit base URL'}>
            <Pencil size={14} />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => props.onRegenKey(app.id)} title={t('apps.regenerateKey')}>
            <RotateCw size={14} />
          </Button>
          {app.inboundSecretSupported ? (
            <Button size="sm" variant="ghost" onClick={() => props.onGenerateInboundSecret(app.id)} title={t('apps.inboundSecretGenerate') || 'Generate inbound secret'}>
              <KeyRound size={14} />
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled title={t('apps.inboundSecretUnsupported') || 'This app cannot be configured with an inbound secret: it only accepts its API key from Obligate.'}>
              <KeyRound size={14} />
            </Button>
          )}
          {app.inboundSecretPending && (
            <Button size="sm" variant="ghost" loading={props.activating === app.id} onClick={() => props.onActivateInboundSecret(app.id)} title={t('apps.inboundSecretActivate') || 'Activate the inbound secret (Obligate checks that the app accepts it)'}>
              <ShieldCheck size={14} />
            </Button>
          )}
          {(app.inboundSecretSet || app.inboundSecretPending) && (
            <Button size="sm" variant="ghost" onClick={() => props.onClearInboundSecret(app.id)} title={t('apps.inboundSecretClear') || 'Remove inbound secret'}>
              <ShieldOff size={14} />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => props.onToggleThirdParty(app)}
            title={app.thirdParty
              ? (t('apps.moveToMain') || 'Move to the main app switcher')
              : (t('apps.moveToMore') || 'Move to "More…" (third-party app)')}
          >
            {app.thirdParty ? <ArrowUpToLine size={14} /> : <MoreHorizontal size={14} />}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => props.onDelete(app.id)} title={t('common.delete')}>
            <Trash2 size={14} className="text-status-down" />
          </Button>
        </div>
      </div>

      {isEditingAppearance && props.editingAppearance && (
        <form onSubmit={props.onSaveAppearance} className="mt-3 flex flex-wrap items-end gap-3 bg-bg-tertiary rounded-md p-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-text-secondary">{t('apps.accentColor') || 'Accent color'}</label>
            <div className="flex items-center gap-2 h-9" title={t('apps.accentColorAnnouncedShort') || 'Announced by the app at startup'}>
              <span className="h-5 w-5 rounded-full border border-border" style={{ background: app.color || DEFAULT_COLOR }} />
              <span className="text-xs font-mono text-text-muted">{app.color || (t('apps.accentColorPending') || 'not announced yet')}</span>
            </div>
          </div>
          <div className="space-y-1 flex-1 min-w-[16rem]">
            <label className="block text-xs font-medium text-text-secondary">{t('apps.iconOverride') || 'Icon URL override (optional)'}</label>
            <Input
              value={props.editingAppearance.icon}
              onChange={e => props.onAppearanceChange({ ...props.editingAppearance!, icon: e.target.value })}
              placeholder={`${app.baseUrl}/favicon.svg`}
            />
          </div>
          <Button type="submit" size="sm" loading={props.appearanceSaving}>{t('common.save') || 'Save'}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={props.onCancelAppearance}>{t('common.cancel')}</Button>
        </form>
      )}

      {app.rawClientIdLastSeenAt && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 bg-status-down-bg border border-status-down/30 rounded-md px-3 py-2">
          <p className="text-xs text-status-down">
            {t('apps.keyExposedHelp', { date: new Date(app.rawClientIdLastSeenAt).toLocaleString(), count: app.rawClientIdUses })
              || `This app sent its API key in clear as its sign-in client_id (last ${new Date(app.rawClientIdLastSeenAt).toLocaleString()}, ${app.rawClientIdUses}×): the key went through browsers and must be treated as public. No delegation token is issued for it. Make the app send sha256(key), then regenerate the key.`}
          </p>
          <Button size="sm" variant="secondary" onClick={() => props.onRegenKey(app.id)}>
            <RotateCw size={14} className="mr-1.5" /> {t('apps.rotateKey') || 'Rotate the key'}
          </Button>
        </div>
      )}
      {props.activation?.id === app.id && (
        <p className={`mt-2 text-xs ${props.activation.ok ? 'text-status-up' : 'text-status-down'}`}>{props.activation.message}</p>
      )}
    </div>
  );
}
