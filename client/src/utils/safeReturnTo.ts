/**
 * `returnTo` is followed after sign-in and enrolment. Only same-origin paths
 * are accepted (the server only ever builds `/api/oauth/authorize?...` ones),
 * so a crafted `/login?returnTo=https://...` link cannot bounce a user who just
 * typed their password and code to another site ("//host" and "/\host" are
 * protocol-relative for a browser, `javascript:` does not start with '/').
 */
export function safeReturnTo(raw: string | null): string | null {
  if (!raw || raw.length > 4096) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  return raw;
}
