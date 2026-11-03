-- Tenth: workout calories matched to the band, and only part of them eaten back.
--
-- 3 Nov: Tenth's heart-rate estimate for back + shoulders + spin intervals was 1,063 kcal after the workout-style
-- adjustment; Mi Fitness said 700. Michael trusts the band's number, but Health Connect only receives Mi Fitness's
-- running daily total of active calories, never per-workout calories. So the estimate is scaled to the band's level:
-- profile.workout_kcal_scale (default 0.65; 3 Nov becomes 128 + 287 + 276 = 691). On metcon days he types a higher
-- burn in the workout's edit sheet, which locks it.
--
-- profile.workout_eat_back_pct (default 25): how much of a day's workout burn the plan function adds to the next
-- day's target. Read by the plan function, not here.
--
-- Recomputes workouts from the last 3 days.

alter table public.profile
  add column if not exists workout_kcal_scale numeric(3,2) not null default 0.65
    check (workout_kcal_scale between 0.30 and 1.50),
  add column if not exists workout_eat_back_pct numeric(5,2) not null default 25
    check (workout_eat_back_pct between 0 and 100);

create or replace function public.hc_refresh_workouts(p_user uuid, p_from timestamptz, p_to timestamptz)
returns int
language plpgsql
set search_path = ''
as $$
declare
  w record;
  p record;
  v_weight numeric;
  v_age numeric;
  v_max numeric;
  v_avg numeric; v_peak numeric;
  z_light int; z_int int; z_aer int; z_ana int; z_vo2 int;
  v_active numeric;
  v_min numeric;
  v_est numeric;
  v_secs numeric;
  v_rest numeric;
  v_style numeric;
  v_n int := 0;
  band boolean;
