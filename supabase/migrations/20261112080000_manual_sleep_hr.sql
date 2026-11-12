-- Tenth: sleeping heart rate typed by hand, and resting HR only from sleep.
--
-- Mi Fitness only shares heart rate from workouts with Health Connect, so Tenth almost never has overnight
-- readings and daily_activity.sleep_hr stays empty. Michael types the number from Mi Fitness's sleep screen instead.
--   * New column daily_activity.sleep_hr_source ('manual' or 'health_connect'). A typed sleep HR is kept on every
--     sync; the band's own figure only fills days you haven't typed.
--   * low_hr used to be the 5th percentile of every heart rate reading that day. On days with only workout heart
--     rate it read 85 to 100 and showed as "resting HR". It now comes from readings inside the night's sleep only
--     (30 or more), or from a resting heart rate record if Health Connect sends one. Otherwise it is left empty.
--   * Recomputes every day that still has raw band records (45 days).

alter table public.daily_activity
  add column if not exists sleep_hr_source text check (sleep_hr_source in ('manual', 'health_connect'));

update public.daily_activity set sleep_hr_source = 'health_connect'
where sleep_hr is not null and sleep_hr_source is null;

create or replace function public.hc_rollup_days(p_user uuid, p_from date, p_to date, p_tz text)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_day date;
  v_ds timestamptz;
  v_de timestamptz;
  a record;
  sl record;
  hr record;
  v_days int := 0;
