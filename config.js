/* ------------------------------------------------------------------
   Frontend API configuration.

   LOCAL DEV (localhost): same origin — the Node server on port 5000
   serves both the frontend and the API.

   PRODUCTION (Vercel): API_BASE points to the deployed Render backend
   (no trailing slash).
------------------------------------------------------------------ */
window.API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? ''
  : 'https://ee-attendance-system.onrender.com';
