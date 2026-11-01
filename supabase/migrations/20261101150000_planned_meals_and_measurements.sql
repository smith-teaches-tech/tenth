-- Tenth: planned meals.
-- A food log entry is either 'eaten' (counts toward the day) or 'planned' (not eaten yet).
-- Planned entries never count toward intake, the burn estimate or the weekly review
-- until you tap "Ate it".

alter table public.food_logs
  add column status text not null default 'eaten' check (status in ('planned', 'eaten'));

create index food_logs_user_day_status on public.food_logs (user_id, eaten_on, status);

-- Daily summary: intake counts eaten food only; planned calories shown separately
drop view public.daily_summary;
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
  coalesce(f.planned_kcal, 0) as planned_kcal,
  coalesce(w.kcal, 0)      as exercise_kcal,
  w.training_load,
  a.steps,
  b.weight_kg,
  b.body_fat_pct,
  t.kcal                   as target_kcal,
  t.protein_g              as target_protein_g
from days d
left join lateral (
  select sum(kcal)      filter (where status = 'eaten')   as kcal,
         sum(protein_g) filter (where status = 'eaten')   as protein_g,
         sum(carbs_g)   filter (where status = 'eaten')   as carbs_g,
         sum(fat_g)     filter (where status = 'eaten')   as fat_g,
         count(*)       filter (where status = 'eaten')   as entries,
         sum(kcal)      filter (where status = 'planned') as planned_kcal
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

revoke all on public.daily_summary from anon;
grant select on public.daily_summary to authenticated;

-- More tape measurements (all optional; hips is also used by the body fat formula for women)
alter table public.body_metrics
  add column chest_cm  numeric(5,1) check (chest_cm between 50 and 200),
  add column arm_cm    numeric(4,1) check (arm_cm between 15 and 70),     -- flexed, widest point
  add column thigh_cm  numeric(5,1) check (thigh_cm between 30 and 110);  -- widest point
