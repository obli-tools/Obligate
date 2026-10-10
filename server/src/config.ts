export const config = {
  port: parseInt(process.env.PORT || '3010', 10),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5174',
  sessionSecret: process.env.SESSION_SECRET || 'obligate-dev-secret-change-in-production',
  sessionMaxAge: parseInt(process.env.SESSION_MAX_AGE || '86400000', 10), // 24h
  defaultAdminUsername: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
  defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || 'admin',
  encryptionKey: process.env.ENCRYPTION_KEY || '', // AES-256-GCM key for LDAP bind passwords
};
