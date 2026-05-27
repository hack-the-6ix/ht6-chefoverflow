// POST /api/submit-score
//
// Server-side trust chain:
//   1. Forward inbound Cookie header to HT6 /api/auth/check. Reject on non-200.
//   2. Validate payload schema and HMAC signature on the run token.
//   3. Recompute plausibility caps (per-second score, delivered, streak).
//   4. Hand off to the submit_run RPC, which atomically locks the token row
//      and the leaderboard row for this email, enforces age + rate limit,
//      claims the token, and does a best-only upsert.
//
// If HT6 returns user info in /auth/check, the trusted email comes from
// there; otherwise we accept the client-typed email (still gated by the
// HT6 session being live).

import { db, hmacToken, json, readJsonBody, timingSafeEqual, verifyHt6Session } from './_lib.js';

const VALID_GRADES = new Set(['F', 'D', 'C', 'B', 'A', 'S']);
const MAX_SCORE_PER_SEC = 250;
const MAX_BURST = 1000;
const MIN_RUN_SECONDS = 10;
const MAX_RUN_SECONDS = 3600;
const TOKEN_MAX_AGE_MS = 30 * 60 * 1000;
const TOKEN_MIN_AGE_MS = MIN_RUN_SECONDS * 1000;
const RATE_LIMIT_MS = 30 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isInt(n, min, max) {
    return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

    // 1) HT6 session gate.
    const auth = await verifyHt6Session(req);
    if (!auth.ok) {
        const code = auth.status === 504 ? 'ht6_unreachable' :
                     auth.status === 502 ? 'ht6_unreachable' :
                                           'ht6_unauthenticated';
        return json(res, auth.status === 401 ? 401 : auth.status, { error: code });
    }

    // 2) Parse + validate payload.
    let body;
    try { body = await readJsonBody(req); }
    catch (e) {
        return json(res, 400, { error: e?.message === 'payload_too_large' ? 'payload_too_large' : 'bad_json' });
    }

    const { run_id, token, email: clientEmail, score, grade, streak, delivered, time_secs } = body;

    if (typeof run_id !== 'string' || run_id.length < 10 || run_id.length > 64) return json(res, 400, { error: 'bad_run_id' });
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return json(res, 400, { error: 'bad_token' });
    if (typeof grade !== 'string' || !VALID_GRADES.has(grade)) return json(res, 400, { error: 'bad_grade' });
    if (!isInt(score, 0, 10_000_000)) return json(res, 400, { error: 'bad_score' });
    if (!isInt(streak, 0, 10_000)) return json(res, 400, { error: 'bad_streak' });
    if (!isInt(delivered, 0, 10_000)) return json(res, 400, { error: 'bad_delivered' });
    if (!isInt(time_secs, MIN_RUN_SECONDS, MAX_RUN_SECONDS)) return json(res, 400, { error: 'bad_time' });

    // Trusted email > client-typed.
    const rawEmail = (auth.user && auth.user.email) || clientEmail;
    if (typeof rawEmail !== 'string' || rawEmail.length > 254 || !EMAIL_RE.test(rawEmail)) {
        return json(res, 400, { error: 'bad_email' });
    }
    const email = rawEmail.toLowerCase();

    // 3) Plausibility.
    if (score > time_secs * MAX_SCORE_PER_SEC + MAX_BURST) return json(res, 400, { error: 'implausible_score' });
    if (delivered > Math.floor(time_secs / 2)) return json(res, 400, { error: 'implausible_delivered' });
    if (streak > delivered) return json(res, 400, { error: 'implausible_streak' });

    // 4) HMAC signature on the run token. We still need this in Node since the
    //    secret lives in env. The RPC just trusts that we verified it.
    let supabase;
    try { supabase = db(); }
    catch (_) { return json(res, 500, { error: 'server_misconfigured' }); }

    const tokenRow = await supabase
        .from('run_tokens')
        .select('id, issued_at')
        .eq('id', run_id)
        .maybeSingle();
    if (tokenRow.error || !tokenRow.data) return json(res, 400, { error: 'unknown_token' });

    let expected;
    try { expected = hmacToken(`${tokenRow.data.id}.${tokenRow.data.issued_at}`); }
    catch (_) { return json(res, 500, { error: 'server_misconfigured' }); }
    if (!timingSafeEqual(expected, token)) return json(res, 400, { error: 'bad_signature' });

    // 5) Atomic claim + best-only upsert. The RPC re-fetches the token row
    //    under FOR UPDATE so we cannot lose a race against a concurrent submit.
    const rpc = await supabase.rpc('submit_run', {
        p_run_id: run_id,
        p_email: email,
        p_score: score,
        p_grade: grade,
        p_streak: streak,
        p_delivered: delivered,
        p_time_secs: time_secs,
        p_min_age_ms: TOKEN_MIN_AGE_MS,
        p_max_age_ms: TOKEN_MAX_AGE_MS,
        p_rate_limit_ms: RATE_LIMIT_MS,
    });

    if (rpc.error) {
        return json(res, 500, { error: 'write_failed', detail: rpc.error.message });
    }

    const result = rpc.data || {};
    if (!result.ok) {
        const status = result.error === 'rate_limited' ? 429 : 400;
        return json(res, status, { error: result.error || 'submit_failed' });
    }

    return json(res, 200, {
        ok: true,
        best: result.best,
        kept_existing: !!result.kept_existing,
        email_source: auth.user ? 'ht6' : 'client',
    });
}
