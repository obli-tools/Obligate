// ── Users ────────────────────────────────────────────────────────────────────

export interface ObligateUser {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  role: 'admin' | 'user';
  isActive: boolean;
  authSource: 'local' | 'ldap';
  directoryId: number | null;
  ldapDn: string | null;
  totpEnabled: boolean;
  /** Admin reset the user's 2FA — a new TOTP secret must be configured at next login. */
  require2faSetup: boolean;
  preferredLanguage: string;
  preferredTheme: string;
  profilePhotoUrl: string | null;
  enrollmentVersion: number;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Connected Apps ───────────────────────────────────────────────────────────

/**
 * Free-form slug (lowercase letters/digits/dash, matched against `app_type`
 * columns of at most 32 chars — see `isValidAppTypeSlug` in app.service.ts).
 * Not a closed union: a new app is registered from AppsPage alone, no
 * code change needed anywhere in the suite to make it a known type.
 */
export type AppType = string;

export interface ConnectedApp {
  id: number;
  appType: AppType;
  name: string;
  baseUrl: string;
  apiKeySet: boolean;   // never expose raw key to client
  /**
   * A distinct secret is set for Obligate's calls TO this app (sso-user-sync,
   * app-info, dashboard-stats), presented instead of the API key. The secret
   * itself is never exposed after generation.
   */
  inboundSecretSet: boolean;
  /** An inbound secret was generated and waits for its activation (the app must accept it first). */
  inboundSecretPending: boolean;
  /** The app type can require an inbound secret (INBOUND_SECRET_APP_TYPES, default obliance, oblimap, oblihub). */
  inboundSecretSupported: boolean;
  /**
   * Last time the app's RAW API key was sent as the public client_id (it went
   * through a browser): the key must be rotated. Null = not seen since the
   * last rotation. While set, no delegation token is minted for the app.
   */
  rawClientIdLastSeenAt: string | null;
  rawClientIdUses: number;
  apiKeyRotatedAt: string | null;
  icon: string | null;
  color: string | null;
  /** Display order across the suite (ascending). Editable in AppsPage. */
  sortOrder: number;
  /** Not an Obli* app (e.g. Passly): filed under "More…", shown apart in every header. */
  thirdParty: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Auth Codes ───────────────────────────────────────────────────────────────

export interface AuthCode {
  id: number;
  code: string;
  userId: number;
  appId: number;
  redirectUri: string;
  expiresAt: string;
  used: boolean;
  createdAt: string;
}

// ── User-App Links ───────────────────────────────────────────────────────────

export interface UserAppLink {
  id: number;
  userId: number;
  appId: number;
  remoteUserId: number | null;
  enabled: boolean;
  firstLoginAt: string | null;
  lastLoginAt: string | null;
}

// ── Permission Groups ────────────────────────────────────────────────────────

export interface PermissionGroup {
  id: number;
  name: string;
  description: string | null;
  scope: 'global' | 'tenant';
  tenantId: number | null;
  createdBy: number | null;
  createdAt: string;
  /** Exempts this group's members from the global "force 2FA" policy — only when EVERY group of the user is exempt. */
  force2faExempt: boolean;
}

export interface PermissionGroupAppMapping {
  id: number;
  groupId: number;
  appId: number;
  appRole: string;         // 'admin' | 'user' | 'viewer' | <permission-set-slug>
  tenantSlug: string | null;
  teamName: string | null;
}

// ── LDAP/AD Directories ──────────────────────────────────────────────────────

export interface LdapDirectory {
  id: number;
  name: string;
  domain: string;
  serverUrl: string;
  bindDn: string;
  baseDn: string;
  userSearchFilter: string;
  userSearchBase: string | null;
  groupSearchFilter: string | null;
  groupSearchBase: string | null;
  emailAttribute: string;
  displayNameAttribute: string;
  tlsRejectUnauthorized: boolean;
  isActive: boolean;
  syncIntervalMinutes: number;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DirectoryDomainAlias {
  id: number;
  directoryId: number;
  domainAlias: string;
}

// ── AD Group Mappings ────────────────────────────────────────────────────────

export interface AdGroupMapping {
  id: number;
  directoryId: number;
  adGroupDn: string;
  adGroupName: string | null;
  permissionGroupId: number;
  createdAt: string;
}

// ── Device Links ─────────────────────────────────────────────────────────────

export interface DeviceLink {
  id: number;
  deviceUuid: string;
  appId: number;
  appPath: string;
  updatedAt: string;
}

// ── Token Exchange Response ──────────────────────────────────────────────────

export interface TokenExchangeResponse {
  obligateUserId: number;
  username: string;
  email: string | null;
  displayName: string | null;
  role: string;
  tenants: Array<{ slug: string; role: string }>;
  teams: string[];
  authSource: 'local' | 'ldap';
  /**
   * DEPRECATED — always null. It used to echo the local account id the app
   * reported through report-provision, a value any holder of the app key
   * could rewrite: an app that trusted it opened a session on whatever local
   * account the attacker named. Apps resolve the local account from their own
   * records (e.g. users.foreign_id / sso_foreign_users).
   */
  linkedLocalUserId: null;
  /**
   * Forced re-authentication — when the Obligate session that issued the code authenticated
   * (unix seconds); null for a session opened before this version.
   */
  authTime: number | null;
  /** Forced re-authentication — RFC 8176 methods of that authentication: ['pwd'] or ['pwd', 'otp']. */
  amr: string[];
}

// ── Step-up support for connected apps (device-bound step-up) ──────────────────────────────

/** GET /api/oauth/capabilities — `data`; apps enable device-bound step-up only when every flag is exactly 1. */
export interface ObligateOAuthCapabilities {
  stepUpEpoch: 1;
  reauth: 1;
  totpReplayGuard: 1;
}

/** POST /api/oauth/verify-totp — `data` of a 200 response. */
export interface VerifyTotpResult {
  valid: boolean;
  /** Time step (floor(unix s / 30)) of the matched code; null when it does not match. */
  step: number | null;
  mfaEpoch: number;
  /** Set when valid is false: 'replayed' = right code, step already used (consume:true only). */
  reason?: 'invalid' | 'replayed';
}

/** GET /api/oauth/users/:id/mfa-epoch — `data` of a 200 response. */
export interface MfaEpochResult {
  mfaEpoch: number;
  /** User active in Obligate, enabled on and entitled to the calling app. */
  active: boolean;
}

/** Admin view of a credentials-changed push given up after 24 h. */
export interface SsoSyncFailure {
  id: number;
  appId: number;
  appName: string | null;
  userId: number;
  username: string | null;
  action: string;
  mfaEpoch: number | null;
  attempts: number;
  firstEnqueuedAt: string;
  lastAttemptAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
}

export interface SsoSyncQueueStatus {
  /** Pushes waiting for delivery (or a retry). */
  pending: number;
  /** Pushes an app refused for good (4xx: it does not handle the action). */
  rejected: number;
  /** Pushes given up after 24 h of failures (admin alert). */
  failed: SsoSyncFailure[];
}

// ── SSO Config (exposed to connected apps' clients) ──────────────────────────

export interface ObligateConfig {
  url: string | null;
  apiKeySet: boolean;
  enabled: boolean;
}
