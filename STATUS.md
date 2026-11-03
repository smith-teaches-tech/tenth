# Tenth: where things stand (2 Nov 2026)

Handoff notes for the next chat. Setup steps are in `README.md`; this file is the state of the build, the conventions, and what's open.

## What it is

Michael's phone app (Android, installed as a PWA from Chrome) for getting to 10% body fat.
- App: plain HTML/CSS/ES-module JS in `docs/`, served by GitHub Pages (repo smith-teaches-tech, `/docs` folder). supabase-js from the jsdelivr CDN. Service worker cache `tenth-shell-v6` (bump the name when the shell changes).
- Logo: "Missing Tenth" (a 1 beside a ring with one tenth sliced out, mint on near-black, white slice). Files in `docs/icons`: `icon.svg`, `mark.svg` (top-bar badge, no tile), `icon-192/512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`.
- Backend: free Supabase project `vmuebcyjdtdxmlyqrfox` (hobby org). Publishable key is in `docs/config.js`.
- AI: Claude API is primary (`claude-sonnet-5-5` smart, `claude-haiku-5-5` fast); Gemini free tier is the backup (3.8-flash → 3.6-flash → 3.5-flash-lite). Keys are Supabase secrets only, never in chat or files.
- Code lives on the Mac at `/Users/michaelsmith/Documents/tenth` (linked to Claude through the desktop app). Copies of the main files are saved in the claude.ai Project docs.

## Working rules

