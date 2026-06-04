// TF Communication — server (Express HTTP + Socket.IO real-time).
import express from 'express';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { config, emailConfigured, uploadsEnabled } from './config.js';
import * as store from './db.js';
import {
  signToken, verifyToken, encryptMessage, decryptMessage,
  generateOtp, hashOtp, checkOtp,
} from './crypto.js';
import { sendLoginCode } from './email.js';

const app = express();
app.disable('x-powered-by');
// Behind a host's proxy (Render/Railway/Fly/Nginx/Caddy), trust it so rate limiting
// sees real visitor IPs. Enable by setting TRUST_PROXY=1 on the host.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------- security headers ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self' ws: wss:; base-uri 'self'; form-action 'self'",
  );
  next();
});

// Serve the web app. `no-cache` makes browsers re-check each file, so an updated
// app is picked up on the next load instead of a stale copy lingering.
app.use(express.static(config.publicDir, {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Wrap an async route so a rejected promise becomes a clean 500 instead of crashing.
const ah = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error('[route]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on the server.' });
  });

// ------------------------------------------------------------------ helpers ----
const publicUser = (u) =>
  u ? { id: u.id, email: u.email, displayName: u.display_name, isAdmin: !!u.is_admin } : null;
const norm = (s) => String(s || '').trim();
const normEmail = (s) => norm(s).toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Only accept attachments that point at our own Cloudinary storage.
function sanitizeAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const url = String(a.url || '');
  if (!/^https:\/\/res\.cloudinary\.com\//.test(url)) return null;
  const type = ['image', 'video', 'raw'].includes(a.type) ? a.type : 'raw';
  return {
    url,
    type,
    name: String(a.name || 'file').slice(0, 200),
    size: Number(a.size) || 0,
    format: String(a.format || '').slice(0, 12),
  };
}

function decodeMessageRow(row) {
  let text = '';
  let attachment = null;
  try {
    const raw = decryptMessage({ iv: row.iv, ct: row.ct, tag: row.tag });
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && ('text' in o || 'attachment' in o)) {
        text = o.text || '';
        attachment = o.attachment || null;
      } else {
        text = raw; // legacy plain-text message
      }
    } catch {
      text = raw; // legacy plain-text message
    }
  } catch {
    text = '[unable to decrypt]';
  }
  return { id: row.id, conversationId: row.conversation_id, senderId: row.sender_id, text, attachment, createdAt: row.created_at };
}

async function conversationSummary(convId, userId) {
  const conv = await store.getConversation(convId);
  if (!conv) return null;
  const members = await store.getMembers(convId);

  let name = conv.name;
  let otherUserId = null;
  if (conv.type === 'direct') {
    const other = members.find((m) => m.id !== userId) || members[0];
    name = other ? other.display_name : 'Direct chat';
    otherUserId = other ? other.id : null;
  }

  const last = await store.getLastMessage(convId);
  let lastMessage = null;
  if (last) {
    const d = decodeMessageRow(last);
    let preview = d.text;
    if (d.attachment) {
      const label = d.attachment.type === 'image' ? '📷 Photo'
        : d.attachment.type === 'video' ? '🎥 Video'
          : `📎 ${d.attachment.name || 'File'}`;
      preview = d.text ? `${label} · ${d.text}` : label;
    }
    lastMessage = { text: preview, senderId: d.senderId, createdAt: d.createdAt };
  }

  return {
    id: conv.id,
    type: conv.type,
    name,
    otherUserId,
    memberIds: members.map((m) => m.id),
    members: members.map((m) => ({ id: m.id, displayName: m.display_name, email: m.email })),
    lastMessage,
    unread: await store.getUnreadCount(convId, userId),
    updatedAt: lastMessage ? lastMessage.createdAt : conv.created_at,
  };
}

async function listConversations(userId) {
  const ids = await store.getConversationIdsForUser(userId);
  const list = (await Promise.all(ids.map((id) => conversationSummary(id, userId)))).filter(Boolean);
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ----------------------------------------------------------------- presence ---
const online = new Map();
function setOnline(userId, socketId) {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(socketId);
}
function setOffline(userId, socketId) {
  const set = online.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) online.delete(userId);
}
const onlineUserIds = () => [...online.keys()];