begin
  select sex, birth_date, max_hr, height_cm, workout_kcal_scale into p from public.profile where user_id = p_user;
  if not found then return 0; end if;
  select weight_kg into v_weight from public.body_metrics where user_id = p_user order by measured_on desc limit 1;
  v_weight := coalesce(v_weight, 80);
  v_age := extract(year from age(p.birth_date));
  v_max := coalesce(p.max_hr, 220 - v_age);

  for w in
    select * from public.workouts
    where user_id = p_user and status <> 'dismissed' and started_at is not null
      and started_at < p_to
      and coalesce(ended_at, started_at + make_interval(secs => coalesce(duration_s, 3600))) > p_from
  loop
    if w.ended_at is null and w.duration_s is null then continue; end if;
    band := w.source in ('health_connect', 'detected');

    -- Heart rate samples in the session; each sample counts until the next one (max 60 s)
    with s as (
      select value as bpm,
             least(60, coalesce(extract(epoch from lead(start_at) over (order by start_at) - start_at), 5)) as secs
      from public.hc_records
      where user_id = p_user and kind = 'hr'
        and start_at >= w.started_at
        and start_at <= coalesce(w.ended_at, w.started_at + make_interval(secs => w.duration_s))
    )
    select avg(bpm), max(bpm), sum(secs),
           round(sum(secs) filter (where bpm < 0.60 * v_max)),
           round(sum(secs) filter (where bpm >= 0.60 * v_max and bpm < 0.70 * v_max)),
           round(sum(secs) filter (where bpm >= 0.70 * v_max and bpm < 0.80 * v_max)),
           round(sum(secs) filter (where bpm >= 0.80 * v_max and bpm < 0.90 * v_max)),
           round(sum(secs) filter (where bpm >= 0.90 * v_max))
      into v_avg, v_peak, v_secs, z_light, z_int, z_aer, z_ana, z_vo2
    from s;

    -- Band's active calories that overlap the session, prorated
    select sum(value * extract(epoch from (least(end_at, coalesce(w.ended_at, w.started_at + make_interval(secs => w.duration_s)))
                                         - greatest(start_at, w.started_at)))
                     / greatest(1, extract(epoch from end_at - start_at)))
      into v_active
    from public.hc_records
    where user_id = p_user and kind = 'active_kcal'
      and start_at < coalesce(w.ended_at, w.started_at + make_interval(secs => w.duration_s))
      and end_at > w.started_at
      -- Only short blocks of band calories. Mi Fitness sends a running total for the whole day on every sync;
      -- a slice of that says nothing about the workout, so those are skipped (the heart-rate estimate is used).
      and end_at - start_at <= interval '3 hours'
      and not exists (
        select 1 from public.hc_records r2
        where r2.user_id = p_user and r2.kind = 'active_kcal'
          and r2.end_at - r2.start_at <= interval '3 hours'
          and r2.start_at <= hc_records.start_at and r2.end_at >= hc_records.end_at
          and (r2.start_at, r2.end_at) <> (hc_records.start_at, hc_records.end_at));

    v_min := extract(epoch from coalesce(w.ended_at, w.started_at + make_interval(secs => w.duration_s)) - w.started_at) / 60;

    -- Fallback burn: Keytel heart-rate formula minus resting burn (rest is already in the everyday burn)
    v_est := null;
    if v_avg is not null and v_min > 0 then
      v_est := case when p.sex = 'female'
                 then (-20.4022 + 0.4472 * v_avg - 0.1263 * v_weight + 0.074 * v_age) / 4.184
                 else (-55.0969 + 0.6309 * v_avg + 0.1988 * v_weight + 0.2017 * v_age) / 4.184 end * v_min
             - (10 * v_weight + 6.25 * p.height_cm - 5 * v_age + case when p.sex = 'female' then -161 else 5 end) / 1440 * v_min;
      v_est := greatest(0, v_est);
    end if;

    -- Workout style from the heart rate: share of the session spent near rest (below 60% of max HR).
    -- Cardio and circuits hold the heart rate up and keep the full estimate; straight sets with real rests
    -- keep less, because the heart rate stays up between sets while little is burned.
    -- 0% near rest -> 85%, 30% or more near rest -> 40%, in a straight line between.
    v_rest := case when coalesce(v_secs, 0) > 0 then coalesce(z_light, 0) / v_secs else 0 end;
    v_style := greatest(0.40, least(0.85, 0.85 - 1.5 * v_rest));

    update public.workouts set
      duration_s       = case when band then round(v_min * 60) else coalesce(duration_s, round(v_min * 60)) end,
      avg_hr           = case when band then coalesce(round(v_avg), avg_hr) else coalesce(avg_hr, round(v_avg)) end,
      max_hr           = case when band then coalesce(round(v_peak), max_hr) else coalesce(max_hr, round(v_peak)) end,
      zone_light_s     = case when band and v_avg is not null then coalesce(z_light, 0) else zone_light_s end,
      zone_intensive_s = case when band and v_avg is not null then coalesce(z_int, 0) else zone_intensive_s end,
      zone_aerobic_s   = case when band and v_avg is not null then coalesce(z_aer, 0) else zone_aerobic_s end,
      zone_anaerobic_s = case when band and v_avg is not null then coalesce(z_ana, 0) else zone_anaerobic_s end,
      zone_vo2max_s    = case when band and v_avg is not null then coalesce(z_vo2, 0) else zone_vo2max_s end,
      active_kcal      = case when band then coalesce(round(v_active), active_kcal) else coalesce(active_kcal, round(v_active)) end,
      kcal_est         = case when band then coalesce(nullif(round(v_active), 0), round(v_est), kcal_est) else kcal_est end,
      kcal_used        = case when band and not kcal_locked
                           then coalesce(nullif(round(v_active), 0), round(v_est * v_style * coalesce(p.workout_kcal_scale, 1)), kcal_used)
                           else kcal_used end
    where id = w.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function public.hc_refresh_workouts(uuid, timestamptz, timestamptz) from public, anon, authenticated;

do $$
declare
  u record;
begin
  for u in select user_id from public.hc_tokens loop
    perform public.hc_refresh_workouts(u.user_id, now() - interval '3 days', now());
  end loop;
end;
$$;
