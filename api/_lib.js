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

/**
 * Forward the inbound request's Cookie header to HT6 /api/auth/check.
 * Returns { ok: boolean, status, user? }. The user object is parsed from the
 * response body when the live server happens to include one (the public spec
 * doesn't promise a body, so we parse defensively).
 *
 * Bounded by AUTH_CHECK_TIMEOUT_MS so a slow/degraded HT6 can't hang the
 * Vercel function until its 10s default timeout.
 */
export async function verifyHt6Session(req) {
    const cookie = req.headers['cookie'];
    if (!cookie) return { ok: false, status: 401 };

    let res;
    try {
        res = await fetch(`${HT6_API_URL}/api/auth/check`, {
            method: 'GET',
            headers: {
                cookie,
                accept: 'application/json',
                'user-agent': 'chef-overflow-server/1.0',
            },
            signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS),
        });
    } catch (err) {
        // AbortError on timeout, TypeError on DNS / network. Treat both as
        // "upstream unavailable" rather than "user is unauthenticated".
        const status = err && err.name === 'TimeoutError' ? 504 : 502;
        return { ok: false, status };
    }

    if (!res.ok) return { ok: false, status: res.status };

    let user = null;
    try {
        const text = await res.text();
        if (text) {
            const data = JSON.parse(text);
            const payload = data?.data ?? data;
            const candidate = payload?.user || payload;
            if (candidate && typeof candidate.email === 'string') user = candidate;
        }
    } catch (_) {
        // Body wasn't JSON or was empty. Auth still valid, no profile data.
    }

    return { ok: true, status: 200, user };
}
