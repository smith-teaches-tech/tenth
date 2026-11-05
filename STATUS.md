# Tenth: where things stand (5 Nov 2026, 20:00)

Handoff notes for the next chat. Setup steps are in `README.md`; this file is the state of the build, the conventions, and what's open. Workout calorie evidence is in `claude/FINDINGS-workout-calories.md` in the Project.

## 5 Nov: workout burn from heart rate (written, tested locally; needs Michael)

Order: `supabase db push`, then commit and push `docs/`. No Edge Function changed, so nothing to deploy with `supabase functions deploy`.

- Why: Mi Fitness's per-workout calories are close to a fixed 5 kcal a minute in most modes, whatever the heart rate (strength, spinning, HIIT, CrossFit, rowing). The 65% scale that matched Tenth to Mi Fitness made no sense after that.
- `20261105190000_workout_burn_from_heart_rate.sql`: style 70% (no time near rest) down to 55% (30% or more below 60% of max HR); `workout_kcal_scale` default 1.00, profiles on 0.65 move to 1.00; sessions saved from a Mi Fitness image are worked out from heart rate unless locked, and keep their number with no heart rate; recomputes the last 14 days. Tested on local Postgres with a stub schema, including a re-run.
- `docs/app.js`: a Mi Fitness image no longer sets or locks the burn. "Burn the plan uses" starts blank for an image; a typed number locks. An image merges into the session that starts closest (was `limit(1)` with no order). Settings text no longer says 65% matched Mi Fitness. Default Workout kcal 100%. Tested with Playwright and a fake backend: merge, merge with typed burn, merge keeping an earlier typed burn, no band session yet, entry by hand.
- `docs/sw.js`: `tenth-shell-v10`.
- Exercise labels and buttons were tested and not built: Michael always records on the band, each session has its own heart rate, and labels changed the estimate by about 21 kcal a session.
- Row 1 (31 Oct CrossFit, 232 kcal from an image, no heart rate in `hc_records`) stays at 232 unless Michael types about 579. Row 9 (5 Nov strength) stays locked at 340; the app has no way to clear a typed burn.

## 4 Nov, 09:50: weekly goals (written; deploy state not confirmed)

The Supabase connector can't reach this project, so whether this migration is applied is unknown. `supabase db push` applies it if it's missing.

- `20261104090000_training_goal.sql`: `profile.training_days_goal` smallint default 5, check 1–7.
- Progress → Goal: "Last 7 days" became "This week", Monday to Sunday (`WEEK_START = 1` plus `weekStart(day)`). Rows: Trained (any confirmed workout counts; Michael counts physio), Protein target hit (within 10%), Slept 7 h or more, Breakfast, lunch and dinner logged.
- Settings: "Train days/wk" next to "Workout kcal %" and "Eaten back %".

## 4 Nov, 07:30

- Auto sync works: `hc` POSTs arrive without a manual Sync. Sleep arrives before overnight HR.
- Data fixed by Claude (SQL): food_logs 30 description "muesli 70 g" → "muesli 50 g"; food_logs 27 (5 Nov lunch) eaten → planned. The saved meal "Usual breakfast" still has muesli 70 g / 264.6 kcal.
- UI suggestions given to Michael (not built): short meal names; fold the long target notes on Today into a "Why 2,051?" link; Progress averages skip today and partly logged days. Others: past days show eaten/under instead of "kcal left"; merge "Redo today's targets" and "Tomorrow's targets"; weigh-in shows last weight; band sync time on Today; padding so + doesn't cover the last card; "Move to another meal".

## 3 Nov evening

- `20261103210000_band_scale_eat_back` applied, plan deployed: `workout_eat_back_pct` 25, Daily movement 1.35. Its 0.65 scale is replaced by the 5 Nov migration.
- `20261103170000_workout_burn_cap` applied: `workouts.kcal_est`, type numbers → names.
- Phone: Honor Magic7 Pro. HC Webhook App launch manual, locked in Recents, Scheduled mode.
- Band accuracy research: Xiaomi Smart Band 8 overestimated cycling EE by 30–41% (PMC12456781); no consumer wearable reliably within 10% (BJSM meta-analysis).
- Webhook token in the URL (and logs); could move to `x-tenth-token` header. Low priority.

## What it is

