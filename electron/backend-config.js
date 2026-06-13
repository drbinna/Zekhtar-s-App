// ─────────────────────────────────────────────
// Production backend configuration.
//
// Shipped (packaged) builds talk to the hosted Fly backend, which holds the
// real API keys — so the downloaded app needs NO local .env to work.
//
// Local dev OVERRIDES this: if a local .env / process.env sets
// ZEKTHAR_SERVER_URL or ZEKTHAR_ACCESS_TOKEN, those win (see main.js), and the
// app falls back to the embedded server. So developers keep their localhost
// loop; end users get the hosted backend automatically.
//
// The ACCESS_TOKEN here is a shared, app-level token (not a user API key). It
// gates casual abuse of the public backend. A determined user can extract it
// from the app bundle — real per-user auth is the follow-up. Rotate it on the
// Fly side + ship a new build if it leaks.
// ─────────────────────────────────────────────
module.exports = {
  BACKEND_URL: 'https://zekthar-backend.fly.dev',
  ACCESS_TOKEN: '0b26afb48f134de822ad166ccfe1221f2f431afcabfdce86908f5c6683a6792f',
};
