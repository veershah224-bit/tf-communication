# Put TF Communication online (free) — step by step

Goal: your staff open a web link from anywhere, and login codes arrive in their
email. All free, no credit card. Takes ~20–30 minutes. I'll help at each step.

You'll set up 4 free things:
1. **Turso** – the cloud database (keeps your accounts + messages safe)
2. **Gmail App Password** – so codes are emailed (using tfxautomation@gmail.com)
3. **GitHub** – holds your app code
4. **Render** – runs your app and gives you the web link

Your secret keys are already generated in **`DEPLOY_SECRETS.txt`** (open it when asked).

---

## 1) Turso — free cloud database
1. Go to **https://turso.tech** → **Sign up** (use Google/GitHub — easiest).
2. Create a database (any name, e.g. `tf`). Pick the region closest to you.
3. Open the database → find **URL** (looks like `libsql://tf-xxxx.turso.io`) — copy it.
4. Create a **token** (a "database token"/"auth token") — copy it.
> Keep both: **TURSO_DATABASE_URL** and **TURSO_AUTH_TOKEN**.

## 2) Gmail App Password — to send codes
1. On the Google account **tfxautomation@gmail.com**, turn on **2-Step
   Verification**: https://myaccount.google.com/security
2. Then open **https://myaccount.google.com/apppasswords** → create an app
   password (name it "TF Communication") → copy the **16-character** password.
> That password is your **SMTP_PASS**. SMTP_USER is `tfxautomation@gmail.com`.

## 3) GitHub — put the code online (use the friendly app)
1. Install **GitHub Desktop**: https://desktop.github.com (sign up for GitHub when asked).
2. **File → Add local repository** → choose this folder
   (`...\Desktop\tf communication`). If it asks, let it **create a repository** here.
3. Make the repository **Private**, then click **Publish repository**.
> Your code is now safely on GitHub. (Secrets are excluded automatically.)

## 4) Render — run it and get your link
1. Go to **https://render.com** → **Sign up** (with GitHub) — free, no card.
2. **New + → Blueprint** → connect your GitHub → pick the `tf communication` repo.
   Render reads `render.yaml` automatically.
3. It will ask you to fill the secret values. Paste:
   - **TOKEN_SECRET**, **MESSAGE_KEY** → from `DEPLOY_SECRETS.txt`
   - **TURSO_DATABASE_URL**, **TURSO_AUTH_TOKEN** → from step 1
   - **SMTP_HOST** = `smtp.gmail.com`
   - **SMTP_USER** = `tfxautomation@gmail.com`
   - **SMTP_PASS** = the app password from step 2
   - **SMTP_FROM** = `TF Communication <tfxautomation@gmail.com>`
4. Click **Apply / Deploy** and wait a few minutes.
5. Open the link Render gives you (like `https://tf-communication.onrender.com`).

## 5) First sign-in
- Open your Render link → enter **your** email → you get a code **by email** →
  sign in. The first person to sign in is the **admin**.
- Admin → **⋮ menu → Manage staff** → add your team by name + email.

---

### Notes
- **Free server sleeps** after ~15 min idle, so the first open after a quiet
  spell takes ~30–60 seconds to wake. Your data is safe (it's in Turso).
- To update the app later: in GitHub Desktop click **Commit** then **Push** —
  Render redeploys automatically.
- Want no sleeping + a custom domain? A ~$3–7/month plan removes the sleep.