// --------------------------------------------------------------- auth tokens ---
async function userFromToken(token) {
  const data = verifyToken(token);
  if (!data) return null;
  const user = await store.getUserById(data.uid);
  if (!user || !user.is_active) return null;
  if (data.epoch !== user.token_epoch) return null;
  return user;
}
const bearer = (req) => {
  const a = req.headers.authorization || '';
  return a.startsWith('Bearer ') ? a.slice(7) : '';
};
async function requireAuth(req, res, next) {
  try {
    const user = await userFromToken(bearer(req));
    if (!user) return res.status(401).json({ error: 'Please sign in again.' });
    req.user = user;
    next();
  } catch (err) {
    console.error('[requireAuth]', err);
    res.status(401).json({ error: 'Please sign in again.' });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admins only.' });
  next();
}

// ------------------------------------------------------------- rate limiting ---
const rl = { byEmail: new Map(), byIp: new Map() };
function withinLimit(map, key, windowMs, max) {
  const now = Date.now();
  const e = map.get(key);
  if (!e || now - e.start > windowMs) { map.set(key, { start: now, count: 1 }); return true; }
  e.count += 1;
  return e.count <= max;
}
const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

// --------------------------------------------------------------- auth routes ---
app.post('/api/auth/request-code', ah(async (req, res) => {
  const email = normEmail(req.body?.email);
  const displayName = norm(req.body?.displayName);
  if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  if (!withinLimit(rl.byIp, clientIp(req), 60 * 60 * 1000, 30)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a while and try again.' });
  }
  if (!withinLimit(rl.byEmail, email, 60 * 60 * 1000, 6)) {
    return res.status(429).json({ error: 'Too many codes requested for this email. Try again later.' });
  }

  const existing = await store.getUserByEmail(email);
  const isFirstUser = (await store.countUsers()) === 0;
  const allowed = (existing && existing.is_active) || isFirstUser || config.allowOpenRegistration;
  if (!allowed) {
    return res.status(403).json({ error: 'This email is not set up yet. Please ask your admin to add you.' });
  }

  const isNew = !existing;
  if (isNew && !displayName) return res.json({ ok: true, needName: true });

  const prev = await store.getLoginCode(email);
  if (prev && Date.now() - prev.sent_at < config.otp.resendCooldownSeconds * 1000) {
    const wait = Math.ceil((config.otp.resendCooldownSeconds * 1000 - (Date.now() - prev.sent_at)) / 1000);
    return res.status(429).json({ error: `Please wait ${wait} seconds before requesting another code.` });
  }

  const code = generateOtp();
  await store.upsertLoginCode({
    email,
    codeHash: hashOtp(email, code),
    displayName: isNew ? (displayName || email.split('@')[0]) : null,
    expiresAt: Date.now() + config.otp.ttlSeconds * 1000,
    sentAt: Date.now(),
  });

  const result = await sendLoginCode(email, code);
  res.json({ ok: true, emailed: result.delivered, testMode: !result.delivered, ...(result.delivered ? {} : { devCode: code }) });
}));

app.post('/api/auth/verify-code', ah(async (req, res) => {
  const email = normEmail(req.body?.email);
  const code = norm(req.body?.code);
  if (!validEmail(email) || !code) return res.status(400).json({ error: 'Enter the code we sent you.' });

  const rec = await store.getLoginCode(email);
  if (!rec) return res.status(400).json({ error: 'No code found. Please request a new one.' });
  if (Date.now() > rec.expires_at) {
    await store.deleteLoginCode(email);
    return res.status(400).json({ error: 'That code expired. Please request a new one.' });
  }
  if (rec.attempts >= config.otp.maxAttempts) {
    await store.deleteLoginCode(email);
    return res.status(429).json({ error: 'Too many wrong tries. Please request a new code.' });
  }
  if (!checkOtp(email, code, rec.code_hash)) {
    await store.incrementCodeAttempts(email);
    return res.status(401).json({ error: 'Wrong code. Please check and try again.' });
  }

  await store.deleteLoginCode(email);
  let user = await store.getUserByEmail(email);
  if (!user) {
    const isAdmin = (await store.countUsers()) === 0;
    user = await store.createUser({ email, displayName: rec.display_name || email.split('@')[0], isAdmin });
    await broadcastUsers();
  }
  if (!user.is_active) return res.status(403).json({ error: 'Your account is disabled. Contact your admin.' });

  res.json({ token: signToken({ uid: user.id, epoch: user.token_epoch }), user: publicUser(user) });
}));

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// Tells the browser whether file sharing is available (so it shows the 📎 button).
app.get('/api/config', (req, res) => res.json({ uploadsEnabled }));

// Signs a short-lived Cloudinary upload so the browser can upload directly.
app.post('/api/upload-signature', requireAuth, (req, res) => {
  if (!uploadsEnabled) return res.status(503).json({ error: 'File sharing is not set up yet.' });
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'tf-communication';
  const signature = createHash('sha1')
    .update(`folder=${folder}&timestamp=${timestamp}${config.cloudinary.apiSecret}`)
    .digest('hex');
  res.json({ cloudName: config.cloudinary.cloudName, apiKey: config.cloudinary.apiKey, timestamp, folder, signature });
});

app.post('/api/logout-everywhere', requireAuth, ah(async (req, res) => {
  await store.bumpTokenEpoch(req.user.id);
  disconnectUserSockets(req.user.id);
  res.json({ ok: true });
}));

// -------------------------------------------------------------- admin routes ---
app.get('/api/admin/users', requireAuth, requireAdmin, ah(async (req, res) => {
  const users = await store.listAllUsers();
  res.json({
    users: users.map((u) => ({
      id: u.id, email: u.email, displayName: u.display_name, isAdmin: !!u.is_admin, isActive: !!u.is_active,
    })),
  });
}));

app.post('/api/admin/users', requireAuth, requireAdmin, ah(async (req, res) => {
  const email = normEmail(req.body?.email);
  const displayName = norm(req.body?.displayName);
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!displayName) return res.status(400).json({ error: "Enter the person's name." });
  if (await store.getUserByEmail(email)) return res.status(409).json({ error: 'Someone with that email already exists.' });
  const user = await store.createUser({ email, displayName, isAdmin: false });
  await broadcastUsers();
  res.json({ user: publicUser(user) });
}));

