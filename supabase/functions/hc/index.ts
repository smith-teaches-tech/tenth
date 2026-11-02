// Edge Function: hc
// Receives band data from the Health Connect Webhook app with nothing but a URL:
//   https://<project>.supabase.co/functions/v1/hc?token=<token from Tenth > Settings > Band data>
// No headers needed. It hands the JSON to the database function hc_ingest, which checks the token,
// stores the raw records (45 days) and rolls them up into steps, sleep, heart rate and workouts.
//
// Deploy with JWT checking off (supabase/config.toml: [functions.hc] verify_jwt = false),
// since the webhook app can't sign in; the token is the lock.

import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true, note: "Tenth band-data receiver. Send POST with JSON." });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = new URL(req.url);
  const token = url.searchParams.get("token") || req.headers.get("x-tenth-token") || "";
  if (!token) return json({ error: "Add ?token=... to the URL (from Tenth > Settings > Band data)." }, 401);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body must be JSON. In the webhook app, choose JSON rather than Protobuf." }, 400);
  }

  try {
    // hc_ingest reads the token the same way it would from a REST call, so set it for this transaction
    const result = await sql.begin(async (tx) => {
      await tx`select set_config('request.headers', ${JSON.stringify({ "x-tenth-token": token })}, true)`;
      const [row] = await tx`select public.hc_ingest(${tx.json(payload as never)}) as r`;
      return row.r;
    });
    return json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code;
    return json({ error: msg }, code === "42501" ? 401 : 500);
  }
});
