import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { config } from '../config';

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Constant-time string equality. Both sides are hashed first so the buffers
 * handed to timingSafeEqual always have the same length (it throws otherwise),
 * which also keeps the length of the secret out of the timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Storage markers of a secret sealed with sealSecret() (self-describing). */
const SEAL_ENCRYPTED = 'enc:aes-256-gcm:';
const SEAL_PLAINTEXT = 'plain:';

/** True when ENCRYPTION_KEY holds a usable AES-256 key (32 bytes in hex). */
export function encryptionKeyConfigured(): boolean {
  return /^[0-9a-fA-F]{64}$/.test(config.encryptionKey);
}

/**
 * Seal a secret Obligate must be able to read back in clear (it presents it to
 * someone else, e.g. an app's inbound secret): AES-256-GCM with ENCRYPTION_KEY
 * when one is configured, else stored as is with a 'plain:' marker (the API
 * keys next to it are stored in clear anyway; a homemade cipher keyed off
 * something guessable would only look like protection).
 */
export function sealSecret(secret: string): string {
  return encryptionKeyConfigured() ? SEAL_ENCRYPTED + encrypt(secret) : SEAL_PLAINTEXT + secret;
}

/** Inverse of sealSecret(). Throws on an unknown format or when ENCRYPTION_KEY changed. */
export function unsealSecret(stored: string): string {
  if (stored.startsWith(SEAL_ENCRYPTED)) return decrypt(stored.slice(SEAL_ENCRYPTED.length));
  if (stored.startsWith(SEAL_PLAINTEXT)) return stored.slice(SEAL_PLAINTEXT.length);
  throw new Error('unrecognised sealed secret format');
}

/**
 * Strict positive integer from untrusted input (JSON body, query, params).
 *
 * Accepted: a JSON number that is a safe integer > 0, or its canonical decimal
 * string ("42"). Everything else is refused (null): "042", "42 ", " 42",
 * "4.2e1", "+42", "42.0", arrays, objects, booleans. Every accepted value has
 * exactly ONE form, so a counter or cache keyed by the result cannot be
 * sidestepped by spelling the same id differently (PostgreSQL would still cast
 * "042" or "42 " to 42 in a WHERE clause).
 */
export function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Encrypt a string with AES-256-GCM (for LDAP bind passwords at rest).
 */
export function encrypt(plaintext: string): string {
  const key = Buffer.from(config.encryptionKey, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a string encrypted with encrypt().
 */
export function decrypt(encoded: string): string {
  const key = Buffer.from(config.encryptionKey, 'hex');
  const [ivHex, tagHex, ciphertextHex] = encoded.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
