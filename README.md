# TF Communication

A small, secure team messenger you run yourself. Built for ~10–15 staff.
Web-based (any browser, PC or phone), with **email one-time-code login** (no
passwords), **admin-managed staff**, group + direct chats, real-time delivery,
online presence, typing indicators, and unread badges.

## How to run it

Double-click **`Start TF Communication.bat`** (keep the window open), or in a
terminal:

```powershell
npm install   # first time only
npm start
```

Then open **http://localhost:3000**. The window prints the link to share with
staff on your Wi-Fi (e.g. `http://192.168.1.16:3000`).

## Signing in (email code)

1. Enter your email → you get a **6-digit code** → enter it. No password.
2. The **first person to sign in becomes the admin**.
3. **In test mode** (no email server set up yet) the code is shown on screen and
   printed in the server window — so you can use it right away.

## Adding staff (admin)

Admin → top-right **⋮ menu → Manage staff**:
- **Add** a person by name + email. They sign in with that email (no password).
- **Disable/Enable** or **Make/Remove admin** anyone.
- Public sign-up is **closed** by default: only the admin's added staff (and the
  first user) can sign in. Set `ALLOW_OPEN_REGISTRATION=true` to let anyone join.

## Sending real email codes (instead of test mode)

Set these environment variables before `npm start` (example for Gmail with an
[App Password](https://support.google.com/accounts/answer/185833)):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=youraddress@gmail.com
SMTP_PASS=your-16-char-app-password
SMTP_FROM=TF Communication <youraddress@gmail.com>
```

When SMTP is set, codes are emailed and no longer shown on screen.

## Security

- **Login codes**: 6 digits, expire in 10 min, max 5 tries, rate-limited per
  email and per IP. Stored only as a salted hash.
- **Tokens**: HMAC-signed, 30-day expiry, with a per-user epoch — **"Log out
  everywhere"** (⋮ menu) instantly invalidates all of a user's logins; disabling
  a user does the same.
- **Messages**: stored AES-256-GCM **encrypted** at rest.
- **HTTP**: security headers + Content-Security-Policy.
- This is "encrypted at rest + in transit"; the server can still decrypt
  messages — it is **not** end-to-end encryption.
- Run behind **HTTPS** before using over the internet.
- **Back up** the `data/` folder — it holds the database **and** the encryption
  keys (`data/secrets.json`). Losing `secrets.json` makes stored messages
  unreadable.

## Sharing on your network / the internet

- **Same Wi-Fi:** staff open `http://<your-ip>:3000` (the server prints it). A
  firewall rule was added by `scripts/allow-on-lan.ps1`.
- **From anywhere:** move it to a small cloud server (VPS) behind HTTPS.

## Project layout

```
src/
  config.js   secrets, settings, SMTP + OTP config
  crypto.js   tokens, login codes, message encryption (Node built-ins)
  email.js    sends login codes (test mode if SMTP not set)
  db.js       SQLite schema + queries (built-in node:sqlite)
  server.js   Express routes (auth, admin) + Socket.IO real-time + security
public/        index.html, css/style.css, js/app.js  (the web app)
scripts/       allow-on-lan.ps1, list-users.mjs (helpers)
test/smoke.mjs end-to-end test (run with: npm test, while the server runs)
data/          created on first run: app.sqlite + secrets.json (DO NOT COMMIT)
```

## Roadmap

- **Stage 2:** send photos, videos, files & voice messages.
- **Stage 3:** read receipts (✓✓), reply, reactions, profile photos.
- Later: voice/video calls; true end-to-end encryption.
