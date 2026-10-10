import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// Where Obligate may send a browser
//
// /authorize delivers a one-time authorization code to redirect_uri. Before
// this check any URL was accepted, so a link naming a connected app (its
// client_id is public) with redirect_uri=https://attacker/ handed the code of
// whoever clicked it to the attacker. Now the redirect_uri must be on the
// origin the app is REGISTERED under (connected_apps.base_url), or on the
// loopback interface for the desktop / native flow (RFC 8252 §7.3: the
// Oblireach desktop client listens on http://127.0.0.1:<port>/sso/callback).
// ─────────────────────────────────────────────────────────────────────────────

/** Normalised `scheme://host[:port]` of an http(s) URL (lower-case host, no default port), or null. */
export function httpOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Hosts a native app may listen on (RFC 8252 §7.3; `localhost` kept for the existing desktop client). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** Spaces, control characters (C0, DEL, C1) and backslashes: never in a URL we redirect a browser to. */
const UNSAFE_URL_CHARS = /[\u0000-\u0020\u007f-\u009f\\]/;

export type RedirectRefusal =
  | 'too_long'
  | 'invalid_characters'
  | 'fragment'
  | 'unparseable'
  | 'scheme'
  | 'credentials'
  | 'origin_not_allowed';

export type RedirectCheck =
  | { ok: true; origin: string; loopback: boolean }
  | { ok: false; reason: RedirectRefusal; origin: string | null };

/**
 * Check a redirect_uri named by a browser request.
 *
 * Accepted: an absolute http(s) URL without credentials or fragment whose
 * origin is EXACTLY one of `allowedOrigins` (compared after URL
 * normalisation: case of the host, default port), or — `allowLoopback` — whose
 * host is a loopback address (any port).
 *
 * The string is also refused when it holds characters a browser strips or
 * rewrites while parsing (tabs, newlines, backslashes...): the origin we check
 * must be the one the browser will actually navigate to.
 */
export function checkRedirectUri(
  raw: string,
  allowedOrigins: ReadonlyArray<string | null>,
  opts: { allowLoopback: boolean },
): RedirectCheck {
  if (raw.length > 2048) return { ok: false, reason: 'too_long', origin: null };
  if (UNSAFE_URL_CHARS.test(raw)) return { ok: false, reason: 'invalid_characters', origin: null };
  // RFC 6749 §3.1.2: the redirection endpoint MUST NOT include a fragment
  // (and a code appended after one would never reach the app's server).
  if (raw.includes('#')) return { ok: false, reason: 'fragment', origin: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'unparseable', origin: null };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme', origin: null };
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials', origin: url.origin };
  if (allowedOrigins.includes(url.origin)) return { ok: true, origin: url.origin, loopback: false };
  if (opts.allowLoopback && LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: true, origin: url.origin, loopback: true };
  }
  return { ok: false, reason: 'origin_not_allowed', origin: url.origin };
}

// ── Loopback (desktop / native flow): which app types may use it ────────────
//
// OAUTH_LOOPBACK_APP_TYPES = comma list of app types whose /authorize may send
// a code to a loopback redirect_uri. Default 'obliance' — the only app with a
// desktop flow today (Oblireach client, POST /api/auth/sso-desktop-init).
// '*' = every app, 'none' = no app. On a shared machine (terminal server)
// another local user can listen on a loopback port: an app that never uses
// loopback has no reason to accept it.

export function loopbackAllowedFor(appType: string): boolean {
  const raw = process.env.OAUTH_LOOPBACK_APP_TYPES?.trim().toLowerCase();
  const list = raw === undefined || raw === '' ? ['obliance'] : raw.split(/[\s,]+/).filter(Boolean);
  if (list.includes('none')) return false;
  return list.includes('*') || list.includes(appType.toLowerCase());
}

// ── Operator escape hatch: extra redirect origins per app ────────────────────
//
// OAUTH_EXTRA_REDIRECT_ORIGINS="<appId>=<origin>[,<origin>...][;<appId>=...]"
// For an app users reach through an address other than its registered base
// URL (e.g. the base URL is an internal name Obligate uses for its own calls).
// Prefer fixing the base URL: it is also where the dashboard and the device
// links send users. The app id is logged with every refused redirect_uri.

let extraCache: { raw: string; map: Map<number, string[]> } | null = null;

function parseExtraOrigins(raw: string): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const idPart = eq > 0 ? trimmed.slice(0, eq).trim() : '';
    if (!/^[1-9][0-9]{0,9}$/.test(idPart)) {
      logger.warn({ entry: trimmed.slice(0, 200) }, 'OAUTH_EXTRA_REDIRECT_ORIGINS: entry ignored (expected <appId>=<origin>[,<origin>])');
      continue;
    }
    const origins: string[] = [];
    for (const candidate of trimmed.slice(eq + 1).split(',')) {
      const value = candidate.trim();
      if (!value) continue;
      const origin = httpOrigin(value);
      if (!origin || UNSAFE_URL_CHARS.test(value)) {
        logger.warn({ appId: Number(idPart), value: value.slice(0, 200) }, 'OAUTH_EXTRA_REDIRECT_ORIGINS: origin ignored (not an http(s) URL)');
        continue;
      }
      origins.push(origin);
    }
    const id = Number(idPart);
    map.set(id, [...(map.get(id) ?? []), ...origins]);
  }
  return map;
}

/** Extra redirect origins the operator allowed for one app (environment, read per call). */
export function extraRedirectOrigins(appId: number): string[] {
  const raw = process.env.OAUTH_EXTRA_REDIRECT_ORIGINS ?? '';
  if (!raw.trim()) return [];
  if (!extraCache || extraCache.raw !== raw) extraCache = { raw, map: parseExtraOrigins(raw) };
  return extraCache.map.get(appId) ?? [];
}

/** Every extra origin the operator allowed, all apps together (for the logout redirect). */
export function allExtraRedirectOrigins(): string[] {
  const raw = process.env.OAUTH_EXTRA_REDIRECT_ORIGINS ?? '';
  if (!raw.trim()) return [];
  if (!extraCache || extraCache.raw !== raw) extraCache = { raw, map: parseExtraOrigins(raw) };
  return [...extraCache.map.values()].flat();
}

// ── Relative paths (login / enrolment returnTo, logout) ─────────────────────

/**
 * A same-origin path: starts with exactly one '/', no backslash, no control
 * character. "//evil.example" and "/\evil.example" are protocol-relative for a
 * browser, hence refused.
 */
export function isSafeRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 2048
    && value[0] === '/'
    && value[1] !== '/'
    && !UNSAFE_URL_CHARS.test(value);
}

// ── Cross-app device paths (POST /api/devices/register) ──────────────────────

/**
 * A device path an app may register: it is appended to the app's base URL
 * (`${base_url}${app_path}`) and shown as a link by the OTHER apps, so it must
 * stay a plain path on that origin:
 *   - starts with a single '/'   ("@evil.example", ".evil.example" would move the host)
 *   - no '//' anywhere           (a client-side router may treat it as protocol-relative)
 *   - no '@', no '\'             (userinfo / backslash tricks)
 *   - no control char or space   (stripped or rewritten by browsers)
 *   - at most 1024 characters
 * A scheme cannot appear: the value starts with '/'.
 */
export function isSafeAppPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && value[0] === '/'
    && !value.includes('//')
    && !value.includes('@')
    && !UNSAFE_URL_CHARS.test(value);
}
