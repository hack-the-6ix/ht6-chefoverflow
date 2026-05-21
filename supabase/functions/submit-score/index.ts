// submit-score: only writer to the leaderboard table.
// Validates an HMAC-signed run token, sanity-checks the score, rate-limits per email,
// and upserts the player's best score.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RUN_TOKEN_SECRET = Deno.env.get("RUN_TOKEN_SECRET")!;

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_GRADES = new Set(["F", "D", "C", "B", "A", "S"]);
const MAX_SCORE_PER_SEC = 250;
const MAX_BURST = 1000;
const MIN_RUN_SECONDS = 10;
const MAX_RUN_SECONDS = 3600;
const TOKEN_MAX_AGE_MS = 30 * 60 * 1000;
const RATE_LIMIT_MS = 30 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, "content-type": "application/json" },
    });
}

function b64url(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmac(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    return b64url(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function isInt(n: unknown, min: number, max: number): n is number {
    return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return json({ error: "bad_json" }, 400);
    }

    const { run_id, token, email, score, grade, streak, delivered, time_secs } = body as Record<string, unknown>;

    // Schema
    if (typeof run_id !== "string" || run_id.length < 10 || run_id.length > 64) return json({ error: "bad_run_id" }, 400);
    if (typeof token !== "string" || token.length < 20 || token.length > 200) return json({ error: "bad_token" }, 400);
    if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "bad_email" }, 400);
    const emailLc = email.toLowerCase();
    if (typeof grade !== "string" || !VALID_GRADES.has(grade)) return json({ error: "bad_grade" }, 400);
    if (!isInt(score, 0, 10_000_000)) return json({ error: "bad_score" }, 400);
    if (!isInt(streak, 0, 10_000)) return json({ error: "bad_streak" }, 400);
    if (!isInt(delivered, 0, 10_000)) return json({ error: "bad_delivered" }, 400);
    if (!isInt(time_secs, MIN_RUN_SECONDS, MAX_RUN_SECONDS)) return json({ error: "bad_time" }, 400);

    // Plausibility
    if (score > time_secs * MAX_SCORE_PER_SEC + MAX_BURST) return json({ error: "implausible_score" }, 400);
    if (delivered > Math.floor(time_secs / 2)) return json({ error: "implausible_delivered" }, 400);
    if (streak > delivered) return json({ error: "implausible_streak" }, 400);

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Token: lookup + signature check
    const tokenRow = await db
        .from("run_tokens")
        .select("id, issued_at, used_at")
        .eq("id", run_id)
        .maybeSingle();
    if (tokenRow.error || !tokenRow.data) return json({ error: "unknown_token" }, 400);
    if (tokenRow.data.used_at) return json({ error: "token_used" }, 400);

    const expected = await hmac(RUN_TOKEN_SECRET, `${tokenRow.data.id}.${tokenRow.data.issued_at}`);
    if (!timingSafeEqual(expected, token)) return json({ error: "bad_signature" }, 400);

    const issuedMs = Date.parse(tokenRow.data.issued_at);
    const ageMs = Date.now() - issuedMs;
    if (ageMs > TOKEN_MAX_AGE_MS) return json({ error: "token_expired" }, 400);
    if (ageMs < MIN_RUN_SECONDS * 1000) return json({ error: "too_fast" }, 400);

    // Per-email rate limit (and existing best lookup)
    const existing = await db
        .from("leaderboard")
        .select("score, created_at")
        .eq("email", emailLc)
        .maybeSingle();

    if (existing.data?.created_at) {
        const sinceMs = Date.now() - Date.parse(existing.data.created_at);
        if (sinceMs < RATE_LIMIT_MS) return json({ error: "rate_limited" }, 429);
    }

    // Best-only upsert. Claim the token first (race-safe) so concurrent submissions can't
    // both win; if the upsert later fails, the burned token is acceptable — at-most-once
    // submission is the right invariant.
    const claim = await db
        .from("run_tokens")
        .update({ used_at: new Date().toISOString() })
        .eq("id", run_id)
        .is("used_at", null)
        .select("id");
    if (claim.error || !claim.data || claim.data.length === 0) return json({ error: "token_used" }, 400);

    if (existing.data && existing.data.score >= score) {
        return json({ ok: true, kept_existing: true, best: existing.data.score });
    }

    const upsert = await db
        .from("leaderboard")
        .upsert(
            {
                email: emailLc,
                score,
                grade,
                streak,
                delivered,
                time_secs,
                run_id,
                created_at: new Date().toISOString(),
            },
            { onConflict: "email" },
        );
    if (upsert.error) return json({ error: "write_failed", detail: upsert.error.message }, 500);

    return json({ ok: true, best: score });
});
