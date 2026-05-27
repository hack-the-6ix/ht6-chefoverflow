# Deploy

## Required topology

The site **must** be served from a subdomain of `hackthe6ix.com` (currently `chefoverflow.hackthe6ix.com`). The HT6 session cookie is scoped to `.hackthe6ix.com`; serving from any other parent domain (including `hackthe6ix.ca`) means the cookie never reaches the `/api/*` functions and server-side auth verification breaks.

1. Ask HT6 ops to add a CNAME at `<chosen>.hackthe6ix.com` pointing to `cname.vercel-dns.com` (or whatever Vercel shows you).
2. In the Vercel project, add `<chosen>.hackthe6ix.com` as a custom domain. Vercel auto-issues TLS.
3. Verify the HT6 cookie is in fact `Domain=.hackthe6ix.com` (open the deployed site, sign in, check DevTools → Application → Cookies). If it's `Domain=v2.api.hackthe6ix.com` (host-only), the cookie won't cross to us and we need HT6 to widen it.

## Required env vars (Vercel project settings)

| Name | Where it's used | Source |
|---|---|---|
| `SUPABASE_URL` | `/api/start-run`, `/api/submit-score` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `/api/start-run`, `/api/submit-score` | Supabase service role (server-only, never expose) |
| `RUN_TOKEN_SECRET` | HMAC for run tokens | Long random string, same value as before |
| `HT6_API_URL` | `/api/submit-score` for `/auth/check` | Defaults to `https://v2.api.hackthe6ix.com` |

The browser-side bundle also needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` inline in `index.html` (already present) for reading the public leaderboard.

## Database

`supabase/migrations/20260521090237_leaderboard_hardening.sql` hardens an existing `public.leaderboard` table. The table itself must already exist with columns `(email text, score int, grade text, streak int, delivered int, time_secs int, run_id uuid, created_at timestamptz)`.

## Auth flow at runtime

1. Browser loads page → calls `https://v2.api.hackthe6ix.com/api/auth/check` with `credentials: 'include'`. If 200, show signed-in UI. If 401, show sign-in button.
2. Sign-in → redirect to `${HT6_API_URL}/api/auth/login?redirectUrl=<current page>`. HT6 handles OAuth, session cookie is set on `.hackthe6ix.com` during callback, browser is redirected back.
3. Game starts → `POST /api/start-run` issues an HMAC run token. (No auth required to start; the gate is at submit.)
4. Game over → user clicks Submit → `POST /api/submit-score` with `credentials: 'include'`. Vercel function reads the inbound `Cookie:` header, forwards it to `/api/auth/check`, and only proceeds on 200.
5. If `/auth/check` returns a body containing the user's email, the server uses that and ignores the client-supplied email. If the body is empty, the server falls back to the client-typed email.

## The defunct Supabase Edge Functions

`supabase/functions/start-run/` and `supabase/functions/submit-score/` are superseded by `/api/start-run.js` and `/api/submit-score.js`. They can be removed once the new endpoints are verified in production.
