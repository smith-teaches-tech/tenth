-- Tenth: workout burn by workout style, and readable workout names.
--
-- 1. Burn. Band sessions get their burn from the heart-rate formula (Keytel minus resting burn). That holds up when
--    the heart rate tracks the work (cardio, circuits, supersets) but overstates straight sets, where the heart rate
--    stays up during rests while little is burned, and it read high for Michael overall (3 Nov: 1,505 kcal for three
--    sessions; Mi Fitness said 700, MET tables about 600-900). The share of the session spent near rest (below 60% of
--    max HR) now sets how much of the estimate counts: 0% near rest keeps 85%, 30% or more keeps 40%, in a straight
--    line between. No typing needed, and it doesn't depend on the type the band picked. The weight trend
--    (adaptive TDEE in plan) corrects what's left over time.
--    3 Nov: back (29% near rest) 487 -> 197; shoulders (0%) 518 -> 441; spin intervals (0%) 500 -> 425 = 1,063.
--    The full heart-rate estimate is kept in workouts.kcal_est. Burns typed in the edit sheet or taken from a
--    Mi Fitness screenshot (kcal_locked) are never changed.
-- 2. Names. HC Webhook sends the exercise type as a number ("70"), which showed as "Workout". Numbers are now
--    mapped to names (Health Connect ExerciseSessionRecord constants); band rows still called "Workout" are renamed.
-- Recomputes workouts from the last 3 days.

alter table public.workouts add column if not exists kcal_est int;  -- band sessions: full heart-rate estimate

-- Health Connect exercise type (number or EXERCISE_TYPE_ name) -> readable name
create or replace function public.hc_exercise_name(t text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v text := upper(regexp_replace(coalesce(t, ''), '^EXERCISE_TYPE_', '', 'i'));
begin
  if v ~ '^[0-9]+$' then
    v := case v::int
      when 0 then 'OTHER_WORKOUT' when 2 then 'BADMINTON' when 4 then 'BASEBALL' when 5 then 'BASKETBALL'
      when 8 then 'BIKING' when 9 then 'BIKING_STATIONARY' when 10 then 'BOOT_CAMP' when 11 then 'BOXING'
      when 13 then 'CALISTHENICS' when 14 then 'CRICKET' when 16 then 'DANCING' when 25 then 'ELLIPTICAL'
      when 26 then 'EXERCISE_CLASS' when 27 then 'FENCING' when 28 then 'FOOTBALL_AMERICAN'
      when 29 then 'FOOTBALL_AUSTRALIAN' when 31 then 'FRISBEE_DISC' when 32 then 'GOLF'
      when 33 then 'GUIDED_BREATHING' when 34 then 'GYMNASTICS' when 35 then 'HANDBALL'
      when 36 then 'HIGH_INTENSITY_INTERVAL_TRAINING' when 37 then 'HIKING' when 38 then 'ICE_HOCKEY'
      when 39 then 'ICE_SKATING' when 44 then 'MARTIAL_ARTS' when 46 then 'PADDLING' when 47 then 'PARAGLIDING'
      when 48 then 'PILATES' when 50 then 'RACQUETBALL' when 51 then 'ROCK_CLIMBING' when 52 then 'ROLLER_HOCKEY'
      when 53 then 'ROWING' when 54 then 'ROWING_MACHINE' when 55 then 'RUGBY' when 56 then 'RUNNING'
      when 57 then 'RUNNING_TREADMILL' when 58 then 'SAILING' when 59 then 'SCUBA_DIVING' when 60 then 'SKATING'
      when 61 then 'SKIING' when 62 then 'SNOWBOARDING' when 63 then 'SNOWSHOEING' when 64 then 'SOCCER'
      when 65 then 'SOFTBALL' when 66 then 'SQUASH' when 68 then 'STAIR_CLIMBING' when 69 then 'STAIR_CLIMBING_MACHINE'
      when 70 then 'STRENGTH_TRAINING' when 71 then 'STRETCHING' when 72 then 'SURFING'
      when 73 then 'SWIMMING_OPEN_WATER' when 74 then 'SWIMMING_POOL' when 75 then 'TABLE_TENNIS'
      when 76 then 'TENNIS' when 78 then 'VOLLEYBALL' when 79 then 'WALKING' when 80 then 'WATER_POLO'
      when 81 then 'WEIGHTLIFTING' when 82 then 'WHEELCHAIR' when 83 then 'YOGA'
      else 'OTHER_WORKOUT' end;
  end if;
  if v = '' or v in ('OTHER_WORKOUT', 'OTHER', 'UNKNOWN') then return 'Workout';
  elsif v = 'HIGH_INTENSITY_INTERVAL_TRAINING' then return 'HIIT';
  elsif v = 'BIKING_STATIONARY' then return 'Stationary bike';
  elsif v = 'RUNNING_TREADMILL' then return 'Treadmill run';
  elsif v = 'STAIR_CLIMBING_MACHINE' then return 'Stair machine';
  elsif v = 'SWIMMING_POOL' then return 'Pool swim';
  elsif v = 'SWIMMING_OPEN_WATER' then return 'Open water swim';
  end if;
  v := replace(lower(v), '_', ' ');
  return upper(left(v, 1)) || substr(v, 2);
end;
$$;

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
  select sex, birth_date, max_hr, height_cm into p from public.profile where user_id = p_user;
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
                           then coalesce(nullif(round(v_active), 0), round(v_est * v_style), kcal_used)
                           else kcal_used end
    where id = w.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function public.hc_refresh_workouts(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- Band sessions still called "Workout" get the band's type name
update public.workouts
set type = public.hc_exercise_name(hc_type)
where source = 'health_connect' and type = 'Workout' and hc_type ~ '^[0-9]+$'
  and public.hc_exercise_name(hc_type) <> 'Workout';

do $$
declare
  u record;
begin
  for u in select user_id from public.hc_tokens loop
    perform public.hc_refresh_workouts(u.user_id, now() - interval '3 days', now());
  end loop;
end;
$$;
