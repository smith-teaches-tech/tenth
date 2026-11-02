-- Tenth: ignore the webhook app's Test data, recompute roll-ups cleanly, and remove the demo data already stored.

-- Recompute band roll-ups for local days [p_from, p_to] from the raw records kept (45 days).
-- Band fields are replaced outright, so removing raw records removes their effect; steps you typed by hand
-- are kept unless the band has steps for that day.
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
    from public.hc_records
    where user_id = p_user and start_at >= v_ds and start_at < v_de
      and kind in ('steps', 'active_kcal', 'distance', 'resting_hr', 'spo2');

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

create or replace function public.hc_ingest(jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb := $1;
  v_token text := coalesce(current_setting('request.headers', true)::json ->> 'x-tenth-token', '');
  v_user uuid;
  v_tz text;
  v_max numeric;
  v_from timestamptz;
  v_to timestamptz;
  v_day date;
  v_ds timestamptz;
  v_de timestamptz;
  ex record;
  v_wid bigint;
  v_new int := 0;
  v_merged int := 0;
  v_detected int := 0;
  v_days int := 0;
  v_result jsonb;
  a record;
  sl record;
  v_low numeric;
begin
  if v_token = '' then
    raise exception 'Missing x-tenth-token header' using errcode = '42501';
  end if;
  select user_id into v_user from public.hc_tokens
  where token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex');
  if v_user is null then
    raise exception 'Unknown token. Create a new one in Tenth > Settings.' using errcode = '42501';
  end if;

  select coalesce(time_zone, 'UTC'),
         coalesce(max_hr, 220 - extract(year from age(birth_date)))
    into v_tz, v_max
  from public.profile where user_id = v_user;
  v_tz := coalesce(v_tz, 'UTC');
  v_max := coalesce(v_max, 180);

  -- The webhook app's Test button sends made-up demo data marked "test": true. Check the token, store nothing.
  if coalesce(payload->>'test', 'false') = 'true' then
    v_result := jsonb_build_object('ok', true, 'test', true, 'note', 'Test received and token accepted. Test data is not stored.');
    update public.hc_tokens set last_used_at = now(), last_result = v_result where user_id = v_user;
    return v_result;
  end if;

  -- 1. Raw records (deduplicated within the payload; updates replace earlier copies)
  insert into public.hc_records (user_id, kind, start_at, end_at, value, extra)
  select distinct on (kind, s, e) v_user, kind, s, e, val, extra
  from (
    select 'steps' as kind, (r->>'start_time')::timestamptz s, (r->>'end_time')::timestamptz e, (r->>'count')::numeric val, null::jsonb extra
      from jsonb_array_elements(coalesce(payload->'steps', '[]')) r
    union all
    select 'active_kcal', (r->>'start_time')::timestamptz, (r->>'end_time')::timestamptz, (r->>'calories')::numeric, null
      from jsonb_array_elements(coalesce(payload->'active_calories', '[]')) r
    union all
    select 'total_kcal', (r->>'start_time')::timestamptz, (r->>'end_time')::timestamptz, (r->>'calories')::numeric, null
      from jsonb_array_elements(coalesce(payload->'total_calories', '[]')) r
    union all
    select 'distance', (r->>'start_time')::timestamptz, (r->>'end_time')::timestamptz, (r->>'meters')::numeric, null
      from jsonb_array_elements(coalesce(payload->'distance', '[]')) r
    union all
    select 'hr', (r->>'time')::timestamptz, (r->>'time')::timestamptz, (r->>'bpm')::numeric, null
      from jsonb_array_elements(coalesce(payload->'heart_rate', '[]')) r
    union all
    select 'resting_hr', (r->>'time')::timestamptz, (r->>'time')::timestamptz, (r->>'bpm')::numeric, null
      from jsonb_array_elements(coalesce(payload->'resting_heart_rate', '[]')) r
    union all
    select 'spo2', (r->>'time')::timestamptz, (r->>'time')::timestamptz, (r->>'percentage')::numeric, null
      from jsonb_array_elements(coalesce(payload->'oxygen_saturation', '[]')) r
    union all
    select 'exercise', (r->>'start_time')::timestamptz, (r->>'end_time')::timestamptz,
           coalesce((r->>'duration_seconds')::numeric, extract(epoch from (r->>'end_time')::timestamptz - (r->>'start_time')::timestamptz)), r
      from jsonb_array_elements(coalesce(payload->'exercise', '[]')) r
    union all
    select 'sleep',
           (r->>'session_end_time')::timestamptz - make_interval(secs => (r->>'duration_seconds')::numeric),
           (r->>'session_end_time')::timestamptz, (r->>'duration_seconds')::numeric, r
      from jsonb_array_elements(coalesce(payload->'sleep', '[]')) r
  ) x
  where s is not null and e is not null and val is not null
  order by kind, s, e
  on conflict (user_id, kind, start_at, end_at) do update set value = excluded.value, extra = excluded.extra;

  -- Time span this payload touched
  select min(start_at), max(end_at) into v_from, v_to
  from (
    select (r->>'start_time')::timestamptz start_at, (r->>'end_time')::timestamptz end_at
      from jsonb_array_elements(coalesce(payload->'steps', '[]') || coalesce(payload->'active_calories', '[]')
                                || coalesce(payload->'total_calories', '[]') || coalesce(payload->'distance', '[]')
                                || coalesce(payload->'exercise', '[]')) r
    union all
    select (r->>'time')::timestamptz, (r->>'time')::timestamptz
      from jsonb_array_elements(coalesce(payload->'heart_rate', '[]') || coalesce(payload->'resting_heart_rate', '[]')
                                || coalesce(payload->'oxygen_saturation', '[]')) r
    union all
    select (r->>'session_end_time')::timestamptz - make_interval(secs => coalesce((r->>'duration_seconds')::numeric, 0)),
           (r->>'session_end_time')::timestamptz
      from jsonb_array_elements(coalesce(payload->'sleep', '[]')) r
  ) t;

  if v_from is null then
    v_result := jsonb_build_object('ok', true, 'note', 'Nothing new in this payload.');
    update public.hc_tokens set last_used_at = now(), last_result = v_result where user_id = v_user;
    return v_result;
  end if;

  -- 2. Daily roll-ups for each local day touched
  v_days := public.hc_rollup_days(v_user, (v_from at time zone v_tz)::date, (v_to at time zone v_tz)::date, v_tz);

  -- 3. Exercise sessions -> workouts (merged with any workout already covering the same time)
  for ex in
    select distinct on (s) (r->>'start_time')::timestamptz s, (r->>'end_time')::timestamptz e, r->>'type' t
    from jsonb_array_elements(coalesce(payload->'exercise', '[]')) r
    where r ? 'start_time' and r ? 'end_time'
    order by s
  loop
    select id into v_wid from public.workouts
    where user_id = v_user and started_at is not null
      and started_at < ex.e
      and coalesce(ended_at, started_at + make_interval(secs => coalesce(duration_s, 60))) > ex.s
    order by abs(extract(epoch from started_at - ex.s))
    limit 1;

    if v_wid is not null then
      update public.workouts set
        ended_at = coalesce(ended_at, ex.e),
        hc_type  = ex.t,
        type     = case when source = 'detected' then public.hc_exercise_name(ex.t) else type end,
        source   = case when source = 'detected' then 'health_connect' else source end,
        status   = case when status = 'suggested' then 'confirmed' else status end
      where id = v_wid;
      v_merged := v_merged + 1;
    else
      insert into public.workouts (user_id, done_on, started_at, ended_at, type, hc_type, duration_s, kcal_used, source, status)
      values (v_user, (ex.s at time zone v_tz)::date, ex.s, ex.e, public.hc_exercise_name(ex.t), ex.t,
              round(extract(epoch from ex.e - ex.s)), 0, 'health_connect', 'confirmed')
      on conflict (user_id, started_at) do nothing;
      v_new := v_new + 1;
    end if;
  end loop;

  -- 4. Sessions the band didn't label: 15+ minutes of high heart rate with no workout logged.
  --    Saved as suggestions; nothing counts toward targets until you confirm it.
  with high as (
    select start_at,
           case when start_at - lag(start_at) over (order by start_at) > interval '180 seconds' then 1 else 0 end as brk
    from public.hc_records
    where user_id = v_user and kind = 'hr'
      and value >= greatest(110, 0.65 * v_max)
      and start_at >= v_from - interval '3 hours' and start_at <= v_to
  ), grp as (
    select start_at, sum(brk) over (order by start_at) as g from high
  ), isl as (
    select min(start_at) as s, max(start_at) as e, count(*) as n from grp group by g
  ), ins as (
    insert into public.workouts (user_id, done_on, started_at, ended_at, type, duration_s, kcal_used, source, status)
    select v_user, (isl.s at time zone v_tz)::date, isl.s, isl.e, 'Detected session',
           round(extract(epoch from isl.e - isl.s)), 0, 'detected', 'suggested'
    from isl
    where isl.e - isl.s >= interval '15 minutes' and isl.n >= 10
      and not exists (
        select 1 from public.workouts w
        where w.user_id = v_user and w.started_at is not null
          and w.started_at < isl.e
          and coalesce(w.ended_at, w.started_at + make_interval(secs => coalesce(w.duration_s, 3600))) > isl.s)
    on conflict (user_id, started_at) do nothing
    returning 1
  )
  select count(*) into v_detected from ins;

  -- 5. Heart rate, zones and burn for every workout in the window
  perform public.hc_refresh_workouts(v_user, v_from - interval '3 hours', v_to);

  -- 6. Keep raw records for 45 days; daily roll-ups and workouts stay for good
  delete from public.hc_records where user_id = v_user and end_at < now() - interval '45 days';

  v_result := jsonb_build_object(
    'ok', true,
    'records', jsonb_build_object(
      'steps', jsonb_array_length(coalesce(payload->'steps', '[]')),
      'heart_rate', jsonb_array_length(coalesce(payload->'heart_rate', '[]')),
      'active_calories', jsonb_array_length(coalesce(payload->'active_calories', '[]')),
      'exercise', jsonb_array_length(coalesce(payload->'exercise', '[]')),
      'sleep', jsonb_array_length(coalesce(payload->'sleep', '[]'))),
    'days_updated', v_days,
    'workouts_new', v_new,
    'workouts_merged', v_merged,
    'sessions_detected', v_detected,
    'from', v_from, 'to', v_to);
  update public.hc_tokens set last_used_at = now(), last_result = v_result where user_id = v_user;
  return v_result;
end;
$$;


revoke all on function public.hc_ingest(jsonb) from public;
grant execute on function public.hc_ingest(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- One-off clean-up: remove the demo data a webhook Test stored on 2 Nov 2026
-- (its "yesterday" = 1 Nov UTC). Matches the demo records exactly, so real band data is untouched.
-- ---------------------------------------------------------------------------
do $$
declare
  u record;
  y timestamptz := '2026-11-01T00:00:00Z';
  t constant interval := interval '1 minute';
begin
  for u in select user_id, coalesce(p.time_zone, 'UTC') as tz from public.hc_tokens h left join public.profile p using (user_id) loop
    delete from public.hc_records r
    using (values
      ('steps', y, y + 360 * t, 1240), ('steps', y + 360 * t, y + 540 * t, 3180), ('steps', y + 540 * t, y + 720 * t, 2450),
      ('steps', y + 720 * t, y + 1080 * t, 1562), ('steps', y, y + 630 * t, 8432),
      ('sleep', y - 30 * t, y + 420 * t, 27000),
      ('distance', y + 480 * t, y + 510 * t, 2100), ('distance', y + 510 * t, y + 540 * t, 3320), ('distance', y + 480 * t, y + 540 * t, 5420),
      ('active_kcal', y + 480 * t, y + 510 * t, 95), ('active_kcal', y + 510 * t, y + 540 * t, 217), ('active_kcal', y + 480 * t, y + 540 * t, 312),
      ('total_kcal', y, y + 630 * t, 2100),
      ('spo2', y + 375 * t, y + 375 * t, 98), ('spo2', y + 390 * t, y + 390 * t, 98.5), ('spo2', y + 1320 * t, y + 1320 * t, 97.8),
      ('resting_hr', y + 360 * t, y + 360 * t, 58), ('resting_hr', y + 360 * t - interval '1 day', y + 360 * t - interval '1 day', 57),
      ('exercise', y + 480 * t, y + 540 * t, 3600), ('exercise', y + 1110 * t, y + 1150 * t, 2400),
      ('hr', y + 365 * t, y + 365 * t, 62), ('hr', y + 380 * t, y + 380 * t, 58), ('hr', y + 405 * t, y + 405 * t, 64),
      ('hr', y + 430 * t, y + 430 * t, 72), ('hr', y + 460 * t, y + 460 * t, 78), ('hr', y + 485 * t, y + 485 * t, 85),
      ('hr', y + 500 * t, y + 500 * t, 110), ('hr', y + 515 * t, y + 515 * t, 142), ('hr', y + 530 * t, y + 530 * t, 155),
      ('hr', y + 540 * t, y + 540 * t, 148), ('hr', y + 555 * t, y + 555 * t, 120), ('hr', y + 570 * t, y + 570 * t, 95),
      ('hr', y + 600 * t, y + 600 * t, 82), ('hr', y + 660 * t, y + 660 * t, 76), ('hr', y + 720 * t, y + 720 * t, 74),
      ('hr', y + 840 * t, y + 840 * t, 88), ('hr', y + 960 * t, y + 960 * t, 92), ('hr', y + 1080 * t, y + 1080 * t, 80),
      ('hr', y + 1200 * t, y + 1200 * t, 70), ('hr', y + 1320 * t, y + 1320 * t, 65)
    ) as demo(kind, s, e, v)
    where r.user_id = u.user_id and r.kind = demo.kind and r.start_at = demo.s and r.end_at = demo.e and r.value = demo.v;

    delete from public.workouts
    where user_id = u.user_id and source in ('health_connect', 'detected')
      and started_at in (y + 480 * t, y + 1110 * t)
      and (hc_type in ('running', 'walking') or source = 'detected');

    perform public.hc_rollup_days(u.user_id, '2026-10-31', '2026-11-02', u.tz);
  end loop;
end;
$$;
