// Edge Function: coach
// Chat with the AI coach about your food, training and progress.
//
// Memory works in layers, built fresh for every message:
//   last 14 days   every meal (with ingredients), workout, weigh-in, steps and sleep
//   days 15-90     one line per day
//   older          one line per week (per month beyond a year)
//   coach notes    lasting facts you agreed to let it remember
// When it needs older detail it looks it up with tools instead of carrying everything.
// It never saves a note itself: it proposes one, and the app asks you "Remember this?".
//
// Secrets: ANTHROPIC_API_KEY (required), CLAUDE_MODEL (optional, default claude-sonnet-5-5), ALLOWED_ORIGIN
//
// Request (POST, JSON, signed in): { "message": "...", "today": "YYYY-MM-DD", "thread_id": "<uuid or omit for new>" }
// Response: { thread_id, reply, proposals: [{ note, replaces_note_id }] }

import { createClient } from "npm:@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("CLAUDE_MODEL") || "claude-sonnet-5-5";
const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const MAX_TOOL_ROUNDS = 5;
const HISTORY_MESSAGES = 20;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const addDays = (d: string, n: number) =>
  new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const r0 = (v: unknown) => (v == null ? "" : String(Math.round(Number(v))));

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM = `You are the coach inside Tenth, a personal app for getting to a target body fat percentage
while keeping muscle. You talk with one person about their own food, training, sleep and progress.

How to answer:
- Ground everything in their actual data below. Name foods, days and numbers. Say when data is missing or thin.
- Be direct and practical, like a good coach texting back. Short paragraphs; a short list only when it helps.
- When you need detail that isn't in the context (an older day, a food they mention), use the lookup tools.
- Calorie targets come from a weight-trend model in the app. Explain them; don't invent a different system.
- You are not a doctor. For pain, illness, medication or anything medical, say so plainly and suggest a professional.

Remembering things:
- Your context holds "Coach notes": lasting facts this person agreed you may remember.
- When they tell you something durable that would change future advice (a preference, a constraint, a schedule,
  a goal, something agreed between you), call propose_memory with one short, specific note.
- Don't propose notes for one-off events or for things already in their logs. Never more than two per reply.
- The app asks them before saving, so you don't need to ask in your reply.
- If a new note updates an existing one, pass replaces_note_id so the old one is replaced.`;

const TOOLS = [
  {
    name: "get_day",
    description: "Everything logged on one date: meals with ingredients, workouts, steps, sleep, weigh-in and that day's targets.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["date"],
    },
  },
  {
    name: "search_meals",
    description: "Find past meals whose description or ingredients contain a word, e.g. 'shawarma' or 'oats'. Returns up to 30, newest first.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        from: { type: "string", description: "YYYY-MM-DD, optional" },
        to: { type: "string", description: "YYYY-MM-DD, optional" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_range",
    description: "One line per day (calories, macros, workouts, steps, sleep, weight) for a date range of up to 120 days.",
    input_schema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
  {
    name: "propose_memory",
    description: "Suggest a lasting note to remember about this person. The app asks them before saving it.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "One short, specific sentence." },
        replaces_note_id: { type: "integer", description: "Id of an existing coach note this one updates, if any." },
      },
      required: ["note"],
    },
  },
];

// ---------------------------------------------------------------------------
// Context, in layers
// ---------------------------------------------------------------------------

type Sb = ReturnType<typeof createClient>;

function must<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new HttpError(500, r.error.message);
  return r.data;
}

