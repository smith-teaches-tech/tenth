-- Tenth: automatic data from Health Connect, and the coach's memory.
--
-- Health Connect route: band -> Mi Fitness -> Health Connect -> HC Webhook (Android app)
--   -> POST https://<project>.supabase.co/rest/v1/rpc/hc_ingest
--      headers: apikey: <publishable key>, x-tenth-token: <token from Tenth's Settings>
-- hc_ingest keeps raw records for 45 days (granular), and rolls them up into
-- daily_activity and workouts, which are kept for good (summary).

-- ---------------------------------------------------------------------------
-- Profile: the phone's time zone, updated by the app, so days follow you when you travel
-- ---------------------------------------------------------------------------
alter table public.profile add column time_zone text not null default 'UTC';

-- ---------------------------------------------------------------------------
-- Daily activity: more than steps now
-- ---------------------------------------------------------------------------
alter table public.daily_activity alter column steps drop not null;
alter table public.daily_activity
  add column steps_source text check (steps_source in ('manual', 'health_connect')),
  add column active_kcal  int,            -- band's all-day active calories (display only; not added to targets)
  add column distance_m   int,
  add column sleep_min    int,            -- time asleep for the night that ended this morning
  add column deep_min     int,
  add column rem_min      int,
  add column light_min    int,
  add column awake_min    int,
  add column low_hr       int,            -- resting heart rate, or the day's low if the band doesn't send one
  add column avg_spo2     numeric(4,1),
  add column updated_at   timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- Workouts: Health Connect sessions and heart-rate-detected sessions
-- ---------------------------------------------------------------------------
alter table public.workouts drop constraint workouts_source_check;
alter table public.workouts add constraint workouts_source_check
  check (source in ('mi_fitness_image', 'manual', 'health_connect', 'detected'));
alter table public.workouts
  add column status      text not null default 'confirmed' check (status in ('confirmed', 'suggested', 'dismissed')),
  add column ended_at    timestamptz,
  add column kcal_locked boolean not null default false,  -- true once you set the burn yourself
  add column hc_type     text;

-- ---------------------------------------------------------------------------
-- Tokens for HC Webhook (only a hash is stored; the app shows the token once)
-- ---------------------------------------------------------------------------
create table public.hc_tokens (
  user_id      uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  last_result  jsonb
);

-- ---------------------------------------------------------------------------
-- Raw Health Connect records, kept 45 days
-- ---------------------------------------------------------------------------
create table public.hc_records (
  user_id  uuid not null references auth.users(id) on delete cascade,
  kind     text not null check (kind in ('steps', 'active_kcal', 'total_kcal', 'distance', 'hr', 'resting_hr', 'spo2', 'exercise', 'sleep')),
  start_at timestamptz not null,
  end_at   timestamptz not null,
  value    numeric not null,
  extra    jsonb,
  primary key (user_id, kind, start_at, end_at)
);

-- ---------------------------------------------------------------------------
-- Coach: chat history and the notes it has been allowed to remember
-- ---------------------------------------------------------------------------
create table public.coach_messages (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  thread_id  uuid not null,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  proposals  jsonb,     -- "remember this?" suggestions attached to an assistant reply
  created_at timestamptz not null default now()
);
create index coach_messages_thread on public.coach_messages (user_id, thread_id, id);

