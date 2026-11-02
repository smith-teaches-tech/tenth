-- Tenth: stop double counting steps, active calories and distance.
-- Health Connect Webhook sends today's steps as one running total ("midnight to now") on every sync,
-- so each sync stored another copy with a later end time and the day's sum grew (1,800 + 1,800 = 3,600).
-- hc_rollup_days now skips any record that a longer record of the same kind fully covers,
-- so only the latest running total counts. Separate, non-overlapping records still add up as before.
-- Raw records are kept; nothing is deleted.

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
  v_low numeric;
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

    select round(percentile_cont(0.05) within group (order by value)::numeric) into v_low
    from public.hc_records
    where user_id = p_user and kind = 'hr' and start_at >= v_ds and start_at < v_de;

    with st as (
      select upper(coalesce(x->>'stage', '')) as stage,
             coalesce((x->>'duration_seconds')::numeric,
                      extract(epoch from (x->>'end_time')::timestamptz - (x->>'start_time')::timestamptz), 0) as secs
      from public.hc_records r, jsonb_array_elements(coalesce(r.extra->'stages', '[]')) x
      where r.user_id = p_user and r.kind = 'sleep' and r.end_at >= v_ds and r.end_at < v_de
    ), tot as (
      select sum(value) as secs from public.hc_records
      where user_id = p_user and kind = 'sleep' and end_at >= v_ds and end_at < v_de
    )
    select (select secs from tot) as total,
           sum(secs) filter (where stage like '%DEEP%' or stage = '5') as deep,
           sum(secs) filter (where stage like '%REM%' or stage = '6') as rem,
           sum(secs) filter (where stage like '%LIGHT%' or stage in ('4', '2') or stage like '%SLEEPING%') as light,
           sum(secs) filter (where stage like '%AWAKE%' or stage like '%OUT_OF_BED%' or stage in ('1', '3', '7')) as awake
      into sl
    from st;

    insert into public.daily_activity as d
      (user_id, day, steps, steps_source, active_kcal, distance_m, sleep_min, deep_min, rem_min, light_min, awake_min, low_hr, avg_spo2, updated_at)
    values
      (p_user, v_day, a.steps, case when a.steps is not null then 'health_connect' end, a.active_kcal, a.distance_m,
       case when sl.total is not null then round((sl.total - coalesce(sl.awake, 0)) / 60) end,
       round(sl.deep / 60), round(sl.rem / 60), round(sl.light / 60), round(sl.awake / 60),
       coalesce(a.resting, v_low), a.spo2, now())
    on conflict (user_id, day) do update set
      steps        = case when excluded.steps is not null then excluded.steps
                          when d.steps_source = 'health_connect' then null else d.steps end,
      steps_source = case when excluded.steps is not null then 'health_connect'
                          when d.steps_source = 'health_connect' then null else d.steps_source end,
      active_kcal  = excluded.active_kcal,
      distance_m   = excluded.distance_m,
      sleep_min    = excluded.sleep_min,
      deep_min     = excluded.deep_min,
      rem_min      = excluded.rem_min,
      light_min    = excluded.light_min,
      awake_min    = excluded.awake_min,
      low_hr       = excluded.low_hr,
      avg_spo2     = excluded.avg_spo2,
      updated_at   = now();
    v_days := v_days + 1;
  end loop;

  -- Days with nothing left at all go away
  delete from public.daily_activity
  where user_id = p_user and day between p_from and p_to
    and steps is null and active_kcal is null and distance_m is null and sleep_min is null and low_hr is null and avg_spo2 is null;
  return v_days;
end;
$$;

revoke all on function public.hc_rollup_days(uuid, date, date, text) from public, anon, authenticated;

-- Recompute the last few days for everyone with band data
do $$
declare
  u record;
begin
  for u in select h.user_id, coalesce(p.time_zone, 'UTC') as tz from public.hc_tokens h left join public.profile p using (user_id) loop
    perform public.hc_rollup_days(u.user_id, (now() at time zone u.tz)::date - 3, (now() at time zone u.tz)::date, u.tz);
  end loop;
end;
$$;
