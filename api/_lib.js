// Shared helpers for the /api functions.
// Runs on Vercel's Node.js runtime. These endpoints assume the site is hosted
// on a subdomain of hackthe6ix.com so that the HT6 session cookie reaches us.

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

export const HT6_API_URL = process.env.HT6_API_URL || 'https://v2.api.hackthe6ix.com';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function db() {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
        throw new Error('missing_supabase_env');
    }
    return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

export function json(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    // Same-origin: no CORS headers needed.
    res.end(JSON.stringify(body));
}

/**
 * Read a JSON body in a way that works on both Vercel (which pre-parses
 * application/json into req.body and drains the stream) and any other Node
 * runtime where the body is still a readable stream.
 */
export async function readJsonBody(req) {
    // Vercel's @vercel/node runtime parses JSON bodies for us. If it already
    // ran, req.body is the parsed object (or string / Buffer for other types).
    const pre = req.body;
    if (pre !== undefined && pre !== null) {
        if (typeof pre === 'object' && !Buffer.isBuffer(pre)) return pre;
        const text = Buffer.isBuffer(pre) ? pre.toString('utf8') : String(pre);
        if (!text) return {};
        try { return JSON.parse(text); } catch (_) { throw new Error('bad_json'); }
    }

    // Fallback: drain the request stream manually.
    return await new Promise((resolve, reject) => {
        let buf = '';
        req.on('data', (chunk) => {
            buf += chunk;
            if (buf.length > 16 * 1024) reject(new Error('payload_too_large'));
        });
        req.on('end', () => {
            if (!buf) return resolve({});
            try { resolve(JSON.parse(buf)); } catch (_) { reject(new Error('bad_json')); }
        });
        req.on('error', reject);
    });
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function hmacToken(message) {
    const secret = process.env.RUN_TOKEN_SECRET;
    if (!secret) throw new Error('missing_run_token_secret');
    return b64url(crypto.createHmac('sha256', secret).update(message).digest());
}

export function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

const AUTH_CHECK_TIMEOUT_MS = 3000;
const HT6_SEASON_CODE = process.env.HT6_SEASON_CODE || 'S26';

/**
 * Verify the HT6 session and resolve the authenticated user's profile.
 *
 * Two-hop strategy (HT6's /auth/check returns no body):
 *   1. /api/auth/check + /api/seasons/{code}/responses run in parallel.
 *      The responses endpoint scopes results to the current user, giving us
 *      their userId without a separate /me endpoint.
 *   2. /api/users/{userId} fetches the trusted email and display name.
 *
 * Returns { ok: boolean, status, user? } where user has { email, userId,
 * firstName, lastName } drawn entirely from HT6's database — never from the
 * client request body.
 */
export async function verifyHt6Session(req) {
    const cookie = req.headers['cookie'];
    if (!cookie) return { ok: false, status: 401 };

    const ht6Headers = {
        cookie,
        accept: 'application/json',
        'user-agent': 'chef-overflow-server/1.0',
    };

    // Step 1: auth liveness check + userId lookup in parallel.
    let authOk = false;
    let userId = null;
    try {
        const [authRes, respRes] = await Promise.all([
            fetch(`${HT6_API_URL}/api/auth/check`, {
                method: 'GET',
                headers: ht6Headers,
                signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS),
            }),
            fetch(`${HT6_API_URL}/api/seasons/${HT6_SEASON_CODE}/responses`, {
                method: 'GET',
                headers: ht6Headers,
                signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS),
            }),
        ]);

        authOk = authRes.ok;

        if (respRes.ok) {
            try {
                const body = await respRes.json();
                userId = body?.data?.[0]?.userId ?? null;
            } catch (_) {}
        }
    } catch (err) {
        const status = err?.name === 'TimeoutError' ? 504 : 502;
        return { ok: false, status };
    }

    if (!authOk) return { ok: false, status: 401 };
    if (!userId) return { ok: false, status: 403 }; // authed but no S26 form response

    // Step 2: fetch the full user profile for trusted email + display name.
    try {
        const profileRes = await fetch(`${HT6_API_URL}/api/users/${userId}`, {
            method: 'GET',
            headers: ht6Headers,
            signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS),
        });
        if (!profileRes.ok) return { ok: false, status: 502 };

        const data = await profileRes.json();
        if (!data || typeof data.email !== 'string') return { ok: false, status: 502 };

        return {
            ok: true,
            status: 200,
            user: {
                email:     data.email,
                userId:    data.userId,
                firstName: data.firstName ?? null,
                lastName:  data.lastName  ?? null,
            },
        };
    } catch (err) {
        const status = err?.name === 'TimeoutError' ? 504 : 502;
        return { ok: false, status };
    }
}