Michael's phone app (Android, installed as a PWA from Chrome) for getting to 10% body fat.
- App: plain HTML/CSS/ES-module JS in `docs/`, served by GitHub Pages (repo smith-teaches-tech, `/docs` folder). supabase-js from the jsdelivr CDN. Service worker cache `tenth-shell-v10` (bump when the shell changes).
- Backend: free Supabase project `vmuebcyjdtdxmlyqrfox`. Publishable key in `docs/config.js`. The Supabase connector returns a permission error for this project, so live data comes from Michael running SQL.
- AI: Claude API primary (`claude-sonnet-5-5`, `claude-haiku-5-5`); Gemini free tier backup. Keys are Supabase secrets only.
- Code on the Mac at `/Users/michaelsmith/Documents/tenth`.

## Working rules

- Claude writes files; Michael runs every git and `supabase` CLI command. Claude never stages, commits, pushes or checks git status.
- Order after a change: `supabase db push` → `supabase functions deploy <name>` → commit and push `docs/`.
- Check claims against the actual code; test SQL on local Postgres and UI with Playwright screenshots before delivering.
- Re-check deploy state right before listing steps.
- After `device_commit_files`, check the Mac file's md5.

## Pieces

| Piece | Path | What it does |
|---|---|---|
| App | `docs/app.js` (about 2,580 lines), `index.html`, `styles.css`, `sw.js`, `manifest.webmanifest` | Tabs: Today, Food, Progress, Coach; Settings from the top-right icon; + button |
| ai function | `supabase/functions/ai/index.ts` | food_photo, food_text, revise, label, workout (Mi Fitness screenshot), targets (AI fine-tune within 8%), review |
| plan function | `supabase/functions/plan/index.ts` | Mifflin-St Jeor × Daily movement, adaptive burn from weight trend, missed-meal fill-in, steps adjustment, `workout_eat_back_pct`, deficit capped at 25% of burn, macros |
| coach function | `supabase/functions/coach/index.ts` | Chat with tiered memory; asks before saving a note |
| hc function | `supabase/functions/hc/index.ts` | HC Webhook POSTs → `hc_ingest` |
| Migrations | `supabase/migrations/` | through `20261103210000_band_scale_eat_back` known applied; `20261104090000_training_goal` unconfirmed; `20261105190000_workout_burn_from_heart_rate` needs push |

## Band data

Xiaomi Smart Band 10 → Mi Fitness → Health Connect → HC Webhook → `hc` → `hc_ingest`.
- `hc_records` (45 days) → `hc_rollup_days` → `daily_activity`. Overnight HR arrives later than sleep. Heart rate during workouts is one reading a minute.
- Band sessions → `workouts`; HR-detected sessions `suggested` until confirmed. Michael always starts a workout on the band; sessions can arrive much later.
- Workout burn (`hc_refresh_workouts`): short blocks of band active calories if there are any, otherwise Keytel − resting × style (70%→55%) × `workout_kcal_scale` (1.00). Typed burns win. No per-workout calories from Mi Fitness in Health Connect.
- Spinning and free training both arrive as "Workout".
- Detection: max(110, 65% of max HR) = 124 bpm, 15+ min, 10+ readings.
- Michael can't run (knee); any running session is suspect.

## Open items

- Michael: `supabase db push` → commit and push `docs/`.
- Partial first day drags the step average: the first evening of step data counts in the plan function's average once there are 7 days of logs (`stepDays.length >= 7`), about 9 Nov. Fix: skip partial days. Not fixed.
- Daily movement (1.35): Michael is hungry and walks about 10,000 steps; 1.40 adds about 85 kcal a day. His call, in Settings.
- Which other UI suggestions to build.
- Weight trend over 2 weeks; knobs: Daily movement, Workout kcal %, Eaten back %, 70%/55%.
- `mifit` trial: Michael to confirm `~/.mifit` is deleted and `mifit` uninstalled. Exports stay in `~/mifit-export`, outside the repo.

## Local testing setup (in Claude's workspace, rebuilt as needed)

- Postgres 16 (`pg_ctlcluster 16 main start`), run as user postgres. Needs `anon` and `authenticated` roles and a stub schema.
- UI: Playwright with `serviceWorkers: 'block'`, serving `docs/`, routing the supabase-js CDN URL to a small in-memory fake.
