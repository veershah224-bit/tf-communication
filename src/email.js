// Sends login codes by email. If SMTP isn't configured, runs in TEST MODE:
// the code is printed in the server window and returned to the page so you can
// still log in while testing (no real email is sent).
import { config, emailConfigured } from './config.js';

let transportPromise = null;
async function getTransport() {
  if (!emailConfigured) return null;
  if (!transportPromise) {
    const { default: nodemailer } = await import('nodemailer');
    transportPromise = Promise.resolve(
      nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: { user: config.smtp.user, pass: config.smtp.pass },
      }),
    );
  }
  return transportPromise;
}

export async function sendLoginCode(email, code) {
  const minutes = Math.round(config.otp.ttlSeconds / 60);
  const transport = await getTransport();

  if (!transport) {
    console.log(`\n  [TEST MODE] Login code for ${email}: ${code}  (expires in ${minutes} min)`);
    console.log('  Configure SMTP_* settings to send real emails instead.\n');
    return { delivered: false };
  }

  await transport.sendMail({
    from: config.smtp.from,
    to: email,
    subject: 'Your TF Communication login code',
    text: `Your login code is ${code}\nIt expires in ${minutes} minutes.\nIf you didn't request this, you can ignore this email.`,
    html:
      `<div style="font-family:Arial,sans-serif;max-width:420px">
         <h2 style="color:#075e54;margin:0 0 8px">TF Communication</h2>
         <p>Your login code is:</p>
         <p style="font-size:30px;font-weight:bold;letter-spacing:6px;color:#111">${code}</p>
         <p style="color:#666">It expires in ${minutes} minutes. If you didn't request this, ignore this email.</p>
       </div>`,
  });
  return { delivered: true };
}
