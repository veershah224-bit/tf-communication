// Database layer. Works two ways from the SAME code:
//   • Local (your PC):  Node's built-in SQLite (node:sqlite) — a file on disk.
//   • Hosted (cloud):   Turso (libSQL) over HTTP, when TURSO_DATABASE_URL is set.
// All functions are async so both paths share one interface (just `await` them).
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
export const useTurso = !!(TURSO_URL && TURSO_TOKEN);

let sqlite = null;
let turso = null;
const prepared = new Map();

if (useTurso) {
  const { createClient } = await import('@libsql/client'); // Node client: steady connection
  turso = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
} else {
  sqlite = new DatabaseSync(config.dbFile);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
}

// Serialize Turso queries: the single client connection can stall under concurrent
// in-flight requests, so we run them strictly one at a time (fast enough at this scale).
let tursoChain = Promise.resolve();
const tursoExec = (sql, args) => {
  const p = tursoChain.then(() => turso.execute({ sql, args }));
  tursoChain = p.then(() => {}, () => {});
  return p;
};

// ---- unified query helpers (positional ? args work on both engines) ----
function stmtFor(sql) {
  let st = prepared.get(sql);
  if (!st) { st = sqlite.prepare(sql); prepared.set(sql, st); }
  return st;
}
async function run(sql, args = []) {
  if (useTurso) {
    const r = await tursoExec(sql, args);
    return { lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : undefined, changes: Number(r.rowsAffected || 0) };
  }
  const info = stmtFor(sql).run(...args);
  return { lastInsertRowid: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : undefined, changes: info.changes };
}
async function get(sql, args = []) {
  if (useTurso) return (await tursoExec(sql, args)).rows[0];
  return stmtFor(sql).get(...args);
}
async function all(sql, args = []) {
  if (useTurso) return (await tursoExec(sql, args)).rows;
  return stmtFor(sql).all(...args);
}

// ---- schema ----
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
     is_admin INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
     token_epoch INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_codes (
     email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, display_name TEXT,
     expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS conversations (
     id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT, created_by INTEGER, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS conversation_members (
     conversation_id INTEGER NOT NULL, user_id INTEGER NOT NULL, joined_at INTEGER NOT NULL,
     last_read_message_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (conversation_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, sender_id INTEGER NOT NULL,
     iv TEXT NOT NULL, ct TEXT NOT NULL, tag TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id)`,
];
if (useTurso) { for (const s of SCHEMA) await turso.execute(s); }
else { sqlite.exec(SCHEMA.join(';\n')); }

const lc = (s) => String(s).toLowerCase();

// ---------- Users ----------
export async function createUser({ email, displayName, isAdmin }) {
  const info = await run(
    'INSERT INTO users (email, display_name, is_admin, is_active, token_epoch, created_at) VALUES (?, ?, ?, 1, 1, ?)',
    [lc(email), displayName, isAdmin ? 1 : 0, Date.now()],
  );
  return getUserById(Number(info.lastInsertRowid));
}
export const getUserByEmail = (email) => get('SELECT * FROM users WHERE email = ?', [lc(email)]);
export const getUserById = (id) => get('SELECT * FROM users WHERE id = ?', [id]);
export const listAllUsers = () => all('SELECT id, email, display_name, is_admin, is_active, created_at FROM users ORDER BY display_name COLLATE NOCASE');
export const listActiveUsers = () => all('SELECT id, email, display_name, is_admin FROM users WHERE is_active = 1 ORDER BY display_name COLLATE NOCASE');
export const countUsers = async () => Number((await get('SELECT COUNT(*) AS n FROM users')).n);
export const setUserActive = (id, active) => run('UPDATE users SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
export const setUserAdmin = (id, admin) => run('UPDATE users SET is_admin = ? WHERE id = ?', [admin ? 1 : 0, id]);
export const setUserDisplayName = (id, name) => run('UPDATE users SET display_name = ? WHERE id = ?', [name, id]);
export const bumpTokenEpoch = (id) => run('UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?', [id]);

// ---------- Login codes ----------
export const upsertLoginCode = ({ email, codeHash, displayName, expiresAt, sentAt }) =>
  run(`INSERT INTO login_codes (email, code_hash, display_name, expires_at, attempts, sent_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, display_name=excluded.display_name,
         expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at`,
      [lc(email), codeHash, displayName ?? null, expiresAt, sentAt]);
export const getLoginCode = (email) => get('SELECT * FROM login_codes WHERE email = ?', [lc(email)]);
export const incrementCodeAttempts = (email) => run('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?', [lc(email)]);
export const deleteLoginCode = (email) => run('DELETE FROM login_codes WHERE email = ?', [lc(email)]);

// ---------- Conversations ----------
export async function createConversation({ type, name, createdBy, memberIds }) {
  const info = await run('INSERT INTO conversations (type, name, created_by, created_at) VALUES (?, ?, ?, ?)', [type, name ?? null, createdBy ?? null, Date.now()]);
  const id = Number(info.lastInsertRowid);
  for (const uid of memberIds) await run('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', [id, uid, Date.now()]);
  return getConversation(id);
}
export const getConversation = (id) => get('SELECT * FROM conversations WHERE id = ?', [id]);
export const getMembers = (convId) => all('SELECT u.id, u.email, u.display_name FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? ORDER BY u.display_name COLLATE NOCASE', [convId]);
export const isMember = async (convId, userId) => !!(await get('SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [convId, userId]));
export const getConversationIdsForUser = async (userId) => (await all('SELECT conversation_id FROM conversation_members WHERE user_id = ?', [userId])).map((r) => r.conversation_id);
export async function findDirectConversation(a, b) {
  const r = await get(`SELECT c.id FROM conversations c
    JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
    JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
    WHERE c.type = 'direct' LIMIT 1`, [a, b]);
  return r ? r.id : null;
}

// ---------- Messages ----------
export async function insertMessage({ conversationId, senderId, enc }) {
  const ts = Date.now();
  const info = await run('INSERT INTO messages (conversation_id, sender_id, iv, ct, tag, created_at) VALUES (?, ?, ?, ?, ?, ?)', [conversationId, senderId, enc.iv, enc.ct, enc.tag, ts]);
  return { id: Number(info.lastInsertRowid), conversationId, senderId, created_at: ts };
}
export const getMessages = async (convId, limit = 100) => (await all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?', [convId, limit])).reverse();
export const getLastMessage = (convId) => get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [convId]);
export const getUnreadCount = async (convId, userId) => Number((await get(
  `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?
     AND id > (SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?)
     AND sender_id != ?`, [convId, convId, userId, userId])).n);
export async function markRead(convId, userId) {
  const maxId = Number((await get('SELECT COALESCE(MAX(id), 0) AS maxId FROM messages WHERE conversation_id = ?', [convId])).maxId);
  await run('UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?', [maxId, convId, userId]);
  return maxId;
}
