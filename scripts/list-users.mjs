// Quick diagnostic: list all accounts in the database.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/app.sqlite');
const users = db.prepare('SELECT id, email, display_name, is_admin, is_active, created_at FROM users ORDER BY id').all();
for (const u of users) {
  const tags = `${u.is_admin ? ' [admin]' : ''}${u.is_active ? '' : ' [disabled]'}`;
  console.log(`#${u.id}  ${u.email}  "${u.display_name}"${tags}  ${new Date(u.created_at).toLocaleString()}`);
}
console.log('total users:', users.length);
