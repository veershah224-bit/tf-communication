// Central configuration + secret-key management.
// Secrets are generated once on first run and saved to data/secrets.json so that
// restarts keep working AND previously-encrypted messages can still be decrypted.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// Where the database + secret keys live. Override with the DATA_DIR env var to
// point at a PERSISTENT disk/volume when hosting (e.g. DATA_DIR=/data).
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, 'data');
const SECRETS_FILE = join(DATA_DIR, 'secrets.json');

mkdirSync(DATA_DIR, { recursive: true });

// Secrets: prefer environment variables (so a hosted server keeps the same keys
// across restarts even with no permanent disk); otherwise generate + save locally.
let tokenSecret = process.env.TOKEN_SECRET;
let messageKeyHex = process.env.MESSAGE_KEY;
if (!tokenSecret || !messageKeyHex) {
  let secrets;
  if (existsSync(SECRETS_FILE)) {
    secrets = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
  } else {
    secrets = {
      tokenSecret: randomBytes(32).toString('hex'), // signs login tokens
      messageKey: randomBytes(32).toString('hex'),  // AES-256 key for messages at rest
    };
    writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
    console.log('[config] Generated new secrets at data/secrets.json - keep this file safe and backed up.');
  }
  tokenSecret = tokenSecret || secrets.tokenSecret;
  messageKeyHex = messageKeyHex || secrets.messageKey;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  root: ROOT,
  dataDir: DATA_DIR,
  publicDir: join(ROOT, 'public'),
  dbFile: join(DATA_DIR, 'app.sqlite'),
  tokenSecret,
  messageKey: Buffer.from(messageKeyHex, 'hex'),
  tokenTtlSeconds: 30 * 24 * 3600, // stay logged in for 30 days

  // Sign-up policy. When false (default), only the FIRST user (who becomes admin)
  // and people the admin has added can sign in. Set ALLOW_OPEN_REGISTRATION=true to
  // let anyone with a valid email create their own account.
  allowOpenRegistration: process.env.ALLOW_OPEN_REGISTRATION === 'true',

  // Email one-time-code (OTP) login.
  otp: {
    length: 6,
    ttlSeconds: 10 * 60,        // code valid for 10 minutes
    maxAttempts: 5,             // wrong tries before the code is killed
    resendCooldownSeconds: 30,  // minimum gap between sending codes
  },

  // SMTP for emailing login codes. If not fully configured, the app runs in
  // TEST MODE: the code is shown on screen and printed in the server window.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'TF Communication <no-reply@tf.local>',
  },

  // Cloudinary stores shared photos/videos/files (free tier). Files upload from the
  // browser straight to Cloudinary using a short-lived signature from the server.
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },
};

// "Real email" is on if Brevo's web API key is set (works on hosts that block SMTP,
// e.g. Render free), or if full SMTP is configured (works locally).
export const emailConfigured = Boolean(
  process.env.BREVO_API_KEY || (config.smtp.host && config.smtp.user && config.smtp.pass),
);

// File sharing is available when Cloudinary is fully configured.
export const uploadsEnabled = Boolean(
  config.cloudinary.cloudName && config.cloudinary.apiKey && config.cloudinary.apiSecret,
);