app.post('/api/admin/users/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const target = await store.getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (typeof req.body?.isActive === 'boolean') {
    if (!req.body.isActive && target.id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account.' });
    await store.setUserActive(id, req.body.isActive);
    if (!req.body.isActive) { await store.bumpTokenEpoch(id); disconnectUserSockets(id); }
  }
  if (typeof req.body?.isAdmin === 'boolean') {
    if (!req.body.isAdmin && target.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own admin rights.' });
    await store.setUserAdmin(id, req.body.isAdmin);
  }
  await broadcastUsers();
  res.json({ ok: true });
}));

// ----------------------------------------------------------------- realtime ---
const httpServer = createServer(app);
const io = new Server(httpServer);

io.use(async (socket, next) => {
  try {
    const user = await userFromToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('unauthorized'));
    socket.userId = user.id;
    socket.user = publicUser(user);
    next();
  } catch (err) {
    next(new Error('unauthorized'));
  }
});

const emitToUser = (userId, event, payload) => io.to(`user:${userId}`).emit(event, payload);
const pushConversations = async (userId) => emitToUser(userId, 'conversations:list', await listConversations(userId));
async function broadcastUsers() {
  const users = await store.listActiveUsers();
  io.emit('users:list', users.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name })));
}
const broadcastPresence = () => io.emit('presence:list', onlineUserIds());
function disconnectUserSockets(userId) {
  for (const s of io.sockets.sockets.values()) if (s.userId === userId) s.disconnect(true);
}

