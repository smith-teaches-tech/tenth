-- Tenth: workout fixes for band data that arrives in batches.
-- 1. Workout burn: hc_refresh_workouts prorated the band's active calories over the workout. Mi Fitness sends
--    active calories as one running total from midnight, re-sent on every sync, so a workout got a slice of the
--    whole day from every copy. Now only short blocks (3 hours or less, not covered by a longer block) count;
--    otherwise the heart-rate estimate (Keytel) is used, as before when there were no band calories.
-- 2. Detected sessions: rests of up to 5 minutes (was 3) below the threshold no longer split a session.
-- 3. Detected sessions are stretched when more of their heart rate arrives in a later sync, and take the band's
--    own start and end if an exercise record for the same session turns up.
-- Recomputes workouts from the last 3 days.

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
    select avg(bpm), max(bpm),
           round(sum(secs) filter (where bpm < 0.60 * v_max)),
           round(sum(secs) filter (where bpm >= 0.60 * v_max and bpm < 0.70 * v_max)),
           round(sum(secs) filter (where bpm >= 0.70 * v_max and bpm < 0.80 * v_max)),
           round(sum(secs) filter (where bpm >= 0.80 * v_max and bpm < 0.90 * v_max)),
           round(sum(secs) filter (where bpm >= 0.90 * v_max))
      into v_avg, v_peak, z_light, z_int, z_aer, z_ana, z_vo2
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
      kcal_used        = case when band and not kcal_locked
                           then coalesce(nullif(round(v_active), 0), round(v_est), kcal_used)
                           else kcal_used end
    where id = w.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

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
      -- A detected session takes the band's own start and end; a workout you logged keeps its times
      update public.workouts set
        started_at = case when source = 'detected' and not exists (
                       select 1 from public.workouts o where o.user_id = v_user and o.started_at = ex.s and o.id <> v_wid)
                     then ex.s else started_at end,
        done_on  = case when source = 'detected' then (ex.s at time zone v_tz)::date else done_on end,
        ended_at = case when source = 'detected' then ex.e else coalesce(ended_at, ex.e) end,
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
  --    Rests of up to 5 minutes below the threshold stay part of the same session (CrossFit, intervals).
  --    Heart rate can arrive over several syncs, so a session already detected is stretched to cover
  --    readings that came later, instead of staying cut short.
  with high as (
    select start_at,
           case when start_at - lag(start_at) over (order by start_at) > interval '300 seconds' then 1 else 0 end as brk
    from public.hc_records
    where user_id = v_user and kind = 'hr'
      and value >= greatest(110, 0.65 * v_max)
      and start_at >= v_from - interval '3 hours' and start_at <= v_to
  ), grp as (
    select start_at, sum(brk) over (order by start_at) as g from high
  ), isl as (
    select min(start_at) as s, max(start_at) as e, count(*) as n from grp group by g
  )
  update public.workouts w set
    started_at = least(w.started_at, isl.s),
    ended_at   = greatest(w.ended_at, isl.e),
    done_on    = (least(w.started_at, isl.s) at time zone v_tz)::date,
    duration_s = round(extract(epoch from greatest(w.ended_at, isl.e) - least(w.started_at, isl.s)))
  from isl
  where w.user_id = v_user and w.source = 'detected' and w.ended_at is not null
    and isl.e - isl.s >= interval '15 minutes' and isl.n >= 10
    and w.started_at < isl.e and w.ended_at > isl.s
    and (isl.s < w.started_at or isl.e > w.ended_at)
    and not exists (  -- never stretch onto the start time of another workout
      select 1 from public.workouts o
      where o.user_id = v_user and o.id <> w.id and o.started_at = least(w.started_at, isl.s));

  with high as (
    select start_at,
           case when start_at - lag(start_at) over (order by start_at) > interval '300 seconds' then 1 else 0 end as brk
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

revoke all on function public.hc_refresh_workouts(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.hc_ingest(jsonb) from public;
grant execute on function public.hc_ingest(jsonb) to anon, authenticated;

do $$
declare
  u record;
begin
  for u in select user_id from public.hc_tokens loop
    perform public.hc_refresh_workouts(u.user_id, now() - interval '3 days', now());
  end loop;
end;
$$;
