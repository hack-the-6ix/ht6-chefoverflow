// start-run: issue a single-use, HMAC-signed token at game start.
// The token is the only way to authenticate a later submit-score call.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RUN_TOKEN_SECRET = Deno.env.get("RUN_TOKEN_SECRET")!;

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
            status: 405,
            headers: { ...CORS, "content-type": "application/json" },
        });
    }

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    const { data, error } = await db
        .from("run_tokens")
        .insert({ client_ip: ip })
        .select("id, issued_at")
        .single();

    if (error || !data) {
        return new Response(JSON.stringify({ error: "issue_failed" }), {
            status: 500,
            headers: { ...CORS, "content-type": "application/json" },
        });
    }

    const token = await hmac(RUN_TOKEN_SECRET, `${data.id}.${data.issued_at}`);

    return new Response(
        JSON.stringify({ run_id: data.id, issued_at: data.issued_at, token }),
        { headers: { ...CORS, "content-type": "application/json" } },
    );
});