io.on('connection', async (socket) => {
  const uid = socket.userId;
  socket.join(`user:${uid}`);
  setOnline(uid, socket.id);

  socket.emit('conversations:list', await listConversations(uid));
  await broadcastUsers();
  broadcastPresence();

  const on = (event, handler) =>
    socket.on(event, async (payload, ack) => {
      try {
        await handler(payload, typeof ack === 'function' ? ack : () => {});
      } catch (err) {
        console.error(`[socket:${event}]`, err);
        if (typeof ack === 'function') ack({ error: 'Something went wrong on the server.' });
      }
    });

  on('conversation:open', async (payload, ack) => {
    const convId = Number(payload?.conversationId);
    if (!(await store.isMember(convId, uid))) return ack({ error: 'Not allowed.' });
    await store.markRead(convId, uid);
    const [messages, members] = await Promise.all([store.getMessages(convId), store.getMembers(convId)]);
    ack({
      conversationId: convId,
      messages: messages.map(decodeMessageRow),
      members: members.map((m) => ({ id: m.id, displayName: m.display_name, email: m.email })),
    });
    await pushConversations(uid);
  });

  on('conversation:read', async (payload) => {
    const convId = Number(payload?.conversationId);
    if (!(await store.isMember(convId, uid))) return;
    await store.markRead(convId, uid);
    await pushConversations(uid);
  });

  on('message:send', async (payload, ack) => {
    const convId = Number(payload?.conversationId);
    const text = String(payload?.text || '').trim();
    const attachment = sanitizeAttachment(payload?.attachment);
    if (!text && !attachment) return ack({ error: 'Empty message.' });
    if (text.length > 4000) return ack({ error: 'Message is too long (max 4000 characters).' });
    if (!(await store.isMember(convId, uid))) return ack({ error: 'Not allowed.' });

    const enc = encryptMessage(JSON.stringify({ text, attachment }));
    const saved = await store.insertMessage({ conversationId: convId, senderId: uid, enc });
    const msg = { id: saved.id, conversationId: convId, senderId: uid, text, attachment, createdAt: saved.created_at };
    const members = await store.getMembers(convId);
    for (const m of members) {
      emitToUser(m.id, 'message:new', msg);
      await pushConversations(m.id);
    }
    ack({ ok: true, message: msg });
  });

  on('group:create', async (payload, ack) => {
    const name = String(payload?.name || '').trim();
    const memberIds = Array.isArray(payload?.memberIds) ? payload.memberIds.map(Number).filter(Boolean) : [];
    if (!name) return ack({ error: 'Please give the group a name.' });
    const unique = [...new Set([uid, ...memberIds])];
    if (unique.length < 2) return ack({ error: 'Add at least one other member.' });
    const conv = await store.createConversation({ type: 'group', name, createdBy: uid, memberIds: unique });
    for (const m of unique) await pushConversations(m);
    ack({ ok: true, conversationId: conv.id });
  });

  on('direct:open', async (payload, ack) => {
    const otherId = Number(payload?.userId);
    if (!otherId || otherId === uid) return ack({ error: 'Pick a valid person.' });
    if (!(await store.getUserById(otherId))) return ack({ error: 'User not found.' });
    let convId = await store.findDirectConversation(uid, otherId);
    if (!convId) {
      convId = (await store.createConversation({ type: 'direct', name: null, createdBy: uid, memberIds: [uid, otherId] })).id;
      await pushConversations(otherId);
    }
    await pushConversations(uid);
    ack({ ok: true, conversationId: convId });
  });

  on('typing', async (payload) => {
    const convId = Number(payload?.conversationId);
    if (!(await store.isMember(convId, uid))) return;
    const isTyping = !!payload?.isTyping;
    const members = await store.getMembers(convId);
    for (const m of members) {
      if (m.id !== uid) emitToUser(m.id, 'typing', { conversationId: convId, userId: uid, displayName: socket.user.displayName, isTyping });
    }
  });

  socket.on('disconnect', () => {
    setOffline(uid, socket.id);
    broadcastPresence();
  });
});

httpServer.listen(config.port, () => {
  const lanIps = Object.values(os.networkInterfaces())
    .flat()
    .filter((ni) => ni && ni.family === 'IPv4' && !ni.internal)
    .map((ni) => ni.address);
  console.log('\n  ============================================================');
  console.log('    TF Communication is running.');
  console.log('  ============================================================');
  console.log(`    On this computer:     http://localhost:${config.port}`);
  for (const ip of lanIps) console.log(`    Staff on your Wi-Fi:  http://${ip}:${config.port}`);
  console.log('  ------------------------------------------------------------');
  console.log(`    Database:     ${store.useTurso ? 'Turso (cloud)' : 'local file (node:sqlite)'}`);
  console.log(`    Login email:  ${emailConfigured ? 'real email (SMTP configured)' : 'TEST MODE (codes show on screen + here)'}`);
  console.log('    Keep this window open while staff are using the app.');
  console.log('  ============================================================\n');
});
