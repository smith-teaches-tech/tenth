-- Tenth: database schema (v2)
-- Applied with `supabase db push` (or paste into the SQL Editor of a new project).
--
-- Single user: every table carries user_id (defaults to the signed-in user),
-- and row level security limits every row to that user.
-- Dates (eaten_on, done_on, measured_on, day, for_date) are LOCAL dates sent by the app,
-- so a 1 a.m. snack in Dhahran lands on the right day regardless of the server's UTC clock.

-- ---------------------------------------------------------------------------
-- Profile: one row
-- ---------------------------------------------------------------------------
create table public.profile (
  user_id            uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  sex                text not null check (sex in ('male', 'female')),
  birth_date         date not null,
  height_cm          numeric(5,1) not null check (height_cm between 100 and 250),
  target_bf_pct      numeric(4,1) not null default 10   check (target_bf_pct between 3 and 40),
  loss_rate_pct      numeric(3,2) not null default 0.50 check (loss_rate_pct between 0.25 and 1.00), -- % of bodyweight lost per week
  protein_g_per_kg   numeric(3,1) not null default 2.0  check (protein_g_per_kg between 1.2 and 3.0),
  fat_g_per_kg       numeric(3,1) not null default 0.8  check (fat_g_per_kg between 0.5 and 1.5),
  activity_factor    numeric(3,2) not null default 1.35 check (activity_factor between 1.10 and 1.70), -- daily movement EXCLUDING logged workouts
  max_hr             int check (max_hr between 120 and 230), -- observed max, not 220 - age
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Weigh-ins (one per day). Tape measurements optional; body fat is worked out
-- from them by the navy_body_fat trigger below.
-- ---------------------------------------------------------------------------
create table public.body_metrics (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  measured_on   date not null,
  weight_kg     numeric(5,2) not null check (weight_kg between 30 and 300),
  waist_cm      numeric(5,1) check (waist_cm between 40 and 200),  -- men: at the navel; women: narrowest point
  neck_cm       numeric(4,1) check (neck_cm between 20 and 70),    -- just below the Adam's apple
  hip_cm        numeric(5,1) check (hip_cm between 50 and 200),    -- women only: widest point
  body_fat_pct  numeric(4,1) check (body_fat_pct between 3 and 60),
  bf_method     text check (bf_method in ('navy', 'manual')),
  note          text,
  unique (user_id, measured_on)
);

-- ---------------------------------------------------------------------------
-- Steps (one row per day)
-- ---------------------------------------------------------------------------
create table public.daily_activity (
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day      date not null,
  steps    int not null check (steps between 0 and 100000),
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------------
-- Food library: products found by barcode or read from a label, reused on later scans
-- ---------------------------------------------------------------------------
create table public.foods (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  barcode       text,
  name          text not null,
  brand         text,
  serving_g     numeric(7,1),
  kcal_100g     numeric(6,1) not null check (kcal_100g >= 0),
  protein_100g  numeric(5,1) not null default 0,
  carbs_100g    numeric(5,1) not null default 0,
  fat_100g      numeric(5,1) not null default 0,
  fiber_100g    numeric(5,1),
  source        text not null check (source in ('openfoodfacts', 'label_photo', 'manual')),
  created_at    timestamptz not null default now(),
  unique (user_id, barcode)
);

-- ---------------------------------------------------------------------------
-- Everything eaten. `items` holds the per-ingredient breakdown:
--   [{"name","grams","kcal","protein_g","carbs_g","fat_g","fiber_g"}, ...]
-- so any entry can be repeated or saved as a meal and re-weighed later.
-- ---------------------------------------------------------------------------
create table public.food_logs (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  eaten_on     date not null,
  eaten_at     timestamptz not null default now(),
  meal         text not null check (meal in ('breakfast', 'lunch', 'dinner', 'snack')),
  description  text not null,
  grams        numeric(7,1),
  kcal         numeric(6,1) not null check (kcal >= 0),
  protein_g    numeric(5,1) not null default 0,
  carbs_g      numeric(5,1) not null default 0,
  fat_g        numeric(5,1) not null default 0,
  fiber_g      numeric(5,1),
  source       text not null check (source in ('barcode', 'photo', 'label', 'text', 'manual', 'saved')),
  confidence   text check (confidence in ('high', 'medium', 'low')),
  food_id      bigint references public.foods(id) on delete set null,
  items        jsonb check (items is null or jsonb_typeof(items) = 'array')
);
create index food_logs_user_day on public.food_logs (user_id, eaten_on);

-- ---------------------------------------------------------------------------
-- Saved meals: same item shape as food_logs.items. Grams are the usual portion;
-- the app rescales each item when you change its weight.
-- ---------------------------------------------------------------------------
create table public.saved_meals (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name          text not null,
  meal          text check (meal in ('breakfast', 'lunch', 'dinner', 'snack')),
  items         jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  use_count     int not null default 0,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, name)
);

-- ---------------------------------------------------------------------------
-- Workouts (from the Mi Fitness share image, or typed in)
-- ---------------------------------------------------------------------------
create table public.workouts (
  id                 bigint generated always as identity primary key,
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  done_on            date not null,
  started_at         timestamptz,
  type               text not null,
  description        text,          -- what you actually did: "5 rounds: thrusters 40 kg, pull-ups, 400 m run"
  duration_s         int check (duration_s > 0),
  active_kcal        int,
  total_kcal         int,
  avg_hr             int,
  max_hr             int,
  zone_light_s       int,
  zone_intensive_s   int,
  zone_aerobic_s     int,
  zone_anaerobic_s   int,
  zone_vo2max_s      int,
  aerobic_te         numeric(2,1),
  anaerobic_te       numeric(2,1),
  training_load      int,
  recovery_h         int,
  kcal_used          int not null check (kcal_used >= 0), -- the burn figure the plan uses (defaults to active_kcal)
  source             text not null check (source in ('mi_fitness_image', 'manual')),
  ai_raw             jsonb,
  created_at         timestamptz not null default now(),
  unique (user_id, started_at)  -- uploading the same Mi Fitness image twice is rejected
);
create index workouts_user_day on public.workouts (user_id, done_on);

-- ---------------------------------------------------------------------------
-- Targets written by the plan function
-- ---------------------------------------------------------------------------
create table public.daily_targets (
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  for_date           date not null,
  kcal               int not null,
  protein_g          int not null,
  carbs_g            int not null,
  fat_g              int not null,
  neat_kcal          int not null,  -- estimated daily burn excluding workouts
  exercise_kcal      int not null,  -- previous day's workouts, eaten back
  steps_adjust_kcal  int not null default 0, -- previous day's steps vs your 28-day average
  deficit_kcal       int not null,
  method             text not null check (method in ('formula', 'blended', 'adaptive')),
  notes              text,
  created_at         timestamptz not null default now(),
  primary key (user_id, for_date)
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profile_touch before update on public.profile
  for each row execute function public.touch_updated_at();

-- US Navy tape formula (metric). Fills body_fat_pct when waist and neck are given
-- (and hip for women), unless you typed a body fat number yourself (bf_method = 'manual').
create function public.navy_body_fat()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  p_sex    text;
  p_height numeric;
  bf       numeric;
begin
  if new.bf_method = 'manual' then
    return new;
  end if;
  if new.waist_cm is null or new.neck_cm is null then
    return new;
  end if;
  select sex, height_cm into p_sex, p_height from public.profile where user_id = new.user_id;
  if not found then
    return new;
  end if;

  if p_sex = 'male' then
    if new.waist_cm <= new.neck_cm then return new; end if;
    bf := 495 / (1.0324 - 0.19077 * log(new.waist_cm - new.neck_cm) + 0.15456 * log(p_height)) - 450;
  else
    if new.hip_cm is null or new.waist_cm + new.hip_cm <= new.neck_cm then return new; end if;
    bf := 495 / (1.29579 - 0.35004 * log(new.waist_cm + new.hip_cm - new.neck_cm) + 0.22100 * log(p_height)) - 450;
  end if;

  if bf between 3 and 60 then
    new.body_fat_pct := round(bf, 1);
    new.bf_method := 'navy';
  end if;
  return new;
end;
$$;

create trigger body_metrics_navy before insert or update on public.body_metrics
  for each row execute function public.navy_body_fat();

-- ---------------------------------------------------------------------------
-- One row per day: intake, workouts, steps, weight, target
-- security_invoker makes the view obey the tables' row level security
-- ---------------------------------------------------------------------------
create view public.daily_summary with (security_invoker = true) as
with days as (
  select user_id, eaten_on as day from public.food_logs
  union
  select user_id, done_on from public.workouts
  union
  select user_id, measured_on from public.body_metrics
  union
  select user_id, day from public.daily_activity
)
select
  d.user_id,
  d.day,
  coalesce(f.kcal, 0)      as intake_kcal,
  coalesce(f.protein_g, 0) as protein_g,
  coalesce(f.carbs_g, 0)   as carbs_g,
  coalesce(f.fat_g, 0)     as fat_g,
  coalesce(f.entries, 0)   as food_entries,
  coalesce(w.kcal, 0)      as exercise_kcal,
  w.training_load,
  a.steps,
  b.weight_kg,
  b.body_fat_pct,
  t.kcal                   as target_kcal,
  t.protein_g              as target_protein_g
from days d
left join lateral (
  select sum(kcal) as kcal, sum(protein_g) as protein_g, sum(carbs_g) as carbs_g,
         sum(fat_g) as fat_g, count(*) as entries
  from public.food_logs
  where user_id = d.user_id and eaten_on = d.day
) f on true
left join lateral (
  select sum(kcal_used) as kcal, sum(training_load) as training_load
  from public.workouts
  where user_id = d.user_id and done_on = d.day
) w on true
left join public.daily_activity a on a.user_id = d.user_id and a.day = d.day
left join public.body_metrics b on b.user_id = d.user_id and b.measured_on = d.day
left join public.daily_targets t on t.user_id = d.user_id and t.for_date = d.day;

-- ---------------------------------------------------------------------------
-- Row level security: signed-in user sees and changes only their own rows
-- ---------------------------------------------------------------------------
alter table public.profile        enable row level security;
alter table public.body_metrics   enable row level security;
alter table public.daily_activity enable row level security;
alter table public.foods          enable row level security;
alter table public.food_logs      enable row level security;
alter table public.saved_meals    enable row level security;
alter table public.workouts       enable row level security;
alter table public.daily_targets  enable row level security;

create policy own_rows on public.profile        for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.body_metrics   for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.daily_activity for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.foods          for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.food_logs      for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.saved_meals    for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.workouts       for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.daily_targets  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Explicit grants: signed-in user can use the tables; anonymous visitors get nothing.
revoke all on public.profile, public.body_metrics, public.daily_activity, public.foods, public.food_logs,
              public.saved_meals, public.workouts, public.daily_targets, public.daily_summary from anon;
grant select, insert, update, delete on public.profile, public.body_metrics, public.daily_activity,
              public.foods, public.food_logs, public.saved_meals, public.workouts,
              public.daily_targets to authenticated;
grant select on public.daily_summary to authenticated;