- Claude writes files; Michael runs every git command and every `supabase` CLI command. Claude never stages, commits, pushes or checks git status.
- Order after a change: `supabase db push` (if there's a new migration) → `supabase functions deploy <name>` (if a function changed) → commit and push (for anything in `docs/`).
- Check claims against the actual code before saying something works. Test SQL on a local Postgres and UI with Playwright screenshots before delivering.

## Pieces

| Piece | Path | What it does |
|---|---|---|
| App | `docs/app.js` (~1900 lines), `index.html`, `styles.css`, `sw.js`, `manifest.webmanifest` | Tabs: Today, Food, Progress, Coach; Settings from the top-right icon; + button fixed bottom right (hidden on Coach and Settings) |
| ai function | `supabase/functions/ai/index.ts` | Modes: food_photo, food_text, revise, label, workout (Mi Fitness screenshot), targets (AI fine-tune with guardrails), review (day or week) |
| plan function | `supabase/functions/plan/index.ts` | Math targets, no AI: Mifflin-St Jeor × activity, adaptive TDEE from weight trend (14→28 days), missed-meal fill-in, steps adjustment, deficit from loss rate capped at 25% of burn, protein/fat per kg, carbs fill. `save:false` returns the goal timeline only |
| coach function | `supabase/functions/coach/index.ts` | Chat with tiered memory (14 days detailed, 15–90 daily, older weekly/monthly), tools get_day / search_meals / get_range / propose_memory. Asks "Remember this?" before saving a note |
| hc function | `supabase/functions/hc/index.ts` | Receives Health Connect Webhook POSTs (token in `?token=` or `x-tenth-token` header) and calls the `hc_ingest` database function |
| Migrations | `supabase/migrations/` | `20261101120000_init`, `20261101150000_planned_meals_and_measurements`, `20261101170000_ai_targets`, `20261102120000_health_connect_and_coach`, `20261102190000_ignore_test_data`, `20261102200000_running_totals`, `20261103070000_sleep_hr`, `20261103080000_workout_fixes` |

All four functions have `verify_jwt = false` in `supabase/config.toml`; they check sign-in (or the token) themselves.

## UI (design "D")

Mockups are on the Design canvas artifact (boards A, B, C, Coach, Combined = D, Goal). Today screen = goal strip, calorie ring, in the evening (from 18:00, or once dinner is logged) a "Tomorrow" card, recovery tiles (sleep, sleep HR, steps), cards for unlogged band sessions, then a timeline of meals grouped by slot (breakfast, lunch, dinner, snack). Michael splits meals into several entries so they're easy to reuse; saved meals have categories. + sheet groups: Food (Saved, Photo, Type, Scan, Plan meals), Activity (Workout, Steps), Body and targets (Weigh-in, Redo today's targets, Tomorrow's targets).

## Band data

Xiaomi Smart Band 10 → Mi Fitness → Health Connect → Health Connect Webhook (free APK, package `com.hcwebhook.app`) → `hc` function → `hc_ingest`.
- Raw records go to `hc_records` (kept 45 days); `hc_rollup_days` rolls them into `daily_activity` (steps, active kcal, distance, sleep and stages, low HR, SpO2) per local day using `profile.time_zone`.
- Band exercise sessions become `workouts` (merged with manual entries within ±20 min). Heart-rate-detected sessions are saved as `status 'suggested'` and show on Today until confirmed or dismissed. Only confirmed workouts count in plan, ai and the summary view.
- Michael's band does not auto-detect workouts and he can't run (knee), so any running session is suspect.

## Just done (needs Michael's push)

1. `20261102190000_ignore_test_data.sql`: the webhook app's Test button sends a made-up payload (`"test": true`: a "Morning Run" 08:00–09:00 UTC and "Evening Walk" on the previous day, plus demo steps, sleep, HR, SpO2, resting HR 58/57). The old `hc_ingest` stored it, which caused the fake 1 Nov run and the resting HR of 65. The migration:
   - makes `hc_ingest` accept test payloads (checks the token, stores nothing, replies "Test received…");
   - adds `hc_rollup_days`, which recomputes band fields from the raw records instead of keeping old values;
   - deletes the exact demo records and the two demo workouts from 1 Nov, then recomputes 31 Oct–2 Nov.
   Tested locally: demo data gone, real records and the Saturday workout untouched, test payload stores nothing.
2. `docs/app.js`: "Redo today's targets" in the + sheet, and targets recalc when yesterday's workouts change.

Michael's next steps: `supabase db push` → commit and push → in the app, + → Redo today's targets (today's target was inflated by the fake run). Use Sync now in the webhook app, not Test.

## 3 Nov morning findings

- `20261102200000_running_totals` was still NOT applied on the live database at 06:15 on 3 Nov (needs `supabase db push`). Until it is, every sync re-adds the running totals (2 Nov showed 11,316 = 4 x 1,800 + 2 x 2,058) and overwrites typed steps.
- Sleep double count: Mi Fitness wrote last night twice as separate Health Connect records (22:12-02:44 partial, then 22:12-05:27 full, different metadata ids) and the roll-up added both (704 min shown, about 7 h real). Fixed in the same `running_totals` migration (rewritten 3 Nov, still unapplied): overlapping sleep sessions count once, longest wins; separate naps still count. Tested locally with the real stage data: 432 min (deep 120, REM 100, light 212, awake 3).
- Automatic sync did not run overnight: Supabase logs show `hc` POSTs at 21:26 on 2 Nov, then nothing until Michael's manual syncs at 06:05 and 06:10 on 3 Nov. Interval mode (30 min) produced no calls. Suspects: Health Connect's separate "access data in the background" permission for HC Webhook, or Android deferring WorkManager jobs; Scheduled mode (exact alarms) is the fallback.
- After the push, 2 Nov steps will show 2,058 (Health Connect only had steps from 4:30pm). Re-enter the day's Mi Fitness total in the Steps sheet with the date set to 2 Nov.

## Workout fixes (3 Nov, needs db push)

- `sleep_hr` is applied (Michael pushed ~07:00 3 Nov).
- `20261103080000_workout_fixes` (replaces `hc_refresh_workouts` and `hc_ingest`):
  - Workout burn ignored the fact that Mi Fitness sends active calories as a midnight-to-now running total re-sent every sync; prorating those gave a workout a slice of the whole day from every copy. Only blocks of 3 hours or less (not covered by a longer one) count now; otherwise the Keytel heart-rate estimate is used.
  - Detection: rests up to 5 minutes (was 3) keep one session; a detected session is stretched when more of its heart rate arrives in a later sync; when the band's own exercise record turns up, a detected session takes the band's start and end. Workouts Michael logged keep their times.
  - Tested locally: HR over two syncs with a 4-min rest gives one 50-min session; band record retimes it to 16:58-17:52 and confirms it as HIIT; burn 671 kcal from HR; a screenshot-logged workout is left alone.
- Michael's tests: afternoon workout on 3 Nov (recorded on the band), and a warm-up on 4 Nov he often forgets to record (detection). Check the workouts table and `hc_records` hr afterwards.
- Detection threshold is max(110, 65% of max HR) = 124 bpm for Michael (max HR 190), 15+ min, 10+ readings.

## Sleep HR (3 Nov, applied; coach deploy and git push pending if not done)

- `running_totals` is applied (Michael pushed ~06:45 3 Nov); last night shows 432 min sleep.
- Overnight heart rate does reach Tenth, but Mi Fitness writes it to Health Connect later than sleep: the 06:10 sync had none, the 06:53 sync brought all 433 readings for 22:12-05:27. The webhook summary's `heart_rate` count is not a count of readings (1 while hundreds arrived).
- `20261103070000_sleep_hr`: new `daily_activity.sleep_hr` = average HR during the night's main sleep session (overlapping copies deduped, needs 30+ readings). 3 Nov: 48 (Mi Fitness says 48); the old day's-low `low_hr` gave 43 and is kept. Tested locally.
- Steps lag the same way: at 06:55 Mi Fitness showed about 2,200 while Health Connect had sent 1,701 at 06:53. Tenth shows what Health Connect has; Mi Fitness writes to it in batches.
- App: Today tile shows "sleep HR" (tap: average while asleep and day's low), falls back to resting HR; Progress → Body "Recovery" chart uses sleep HR. Coach gets "average HR while asleep". Needs `supabase functions deploy coach`.

## Tomorrow card (2 Nov, needs push)

- `tomorrowCard` / `refreshTomorrow` in `docs/app.js`: shows tomorrow's saved target with Plan meals (meal planner for tomorrow) and Details (the existing `runPlan` sheet with the breakdown and AI fine-tune). A math target older than 30 minutes is re-saved in the background (at most every 5 minutes), so it follows the evening's steps and workouts; an AI-tuned target is never touched.
- `ensureTodayTarget`: a math target worked out before the day began (evening card or + → Tomorrow's targets) is redone once on the first open of the day, with yesterday complete. AI-tuned targets are kept.
- The target has to be saved (not a save:false preview) because the meal planner, Food → Plan ahead and AI fine-tune all read the saved row.
- Tested with Playwright and a fake supabase module: no card at 15:30; card at 19:30 and at 17:40 with dinner logged (one save call, then redraw); AI-tuned kept; morning recompute only for an evening-made math target.

## Open items

- `20261102190000_ignore_test_data` is now applied on the live database (Michael ran `supabase db push` 2 Nov evening).
- Double counting fixed in `20261102200000_running_totals` (needs `supabase db push`): the webhook sends today's steps, active calories and distance as one running total ("local midnight to now") on every sync, each with a new end time, and `hc_rollup_days` summed every copy (1,800 + 1,800 = 3,600). It now skips any record a longer same-kind record fully covers, then recomputes the last 3 days. Tested locally: repeat totals count once, a bigger later total replaces it, separate hourly records still add up. Same migration: steps typed in the Steps sheet (app now saves `steps_source: "manual"`; older rows with no source count as typed) are kept unless the band total is higher. Needed because Health Connect only holds data from when Mi Fitness was allowed to write (2 Nov: from 4:30pm, 1,800 of 9,250 steps); from 3 Nov full days should arrive.
- Steps: Health Connect Webhook sends one combined steps total per day (no app name attached). On 2 Nov it sent 1,800 while Mi Fitness showed 9,250, and no sleep, while heart rate and SpO2 did arrive. So Health Connect itself only had 1,800: either Mi Fitness isn't allowed to write Steps and Sleep, or another source (phone/Google Fit) outranks it. Check Health Connect → App permissions → Mi Fitness (Steps, Sleep, Distance, Active calories all on) and Data and access → Steps → which apps contributed, and put Mi Fitness first in App priority.

- Today's steps and last night's sleep hadn't arrived on 2 Nov. Most likely Mi Fitness hadn't written them to Health Connect yet. Check: open Mi Fitness and let it sync → Health Connect → Data and access shows today's steps and sleep → webhook Sync now. If Health Connect has them but Tenth doesn't, it's a Tenth bug: look at `hc_tokens.last_result` and `hc_records` for that day.
- Watch the next few syncs for anything else odd (duplicate steps from overlapping records, sleep landing on the wrong day).
- Offered, not requested: VO2 max under Progress → Training if Health Connect sends it.

## Local testing setup (in Claude's workspace, rebuilt as needed)

- Postgres: data dir `/home/claude/.pgtest/data`, port 54329, socket dir `/home/claude/.pgtest`, run as user `claude`. `stub0.sql` creates a fake `auth` schema; migrations are applied in order; test user `1111…`, token `tok123`, time zone Asia/Riyadh. `hctest/t5.mjs` ingests a replica of the webhook demo payload (`node t5.mjs mock|real|flag|show`).
- UI: `python3 -m http.server 8765` from `docs/`, Playwright with a fake supabase module (`scratchpad/uitest/fake-supabase.js`, `shoot.cjs`).