function summaryLine(r: any): string {
  const parts = [r.day];
  if (r.food_entries) parts.push(`ate ${r0(r.intake_kcal)} kcal P${r0(r.protein_g)} C${r0(r.carbs_g)} F${r0(r.fat_g)}`);
  else parts.push("no food logged");
  if (r.target_kcal) parts.push(`target ${r.target_kcal}`);
  if (r.exercise_kcal) parts.push(`workout ${r0(r.exercise_kcal)} kcal${r.workouts ? ` (${r.workouts})` : ""}`);
  if (r.steps != null) parts.push(`${r.steps} steps`);
  if (r.sleep_min != null) parts.push(`slept ${(r.sleep_min / 60).toFixed(1)} h`);
  if (r.weight_kg != null) parts.push(`${r.weight_kg} kg`);
  if (r.body_fat_pct != null) parts.push(`${r.body_fat_pct}% fat`);
  return parts.join(" · ");
}

function rollUp(rows: any[], keyOf: (day: string) => string, label: string): string[] {
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const k = keyOf(r.day);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return [...groups.entries()].map(([k, rs]) => {
    const fed = rs.filter((r) => r.food_entries > 0);
    const w = rs.filter((r) => r.weight_kg != null).map((r) => Number(r.weight_kg));
    const parts = [`${label} ${k}`, `${fed.length} days logged`];
    if (fed.length) {
      parts.push(`avg ${r0(avg(fed.map((r) => Number(r.intake_kcal))))} kcal`);
      parts.push(`P${r0(avg(fed.map((r) => Number(r.protein_g))))}`);
    }
    const ex = rs.filter((r) => Number(r.exercise_kcal) > 0).length;
    if (ex) parts.push(`${ex} workout days`);
    const st = rs.filter((r) => r.steps != null).map((r) => Number(r.steps));
    if (st.length) parts.push(`avg ${r0(avg(st))} steps`);
    if (w.length) parts.push(`weight ${w[0]} → ${w[w.length - 1]} kg`);
    return parts.join(" · ");
  });
}

