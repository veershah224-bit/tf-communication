// Verifies the Gmail App Password works by connecting and sending a test email.
// Usage: set TEST_SMTP_PASS, then: node scripts/test-email.mjs
import nodemailer from 'nodemailer';

const user = 'tfxautomation@gmail.com';
const pass = process.env.TEST_SMTP_PASS;
if (!pass) { console.log('No TEST_SMTP_PASS set.'); process.exit(1); }

const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, auth: { user, pass } });
try {
  await t.verify();
  console.log('AUTH OK — Gmail accepted the app password.');
  const info = await t.sendMail({
    from: `TF Communication <${user}>`,
    to: user,
    subject: 'TF Communication — email test ✅',
    text: 'Success! Your app can now email login codes to staff.',
  });
  console.log('SENT OK — check the tfxautomation@gmail.com inbox. id:', info.messageId || '(sent)');
} catch (e) {
  console.log('EMAIL FAILED:', e.message);
  process.exit(1);
}
