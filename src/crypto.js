// All cryptography, using only Node's built-in `node:crypto`.
//
//  - Login tokens:     compact HMAC-SHA256 signed token (JWT-like) with expiry + epoch
//  - Login codes:      6-digit one-time codes, stored only as a salted SHA-256 hash
//  - Messages at rest: AES-256-GCM (authenticated encryption) with the server key
//
// NOTE: messages are encrypted at rest and in transit, but the server CAN decrypt
// them (the chosen model). This is NOT end-to-end encryption.
import {
  randomBytes, timingSafeEqual,
  createHmac, createHash, createCipheriv, createDecipheriv,
} from 'node:crypto';
import { config } from './config.js';

// ---------- Login tokens ----------
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload) {
  const data = { ...payload, exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds };
  const body = b64url(JSON.stringify(data));
  const sig = b64url(createHmac('sha256', config.tokenSecret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = b64url(createHmac('sha256', config.tokenSecret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}

// ---------- Email login codes (one-time codes) ----------
export function generateOtp(length = config.otp.length) {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) code += (bytes[i] % 10).toString();
  return code;
}

// Codes are low-entropy, so they're protected by expiry + attempt limits. We still
// store only a hash, bound to the email and the server secret.
export const hashOtp = (email, code) =>
  createHash('sha256').update(`${String(email).toLowerCase()}:${code}:${config.tokenSecret}`).digest('hex');

export function checkOtp(email, code, storedHash) {
  const a = Buffer.from(hashOtp(email, code));
  const b = Buffer.from(String(storedHash || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- Message encryption at rest (AES-256-GCM) ----------
export function encryptMessage(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.messageKey, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function decryptMessage({ iv, ct, tag }) {
  const decipher = createDecipheriv('aes-256-gcm', config.messageKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}