async function buildContext(sb: Sb, today: string): Promise<string> {
  const d14 = addDays(today, -13);
  const d90 = addDays(today, -89);
  const d730 = addDays(today, -729);

  const [profile, notes, targetToday, foods, works, activity, metrics, recentTargets, mid, old] = await Promise.all([
    sb.from("profile").select("sex, birth_date, height_cm, target_bf_pct, loss_rate_pct, protein_g_per_kg, fat_g_per_kg, max_hr, time_zone").maybeSingle(),
    sb.from("coach_notes").select("id, note, updated_at").order("updated_at", { ascending: false }).limit(60),
    sb.from("daily_targets").select("kcal, protein_g, carbs_g, fat_g, source, ai_reason, notes").eq("for_date", today).maybeSingle(),
    sb.from("food_logs").select("eaten_on, meal, status, description, kcal, protein_g, carbs_g, fat_g, items").gte("eaten_on", d14).lte("eaten_on", addDays(today, 7)).order("eaten_on").order("eaten_at"),
    sb.from("workouts").select("done_on, type, description, duration_s, kcal_used, avg_hr, max_hr, training_load, status, source").gte("done_on", d14).neq("status", "dismissed").order("done_on"),
    sb.from("daily_activity").select("day, steps, sleep_min, deep_min, rem_min, low_hr, sleep_hr").gte("day", d14).order("day"),
    sb.from("body_metrics").select("measured_on, weight_kg, body_fat_pct, waist_cm, neck_cm, chest_cm, arm_cm, thigh_cm, hip_cm").gte("measured_on", d90).order("measured_on"),
    sb.from("daily_targets").select("for_date, kcal, protein_g").gte("for_date", d14).lte("for_date", today).order("for_date"),
    sb.from("daily_summary").select("*").gte("day", d90).lt("day", d14).order("day"),
    sb.from("daily_summary").select("*").gte("day", d730).lt("day", d90).order("day"),
  ]);

  const out: string[] = [];
  out.push(`Today is ${today} (the person's local date).`);
  const p = must(profile);
  out.push(p ? `Profile: ${JSON.stringify(p)}` : "Profile: not filled in yet.");

  const n = must(notes) as any[];
  out.push("\nCoach notes (agreed to be remembered):");
  out.push(n.length ? n.map((x) => `[${x.id}] ${x.note}`).join("\n") : "(none yet)");

  const t = must(targetToday) as any;
  out.push(`\nToday's target: ${t ? `${t.kcal} kcal, P${t.protein_g} C${t.carbs_g} F${t.fat_g}${t.source === "ai" ? ` (AI-tuned: ${t.ai_reason})` : ""}` : "not set yet"}`);

  // Last 14 days, granular
  out.push(`\nLAST 14 DAYS IN DETAIL (${d14} to ${today}, plus anything planned ahead)`);
  const tByDay = new Map((must(recentTargets) as any[]).map((r) => [r.for_date, r]));
  const fByDay = new Map<string, any[]>();
  for (const f of must(foods) as any[]) {
    if (!fByDay.has(f.eaten_on)) fByDay.set(f.eaten_on, []);
    fByDay.get(f.eaten_on)!.push(f);
  }
  const wByDay = new Map<string, any[]>();
  for (const w of must(works) as any[]) {
    if (!wByDay.has(w.done_on)) wByDay.set(w.done_on, []);
    wByDay.get(w.done_on)!.push(w);
  }
  const aByDay = new Map((must(activity) as any[]).map((a) => [a.day, a]));
  const mRows = must(metrics) as any[];
  const mByDay = new Map(mRows.map((m) => [m.measured_on, m]));
  const days = new Set<string>([...fByDay.keys(), ...wByDay.keys(), ...aByDay.keys()]);
  for (let i = 0; i < 14; i++) days.add(addDays(d14, i));
  for (const day of [...days].sort()) {
    const lines: string[] = [];
    const tg = tByDay.get(day);
    const a = aByDay.get(day);
    const m = mByDay.get(day);
    const head = [day];
    if (tg) head.push(`target ${tg.kcal} kcal P${tg.protein_g}`);
    if (a?.steps != null) head.push(`${a.steps} steps`);
    if (a?.sleep_min != null) head.push(`slept ${(a.sleep_min / 60).toFixed(1)} h (deep ${a.deep_min ?? "?"} min, REM ${a.rem_min ?? "?"} min)`);
    if (a?.sleep_hr != null) head.push(`average HR while asleep ${a.sleep_hr}`);
    else if (a?.low_hr != null) head.push(`resting HR ${a.low_hr}`);
    if (m) head.push(`weigh-in ${m.weight_kg} kg${m.body_fat_pct != null ? `, ${m.body_fat_pct}% fat` : ""}${m.waist_cm != null ? `, waist ${m.waist_cm}` : ""}`);
    lines.push(head.join(" · "));
    for (const f of fByDay.get(day) ?? []) {
      const items = Array.isArray(f.items) && f.items.length > 1
        ? ` [${f.items.map((i: any) => `${i.name} ${r0(i.grams)}g`).join(", ")}]` : "";
      lines.push(`  ${f.status === "planned" ? "PLANNED " : ""}${f.meal}: ${f.description} — ${r0(f.kcal)} kcal P${r0(f.protein_g)} C${r0(f.carbs_g)} F${r0(f.fat_g)}${items}`);
    }
    for (const w of wByDay.get(day) ?? []) {
      lines.push(`  ${w.status === "suggested" ? "UNCONFIRMED " : ""}workout: ${w.type}${w.description ? ` (${w.description})` : ""}` +
        `${w.duration_s ? `, ${Math.round(w.duration_s / 60)} min` : ""}, ${w.kcal_used} kcal` +
        `${w.avg_hr ? `, avg HR ${w.avg_hr}` : ""}${w.max_hr ? ` max ${w.max_hr}` : ""}${w.training_load ? `, load ${w.training_load}` : ""}`);
    }
    if (lines.length === 1 && !tg && !a && !m) lines[0] += " · nothing logged";
    out.push(lines.join("\n"));
  }

  // Days 15-90, one line each
  const midRows = must(mid) as any[];
  if (midRows.length) {
    out.push(`\nDAYS 15-90 (one line per day)`);
    out.push(midRows.map(summaryLine).join("\n"));
  }

  // Older: weekly within the last year, monthly before that
  const oldRows = must(old) as any[];
  if (oldRows.length) {
    const yearAgo = addDays(today, -364);
    const weekOf = (d: string) => {
      const dt = new Date(d + "T00:00:00Z");
      const monday = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86_400_000);
      return monday.toISOString().slice(0, 10);
    };
    const weekly = oldRows.filter((r) => r.day >= yearAgo);
    const monthly = oldRows.filter((r) => r.day < yearAgo);
    out.push(`\nOLDER HISTORY (summaries; use get_range or get_day for detail)`);
    if (monthly.length) out.push(rollUp(monthly, (d) => d.slice(0, 7), "Month").join("\n"));
    if (weekly.length) out.push(rollUp(weekly, weekOf, "Week of").join("\n"));
  }

  // Body measurements over 90 days, first and latest
  if (mRows.length > 1) {
    const first = mRows[0], last = mRows[mRows.length - 1];
    out.push(`\nWeight ${first.measured_on} ${first.weight_kg} kg → ${last.measured_on} ${last.weight_kg} kg` +
      (first.waist_cm && last.waist_cm ? `; waist ${first.waist_cm} → ${last.waist_cm} cm` : ""));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

async function runTool(sb: Sb, name: string, input: any, proposals: any[]): Promise<string> {
  if (name === "propose_memory") {
    const note = String(input.note ?? "").trim().slice(0, 400);
    if (note.length < 3) return "Note too short; not proposed.";
    if (proposals.length >= 2) return "Already proposed two notes this reply; not proposed.";
    proposals.push({ note, replaces_note_id: Number.isInteger(input.replaces_note_id) ? input.replaces_note_id : null });
    return "Shown to the user. It is saved only if they agree.";
  }
  if (name === "get_day") {
    const d = String(input.date ?? "");
    if (!DAY.test(d)) return "date must be YYYY-MM-DD.";
    const [f, w, a, m, t] = await Promise.all([
      sb.from("food_logs").select("meal, status, description, kcal, protein_g, carbs_g, fat_g, fiber_g, items").eq("eaten_on", d).order("eaten_at"),
      sb.from("workouts").select("type, description, duration_s, kcal_used, avg_hr, max_hr, training_load, status").eq("done_on", d).neq("status", "dismissed"),
      sb.from("daily_activity").select("*").eq("day", d).maybeSingle(),
      sb.from("body_metrics").select("*").eq("measured_on", d).maybeSingle(),
      sb.from("daily_targets").select("kcal, protein_g, carbs_g, fat_g, source").eq("for_date", d).maybeSingle(),
    ]);
    return JSON.stringify({ date: d, food: f.data, workouts: w.data, activity: a.data, weigh_in: m.data, target: t.data });
  }
  if (name === "search_meals") {
    const q = String(input.query ?? "").trim().toLowerCase().slice(0, 60);
    if (!q) return "Empty query.";
    const from = DAY.test(input.from ?? "") ? input.from : "0001-01-01";
    const to = DAY.test(input.to ?? "") ? input.to : "9999-12-31";
    const { data, error } = await sb.from("food_logs")
      .select("eaten_on, meal, description, kcal, protein_g, carbs_g, fat_g, items")
      .eq("status", "eaten").gte("eaten_on", from).lte("eaten_on", to)
      .order("eaten_on", { ascending: false }).limit(3000);
    if (error) return `Search failed: ${error.message}`;
    const hits = (data ?? []).filter((f: any) =>
      String(f.description).toLowerCase().includes(q) ||
      (Array.isArray(f.items) && f.items.some((i: any) => String(i.name ?? "").toLowerCase().includes(q))));
    return hits.length ? JSON.stringify(hits.slice(0, 30)) : `No meals matching "${q}".`;
  }
  if (name === "get_range") {
    const from = String(input.from ?? ""), to = String(input.to ?? "");
    if (!DAY.test(from) || !DAY.test(to)) return "from and to must be YYYY-MM-DD.";
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (span < 0 || span > 120) return "Range must be 0 to 120 days.";
    const { data, error } = await sb.from("daily_summary").select("*").gte("day", from).lte("day", to).order("day");
    if (error) return `Lookup failed: ${error.message}`;
    return (data ?? []).map(summaryLine).join("\n") || "Nothing logged in that range.";
  }
  return `Unknown tool ${name}.`;
}

// ---------------------------------------------------------------------------
// Claude, with tools
// ---------------------------------------------------------------------------

async function callClaude(system: any[], messages: any[]): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, output_config: { effort: "medium" }, system, tools: TOOLS, messages }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) return await res.json();
    const detail = (await res.text()).slice(0, 300);
    if ((res.status === 529 || res.status === 500 || res.status === 503) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    throw new HttpError(res.status === 529 ? 503 : 502, `Claude error ${res.status}: ${detail}`);
  }
  throw new HttpError(503, "Claude is busy right now. Try again in a minute.");
}

