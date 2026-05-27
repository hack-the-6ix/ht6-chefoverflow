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

const MAX_SCORE_PER_SEC = 250;
const MAX_BURST = 1000;
const MIN_RUN_SECONDS = 10;
const MAX_RUN_SECONDS = 3600;
// 65 min: leaves headroom for a full 60-min run plus the OAuth roundtrip
// on submit. Must stay >= MAX_RUN_SECONDS + some slack.
const TOKEN_MAX_AGE_MS = 65 * 60 * 1000;
const TOKEN_MIN_AGE_MS = MIN_RUN_SECONDS * 1000;
const RATE_LIMIT_MS = 30 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 'log' (default): plausibility violations are logged but not rejected, so we
// can tune caps from real-run data without burning legit players. Flip to
// 'strict' via env once telemetry is in.
const PLAUSIBILITY_MODE = process.env.PLAUSIBILITY_MODE === 'strict' ? 'strict' : 'log';

function isInt(n, min, max) {
    return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
}

// Server-authoritative grade. Mirrors gradeFromScore in game.js but is the
// source of truth — we never trust the client-supplied grade.
function gradeFromScore(score) {
    const s = Math.floor(score);
    if (s < 0) return 'F';
    if (s < 500) return 'D';
    if (s < 2000) return 'C';
    if (s < 5000) return 'B';
    if (s < 10000) return 'A';
    return 'S';
}

// Compact, structured logger so the reason for every rejection lands
// next to the request in Vercel function logs.
function logReject(reason, ctx) {
    try {
        console.warn('[submit-score] rejected', JSON.stringify({ reason, ...ctx }));
    } catch (_) {
        console.warn('[submit-score] rejected', reason);
    }
}

