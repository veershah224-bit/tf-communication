// End-to-end smoke test for the email-code login + admin + chat.
// Run the server first (npm start, in TEST MODE), then: node test/smoke.mjs
import { io } from 'socket.io-client';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const H = { 'Content-Type': 'application/json' };
const log = (...a) => console.log('•', ...a);
const fail = (m) => { console.error('✗ FAIL:', m); process.exit(1); };
const post = async (path, body, token) => {
  const headers = { ...H, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const get = async (path, token) => {
  const res = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

// Log in with the email one-time-code (relies on TEST MODE returning devCode).
async function loginOtp(email, name) {
  const r1 = await post('/api/auth/request-code', { email, displayName: name });
  if (!r1.data.ok) fail(`request-code failed for ${email}: ${JSON.stringify(r1)}`);
  if (!r1.data.devCode) fail('No devCode — is the server in TEST MODE (no SMTP)? This test needs test mode.');
  const r2 = await post('/api/auth/verify-code', { email, code: r1.data.devCode });
  if (r2.status !== 200 || !r2.data.token) fail(`verify-code failed for ${email}: ${JSON.stringify(r2)}`);
  return r2.data; // { token, user }
}

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const emit = (s, ev, payload) => new Promise((res) => s.emit(ev, payload, res));
const once = (s, ev, timeout = 3000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timed out waiting for "${ev}"`)), timeout);
    s.once(ev, (d) => { clearTimeout(t); res(d); });
  });

const stamp = `${Date.now()}`.slice(-6);
const run = async () => {
  const adminEmail = `admin${stamp}@example.com`;
  const bobEmail = `bob${stamp}@example.com`;
  const outsiderEmail = `nobody${stamp}@example.com`;

  // 1) First user becomes admin.
  const admin = await loginOtp(adminEmail, 'Admin Boss');
  if (!admin.user.isAdmin) fail('first user should be admin');
  log(`first user is admin: ${admin.user.email}`);

  // 2) Wrong code is rejected.
  await post('/api/auth/request-code', { email: adminEmail });
  const wrong = await post('/api/auth/verify-code', { email: adminEmail, code: '000000' });
  if (wrong.status === 200) fail('wrong code was accepted!');
  log(`wrong code rejected (status ${wrong.status})`);

  // 3) Sign-up is closed: an un-added email cannot get a code.
  const blocked = await post('/api/auth/request-code', { email: outsiderEmail, displayName: 'Sneaky' });
  if (blocked.status !== 403) fail(`outsider should be blocked (got ${blocked.status})`);
  log('closed sign-up works: un-added email blocked');

  // 4) Admin adds a staff member; staff can then log in.
  const added = await post('/api/admin/users', { email: bobEmail, displayName: 'Bob Staff' }, admin.token);
  if (added.status !== 200) fail(`admin add-user failed: ${JSON.stringify(added)}`);
  const bob = await loginOtp(bobEmail, '');
  if (bob.user.isAdmin) fail('added staff should NOT be admin');
  log(`admin added staff and they logged in: ${bob.user.email}`);

  // 5) Non-admin cannot use admin endpoints.
  const denied = await get('/api/admin/users', bob.token);
  if (denied.status !== 403) fail(`non-admin reached admin endpoint (got ${denied.status})`);
  log('admin endpoints are admin-only');

  // 6) Real-time chat between the two.
  const sa = await connect(admin.token);
  const sb = await connect(bob.token);
  const presence = await once(sa, 'presence:list');
  if (!presence.includes(bob.user.id)) fail('presence missing the other user');
  log(`both connected; presence works (${presence.join(', ')})`);

  const opened = await emit(sa, 'direct:open', { userId: bob.user.id });
  if (!opened.conversationId) fail('direct:open failed');
  const incoming = once(sb, 'message:new');
  const text = 'Hello via email-code login 👋';
  await emit(sa, 'message:send', { conversationId: opened.conversationId, text });
  const got = await incoming;
  if (got.text !== text) fail(`bad delivery: ${got.text}`);
  log(`real-time delivery works: "${got.text}"`);

  const grp = await emit(sa, 'group:create', { name: 'Team', memberIds: [bob.user.id] });
  if (!grp.ok) fail('group create failed');
  log(`group chat works (#${grp.conversationId})`);

  // 7) Log out everywhere invalidates the old token.
  await post('/api/logout-everywhere', {}, bob.token);
  const after = await get('/api/me', bob.token);
  if (after.status === 200) fail('token still valid after log-out-everywhere!');
  log(`log out everywhere works (old token now ${after.status})`);

  sa.close(); sb.close();
  console.log('\n✓ ALL CHECKS PASSED\n');
  process.exit(0);
};

run().catch((e) => fail(e.message));
