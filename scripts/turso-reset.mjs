// Deletes all rows from the Turso database (keeps the tables).
// Usage: set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, then: node scripts/turso-reset.mjs
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN first.');
  process.exit(1);
}
const db = createClient({ url, authToken });
for (const t of ['messages', 'conversation_members', 'conversations', 'login_codes', 'users']) {
  try {
    const r = await db.execute(`DELETE FROM ${t}`);
    console.log(`cleared ${t}: ${r.rowsAffected} rows`);
  } catch (e) {
    console.log(`skip ${t}: ${e.message}`);
  }
}
console.log('Turso reset done.');