export async function converse(sb: Sb, context: string, history: any[], message: string) {
  const system = [
    { type: "text", text: SYSTEM },
    // The context is identical across a conversation's turns, so it is cached
    { type: "text", text: context, cache_control: { type: "ephemeral" } },
  ];
  const messages: any[] = [...history, { role: "user", content: message }];
  const proposals: any[] = [];
  let reply = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data = await callClaude(system, messages);
    const blocks: any[] = data.content ?? [];
    reply = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || reply;
    if (data.stop_reason === "refusal") { reply = reply || "I can't help with that one."; break; }
    if (data.stop_reason !== "tool_use") break;

    // Pass the whole assistant turn back (thinking blocks included), then the tool results
    messages.push({ role: "assistant", content: blocks });
    const results = [];
    for (const b of blocks.filter((b) => b.type === "tool_use")) {
      let content: string;
      try {
        content = await runTool(sb, b.name, b.input ?? {}, proposals);
      } catch (e) {
        content = `Tool failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      results.push({ type: "tool_result", tool_use_id: b.id, content: content.slice(0, 60_000) });
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: reply || "(No reply.)", proposals };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    if (!ANTHROPIC_KEY) throw new HttpError(500, "The coach needs the ANTHROPIC_API_KEY secret.");
    const auth = req.headers.get("Authorization");
    if (!auth) throw new HttpError(401, "Not signed in.");
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "",
      { global: { headers: { Authorization: auth } } },
    );
    const { data: { user }, error } = await sb.auth.getUser();
    if (error || !user) throw new HttpError(401, "Not signed in.");

    const body = await req.json();
    const message = String(body.message ?? "").trim().slice(0, 4000);
    const today = String(body.today ?? "");
    if (!message) throw new HttpError(400, "Say something first.");
    if (!DAY.test(today)) throw new HttpError(400, "today must be YYYY-MM-DD.");
    const threadId: string = typeof body.thread_id === "string" && body.thread_id ? body.thread_id : crypto.randomUUID();

    const hist = must(await sb.from("coach_messages").select("role, content")
      .eq("thread_id", threadId).order("id", { ascending: false }).limit(HISTORY_MESSAGES)) as any[];
    const history = hist.reverse().map((m) => ({ role: m.role, content: m.content }));
    // The API needs the conversation to start with the user
    while (history.length && history[0].role !== "user") history.shift();

    const context = await buildContext(sb, today);
    const { reply, proposals } = await converse(sb, context, history, message);

    must(await sb.from("coach_messages").insert([
      { thread_id: threadId, role: "user", content: message },
      { thread_id: threadId, role: "assistant", content: reply, proposals: proposals.length ? proposals : null },
    ]));

    return json({ thread_id: threadId, reply, proposals });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
