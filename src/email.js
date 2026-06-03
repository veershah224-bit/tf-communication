// Sends login codes by email, in this order of preference:
//   1) Brevo web API  — works on hosts that BLOCK outgoing SMTP (e.g. Render free).
//   2) SMTP           — works locally / on hosts that allow SMTP.
//   3) TEST MODE      — no email configured: code is shown on screen + in the log.
import { config, emailConfigured } from './config.js';

function buildContent(code) {
  const minutes = Math.round(config.otp.ttlSeconds / 60);
  return {
    subject: 'Your TF Communication login code',
    text: `Your login code is ${code}\nIt expires in ${minutes} minutes.\nIf you didn't request this, you can ignore this email.`,
    html:
      `<div style="font-family:Arial,sans-serif;max-width:420px">
         <h2 style="color:#075e54;margin:0 0 8px">TF Communication</h2>
         <p>Your login code is:</p>
         <p style="font-size:30px;font-weight:bold;letter-spacing:6px;color:#111">${code}</p>
         <p style="color:#666">It expires in ${minutes} minutes. If you didn't request this, ignore this email.</p>
       </div>`,
  };
}

// 1) Brevo web API (HTTPS — not blocked by SMTP-restricted hosts)
async function sendViaBrevo(email, c) {
  const sender = process.env.BREVO_SENDER || config.smtp.user || 'no-reply@tf.local';
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: sender, name: 'TF Communication' },
      to: [{ email }],
      subject: c.subject,
      htmlContent: c.html,
      textContent: c.text,
    }),
  });
  if (!res.ok) throw new Error(`Brevo send failed (${res.status}): ${await res.text().catch(() => '')}`);
  return { delivered: true };
}

// 2) SMTP via nodemailer (forced IPv4 + short timeouts so it fails fast if blocked)
let transportPromise = null;
async function sendViaSmtp(email, c) {
  if (!transportPromise) {
    const { default: nodemailer } = await import('nodemailer');
    transportPromise = Promise.resolve(
      nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: { user: config.smtp.user, pass: config.smtp.pass },
        family: 4,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
      }),
    );
  }
  const t = await transportPromise;
  await t.sendMail({ from: config.smtp.from, to: email, subject: c.subject, text: c.text, html: c.html });
  return { delivered: true };
}

export async function sendLoginCode(email, code) {
  const content = buildContent(code);

  if (process.env.BREVO_API_KEY) return sendViaBrevo(email, content);

  const smtpReady = config.smtp.host && config.smtp.user && config.smtp.pass;
  if (smtpReady) return sendViaSmtp(email, content);

  const minutes = Math.round(config.otp.ttlSeconds / 60);
  console.log(`\n  [TEST MODE] Login code for ${email}: ${code}  (expires in ${minutes} min)`);
  console.log('  Set BREVO_API_KEY (recommended on free hosting) or SMTP_* to send real emails.\n');
  return { delivered: false };
}
