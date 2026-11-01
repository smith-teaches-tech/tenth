// Edge Function: plan
// Works out tomorrow's calories and macros, and the timeline to target body fat.
// Pure arithmetic, no AI. Reads your data, writes one row to daily_targets (unless save is false).
//
// How the numbers are made:
// 1. Everyday burn (excluding workouts) starts from the Mifflin-St Jeor formula x activity factor.
// 2. Once there are 14+ logged days and enough weigh-ins, the app measures your real burn:
//    average intake minus (weight trend x 7700 kcal/kg) minus average workout burn.
//    It blends that in, reaching 100% measured at 28 logged days. This corrects for
//    inaccurate watch calories and inaccurate food estimates alike.
// 3. Missed meals: the plan learns which meals you usually log and what they usually come to.
//    A day with lunch but no dinner gets your typical dinner filled in. Days with nothing
//    logged are left out. Days still far below your normal after filling are left out too.
// 4. Tomorrow = everyday burn + today's workout burn (eaten back)
//               + today's steps vs your 28-day average - deficit.
//    Deficit comes from the loss rate in your profile (default 0.5% of bodyweight a week; 0.25 to 1.0 allowed).
// 5. Protein and fat are set per kg of bodyweight; carbs fill the rest.
// 6. Body fat for the timeline is the average of your last 3 readings, to smooth tape-measure noise.
//
// Request (POST, JSON, with your signed-in session token):
//   { "today": "YYYY-MM-DD", "for_date": "YYYY-MM-DD", "save": true }
//   both LOCAL dates; for_date is usually tomorrow. save: false returns the plan without storing it.
//
// Secret (optional): ALLOWED_ORIGIN, e.g. https://smith-teaches-tech.github.io

import { createClient } from "npm:@supabase/supabase-js@2";

const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// --- math start ---

export type Profile = {
  sex: "male" | "female";
  birth_date: string;
  height_cm: number;
  target_bf_pct: number;
  loss_rate_pct: number;
  protein_g_per_kg: number;
  fat_g_per_kg: number;
  activity_factor: number;
};

export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type Meal = typeof MEALS[number];

/** One calendar day of history. meals holds logged kcal per meal; exercise is workout burn. */
export type Day = {
  day: string;
  meals: Record<Meal, number>;
  entries: number;
  exercise: number;
  steps: number | null;
};

export const KCAL_PER_KG = 7700;
const MIN_LOGGED_DAYS = 14;
const FULL_TRUST_DAYS = 28;
const USUAL_MEAL_SHARE = 0.6;   // a meal is "usual" if it appears on 60%+ of logged days
const MIN_DAYS_FOR_USUAL = 5;
const KCAL_PER_STEP_PER_KG = 0.0005; // about 0.04 kcal per step at 85 kg
const MAX_STEPS_ADJUST = 400;

