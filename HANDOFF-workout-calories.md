# Tenth: better workout calories (handoff, 5 Nov 2026, 18:35 Riyadh)

For a new chat. Goal: estimate each workout's burn from what Michael actually did and how his heart rate moved, instead of one percentage of a heart-rate formula.

Nothing in this handoff has been built. No code in the repo changed in the chat that wrote it; this file is the only addition.

## Michael's idea

"If I can identify the exercise and you can see the heart rate changes, we can estimate much better."

So: Michael says what the exercises were, the heart-rate trace shows work and rest, and the estimate is built from those.

## Start here

1. Read the working rules below, then `claude/STATUS.md` in the Project.
2. Vet the `mifit` package, then pull past workouts (see "Step 1").
3. Compare Mi Fitness, the current formula and exercise-based estimates across many sessions before proposing a method.
4. Check every claim in any option against the code first. Michael asks for this before he commits to a choice.

## Working rules

- Claude writes files. Michael runs every git and `supabase` command. Claude never stages, commits, pushes or checks git status.
- Order after a change: `supabase db push`, then `supabase functions deploy <name>`, then Michael commits and pushes `docs/`.
- Test SQL on local Postgres and UI with Playwright screenshots before delivering.
- Re-check deploy state right before listing steps.
- Bump the service worker cache in `docs/sw.js` when the shell changes (now `tenth-shell-v9`).
- Name things plainly; avoid vague "this" and "that". He dislikes poor referencing.

## Access

- Code: `/Users/michaelsmith/Documents/tenth`, reached through the linked computer (`$HOME/mnt/tenth` in the device shell).
- Supabase project `vmuebcyjdtdxmlyqrfox` (his free hobby org). **The Supabase connector could not reach it in this chat:** `list_tables` and `list_migrations` returned a permission error, and `list_projects` showed only the two PaperTrail projects. Try again; if it still fails, ask Michael to run SQL in the Supabase SQL editor and send the results.
- Because of that, nothing here was checked against live data. Deployed state is unknown, including whether `20261104090000_training_goal` has been pushed.

## Drift to fix

- `STATUS.md` on the Mac is dated 2 Nov. `claude/STATUS.md` in the Project is dated 4 Nov and is the newer one. Bring them back in line.
- The Mac's `docs/app.js` is the version to trust (about 2,400 lines). The Project's STATUS says about 1,980.

## How the burn works now

Latest definition: `public.hc_refresh_workouts` in `supabase/migrations/20261103210000_band_scale_eat_back.sql`.

```
estimate = Keytel heart-rate formula - resting burn         (saved in workouts.kcal_est)
style    = max(0.40, min(0.85, 0.85 - 1.5 x share of session below 60% of max HR))
kcal_used = estimate x style x profile.workout_kcal_scale   (scale is 0.65)
```

- If `kcal_locked` is true (a typed burn or a Mi Fitness image), `kcal_used` is never changed.
- The plan function adds `workout_eat_back_pct` (25%) of the day's confirmed workouts to the next day's target. Workouts count the day after they happen, not the same day.
- Health Connect does not carry Mi Fitness's per-workout calories, only a running daily total of active calories.
- Raw heart rate is in `hc_records` (`kind = 'hr'`), kept 45 days. **Sampling rate not checked;** it decides how much of a work and rest pattern can be seen. Check it first.
- `workouts.description` already holds free text about what he did, and the coach can read logged workouts.

## Evidence so far (only two sessions with a Mi Fitness number)

| Session | HR | Length | Heart-rate estimate | Tenth now | Mi Fitness |
|---|---|---|---:|---:|---:|
| Strength, 5 Nov: 6 chest and 3 biceps exercises, 3 sets each | avg 113, max 161 | 68 min | about 605 | 156 | 340 |
| Spin intervals, 3 Nov | avg 161, max 179, 24 min anaerobic | 30 min | 500 | 276 | 150 |

Nov 3 also had back (estimate 487, Tenth 128) and shoulders (estimate 518, Tenth 287). Mi Fitness's day total was 700, so back and shoulders were 550 between them.

What this shows:
- Mi Fitness is 56% of the estimate on strength and 30% on spin, so no single percentage matches it.
- Tenth's 691 for Nov 3 only looked right against 700 because its errors cancelled out.
- Mi Fitness's spin number looks too low: 5 kcal a minute, the same as the 113 bpm lifting session. Claude's rough estimate for that spin is 260-410 kcal (typical energy costs, not a measurement). Do not treat Mi Fitness as the truth for cycling.

