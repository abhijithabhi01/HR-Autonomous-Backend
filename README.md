# HR Onboarding — Backend

Tiny Express server that handles two things the browser can't do:

| Route | Does |
|---|---|
| `POST /api/sendmail` | Sends welcome email via Resend |
| `POST /api/deleteOrphanedAuth` | Deletes ghost Firebase Auth accounts (Admin SDK) |

---

## 5-minute setup

### Step 1 — Install dependencies
```bash
cd backend
npm install
```

### Step 2 — Create your .env
```bash
cp .env.example .env
```
Open `backend/.env` and set:
```
RESEND_API_KEY=re_your_key_here
```
Get your key from https://resend.com/api-keys (free tier works fine).

### Step 3 — Add Firebase service account key
1. Go to **Firebase Console → Project Settings → Service Accounts**
2. Click **Generate New Private Key**
3. Save the downloaded JSON as **`backend/serviceAccountKey.json`**

> ⚠️ Never commit `serviceAccountKey.json` or `.env` to git — they're in `.gitignore`

### Step 4 — Run both servers

Terminal 1 (backend):
```bash
cd backend
node server.js
```

Terminal 2 (frontend):
```bash
cd ..        # project root
npm run dev
```

That's it. The frontend Vite proxy automatically forwards all `/api/*` requests to `localhost:3001`.

---

## Production

For production, use Firebase Cloud Functions instead of this local server.
The `functions/index.js` file already has the same two functions ready to deploy:

```bash
cd functions && npm install
firebase deploy --only functions
```

The `firebase.json` rewrites already route `/api/sendmail` and `/api/deleteOrphanedAuth`
to the Cloud Functions — no code changes needed.
