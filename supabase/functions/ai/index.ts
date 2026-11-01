// Edge Function: ai
// Reads food photos, typed meals, nutrition labels and Mi Fitness workout images with Gemini,
// and returns checked JSON for the app to show you before anything is saved.
// It never writes to the database; the app saves only what you confirm.
//
// Secrets (Edge Functions > Secrets):
//   GEMINI_API_KEY   required, from Google AI Studio
//   GEMINI_MODEL     optional, defaults to gemini-3.8-flash
//   ALLOWED_ORIGIN   optional, e.g. https://smith-teaches-tech.github.io
//
// Request (POST, JSON, with your signed-in session token):
//   { "mode": "food_photo" | "food_text" | "label" | "workout",
//     "image": "<base64, no data: prefix>", "mime_type": "image/jpeg",
//     "note": "ingredients, weights, or what the workout was" }
//   { "mode": "review", "today": "YYYY-MM-DD", "days": 7 }   recommendations from your logs;
//   days: 1 reviews one day including planned meals, 7 (default) the last week

import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const MAX_IMAGE_B64 = 8_000_000; // about 6 MB of image

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const FOOD_PROMPT = `You estimate the nutrition of one meal for a calorie-tracking app.

Rules:
- The user's note is the primary source. When it gives an ingredient or a gram weight, use that exact weight and mark grams_source "stated". Never re-estimate a stated weight.
- Estimate portion sizes only for items the note does not weigh, and mark those grams_source "estimated".
- Use standard nutrition database values (USDA-style). Match the cooked or raw state described; if not stated, assume the food as served on the plate.
- Include cooking oil, butter, sauces and dressings when visible or stated. If a dish is normally cooked in oil and none is mentioned, include a modest amount as its own item and list it in assumptions.
- One item per distinct food. Do not add a totals field; the app adds up the items.

Return JSON only, in exactly this shape:
{"items":[{"name":string,"grams":number,"grams_source":"stated"|"estimated","kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number,"fiber_g":number}],
 "confidence":"high"|"medium"|"low",
 "assumptions":[string],
 "question":string|null}

confidence: "high" when every weight is stated; "medium" when ingredients are stated but some weights are estimated; "low" when working from the photo alone.
question: the single short question whose answer would most improve accuracy, or null.`;

const LABEL_PROMPT = `Read the nutrition facts label in this image for a calorie-tracking app.
The label may be in English, Arabic or both; read the numbers, whatever the language.

Rules:
- Return values per 100 g (per 100 ml for drinks). If the label only gives per-serving values, convert using the serving size in grams or ml.
- If energy is only given in kJ, divide by 4.184 to get kcal.
- Use the carbohydrate number exactly as the label prints it.
- Use null for anything not printed. Do not guess numbers that are not on the label.

Return JSON only, in exactly this shape:
{"name":string|null,"brand":string|null,"basis":"100g"|"100ml","serving_g":number|null,
 "kcal_100g":number,"protein_100g":number,"carbs_100g":number,"fat_100g":number,"fiber_100g":number|null,
 "read_confidence":"high"|"medium"|"low","notes":string|null}`;

const WORKOUT_PROMPT = `This image is a workout summary shared from the Xiaomi Mi Fitness app.
Read the numbers exactly as printed. Do not estimate anything that is not printed; use null for missing fields.

Notes on the layout:
- The workout type is the large title at the top (for example "Cross training").
- The date under the title is MM/DD/YYYY followed by a 24-hour time.
- The large kcal number near the top is ACTIVE calories. "Total kcal" is total calories.
- Heart-rate zones are listed as Light, Intensive, Aerobic, Anaerobic and VO2 max, each with a time.
- Convert every HH:MM:SS time to seconds.

Return JSON only, in exactly this shape:
{"type":string,"started_at_local":"YYYY-MM-DDTHH:MM"|null,"duration_s":integer|null,
 "active_kcal":integer|null,"total_kcal":integer|null,"avg_hr":integer|null,"max_hr":integer|null,
 "zones_s":{"light":integer|null,"intensive":integer|null,"aerobic":integer|null,"anaerobic":integer|null,"vo2max":integer|null},
 "aerobic_te":number|null,"anaerobic_te":number|null,"training_load":integer|null,"recovery_h":integer|null,
 "device":string|null}`;

