# Tenth: where things stand (12 Nov 2026, 11:30)

## 12 Nov, 11:30: planned food shaded on the ring and macro bars (written, tested; needs Michael to commit and push `docs/`)

- Why: Michael wants to see what planned food (status 'planned', not eaten yet) will do to his macros, e.g. when planning dinner, and eaten vs planned numbers side by side.
- `docs/app.js`: `ring(eaten, target, planned)` draws planned as a faint arc after the eaten arc (red when eaten + planned is over target). `bar(label, value, target, color, planned)` adds a striped, shaded segment after the eaten one; numbers read "45 +59/160", and the "+59" turns orange when eaten + planned is more than 5% over target. Ring centre adds "952 after plan" (or "−176 after plan" in orange). The line under the bars reads "583 eaten + 586 planned of 2,121". With nothing planned, the card looks as before. The AI day-feedback summary still passes no planned figure (it already counts planned as eaten).
- `docs/styles.css`: `.bar` is a flex row, `.bar > span.plan` shaded segment, `.plan-num`, bar label column 56 to 50 px. `docs/sw.js`: `tenth-shell-v14`.
- Tested with Playwright and the fake backend at 390 px: under target, over target, nothing planned; sleep HR checks re-run.
- Checked live at 11:30: `20261112080000_manual_sleep_hr` is applied and `plan` is version 9 (this morning's change). Whether this morning's `docs/` push happened is unknown; this push carries it either way.

## 12 Nov, 08:30: sleep HR typed by hand, resting HR from sleep only, clearer missed-meals note, spell check off

Migration and `plan` (version 9) confirmed live at 11:30; `docs/` goes with the 11:30 push.

- Finding: Mi Fitness only shares heart rate from workouts with Health Connect (Michael confirmed in Health Connect: thousands of readings, all from workouts). The two all-day stretches (2-3 Nov, 6-7 Nov) each started right after connecting Mi Fitness, so they look like one-off backfills. Sleep stages and SpO2 do arrive every night; no resting HR record has ever arrived. Michael is happy to type sleep HR each morning.
- `20261112080000_manual_sleep_hr.sql`: new `daily_activity.sleep_hr_source` ('manual' or 'health_connect'); a typed sleep HR survives every sync. `low_hr` now comes from a resting HR record, or the 5th percentile of readings inside the night's sleep (30+), else empty; it used to be the whole day's 5th percentile, which gave 85-100 on workout-only days. Recomputes every day with raw records. Tested on local Postgres (typed values kept through a sync and a re-run, clearing hands back to the band's figure). Read-only check on live data: 3 Nov (48) and 7 Nov (51) keep their sleep HR; lows of 47, 60, 100, 53, 88, 85 and 94 go empty.
- `docs/app.js`: the sleep HR tile always shows `sleep_hr` or a dash and opens "Sleeping heart rate" (day and bpm, 30-120, empty clears). Also under + > Activity > Sleep HR. `h()` sets `spellcheck = false` on every input and textarea: Chrome on Android's spelling popup trapped the field on a misspelt word. `docs/sw.js`: `tenth-shell-v13`. Tested with Playwright and a fake backend at phone size.
- `supabase/functions/plan/index.ts`: "Filled 3 missed meals with your usual amounts" showed every day and read like today's meals. The 3 were lunch and snack on 1 Nov and snack on 7 Nov (28-day window), not a recent dinner. The note now names meals and days (3 latest days, then a count), and only appears when logged intake is used (blended or adaptive), since the formula ignores it. Calories unchanged. Today's saved target keeps the old note until "Redo today's targets".
- Project drift found: the Project's copy of `docs/app.js` was older than the Mac's (no 6 Nov sleep HR tile change). Project copies updated with this change.


## 6 Nov, 14:40: heart tile shows sleep HR only (written; needs Michael to commit and push `docs/`)

- `docs/app.js`: Today's tile shows `sleep_hr`, or a dash labelled "sleep HR", no longer `low_hr` as "resting HR". `low_hr` is the 5th percentile of whatever readings a day has, so on partial days it read 64, 67, 68 and 100. The Progress sleep heart rate chart no longer falls back to `low_hr`. `docs/sw.js`: `tenth-shell-v12`.
- Open: no HR readings inside sleep sessions since the night of 2-3 Nov, though Mi Fitness shows a sleeping HR. `sleep_hr` needs 30+ readings in the session. Unverified theory: HC Webhook's per-type watermarks skip overnight HR that Mi Fitness writes late.
- Plan for faster sync (not built): more Scheduled times in HC Webhook, then Tenth calls HC Webhook's local `POST /sync` on open. Waiting on Michael's `http://127.0.0.1:8787/ping` test.

Handoff notes for the next chat. Setup steps are in `README.md`; this file is the state of the build, the conventions, and what's open. Workout calorie evidence is in `claude/FINDINGS-workout-calories.md` in the Project.

## 6 Nov: body fat and goal date follow weight (written, tested; needs Michael)

Order: `supabase functions deploy plan`, then commit and push `docs/`. Checked live on 6 Nov: every migration through `20261105190000` is applied, and `plan` is still version 7 from 3 Nov.

- Bug: lean mass was today's weight x (1 - last tape body fat). Body fat stayed frozen between tapes, every kilo lost lowered goal weight and showed as lean loss, and the 10% date slid one day later each day (26 Feb, 27 Feb, 28 Feb, 1 Mar).
- `supabase/functions/plan/index.ts`: `leanFromReadings` averages weight that day x (1 - body fat) over the last 3 readings (within 42 days). Current body fat = (weight - lean) / weight. `timeline` takes lean mass. New `detail.lean_kg_used`, `detail.body_fat_tape_on`; `detail.body_fat_pct_used` is now today's estimate, not the tape average.
- Behaviour change: at goal weight the plan now drops the deficit and eats at maintenance without a new tape. Calories are otherwise unchanged.
- `docs/app.js`: goal screens use the plan's lean mass and goal weight; Lean mass shows "from <date> tape" with a single reading; note under the goal says body fat is estimated since the last tape. `docs/sw.js`: `tenth-shell-v11`.
- Tested: `makePlan` scenarios (6 Nov gives 15.6%, goal 75.1 kg, 4 Feb; on-pace weigh-ins hold the date 31 Jan to 1 Feb; flat weight slides it; new tapes; goal reached; no readings) and Playwright with a fake backend, including the new app against the old function. The first tape is confirmed live: 81.5 kg, 17.1%, 1 Nov.
- Not changed: "Weight (trend)" still shows the plain weigh-in until there are 5 weigh-ins.
- Michael raised Daily movement to 1.40 on 6 Nov (live). That morning's saved target of 1,970 was made at 1.35; Redo today's targets gives about 2,056.
- Live on 6 Nov: `body_metrics` has only 1, 3 and 6 Nov, though Michael weighs daily (80.3 kg on 5 Nov isn't saved). Trend needs 5 weigh-ins and adaptive burn 8. `profile.height_cm` is 183; he has also said 185.

## 5 Nov: workout burn from heart rate (written, tested locally; needs Michael)

Order: `supabase db push`, then commit and push `docs/`. No Edge Function changed, so nothing to deploy with `supabase functions deploy`.

- Why: Mi Fitness's per-workout calories are close to a fixed 5 kcal a minute in most modes, whatever the heart rate (strength, spinning, HIIT, CrossFit, rowing). The 65% scale that matched Tenth to Mi Fitness made no sense after that.
- `20261105190000_workout_burn_from_heart_rate.sql`: style 70% (no time near rest) down to 55% (30% or more below 60% of max HR); `workout_kcal_scale` default 1.00, profiles on 0.65 move to 1.00; sessions saved from a Mi Fitness image are worked out from heart rate unless locked, and keep their number with no heart rate; recomputes the last 14 days. Tested on local Postgres with a stub schema, including a re-run.
- `docs/app.js`: a Mi Fitness image no longer sets or locks the burn. "Burn the plan uses" starts blank for an image; a typed number locks. An image merges into the session that starts closest (was `limit(1)` with no order). Settings text no longer says 65% matched Mi Fitness. Default Workout kcal 100%. Tested with Playwright and a fake backend: merge, merge with typed burn, merge keeping an earlier typed burn, no band session yet, entry by hand.
- `docs/sw.js`: `tenth-shell-v10`.
- Exercise labels and buttons were tested and not built: Michael always records on the band, each session has its own heart rate, and labels changed the estimate by about 21 kcal a session.
- Row 1 (31 Oct CrossFit, 232 kcal from an image, no heart rate in `hc_records`) stays at 232 unless Michael types about 579. Row 9 (5 Nov strength) stays locked at 340; the app has no way to clear a typed burn.

## 4 Nov, 09:50: weekly goals

Applied (checked live on 6 Nov).

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
- Backend: free Supabase project `vmuebcyjdtdxmlyqrfox`. Publishable key in `docs/config.js`. The `supabase_hobby` connector reads this project (read-only, added 6 Nov). The older `Supabase` connector only reaches the PaperTrail org. Writes and deploys stay with Michael's CLI.
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
