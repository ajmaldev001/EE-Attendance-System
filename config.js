/* ------------------------------------------------------------------
   Frontend API configuration.

   LOCAL DEV (localhost): same origin — the Node server on port 5000
   serves both the frontend and the API.

   PRODUCTION (Vercel): API_BASE points to the deployed Render backend
   (no trailing slash).
------------------------------------------------------------------ */
// Local dev covers localhost plus private LAN addresses (so phones/tablets on
// the same Wi-Fi can use the dev server directly).
window.API_BASE = /^(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(location.hostname)
  ? ''
  : 'https://ee-attendance-system.onrender.com';
