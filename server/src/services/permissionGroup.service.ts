import { db } from '../db';
import { configService } from './config.service';
import type { PermissionGroup, PermissionGroupAppMapping } from '@obligate/shared';

interface GroupRow {
  id: number;
  name: string;
  description: string | null;
  scope: string;
  tenant_id: number | null;
  created_by: number | null;
  created_at: Date;
  force_2fa_exempt: boolean;
}

interface MappingRow {
  id: number;
  group_id: number;
  app_id: number;
  app_role: string;
  tenant_slug: string | null;
  team_name: string | null;
}

function rowToGroup(row: GroupRow): PermissionGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope as 'global' | 'tenant',
    tenantId: row.tenant_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    force2faExempt: row.force_2fa_exempt,
  };
}

function rowToMapping(r: MappingRow): PermissionGroupAppMapping {
  return {
    id: r.id,
    groupId: r.group_id,
    appId: r.app_id,
    appRole: r.app_role,
    tenantSlug: r.tenant_slug,
    teamName: r.team_name,
  };
}

export const permissionGroupService = {
  async listGroups(): Promise<PermissionGroup[]> {
    const rows = await db('permission_groups').orderBy('name') as GroupRow[];
    return rows.map(rowToGroup);
  },

  async getGroupById(id: number): Promise<PermissionGroup | null> {
    const row = await db('permission_groups').where({ id }).first() as GroupRow | undefined;
    if (!row) return null;
    return rowToGroup(row);
  },

  async createGroup(data: {
    name: string;
    description?: string | null;
    scope?: 'global' | 'tenant';
    tenantId?: number | null;
    createdBy?: number | null;
    force2faExempt?: boolean;
  }): Promise<PermissionGroup> {
    const [row] = await db('permission_groups')
      .insert({
        name: data.name,
        description: data.description ?? null,
        scope: data.scope ?? 'global',
        tenant_id: data.tenantId ?? null,
        created_by: data.createdBy ?? null,
        force_2fa_exempt: data.force2faExempt ?? false,
      })
      .returning('*') as GroupRow[];
    return rowToGroup(row);
  },

  async updateGroup(id: number, data: {
    name?: string;
    description?: string | null;
    force2faExempt?: boolean;
  }): Promise<PermissionGroup | null> {
    const update: Record<string, unknown> = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.force2faExempt !== undefined) update.force_2fa_exempt = data.force2faExempt;
    if (Object.keys(update).length === 0) return this.getGroupById(id);

    const [row] = await db('permission_groups')
      .where({ id })
      .update(update)
      .returning('*') as GroupRow[];
    if (!row) return null;
    return rowToGroup(row);
  },

  async deleteGroup(id: number): Promise<boolean> {
    const count = await db('permission_groups').where({ id }).del();
    return count > 0;
  },

  // ── App Mappings ─────────────────────────────────────────────

  async getMappingsForGroup(groupId: number): Promise<PermissionGroupAppMapping[]> {
    const rows = await db('permission_group_app_mappings')
      .where({ group_id: groupId }) as MappingRow[];
    return rows.map(rowToMapping);
  },

  async addMapping(data: {
    groupId: number;
    appId: number;
    appRole: string;
    tenantSlug?: string | null;
    teamName?: string | null;
  }): Promise<PermissionGroupAppMapping> {
    const [row] = await db('permission_group_app_mappings')
      .insert({
        group_id: data.groupId,
        app_id: data.appId,
        app_role: data.appRole,
        tenant_slug: data.tenantSlug ?? null,
        team_name: data.teamName ?? null,
      })
      .returning('*') as MappingRow[];
    return rowToMapping(row);
  },

  async updateMapping(id: number, data: {
    appRole?: string;
  }): Promise<PermissionGroupAppMapping | null> {
    const update: Record<string, unknown> = {};
    if (data.appRole !== undefined) update.app_role = data.appRole;
    if (Object.keys(update).length === 0) return null;

    const [row] = await db('permission_group_app_mappings')
      .where({ id })
      .update(update)
      .returning('*') as MappingRow[];
    if (!row) return null;
    return rowToMapping(row);
  },

  async deleteMapping(id: number): Promise<boolean> {
    const count = await db('permission_group_app_mappings').where({ id }).del();
    return count > 0;
  },

  // ── User ↔ Group assignments ─────────────────────────────────

  async assignUserToGroup(userId: number, groupId: number): Promise<void> {
    await db('user_permission_groups')
      .insert({ user_id: userId, group_id: groupId })
      .onConflict(['user_id', 'group_id'])
      .ignore();
  },

  async removeUserFromGroup(userId: number, groupId: number): Promise<void> {
    await db('user_permission_groups')
      .where({ user_id: userId, group_id: groupId })
      .del();
  },

  async getGroupsForUser(userId: number): Promise<PermissionGroup[]> {
    const rows = await db('user_permission_groups as upg')
      .join('permission_groups as pg', 'pg.id', 'upg.group_id')
      .where('upg.user_id', userId)
      .select('pg.*') as GroupRow[];
    return rows.map(rowToGroup);
  },

  async getAllUserGroupAssignments(): Promise<Record<number, PermissionGroup[]>> {
    const rows = await db('user_permission_groups as upg')
      .join('permission_groups as pg', 'pg.id', 'upg.group_id')
      .select('upg.user_id', 'pg.*') as Array<GroupRow & { user_id: number }>;
    const result: Record<number, PermissionGroup[]> = {};
    for (const row of rows) {
      if (!result[row.user_id]) result[row.user_id] = [];
      result[row.user_id].push(rowToGroup(row));
    }
    return result;
  },

  // ── Resolution: user + app → effective role / tenants / teams ────
  //
  // Capabilities used to be tracked per mapping; that concept was removed —
  // a tenant's role (permission set) on the app side owns the capability
  // matrix, and the team scopes that role to a set of devices.

  async resolveForUserAndApp(userId: number, appId: number): Promise<{
    role: string;
    tenants: Array<{ slug: string; role: string }>;
    teams: string[];
  }> {
    const mappings = await db('user_permission_groups as upg')
      .join('permission_group_app_mappings as pgam', 'pgam.group_id', 'upg.group_id')
      .where({ 'upg.user_id': userId, 'pgam.app_id': appId })
      .select('pgam.app_role', 'pgam.tenant_slug', 'pgam.team_name') as Array<{
        app_role: string;
        tenant_slug: string | null;
        team_name: string | null;
      }>;

    if (mappings.length === 0) {
      return { role: '', tenants: [], teams: [] };
    }

    // Platform-wide ("global") role is derived ONLY from app-wide mappings
    // — those with NO tenant_slug, i.e. the "All tenants" toggle in the
    // Permission Groups UI. This is what makes the SSO model coherent for
    // relying-party apps (Obliance et al.):
    //
    //   • "Admin on All tenants"      (tenant_slug = NULL, admin) → global/platform admin
    //   • "Admin on a specific tenant" (tenant_slug = 'x',  admin) → tenant admin only
    //                                                                 (carried in tenants[] below)
    //
    // A user who only has tenant-scoped mappings still gets app access with
    // a baseline 'user' platform role (never '' — that would deny access).
    // Previously ANY admin mapping (even one tenant) set role='admin',
    // which silently turned tenant admins into platform admins on every app.
    const appWide = mappings.filter(m => !m.tenant_slug);
    let role: string;
    if (appWide.some(m => m.app_role === 'admin')) role = 'admin';
    else if (appWide.some(m => m.app_role === 'user')) role = 'user';
    else if (appWide.length > 0) role = appWide[0].app_role; // viewer / custom slug
    else role = 'user'; // only tenant-scoped mappings → access yes, global admin no

    // Per-tenant role (highest wins)
    const tenantRoleMap = new Map<string, string>();
    for (const m of mappings) {
      if (m.tenant_slug) {
        const existing = tenantRoleMap.get(m.tenant_slug);
        if (!existing || m.app_role === 'admin' || (m.app_role === 'user' && existing === 'viewer')) {
          tenantRoleMap.set(m.tenant_slug, m.app_role);
        }
      }
    }
    const tenants = Array.from(tenantRoleMap.entries()).map(([slug, r]) => ({ slug, role: r }));

    const teams = [...new Set(mappings.filter(m => m.team_name).map(m => m.team_name!))];

    return { role, tenants, teams };
  },

  // ── Membership of a user in ONE connected app ─────────────────
  //
  // Every endpoint authenticated by an app key alone must stay within that
  // app's own users (a key may be public while the app sends it as its
  // client_id). These are the facts they scope on.

  async getAppMembership(userId: number, appId: number): Promise<{
    /** null when the user does not exist */
    user: { id: number; role: string; isActive: boolean } | null;
    /** the user_app_links row, null when none */
    link: { enabled: boolean; remoteUserId: number | null; lastLoginAt: Date | null; remoteUserReportedAt: Date | null } | null;
    /** permission-group mappings of the user to this app */
    mappings: Array<{ appRole: string; tenantSlug: string | null }>;
    /** may sign in to the app now: platform admin, or ≥1 mapping (same rule as GET /api/apps/users) */
    entitled: boolean;
  }> {
    const user = await db('users').where({ id: userId }).first('id', 'role', 'is_active') as
      { id: number; role: string; is_active: boolean } | undefined;
    if (!user) return { user: null, link: null, mappings: [], entitled: false };
    const [link, mappings] = await Promise.all([
      db('user_app_links').where({ user_id: userId, app_id: appId })
        .first('enabled', 'remote_user_id', 'last_login_at', 'remote_user_reported_at') as Promise<
          { enabled: boolean; remote_user_id: number | null; last_login_at: Date | null; remote_user_reported_at: Date | null } | undefined>,
      db('user_permission_groups as upg')
        .join('permission_group_app_mappings as pgam', 'pgam.group_id', 'upg.group_id')
        .where({ 'upg.user_id': userId, 'pgam.app_id': appId })
        .select('pgam.app_role', 'pgam.tenant_slug') as Promise<Array<{ app_role: string; tenant_slug: string | null }>>,
    ]);
    return {
      user: { id: user.id, role: user.role, isActive: user.is_active },
      link: link ? {
        enabled: link.enabled,
        remoteUserId: link.remote_user_id,
        lastLoginAt: link.last_login_at,
        remoteUserReportedAt: link.remote_user_reported_at ?? null,
      } : null,
      mappings: mappings.map(m => ({ appRole: m.app_role, tenantSlug: m.tenant_slug })),
      entitled: user.role === 'admin' || mappings.length > 0,
    };
  },

  /**
   * Is the user one of the app's users? An existing link row decides (its
   * `enabled` flag); without one, the current entitlement does. Unknown user:
   * false.
   */
  async belongsToApp(userId: number, appId: number): Promise<boolean> {
    const m = await this.getAppMembership(userId, appId);
    if (!m.user) return false;
    return m.link ? m.link.enabled : m.entitled;
  },

  // ── Force-2FA group exemption ───────────────────────────────

  /**
   * True iff the user is exempt from the global "force 2FA" policy: they
   * belong to at least one permission group, AND every one of their groups
   * is marked exempt. A user with no group, or with even one non-exempt
   * group, is NOT exempt — the most restrictive group wins by design.
   */
  async isForce2faExempt(userId: number): Promise<boolean> {
    const exempts = await db('user_permission_groups as upg')
      .join('permission_groups as pg', 'pg.id', 'upg.group_id')
      .where('upg.user_id', userId)
      .pluck('pg.force_2fa_exempt') as boolean[];
    if (exempts.length === 0) return false;
    return exempts.every(Boolean);
  },

  /** Global force-2FA policy resolved for one user: off globally, or exempt via groups, both mean false. */
  async isForce2faRequiredForUser(userId: number): Promise<boolean> {
    const globalForce = (await configService.get('force_2fa')) === 'true';
    if (!globalForce) return false;
    return !(await this.isForce2faExempt(userId));
  },

  // ── Group Managers ───────────────────────────────────────────

  async setManagers(groupId: number, userIds: number[]): Promise<void> {
    await db.transaction(async (trx) => {
      await trx('permission_group_managers').where({ group_id: groupId }).del();
      if (userIds.length > 0) {
        await trx('permission_group_managers').insert(
          userIds.map(uid => ({ group_id: groupId, user_id: uid })),
        );
      }
    });
  },

  async getManagersForGroup(groupId: number): Promise<number[]> {
    const rows = await db('permission_group_managers').where({ group_id: groupId })
      .pluck('user_id') as number[];
    return rows;
  },

  async getAllGroupManagers(): Promise<Record<number, number[]>> {
    const rows = await db('permission_group_managers').select('group_id', 'user_id') as Array<{
      group_id: number; user_id: number;
    }>;
    const result: Record<number, number[]> = {};
    for (const r of rows) {
      if (!result[r.group_id]) result[r.group_id] = [];
      result[r.group_id].push(r.user_id);
    }
    return result;
  },

  /** Returns the IDs of groups this user manages. */
  async getManagedGroupIds(userId: number): Promise<number[]> {
    const rows = await db('permission_group_managers').where({ user_id: userId })
      .pluck('group_id') as number[];
    return rows;
  },

  /**
   * True iff the actor is allowed to act on the target user (reset their
   * password or 2FA, (de)activate them, change their groups).
   * Rule: actor is admin, OR
   *   - the target is NOT the actor: a manager never acts on HIS OWN account
   *     through the management routes (they would change his password
   *     without the current one, which PUT /account/password requires, reset
   *     his own 2FA, or add him to a managed group and so grant him its
   *     apps), AND
   *   - the target is NOT a platform admin (a manager resetting an admin's
   *     password and 2FA would sign in as that admin: platform admin by
   *     proxy), AND
   *   - the target has ≥1 group and every group of the target is managed by
   *     the actor, AND
   *   - every group the TARGET manages is also managed by the actor (else a
   *     manager could take over a manager of a wider scope).
   */
  async canActOnUser(actorId: number, actorRole: string, targetId: number): Promise<boolean> {
    if (actorRole === 'admin') return true;
    if (!Number.isSafeInteger(targetId) || targetId === Number(actorId)) return false;
    const target = await db('users').where({ id: targetId }).first('role') as { role: string } | undefined;
    if (!target || target.role === 'admin') return false;
    const targetGroupIds = await db('user_permission_groups')
      .where({ user_id: targetId })
      .pluck('group_id') as number[];
    if (targetGroupIds.length === 0) return false;
    const managed = new Set(await this.getManagedGroupIds(actorId));
    if (!targetGroupIds.every(gid => managed.has(gid))) return false;
    const targetManages = await this.getManagedGroupIds(targetId);
    return targetManages.every(gid => managed.has(gid));
  },

  /** IDs of users the actor can act on (same rule as canActOnUser). */
  async getActionableUserIds(actorId: number): Promise<number[]> {
    const managed = await this.getManagedGroupIds(actorId);
    if (managed.length === 0) return [];
    const rows = await db('user_permission_groups')
      .select('user_id')
      .groupBy('user_id')
      .havingRaw('bool_and(group_id = ANY(?))', [managed]) as Array<{ user_id: number }>;
    const candidates = rows.map(r => r.user_id);
    if (candidates.length === 0) return [];
    const admins = new Set(await db('users').whereIn('id', candidates).where({ role: 'admin' }).pluck('id') as number[]);
    const managerRows = await db('permission_group_managers').whereIn('user_id', candidates)
      .select('user_id', 'group_id') as Array<{ user_id: number; group_id: number }>;
    const managedSet = new Set(managed);
    const widerManagers = new Set(managerRows.filter(r => !managedSet.has(r.group_id)).map(r => r.user_id));
    return candidates.filter(id => id !== Number(actorId) && !admins.has(id) && !widerManagers.has(id));
  },

  /** IDs of users with ≥1 group managed by the actor (visible but not necessarily actionable). */
  async getVisibleUserIds(actorId: number): Promise<number[]> {
    const managed = await this.getManagedGroupIds(actorId);
    if (managed.length === 0) return [];
    const rows = await db('user_permission_groups')
      .whereIn('group_id', managed)
      .select('user_id')
      .groupBy('user_id') as Array<{ user_id: number }>;
    return rows.map(r => r.user_id);
  },
};