function rejectAndLog(res, status, reason, ctx) {
    logReject(reason, ctx);
    return json(res, status, { error: reason, ...(ctx?.detail ? { detail: ctx.detail } : {}) });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

    // 1) HT6 session gate.
    const auth = await verifyHt6Session(req);
    if (!auth.ok) {
        const code = auth.status === 504 ? 'ht6_unreachable' :
                     auth.status === 502 ? 'ht6_unreachable' :
                                           'ht6_unauthenticated';
        logReject(code, { upstream_status: auth.status });
        return json(res, auth.status, { error: code });
    }

    // 2) Parse + validate payload.
    let body;
    try { body = await readJsonBody(req); }
    catch (e) {
        const reason = e?.message === 'payload_too_large' ? 'payload_too_large' : 'bad_json';
        return rejectAndLog(res, 400, reason);
    }

    const { run_id, token, email: clientEmail, score, streak, delivered, time_secs } = body;

    if (typeof run_id !== 'string' || run_id.length < 10 || run_id.length > 64)
        return rejectAndLog(res, 400, 'bad_run_id', { run_id_type: typeof run_id, run_id_len: typeof run_id === 'string' ? run_id.length : null });
    if (typeof token !== 'string' || token.length < 20 || token.length > 200)
        return rejectAndLog(res, 400, 'bad_token', { token_type: typeof token, token_len: typeof token === 'string' ? token.length : null });
    if (!isInt(score, 0, 10_000_000))
        return rejectAndLog(res, 400, 'bad_score', { score });
    if (!isInt(streak, 0, 10_000))
        return rejectAndLog(res, 400, 'bad_streak', { streak });
    if (!isInt(delivered, 0, 10_000))
        return rejectAndLog(res, 400, 'bad_delivered', { delivered });
    if (!isInt(time_secs, MIN_RUN_SECONDS, MAX_RUN_SECONDS))
        return rejectAndLog(res, 400, 'bad_time', { time_secs });

    // Email must come from HT6's user profile — client-typed email is ignored.
    if (!auth.user?.email) {
        return rejectAndLog(res, 503, 'ht6_profile_unavailable');
    }
    const email = auth.user.email.toLowerCase();

    // 3) Plausibility. In 'log' mode we record violations but accept the
    //    submission, so we can tune caps from real telemetry.
    const plausibilityChecks = [
        score > time_secs * MAX_SCORE_PER_SEC + MAX_BURST
            ? { reason: 'implausible_score', ctx: { score, time_secs, cap: time_secs * MAX_SCORE_PER_SEC + MAX_BURST } }
            : null,
        delivered > Math.floor(time_secs / 2)
            ? { reason: 'implausible_delivered', ctx: { delivered, time_secs, cap: Math.floor(time_secs / 2) } }
            : null,
        streak > delivered
            ? { reason: 'implausible_streak', ctx: { streak, delivered } }
            : null,
    ].filter(Boolean);
    for (const v of plausibilityChecks) {
        if (PLAUSIBILITY_MODE === 'strict') {
            return rejectAndLog(res, 400, v.reason, v.ctx);
        }
        logReject(`would_reject_${v.reason}`, { ...v.ctx, mode: 'log' });
    }

    // Server-authoritative grade. Client value is ignored.
    const grade = gradeFromScore(score);

    // 4) HMAC signature on the run token. We still need this in Node since the
    //    secret lives in env. The RPC just trusts that we verified it.
    let supabase;
    try { supabase = db(); }
    catch (_) { return rejectAndLog(res, 500, 'server_misconfigured'); }

    const tokenRow = await supabase
        .from('run_tokens')
        .select('id, issued_at')
        .eq('id', run_id)
        .maybeSingle();
    if (tokenRow.error || !tokenRow.data) {
        return rejectAndLog(res, 400, 'unknown_token', { pg_error: tokenRow.error?.code || null });
    }

    let expected;
    try { expected = hmacToken(`${tokenRow.data.id}.${tokenRow.data.issued_at}`); }
    catch (_) { return rejectAndLog(res, 500, 'server_misconfigured'); }
    if (!timingSafeEqual(expected, token)) {
        return rejectAndLog(res, 400, 'bad_signature', { issued_at: tokenRow.data.issued_at });
    }

    // 5) Atomic claim + best-only upsert. The RPC re-fetches the token row
    //    under FOR UPDATE so we cannot lose a race against a concurrent submit.
    const rpc = await supabase.rpc('submit_run', {
        p_run_id:       run_id,
        p_email:        email,
        p_score:        score,
        p_grade:        grade,
        p_streak:       streak,
        p_delivered:    delivered,
        p_time_secs:    time_secs,
        p_ht6_user_id:  auth.user.userId    || null,
        p_first_name:   auth.user.firstName || null,
        p_last_name:    auth.user.lastName  || null,
        p_min_age_ms:   TOKEN_MIN_AGE_MS,
        p_max_age_ms:   TOKEN_MAX_AGE_MS,
        p_rate_limit_ms: RATE_LIMIT_MS,
    });

    if (rpc.error) {
        // Surface specific Supabase failure modes so the operator can fix
        // them without reading server logs.
        let code = 'write_failed';
        const pgCode = rpc.error.code;
        if (pgCode === '42883') code = 'rpc_missing';        // function does not exist
        else if (pgCode === '42P01') code = 'table_missing';  // relation does not exist
        else if (pgCode === '42703') code = 'column_missing'; // column does not exist
        else if (pgCode === '23505') code = 'duplicate';      // unique violation (shouldn't happen)
        logReject(code, { pg_code: pgCode, pg_message: rpc.error.message, hint: rpc.error.hint });
        return json(res, 500, { error: code, pg_code: pgCode || null, detail: rpc.error.message });
    }

    const result = rpc.data || {};
    if (!result.ok) {
        const status = result.error === 'rate_limited' ? 429 : 400;
        logReject(result.error || 'submit_failed', { from: 'rpc' });
        return json(res, status, { error: result.error || 'submit_failed' });
    }

    return json(res, 200, {
        ok: true,
        best: result.best,
        kept_existing: !!result.kept_existing,
        email_source: auth.user ? 'ht6' : 'client',
    });
}