## Fallback if the new method doesn't work out

Proposed and not built: Workout kcal 100%, style from 70% (no time near rest) down to 55% (30% or more near rest). Gives strength about 333, spin about 350, back about 270, shoulders about 363, Nov 3 total about 983. Only tuned on the two sessions above.

Also rejected: a flat 50% (spin 250, strength about 303), and differencing Mi Fitness's running totals around a session (it would inherit the low spin number).

## Step 1: pull past workouts with `mifit`

`mifit` (https://pypi.org/project/mifit/) is an unofficial Python tool that reads Mi Fitness data from Xiaomi's cloud. Its page says its `workouts` domain gives active and total calories per workout, and `workout_detail` gives per-second samples.

- **Read the package's code before running it.** Michael hasn't approved anything beyond a trial, and it hasn't been vetted.
- It signs in by QR code, which Michael scans. Its page says the session file (`~/.mifit/session.json`) grants access to his whole Xiaomi account, so treat it like a password. Have him sign out afterwards.
- **Keep the session file and exports out of the repo.** `.gitignore` covers neither, and he pushes this folder to GitHub. Check the device shell can install it and reach the network, and that its home folder isn't inside `tenth`.
- It has only been tested on one China-region account, so it may fail on his. If it does, ask him for Mi Fitness screenshots of several varied sessions (the app's `ai` function `workout` mode can already read them).
- Run it once on the Mac. Don't put Xiaomi credentials on Supabase.

Gadgetbridge and rooting were considered and set aside. Honor users report its bootloader unlock route is gone, and Gadgetbridge's Band 10 reports don't confirm workouts or calories.

## Step 2: design the estimate

Questions to settle with data:
- Can sets and rests be told apart in the trace at the sampling rate available?
- Heart rate lags effort and stays up during rest, which is why it overstates straight sets. How should the work and rest split be used?
- What's the source for exercise energy costs (for example MET values from the Compendium of Physical Activities), and how far off are they for strength work?
- Does the weight trend end up deciding this anyway? The plan function's adaptive burn takes over after 14 logged days and 8 weigh-ins, so keep the build proportionate. At 25% eat-back, a 100 kcal error moves the next day's target by 25 kcal.

**Constraint to raise with Michael:** he has said he won't type workout details every day. His new idea needs him to identify the exercises, so keep that very cheap: one-tap names on the band workout card (Back, Shoulders, Chest and biceps, Spin, Metcon, Physio), remembered routines, or the coach asking once. One-tap chips were already an unbuilt UI suggestion. Ask him how much input he'll accept.

Facts about his training:
- About 5 sessions a week is the goal (6 is a good week). Physio counts.
- Circuits (MetCon) are where he believes burn is most underestimated; he types those burns.
- Leg constraint since July 2026: no running, pistol squats or Turkish get-ups. A running session in the data is suspect.
- Height 185 cm, age 47, about 80 kg, comfortable max HR 180-186.

## Bugs found, not fixed

1. **Mi Fitness image can merge into the wrong workout.** `docs/app.js`, about line 870: the save looks for a workout starting within 20 minutes and takes `limit(1)` with no ordering. On 5 Nov, rowing started 15:50 and strength 15:53, so a strength image could overwrite rowing. Fix: fetch all matches with `started_at` and pick the closest to the image's start.
2. **Partial first day drags the step average.** The first evening of step data (about 2,000 steps) counts in the plan function's average. Steps only start counting once there are 7 days of logs (`stepDays.length >= 7` in `supabase/functions/plan/index.ts`), so this should start to matter around 9 Nov, adding about 45 kcal a day at first. His normal is about 10,000 steps. Fix: skip partial days.
3. **Settings help text** says "65% matched Mi Fitness". That's no longer true; update it with whatever replaces the scale.

## Related question left open

Michael thinks his metabolism is being underestimated, and he's hungry. Daily movement is 1.35; the app's guide says 1.35 is "on your feet some of the day" and 1.5 "most of it", and he walks about 10,000 steps. 1.40 would add about 85 kcal a day and 1.45 about 175. The target is still on the formula until the weight trend has enough data (14 logged days and 8 weigh-ins over 2 weeks). This likely matters more to his hunger than workout calories do. He weighed 80.3 kg on 5 Nov, target about 1,890 kcal on rest days.