const DAY_MS = 86_400_000;
export const dayNum = (d: string) => Math.round(Date.parse(d + "T00:00:00Z") / DAY_MS);
export const addDays = (d: string, n: number) =>
  new Date(Date.parse(d + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
export const emptyMeals = (): Record<Meal, number> => ({ breakfast: 0, lunch: 0, dinner: 0, snack: 0 });

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function ageOn(birth: string, on: string): number {
  const [by, bm, bd] = birth.split("-").map(Number);
  const [y, m, d] = on.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Mifflin-St Jeor resting burn. */
export function bmr(sex: Profile["sex"], kg: number, cm: number, age: number): number {
  return 10 * kg + 6.25 * cm - 5 * age + (sex === "male" ? 5 : -161);
}

/** Least-squares line through weigh-ins. slope is kg per day; current is the line's value on `on`. */
export function weightTrend(points: { day: string; w: number }[], on: string) {
  if (points.length < 2) return null;
  const xs = points.map((p) => dayNum(p.day));
  const ys = points.map((p) => p.w);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, current: my + slope * (dayNum(on) - mx), spanDays: Math.max(...xs) - Math.min(...xs) };
}

/**
 * Fill in missed meals with your usual amounts, then drop days that still look incomplete.
 * Returns each counted day's estimated intake, plus how many meals were filled in.
 */
export function estimateIntake(history: Day[]) {
  const logged = history.filter((d) => d.entries > 0);
  const usual = new Map<Meal, number>(); // meal -> median kcal on days it was logged
  for (const m of MEALS) {
    const withMeal = logged.filter((d) => d.meals[m] > 0);
    if (withMeal.length >= MIN_DAYS_FOR_USUAL && withMeal.length / Math.max(1, logged.length) >= USUAL_MEAL_SHARE) {
      usual.set(m, median(withMeal.map((d) => d.meals[m])));
    }
  }

  let filled = 0;
  const estimated = logged.map((d) => {
    let kcal = 0;
    for (const m of MEALS) {
      if (d.meals[m] > 0) kcal += d.meals[m];
      else if (usual.has(m)) { kcal += usual.get(m)!; filled++; }
    }
    return { day: d.day, kcal };
  });

  // Anything still under half your typical day is treated as not properly logged
  const typical = estimated.length ? median(estimated.map((d) => d.kcal)) : 0;
  const counted = estimated.filter((d) => d.kcal >= typical * 0.5);
  return { counted, filled, dropped: estimated.length - counted.length, usualMeals: Object.fromEntries(usual) };
}

/** Weeks to go from current weight to goal weight, losing loss_rate_pct of CURRENT weight each week. */
export function timeline(weight: number, bfPct: number, targetPct: number, ratePct: number, from: string) {
  const leanKg = weight * (1 - bfPct / 100);
  const goalWeight = leanKg / (1 - targetPct / 100);
  const toLose = weight - goalWeight;
  if (toLose <= 0) return { lean_kg: leanKg, goal_weight_kg: goalWeight, kg_to_lose: 0, weeks: 0, eta: from };
  const weeks = Math.log(weight / goalWeight) / -Math.log(1 - ratePct / 100);
  return {
    lean_kg: leanKg,
    goal_weight_kg: goalWeight,
    kg_to_lose: toLose,
    weeks,
    eta: addDays(from, Math.ceil(weeks * 7)),
  };
}

export type PlanInput = {
  profile: Profile;
  history: Day[];          // the 28 days BEFORE today (today's food log is usually incomplete, so it is left out)
  todayExercise: number;   // workout burn logged today, eaten back tomorrow
  todayLoad: number;       // Mi Fitness training load logged today
  todaySteps: number | null;
  weighIns: { day: string; w: number }[]; // weigh-ins from 28 days ago up to and including today
  latestWeight: number;    // most recent weigh-in
  bfPct: number | null;    // average of recent body fat readings
  today: string;
};

export function makePlan(inp: PlanInput) {
  const p = inp.profile;
  const notes: string[] = [];

  // Current weight: trend line if there are enough weigh-ins, else the latest weigh-in
  const weighIns = inp.weighIns;
  const trend = weighIns.length >= 5 ? weightTrend(weighIns, inp.today) : null;
  const weight = trend ? trend.current : inp.latestWeight;

  const age = ageOn(p.birth_date, inp.today);
  const restKcal = bmr(p.sex, weight, p.height_cm, age);
  const formulaNeat = restKcal * p.activity_factor;

  // Measured everyday burn, once there is enough data
  const intake = estimateIntake(inp.history);
  if (intake.filled > 0) notes.push(`Filled ${intake.filled} missed meal${intake.filled === 1 ? "" : "s"} with your usual amounts.`);
  if (intake.dropped > 0) notes.push(`Left out ${intake.dropped} day${intake.dropped === 1 ? "" : "s"} that looked only partly logged.`);

  let neat = formulaNeat;
  let method: "formula" | "blended" | "adaptive" = "formula";
  let measuredNeat: number | null = null;

  if (intake.counted.length >= MIN_LOGGED_DAYS && trend && weighIns.length >= 8 && trend.spanDays >= 14) {
    const avgIntake = intake.counted.reduce((s, d) => s + d.kcal, 0) / intake.counted.length;
    const avgExercise = inp.history.reduce((s, d) => s + d.exercise, 0) / inp.history.length;
    const raw = avgIntake - trend.slope * KCAL_PER_KG - avgExercise;
    // Backstop against bad logging: keep the measurement within 35% of the formula
    measuredNeat = Math.min(Math.max(raw, formulaNeat * 0.65), formulaNeat * 1.35);
    if (measuredNeat !== raw) notes.push("Measured burn looked off, so it was capped near the formula.");
    const trust = Math.min(1, intake.counted.length / FULL_TRUST_DAYS);
    neat = trust * measuredNeat + (1 - trust) * formulaNeat;
    method = trust >= 1 ? "adaptive" : "blended";
  } else {
    notes.push(
      `Using the formula until there are ${MIN_LOGGED_DAYS} logged days and 8 weigh-ins over 2 weeks ` +
        `(now ${intake.counted.length} days, ${weighIns.length} weigh-ins).`,
    );
  }

  // Steps: today's count vs your own average, so normal walking isn't counted twice
  let stepsAdjust = 0;
  const stepDays = inp.history.filter((d) => d.steps !== null).map((d) => d.steps as number);
  if (inp.todaySteps !== null && stepDays.length >= 7) {
    const avgSteps = stepDays.reduce((a, b) => a + b, 0) / stepDays.length;
    stepsAdjust = (inp.todaySteps - avgSteps) * KCAL_PER_STEP_PER_KG * weight;
    stepsAdjust = Math.max(-MAX_STEPS_ADJUST, Math.min(MAX_STEPS_ADJUST, stepsAdjust));
  } else if (inp.todaySteps !== null) {
    notes.push(`Steps count toward the plan after 7 days of step logs (now ${stepDays.length}).`);
  }

  // Deficit from the chosen loss rate, unless the target is already reached
  let tl = null as ReturnType<typeof timeline> | null;
  let deficit = (weight * p.loss_rate_pct) / 100 * KCAL_PER_KG / 7;
  if (inp.bfPct !== null) {
    tl = timeline(weight, inp.bfPct, p.target_bf_pct, p.loss_rate_pct, inp.today);
    if (tl.kg_to_lose <= 0) {
      deficit = 0;
      notes.push("At or below target body fat: eating at maintenance.");
    }
  } else {
    notes.push("Add waist and neck measurements to a weigh-in to get a body fat timeline.");
  }
  // Never cut more than a quarter of the day's burn
  const dayBurn = neat + inp.todayExercise + stepsAdjust;
  if (deficit > dayBurn * 0.25) {
    deficit = dayBurn * 0.25;
    notes.push("Deficit capped at 25% of the day's burn.");
  }

  // Calories, with a floor
  const floor = Math.max(restKcal, p.sex === "male" ? 1500 : 1200);
  let kcal = dayBurn - deficit;
  if (kcal < floor) {
    kcal = floor;
    notes.push("Raised to the minimum safe intake.");
  }

  // Macros: protein and fat per kg, carbs fill the rest
  const protein = p.protein_g_per_kg * weight;
  let fat = p.fat_g_per_kg * weight;
  let carbs = (kcal - 4 * protein - 9 * fat) / 4;
  if (carbs < 50) {
    fat = Math.max(0.6 * weight, (kcal - 4 * protein - 4 * 50) / 9);
    carbs = Math.max(0, (kcal - 4 * protein - 9 * fat) / 4);
    notes.push("Fat trimmed to keep some carbs for training.");
  }

  if (inp.todayLoad >= 200 || inp.todayExercise >= 500) {
    notes.push("Hard session today: the extra calories are mostly carbs. Put them around tomorrow's training and keep protein high.");
  }

  return {
    kcal: Math.round(kcal),
    protein_g: Math.round(protein),
    carbs_g: Math.round(carbs),
    fat_g: Math.round(fat),
    neat_kcal: Math.round(neat),
    exercise_kcal: Math.round(inp.todayExercise),
    steps_adjust_kcal: Math.round(stepsAdjust),
    deficit_kcal: Math.round(deficit),
    method,
    detail: {
      weight_used_kg: Math.round(weight * 10) / 10,
      trend_kg_per_week: trend ? Math.round(trend.slope * 7 * 100) / 100 : null,
      formula_neat_kcal: Math.round(formulaNeat),
      measured_neat_kcal: measuredNeat === null ? null : Math.round(measuredNeat),
      logged_days: intake.counted.length,
      meals_filled: intake.filled,
      usual_meals_kcal: Object.fromEntries(Object.entries(intake.usualMeals).map(([k, v]) => [k, Math.round(v as number)])),
      weigh_ins: weighIns.length,
      body_fat_pct_used: inp.bfPct,
    },
    timeline: tl && {
      lean_kg: Math.round(tl.lean_kg * 10) / 10,
      goal_weight_kg: Math.round(tl.goal_weight_kg * 10) / 10,
      kg_to_lose: Math.round(tl.kg_to_lose * 10) / 10,
      weeks: Math.round(tl.weeks * 10) / 10,
      eta: tl.eta,
      assumes: "All weight lost is fat and lean mass holds. Expect the real date to run a little later.",
    },
    notes,
  };
}

// --- math end ---

const DATE = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Not signed in." }, 401);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "",
      { global: { headers: { Authorization: auth } } },
    );
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "Not signed in." }, 401);

    const { today, for_date, save = true } = await req.json();
    if (!DATE.test(today ?? "") || !DATE.test(for_date ?? "")) {
      return json({ error: "Send today and for_date as YYYY-MM-DD local dates." }, 400);
    }
    const start = addDays(today, -28);
    const yesterday = addDays(today, -1);

    // Row level security limits every query to your rows
    const [prof, metrics, bfRows, foods, works, steps] = await Promise.all([
      supabase.from("profile").select("*").maybeSingle(),
      supabase.from("body_metrics").select("measured_on, weight_kg").gte("measured_on", start).lte("measured_on", today).order("measured_on"),
      supabase.from("body_metrics").select("body_fat_pct").not("body_fat_pct", "is", null)
        .gte("measured_on", addDays(today, -42)).lte("measured_on", today).order("measured_on", { ascending: false }).limit(3),
      supabase.from("food_logs").select("eaten_on, meal, kcal").eq("status", "eaten").gte("eaten_on", start).lte("eaten_on", yesterday),
      supabase.from("workouts").select("done_on, kcal_used, training_load").gte("done_on", start).lte("done_on", today),
      supabase.from("daily_activity").select("day, steps").gte("day", start).lte("day", today),
    ]);
    for (const r of [prof, metrics, bfRows, foods, works, steps]) if (r.error) throw r.error;
    if (!prof.data) return json({ error: "Fill in your profile first (Settings)." }, 400);
    if (!metrics.data?.length) return json({ error: "Log a weigh-in first." }, 400);

    // Build the 28-day history (start .. yesterday)
    const history: Day[] = [];
    for (let i = 0; i < 28; i++) {
      history.push({ day: addDays(start, i), meals: emptyMeals(), entries: 0, exercise: 0, steps: null });
    }
    const byDay = new Map(history.map((d) => [d.day, d]));
    for (const f of foods.data!) {
      const d = byDay.get(f.eaten_on);
      if (d) { d.meals[f.meal as Meal] += Number(f.kcal); d.entries++; }
    }
    let todayExercise = 0, todayLoad = 0;
    for (const w of works.data!) {
      if (w.done_on === today) { todayExercise += w.kcal_used; todayLoad += w.training_load ?? 0; }
      else { const d = byDay.get(w.done_on); if (d) d.exercise += w.kcal_used; }
    }
    let todaySteps: number | null = null;
    for (const s of steps.data!) {
      if (s.day === today) todaySteps = s.steps;
      else { const d = byDay.get(s.day); if (d) d.steps = s.steps; }
    }
    const weighIns = metrics.data.map((m) => ({ day: m.measured_on as string, w: Number(m.weight_kg) }));
    const latestWeight = weighIns[weighIns.length - 1].w;
    const bfVals = bfRows.data!.map((r) => Number(r.body_fat_pct));
    const bfPct = bfVals.length ? Math.round((bfVals.reduce((a, b) => a + b, 0) / bfVals.length) * 10) / 10 : null;

    const profile: Profile = {
      ...prof.data,
      height_cm: Number(prof.data.height_cm),
      target_bf_pct: Number(prof.data.target_bf_pct),
      loss_rate_pct: Number(prof.data.loss_rate_pct),
      protein_g_per_kg: Number(prof.data.protein_g_per_kg),
      fat_g_per_kg: Number(prof.data.fat_g_per_kg),
      activity_factor: Number(prof.data.activity_factor),
    };
    const plan = makePlan({ profile, history, todayExercise, todayLoad, todaySteps, weighIns, latestWeight, bfPct, today });

    if (save) {
      const { error: upErr } = await supabase.from("daily_targets").upsert({
        for_date,
        kcal: plan.kcal,
        protein_g: plan.protein_g,
        carbs_g: plan.carbs_g,
        fat_g: plan.fat_g,
        neat_kcal: plan.neat_kcal,
        exercise_kcal: plan.exercise_kcal,
        steps_adjust_kcal: plan.steps_adjust_kcal,
        deficit_kcal: plan.deficit_kcal,
        method: plan.method,
        notes: plan.notes.join(" "),
      }, { onConflict: "user_id,for_date" });
      if (upErr) throw upErr;
    }

    return json({ for_date, saved: !!save, ...plan });
  } catch (e) {
    const msg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
    return json({ error: msg }, 500);
  }
});