const REVIEW_PROMPT = `You are a sports nutrition coach reviewing food and training logs
for someone cutting toward a body fat target while keeping muscle.

You get JSON with: the period (one day or a week), profile, daily targets, each day's food entries
(with ingredient breakdowns where known), workouts, steps and weigh-ins.
Entries with "status":"planned" are meals planned but not eaten yet. For a single day, review the day as
it will be if the plan is followed, and say whether the plan lands on the calorie and protein targets and
what one or two swaps would get it closer.

Write a short, specific review:
- Base every point on the actual foods and numbers in the log. Name the foods. Use numbers.
- Look for: protein short of target or bunched into one meal; calories over or under target and on which days;
  carbs coming mostly from fruit, juice, sweets or drinks; low fibre or vegetables; heavy evening eating;
  low-carb days before hard training; weekends versus weekdays; foods that keep appearing and cost a lot of calories.
- Missing days or meals are normal; mention them only if they make the review unreliable.
- No medical advice, no supplements, no moralising. Plain, friendly, direct.

Return JSON only, in exactly this shape:
{"summary":string,                       // two sentences at most
 "wins":[string],                        // up to 2
 "recommendations":[{"title":string,"detail":string}]}  // 2 to 4, most important first`;

// ---------------------------------------------------------------------------
// Gemini call
// ---------------------------------------------------------------------------

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