begin
  for v_day in select generate_series(p_from, p_to, interval '1 day')::date loop
    v_ds := v_day::timestamp at time zone p_tz;
    v_de := (v_day + 1)::timestamp at time zone p_tz;

    select round(sum(value) filter (where kind = 'steps'))       as steps,
           round(sum(value) filter (where kind = 'active_kcal')) as active_kcal,
           round(sum(value) filter (where kind = 'distance'))    as distance_m,
           round(avg(value) filter (where kind = 'resting_hr'))  as resting,
           round(avg(value) filter (where kind = 'spo2'), 1)     as spo2
      into a
    from public.hc_records r
    where r.user_id = p_user and r.start_at >= v_ds and r.start_at < v_de
      and r.kind in ('steps', 'active_kcal', 'distance', 'resting_hr', 'spo2')
      -- Running totals: each sync sends "midnight to now" again with a later end time.
      -- Count a total only if no longer record of the same kind covers it.
      and not (r.kind in ('steps', 'active_kcal', 'distance') and exists (
        select 1 from public.hc_records r2
        where r2.user_id = r.user_id and r2.kind = r.kind
          and r2.start_at <= r.start_at and r2.end_at >= r.end_at
          and (r2.start_at, r2.end_at) <> (r.start_at, r.end_at)));

    -- Heart rate while asleep (the night's main session, the longest of any overlapping copies).
    -- Sleep HR is the average, the low is the 5th percentile. Both need 30+ readings.
    select case when count(*) >= 30 then round(avg(h.value)) end as avg_hr,
           case when count(*) >= 30 then round(percentile_cont(0.05) within group (order by h.value)::numeric) end as low
      into hr
    from public.hc_records h
    where h.user_id = p_user and h.kind = 'hr'
      and exists (
        select 1 from public.hc_records r
        where r.user_id = p_user and r.kind = 'sleep' and r.end_at >= v_ds and r.end_at < v_de
          and h.start_at >= r.start_at and h.start_at < r.end_at
          and not exists (
            select 1 from public.hc_records r2
            where r2.user_id = r.user_id and r2.kind = 'sleep'
              and r2.start_at < r.end_at and r2.end_at > r.start_at
              and (r2.end_at - r2.start_at, r2.end_at) > (r.end_at - r.start_at, r.end_at)));

    with st as (
      select upper(coalesce(x->>'stage', '')) as stage,
             coalesce((x->>'duration_seconds')::numeric,
                      extract(epoch from (x->>'end_time')::timestamptz - (x->>'start_time')::timestamptz), 0) as secs
      from public.hc_records r, jsonb_array_elements(coalesce(r.extra->'stages', '[]')) x
      where r.user_id = p_user and r.kind = 'sleep' and r.end_at >= v_ds and r.end_at < v_de
        and not exists (  -- an earlier, partial copy of the same night
          select 1 from public.hc_records r2
          where r2.user_id = r.user_id and r2.kind = 'sleep'
            and r2.start_at < r.end_at and r2.end_at > r.start_at
            and (r2.end_at - r2.start_at, r2.end_at) > (r.end_at - r.start_at, r.end_at))
    ), tot as (
      select sum(r.value) as secs from public.hc_records r
      where r.user_id = p_user and r.kind = 'sleep' and r.end_at >= v_ds and r.end_at < v_de
        and not exists (
          select 1 from public.hc_records r2
          where r2.user_id = r.user_id and r2.kind = 'sleep'
            and r2.start_at < r.end_at and r2.end_at > r.start_at
            and (r2.end_at - r2.start_at, r2.end_at) > (r.end_at - r.start_at, r.end_at))
    )
    select (select secs from tot) as total,
           sum(secs) filter (where stage like '%DEEP%' or stage = '5') as deep,
           sum(secs) filter (where stage like '%REM%' or stage = '6') as rem,
           sum(secs) filter (where stage like '%LIGHT%' or stage in ('4', '2') or stage like '%SLEEPING%') as light,
           sum(secs) filter (where stage like '%AWAKE%' or stage like '%OUT_OF_BED%' or stage in ('1', '3', '7')) as awake
      into sl
    from st;

    insert into public.daily_activity as d
      (user_id, day, steps, steps_source, active_kcal, distance_m, sleep_min, deep_min, rem_min, light_min, awake_min,
       low_hr, sleep_hr, sleep_hr_source, avg_spo2, updated_at)
    values
      (p_user, v_day, a.steps, case when a.steps is not null then 'health_connect' end, a.active_kcal, a.distance_m,
       case when sl.total is not null then round((sl.total - coalesce(sl.awake, 0)) / 60) end,
       round(sl.deep / 60), round(sl.rem / 60), round(sl.light / 60), round(sl.awake / 60),
       coalesce(a.resting, hr.low), hr.avg_hr, case when hr.avg_hr is not null then 'health_connect' end, a.spo2, now())
    on conflict (user_id, day) do update set
      -- Steps you typed (source 'manual', or older rows with no source) stand unless the band reports more
      steps        = case when d.steps is not null and coalesce(d.steps_source, 'manual') = 'manual'
                               and (excluded.steps is null or d.steps >= excluded.steps) then d.steps
                          when excluded.steps is not null then excluded.steps
                          when d.steps_source = 'health_connect' then null else d.steps end,
      steps_source = case when d.steps is not null and coalesce(d.steps_source, 'manual') = 'manual'
                               and (excluded.steps is null or d.steps >= excluded.steps) then 'manual'
                          when excluded.steps is not null then 'health_connect'
                          when d.steps_source = 'health_connect' then null else d.steps_source end,
      active_kcal  = excluded.active_kcal,
      distance_m   = excluded.distance_m,
      sleep_min    = excluded.sleep_min,
      deep_min     = excluded.deep_min,
      rem_min      = excluded.rem_min,
      light_min    = excluded.light_min,
      awake_min    = excluded.awake_min,
      low_hr       = excluded.low_hr,
      -- A sleep HR you typed always stands
      sleep_hr        = case when d.sleep_hr_source = 'manual' then d.sleep_hr else excluded.sleep_hr end,
      sleep_hr_source = case when d.sleep_hr_source = 'manual' then 'manual' else excluded.sleep_hr_source end,
      avg_spo2     = excluded.avg_spo2,
      updated_at   = now();
    v_days := v_days + 1;
  end loop;

  -- Days with nothing left at all go away
  delete from public.daily_activity
  where user_id = p_user and day between p_from and p_to
    and steps is null and active_kcal is null and distance_m is null and sleep_min is null and low_hr is null and sleep_hr is null and avg_spo2 is null;
  return v_days;
end;
$$;

-- Recompute every day that still has raw records, so the old all-day lows (85, 88, 100) go
do $$
declare
  u record;
begin
  for u in
    select r.user_id, coalesce(p.time_zone, 'UTC') as tz,
           min((r.start_at at time zone coalesce(p.time_zone, 'UTC'))::date) as d0,
           max((r.end_at at time zone coalesce(p.time_zone, 'UTC'))::date) as d1
    from public.hc_records r left join public.profile p on p.user_id = r.user_id
    group by r.user_id, p.time_zone
  loop
    perform public.hc_rollup_days(u.user_id, u.d0, u.d1, u.tz);
  end loop;
end;
$$;