create table public.coach_notes (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  note       text not null check (char_length(note) between 3 and 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Daily summary: confirmed workouts only, plus band data
-- ---------------------------------------------------------------------------
drop view public.daily_summary;
create view public.daily_summary with (security_invoker = true) as
with days as (
  select user_id, eaten_on as day from public.food_logs
  union
  select user_id, done_on from public.workouts where status = 'confirmed'
  union
  select user_id, measured_on from public.body_metrics
  union
  select user_id, day from public.daily_activity
)
select
  d.user_id,
  d.day,
  coalesce(f.kcal, 0)         as intake_kcal,
  coalesce(f.protein_g, 0)    as protein_g,
  coalesce(f.carbs_g, 0)      as carbs_g,
  coalesce(f.fat_g, 0)        as fat_g,
  coalesce(f.entries, 0)      as food_entries,
  coalesce(f.planned_kcal, 0) as planned_kcal,
  coalesce(w.kcal, 0)         as exercise_kcal,
  w.training_load,
  w.workouts,
  a.steps,
  a.sleep_min,
  a.low_hr,
  b.weight_kg,
  b.body_fat_pct,
  b.waist_cm,
  t.kcal                      as target_kcal,
  t.protein_g                 as target_protein_g
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
  select sum(kcal_used) as kcal, sum(training_load) as training_load, string_agg(type, ', ') as workouts
  from public.workouts
  where user_id = d.user_id and done_on = d.day and status = 'confirmed'
) w on true
left join public.daily_activity a on a.user_id = d.user_id and a.day = d.day
left join public.body_metrics b on b.user_id = d.user_id and b.measured_on = d.day
left join public.daily_targets t on t.user_id = d.user_id and t.for_date = d.day;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Health Connect exercise type -> readable name ("EXERCISE_TYPE_STRENGTH_TRAINING" -> "Strength training")
create function public.hc_exercise_name(t text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v text := upper(coalesce(t, ''));
begin
  v := regexp_replace(v, '^EXERCISE_TYPE_', '');
  if v = '' or v ~ '^[0-9]+$' or v in ('OTHER_WORKOUT', 'OTHER', 'UNKNOWN') then
    return 'Workout';
  elsif v = 'HIGH_INTENSITY_INTERVAL_TRAINING' then
    return 'HIIT';
  end if;
  v := replace(lower(v), '_', ' ');
  return upper(left(v, 1)) || substr(v, 2);
end;
$$;

-- Recalculate heart rate, zones, duration and burn for workouts overlapping [p_from, p_to].
-- Mi Fitness image workouts only get blanks filled; band-sourced ones are fully recalculated.
create function public.hc_refresh_workouts(p_user uuid, p_from timestamptz, p_to timestamptz)
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
      and end_at > w.started_at;

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

-- ---------------------------------------------------------------------------
-- The receiver. HC Webhook posts its JSON straight here.
-- ---------------------------------------------------------------------------
create function public.hc_ingest(jsonb)
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
  for v_day in
    select generate_series((v_from at time zone v_tz)::date, (v_to at time zone v_tz)::date, interval '1 day')::date
  loop
    v_ds := v_day::timestamp at time zone v_tz;
    v_de := (v_day + 1)::timestamp at time zone v_tz;

    select round(sum(value) filter (where kind = 'steps'))       as steps,
           round(sum(value) filter (where kind = 'active_kcal')) as active_kcal,
           round(sum(value) filter (where kind = 'distance'))    as distance_m,
           round(avg(value) filter (where kind = 'resting_hr'))  as resting,
           round(avg(value) filter (where kind = 'spo2'), 1)     as spo2
      into a
    from public.hc_records
    where user_id = v_user and start_at >= v_ds and start_at < v_de
      and kind in ('steps', 'active_kcal', 'distance', 'resting_hr', 'spo2');

    select round(percentile_cont(0.05) within group (order by value)::numeric) into v_low
    from public.hc_records
    where user_id = v_user and kind = 'hr' and start_at >= v_ds and start_at < v_de;

    -- Sleep: sessions ending this local day (last night)
    with st as (
      select upper(coalesce(x->>'stage', '')) as stage,
             coalesce((x->>'duration_seconds')::numeric,
                      extract(epoch from (x->>'end_time')::timestamptz - (x->>'start_time')::timestamptz), 0) as secs
      from public.hc_records r, jsonb_array_elements(coalesce(r.extra->'stages', '[]')) x
      where r.user_id = v_user and r.kind = 'sleep' and r.end_at >= v_ds and r.end_at < v_de
    ), tot as (
      select sum(value) as secs from public.hc_records
      where user_id = v_user and kind = 'sleep' and end_at >= v_ds and end_at < v_de
    )
    select (select secs from tot) as total,
           sum(secs) filter (where stage like '%DEEP%' or stage = '5') as deep,
           sum(secs) filter (where stage like '%REM%' or stage = '6') as rem,
           sum(secs) filter (where stage like '%LIGHT%' or stage in ('4', '2') or stage like '%SLEEPING%') as light,
           sum(secs) filter (where stage like '%AWAKE%' or stage like '%OUT_OF_BED%' or stage in ('1', '3', '7')) as awake
      into sl
    from st;

    if a.steps is not null or a.active_kcal is not null or a.distance_m is not null or v_low is not null
       or a.spo2 is not null or sl.total is not null then
      insert into public.daily_activity as d
        (user_id, day, steps, steps_source, active_kcal, distance_m, sleep_min, deep_min, rem_min, light_min, awake_min, low_hr, avg_spo2, updated_at)
      values
        (v_user, v_day, a.steps, case when a.steps is not null then 'health_connect' end, a.active_kcal, a.distance_m,
         case when sl.total is not null then round((sl.total - coalesce(sl.awake, 0)) / 60) end,
         round(sl.deep / 60), round(sl.rem / 60), round(sl.light / 60), round(sl.awake / 60),
         coalesce(a.resting, v_low), a.spo2, now())
      on conflict (user_id, day) do update set
        steps        = coalesce(excluded.steps, d.steps),
        steps_source = case when excluded.steps is not null then 'health_connect' else d.steps_source end,
        active_kcal  = coalesce(excluded.active_kcal, d.active_kcal),
        distance_m   = coalesce(excluded.distance_m, d.distance_m),
        sleep_min    = coalesce(excluded.sleep_min, d.sleep_min),
        deep_min     = coalesce(excluded.deep_min, d.deep_min),
        rem_min      = coalesce(excluded.rem_min, d.rem_min),
        light_min    = coalesce(excluded.light_min, d.light_min),
        awake_min    = coalesce(excluded.awake_min, d.awake_min),
        low_hr       = coalesce(excluded.low_hr, d.low_hr),
        avg_spo2     = coalesce(excluded.avg_spo2, d.avg_spo2),
        updated_at   = now();
      v_days := v_days + 1;
    end if;
  end loop;

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

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
alter table public.hc_tokens      enable row level security;
alter table public.hc_records     enable row level security;
alter table public.coach_messages enable row level security;
alter table public.coach_notes    enable row level security;

create policy own_rows on public.hc_tokens for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows_read on public.hc_records for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_rows on public.coach_messages for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.coach_notes for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.hc_tokens, public.hc_records, public.coach_messages, public.coach_notes, public.daily_summary from anon;
grant select, insert, update, delete on public.hc_tokens, public.coach_messages, public.coach_notes to authenticated;
grant select on public.hc_records, public.daily_summary to authenticated;

-- Only the receiver is callable without signing in (it checks the token itself)
revoke all on function public.hc_ingest(jsonb) from public;
grant execute on function public.hc_ingest(jsonb) to anon, authenticated;
revoke all on function public.hc_refresh_workouts(uuid, timestamptz, timestamptz) from public, anon, authenticated;
