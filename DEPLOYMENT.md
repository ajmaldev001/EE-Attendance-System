# Deployment Guide — Vercel (frontend) + Fly.io (backend)

Your app is split into two deploys:

- **Frontend** (`index.html`, `style.css`, `app.js`, `config.js`) → **Vercel**
- **Backend + SQLite** (`server/`, `Dockerfile`, `fly.toml`) → **Fly.io** (SQLite persists on a volume)

---

## 0. Prerequisites (one-time)

1. Create free accounts: [github.com](https://github.com), [vercel.com](https://vercel.com), [fly.io](https://fly.io).
2. Install the Fly CLI:
   ```bash
   brew install flyctl        # macOS
   fly auth login
   ```
3. Push this project to GitHub (both hosts deploy from Git):
   ```bash
   cd /Users/ajju/Development/Ajju/AttendanceWebApp
   git init
   git add .
   git commit -m "Attendance app: split frontend/backend for deploy"
   git branch -M main
   git remote add origin https://github.com/<you>/attendance-app.git
   git push -u origin main
   ```

---

## 1. Deploy the backend to Fly.io

From the project root:

```bash
cd /Users/ajju/Development/Ajju/AttendanceWebApp

# Launch (uses the existing Dockerfile + fly.toml).
# When prompted: pick a unique app name, your region, and say NO to deploying now.
fly launch --no-deploy

# Create the persistent volume that holds data.db (1 GB, free tier)
fly volumes create attendance_data --size 1 --region <your-region>

# Set a strong JWT secret (do NOT use the dev default)
fly secrets set JWT_SECRET="$(openssl rand -hex 32)"

# Deploy
fly deploy
```

When it finishes, note your backend URL, e.g. **`https://ece-attendance-backend.fly.dev`**.

Quick test:
```bash
curl https://<your-app>.fly.dev/api/meta      # → {"subjects":[...],"markTypes":[...]}
```

> The seed data (admin + 10 students) is created automatically on first boot.

---

## 2. Point the frontend at the backend

Edit **`config.js`** and set your Fly URL:

```js
window.API_BASE = 'https://ece-attendance-backend.fly.dev';  // no trailing slash
```

Commit and push:
```bash
git add config.js && git commit -m "Point frontend at Fly backend" && git push
```

---

## 3. Deploy the frontend to Vercel

1. Go to **vercel.com → Add New → Project → Import** your GitHub repo.
2. In the setup screen:
   - **Framework Preset:** `Other`
   - **Root Directory:** `./` (leave default)
   - **Build Command:** leave **empty**
   - **Output Directory:** leave **empty**
3. Click **Deploy**.

`.vercelignore` already keeps the `server/` folder and `data.db` out of the static deploy.

Your frontend goes live at something like `https://attendance-app.vercel.app`.

---

## 4. Allow the Vercel domain (CORS)

CORS is already enabled globally in `server.js` (`app.use(cors())`), so the Vercel domain can call the Fly backend out of the box. To lock it down to only your Vercel URL later, change that line to:

```js
app.use(cors({ origin: 'https://attendance-app.vercel.app' }));
```
then `fly deploy` again.

---

## Done ✅

| Piece | URL |
|-------|-----|
| Frontend | `https://<you>.vercel.app` |
| Backend API | `https://<you>.fly.dev/api` |
| Database | SQLite on Fly volume `attendance_data` (persistent) |

**Login:** Admin `admin@ece.edu / Admin@123` · Staff `staff@ece.edu / Staff@123` · Student `22ECE001 / Student@123`

---

## Notes & gotchas

- **Free Fly machines auto-sleep** when idle (`auto_stop_machines`). The first request after a nap takes ~1–2 s to wake — normal on free tier.
- **Backups:** to download the live DB → `fly ssh console -C "cat /data/data.db" > backup.db` (or use `fly ssh sftp get`).
- **Change the seed password** for admin/staff in `server/db.js` before real use, or change it via the app after first login (add a change-password screen — not built yet).
- **Redeploy backend:** `fly deploy`. **Redeploy frontend:** just `git push` (Vercel auto-builds).
