// POST /api/start-run
// Issues a single-use HMAC-signed run token at game start.
// HT6 session is NOT required to start a run — only to submit a score.
// We bind the token to the IP at issuance time for a soft tamper signal.

import { db, hmacToken, json, readJsonBody } from './_lib.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

    // Body is optional; we accept it for forward compatibility.
    try { await readJsonBody(req); } catch (_) { /* ignore */ }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;

    let supabase;
    try { supabase = db(); }
    catch (_) { return json(res, 500, { error: 'server_misconfigured' }); }

    const { data, error } = await supabase
        .from('run_tokens')
        .insert({ client_ip: ip })
        .select('id, issued_at')
        .single();
    if (error || !data) return json(res, 500, { error: 'issue_failed' });

    let token;
    try { token = hmacToken(`${data.id}.${data.issued_at}`); }
    catch (_) { return json(res, 500, { error: 'server_misconfigured' }); }

    return json(res, 200, { run_id: data.id, issued_at: data.issued_at, token });
}
