// Generates the two secret keys your hosted server needs, and saves them to
// DEPLOY_SECRETS.txt (which is git-ignored so it never leaves your computer).
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const tokenSecret = randomBytes(32).toString('hex');
const messageKey = randomBytes(32).toString('hex');

const content = `YOUR TF COMMUNICATION SERVER KEYS — keep these private, do not share.
Paste each into your host's Environment Variables when asked.

TOKEN_SECRET=${tokenSecret}
MESSAGE_KEY=${messageKey}
`;

writeFileSync('DEPLOY_SECRETS.txt', content);
console.log(content);
console.log('Saved to DEPLOY_SECRETS.txt');
