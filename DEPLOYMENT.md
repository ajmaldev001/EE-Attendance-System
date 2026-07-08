# Deployment Guide — Vercel (frontend) + Render (backend) + Supabase (Postgres)

100% free, **no credit card required**. Three pieces:

- **Frontend** (`index.html`, `style.css`, `app.js`, `config.js`) → **Vercel**
- **Backend** (`server/`) → **Render** (free web service)
- **Database** → **Supabase** (free Postgres, data persists)

All three deploy from your GitHub repo: `https://github.com/ajmaldev001/EE-Attendance-System`.

---

## 0. Prerequisites (one-time)

Create free accounts (sign in with GitHub for all three):
- [github.com](https://github.com) · [supabase.com](https://supabase.com) · [render.com](https://render.com) · [vercel.com](https://vercel.com)

Make sure the latest code is pushed:
```bash
cd /Users/ajju/Development/Ajju/EE-Attendance-System
git add -A && git commit -m "Switch backend to Postgres for Render + Supabase" && git push
```

---

## 1. Create the database on Supabase

1. Go to **supabase.com → New project**. Pick a name, a strong **database password** (save it), and the nearest region. Wait ~2 min for it to provision.
2. Open **Project Settings → Database → Connection string → URI**.
3. Copy the **Connection Pooler** URI (recommended for hosted apps). It looks like:
   ```
   postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```
4. Replace `[YOUR-PASSWORD]` with the database password from step 1. This full string is your **`DATABASE_URL`**.

> Tables + seed data (admin, staff, 10 students, sample attendance/marks) are created **automatically** on the backend's first boot — you don't run any SQL by hand.

---

## 2. Deploy the backend to Render

1. Go to **render.com → New → Web Service → Build and deploy from a Git repository** and pick your repo.
2. Render detects `render.yaml`. If it asks manually, set:
   - **Root Directory:** `server`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** `Free`
3. Under **Environment**, add:
   - **`DATABASE_URL`** = the Supabase URI from step 1.
   - **`JWT_SECRET`** = any long random string (or let the blueprint generate it).
4. Click **Create Web Service**. First build takes ~2–3 min. Watch the logs for:
   ```
   🌱 Seeded admin, staff, and 10 sample students.
   ✅ Attendance API running on http://localhost:10000
   ```
5. Note your backend URL, e.g. **`https://ece-attendance-backend.onrender.com`**.

Quick test:
```bash
curl https://<your-app>.onrender.com/api/meta   # → {"subjects":[...],"markTypes":[...]}
```

---

## 3. Point the frontend at the backend

Edit **`config.js`**:
```js
window.API_BASE = 'https://ece-attendance-backend.onrender.com';  // your Render URL, no trailing slash
```
Commit and push:
```bash
git add config.js && git commit -m "Point frontend at Render backend" && git push
```

---

## 4. Deploy the frontend to Vercel

1. **vercel.com → Add New → Project → Import** your GitHub repo.
2. Setup screen:
   - **Framework Preset:** `Other`
   - **Root Directory:** `./`
   - **Build Command:** leave empty
   - **Output Directory:** leave empty
3. Click **Deploy**. Live at something like `https://ee-attendance-system.vercel.app`.

`vercel.json` keeps the `server/` folder out of the static deploy. CORS is already enabled globally in `server.js`, so the Vercel domain can call Render out of the box.

---

## Done ✅

| Piece | URL |
|-------|-----|
| Frontend | `https://<you>.vercel.app` |
| Backend API | `https://<you>.onrender.com/api` |
| Database | Supabase Postgres (persistent, free) |

**Login:** Admin `admin@ece.edu / Admin@123` · Staff `staff@ece.edu / Staff@123` · Student `22ECE001 / Student@123`

---

## Notes & gotchas

- **Render free web services sleep after 15 min idle.** The first request after a nap takes ~30–50 s to wake (cold start). Normal on the free plan; it stays warm while in use.
- **Supabase free projects pause after ~1 week of zero activity.** Just un-pause from the dashboard if that happens; data is retained.
- **SSL:** the backend enables SSL automatically for any non-local `DATABASE_URL` (`rejectUnauthorized: false`), which is what Supabase needs.
- **Change the seed passwords** for admin/staff in `server/db.js` before real use.
- **Redeploy:** just `git push` — both Render and Vercel auto-build on push to `main`.