async function gemini(parts: Part[]): Promise<any> {
  if (!GEMINI_KEY) throw new HttpError(500, "GEMINI_API_KEY secret is not set.");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    },
  );
  if (res.status === 429) {
    throw new HttpError(429, "Free Gemini quota used up for now. Try again in a minute, or tomorrow if the daily limit is hit.");
  }
  if (!res.ok) {
    throw new HttpError(502, `Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const text: string = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string }) => p.text ?? "")
    .join("")
    .replace(/^```(?:json)?\s*|\s*```$/g, "")
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, `Gemini did not return valid JSON: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Checks on what the model returns (the app shows these warnings to you)
// ---------------------------------------------------------------------------

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r1 = (v: number) => Math.round(v * 10) / 10;

function checkFood(out: any) {
  const warnings: string[] = [];
  const items = Array.isArray(out.items) ? out.items : [];
  if (items.length === 0) throw new HttpError(422, "No food items found.");

  const totals = { grams: 0, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  for (const it of items) {
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[k] += num(it[k]) ?? 0;
    }
    // Calories should roughly match 4/4/9 from the macros
    const fromMacros = 4 * (num(it.protein_g) ?? 0) + 4 * (num(it.carbs_g) ?? 0) + 9 * (num(it.fat_g) ?? 0);
    const kcal = num(it.kcal) ?? 0;
    if (kcal > 40 && Math.abs(fromMacros - kcal) / kcal > 0.2) {
      warnings.push(`${it.name}: calories (${Math.round(kcal)}) don't match its macros (${Math.round(fromMacros)}). Check this item.`);
    }
  }
  for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = r1(totals[k]);

  return {
    items,
    totals,
    confidence: out.confidence ?? "low",
    assumptions: Array.isArray(out.assumptions) ? out.assumptions : [],
    question: out.question ?? null,
    warnings,
  };
}

function checkLabel(out: any) {
  const warnings: string[] = [];
  const p = num(out.protein_100g) ?? 0, c = num(out.carbs_100g) ?? 0, f = num(out.fat_100g) ?? 0;
  const kcal = num(out.kcal_100g);
  if (kcal === null) throw new HttpError(422, "Couldn't read calories from the label.");
  if (p + c + f > 102) warnings.push("Protein, carbs and fat add up to more than 100 g per 100 g. A number was probably misread.");
  const fromMacros = 4 * p + 4 * c + 9 * f;
  if (kcal > 40 && Math.abs(fromMacros - kcal) / kcal > 0.2) {
    warnings.push(`Label calories (${kcal}) don't match its macros (${Math.round(fromMacros)}). Check the reading.`);
  }
  return { ...out, warnings };
}

function checkWorkout(out: any) {
  const warnings: string[] = [];
  const z = out.zones_s ?? {};
  const zoneSum = ["light", "intensive", "aerobic", "anaerobic", "vo2max"]
    .reduce((s, k) => s + (num(z[k]) ?? 0), 0);
  const dur = num(out.duration_s);
  if (dur && zoneSum > 0 && Math.abs(zoneSum - dur) / dur > 0.1) {
    warnings.push(`Heart-rate zone times add to ${zoneSum}s but the workout lasted ${dur}s. A time was probably misread.`);
  }
  const avg = num(out.avg_hr), max = num(out.max_hr);
  if (avg && max && avg > max) warnings.push("Average heart rate is above max heart rate. One was misread.");
  if (!out.started_at_local) warnings.push("Couldn't read the start time; set it before saving.");
  if (num(out.active_kcal) === null) warnings.push("Couldn't read active calories; enter the burn before saving.");

  return {
    ...out,
    done_on: typeof out.started_at_local === "string" ? out.started_at_local.slice(0, 10) : null,
    kcal_used: num(out.active_kcal), // the plan eats this back the next day; you can override it
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    // Only your signed-in session may spend the Gemini quota
    const auth = req.headers.get("Authorization");
    if (!auth) throw new HttpError(401, "Not signed in.");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "",
      { global: { headers: { Authorization: auth } } },
    );
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) throw new HttpError(401, "Not signed in.");

    const body = await req.json();
    const mode: string = body.mode;
    const note: string = (body.note ?? "").toString().slice(0, 2000);
    const image: string | undefined = body.image;
    const mimeType: string = body.mime_type ?? "image/jpeg";

    if (image && image.length > MAX_IMAGE_B64) throw new HttpError(413, "Image too large. Send it under about 6 MB.");
    const imagePart: Part[] = image ? [{ inlineData: { mimeType, data: image } }] : [];

    switch (mode) {
      case "food_photo": {
        if (!image) throw new HttpError(400, "food_photo needs an image.");
        const out = await gemini([{ text: FOOD_PROMPT }, ...imagePart, { text: `User's note: ${note || "(none)"}` }]);
        return json(checkFood(out));
      }
      case "food_text": {
        if (!note) throw new HttpError(400, "food_text needs a note describing the meal.");
        const out = await gemini([{ text: FOOD_PROMPT }, { text: `No photo. User's note: ${note}` }]);
        return json(checkFood(out));
      }
      case "label": {
        if (!image) throw new HttpError(400, "label needs an image.");
        const out = await gemini([{ text: LABEL_PROMPT }, ...imagePart]);
        return json(checkLabel(out));
      }
      case "workout": {
        if (!image) throw new HttpError(400, "workout needs an image.");
        const out = await gemini([{ text: WORKOUT_PROMPT }, ...imagePart]);
        return json({ ...checkWorkout(out), description: note || null });
      }
      case "review": {
        // `days` days ending `today` (a local YYYY-MM-DD date sent by the app). 1 = one day, including planned meals.
        const today: string = body.today;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? "")) throw new HttpError(400, "review needs today as YYYY-MM-DD.");
        const days = Math.min(14, Math.max(1, Math.round(Number(body.days) || 7)));
        const start = new Date(Date.parse(today + "T00:00:00Z") - (days - 1) * 86_400_000).toISOString().slice(0, 10);
        const [prof, foods, targets, works, steps, weights] = await Promise.all([
          supabase.from("profile").select("sex, birth_date, height_cm, target_bf_pct, protein_g_per_kg").maybeSingle(),
          supabase.from("food_logs").select("eaten_on, meal, description, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, items, status")
            .in("status", days === 1 ? ["eaten", "planned"] : ["eaten"]).gte("eaten_on", start).lte("eaten_on", today).order("eaten_on").order("eaten_at"),
          supabase.from("daily_targets").select("for_date, kcal, protein_g, carbs_g, fat_g").gte("for_date", start).lte("for_date", today),
          supabase.from("workouts").select("done_on, type, description, duration_s, kcal_used, avg_hr, training_load")
            .gte("done_on", start).lte("done_on", today),
          supabase.from("daily_activity").select("day, steps").gte("day", start).lte("day", today),
          supabase.from("body_metrics").select("measured_on, weight_kg, body_fat_pct").gte("measured_on", start).lte("measured_on", today),
        ]);
        for (const r of [prof, foods, targets, works, steps, weights]) if (r.error) throw new HttpError(500, r.error.message);
        if (!foods.data?.length) {
          throw new HttpError(422, days === 1 ? "Nothing logged or planned for that day yet." : `No meals logged in the last ${days} days to review.`);
        }
        const week = {
          period: days === 1 ? "one day" : `${days} days`,
          from: start, to: today,
          profile: prof.data,
          targets: targets.data, food: foods.data, workouts: works.data, steps: steps.data, weigh_ins: weights.data,
        };
        const out = await gemini([{ text: REVIEW_PROMPT }, { text: JSON.stringify(week) }]);
        return json({
          summary: out.summary ?? "",
          wins: Array.isArray(out.wins) ? out.wins.slice(0, 2) : [],
          recommendations: Array.isArray(out.recommendations) ? out.recommendations.slice(0, 4) : [],
          days_logged: new Set(foods.data.map((f) => f.eaten_on)).size,
        });
      }
      default:
        throw new HttpError(400, "mode must be food_photo, food_text, label, workout or review.");
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
