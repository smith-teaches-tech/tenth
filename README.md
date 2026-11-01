# Tenth

Phone app for tracking food, training, steps and body fat toward a target body fat percentage.
Static web app on GitHub Pages, Supabase for data and server functions, Claude for reading photos and giving feedback (Gemini free tier as backup).

## Folders

- `docs/` the app itself. GitHub Pages serves this folder.
- `supabase/migrations/` database schema.
- `supabase/functions/ai/` reads food photos, typed meals, nutrition labels and Mi Fitness workout images; meal balance tips, day and weekly feedback, AI fine-tuned macro targets (with guardrails).
- `supabase/functions/plan/` tomorrow's calories and macros, adaptive burn estimate, missed-meal fill-in, body fat timeline. No AI.

## Setup

1. In this folder: `supabase init` (accept defaults), then `supabase link --project-ref <your-project-ref>`.
2. Database: `supabase db push`
3. Secrets: `supabase secrets set ANTHROPIC_API_KEY=<key from platform.claude.com> GEMINI_API_KEY=<key from Google AI Studio> ALLOWED_ORIGIN=https://smith-teaches-tech.github.io`
   Optional: `CLAUDE_MODEL` (default claude-sonnet-5-5) and `CLAUDE_FAST_MODEL` (default claude-haiku-5-5).
4. Functions: `supabase functions deploy ai` and `supabase functions deploy plan`
   (`supabase/config.toml` sets `verify_jwt = false` for both; they check your sign-in themselves.)
   After adding a migration, always `supabase db push` before deploying the functions.
5. Auth, in the Supabase dashboard: Authentication > Users > Add user (your email and a password).
   Then turn off new sign-ups under Authentication > Sign In / Providers > Email.
6. App: put your project URL and publishable key in `docs/config.js`.
7. GitHub: Settings > Pages > Deploy from branch > `main`, folder `/docs`.
8. Phone: open the Pages URL in Chrome, sign in, Settings > fill in profile, then Chrome menu > Add to Home screen.
   Once installed, the app appears in the Android share sheet, so Mi Fitness workout images can be shared straight in.

## Notes

- Claude is the main AI (roughly 2–3 cents per food photo on Sonnet 5.5). Gemini is only used when Claude is busy; its free tier lets Google use what you send to improve its products.
- Supabase's free plan pauses a project after 7 days without use and keeps no backups. Settings > Export saves everything as JSON.
- Rename the app: `APP_NAME` in `docs/config.js`, and `name` / `short_name` in `docs/manifest.webmanifest`.
