-- Shelf sensor readings, the dashboard's environment feed. Written by each
-- farm's Supabase bridge from farm/shelf/+/sensors. Run after farms.sql.

create extension if not exists pgcrypto;

create table if not exists public.sensor_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id text not null references public.farms (id),
  device text,
  source text,
  ts timestamptz,
  air_temp_c numeric,
  humidity_pct numeric,
  water_temp_c numeric,
  water_level_ok boolean,
  ph numeric,
  -- LightReading[]: each level's light, [{"level": 0, "lux": 412}, ...]
  lights jsonb not null default '[]'
);

-- Projects from before per-level lights: their one light_lux moves into lights.
-- sensor_events never kept the shelf's level; that sensor faced level 0, the
-- only shelf's.
alter table public.sensor_events
  add column if not exists lights jsonb not null default '[]';

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'sensor_events' and column_name = 'light_lux') then
    update public.sensor_events
       set lights = jsonb_build_array(jsonb_build_object('level', 0, 'lux', light_lux));
  end if;
end $$;

alter table public.sensor_events
  drop column if exists light_lux;

-- Columns from the retired laptop serial bridge. The dashboard derives °F from
-- °C and the level text from water_level_ok, the Pi converts pH, and light is
-- shown as lux (a PPFD estimate from lux doesn't hold under grow lights)
alter table public.sensor_events
  drop column if exists air_temp_f,
  drop column if exists water_temp_f,
  drop column if exists water_level_text,
  drop column if exists ph_voltage,
  drop column if exists light_ppfd,
  drop column if exists raw_text;

create index if not exists sensor_events_created_at_desc_idx
  on public.sensor_events (created_at desc);

-- The dashboard asks for one farm's latest reading
create index if not exists sensor_events_farm_idx
  on public.sensor_events (farm_id, created_at desc);

create index if not exists sensor_events_ts_desc_idx
  on public.sensor_events (ts desc);

create index if not exists sensor_events_device_idx
  on public.sensor_events (device);

alter table public.sensor_events enable row level security;

-- Table privileges. New Supabase projects no longer grant them by default,
-- and RLS only filters rows a role may already read: without these every
-- query fails with "permission denied for table". The dashboard's keys only
-- read; the secret key (the bridge, the dashboard's server) also writes.
grant select on public.sensor_events to anon, authenticated;
grant select, insert, update, delete on public.sensor_events to service_role;

-- Signed-in operators read as authenticated, everyone else as anon
drop policy if exists "Allow public dashboard reads" on public.sensor_events;
create policy "Allow public dashboard reads"
  on public.sensor_events
  for select
  to anon, authenticated
  using (true);

-- ---- For the remote dashboard -------------------------------------------------
-- The History page's stored readings: this farm's since p_from as one mean per
-- shelf (device) per p_bucket_ms, newest bucket first, like the Pi's Dashboard
-- API (GET /shelves?bucket_ms=). Buckets go by the reading's time on the Pi
-- (ts), so rows a bridge sent late after an outage land where they were read.
-- water_level_ok is false if any reading in the bucket was low, and lights
-- holds each level's mean. It runs as the caller, so it reads only what RLS
-- already lets the dashboard read.

-- Dropped first: create or replace can't change the columns a function returns
-- (lights replaced light_lux), and dropping also lets the file run again
drop function if exists public.shelf_history(text, timestamptz, bigint);

create function public.shelf_history(p_farm_id text, p_from timestamptz, p_bucket_ms bigint)
returns table (
  device text,
  bucket_start bigint,
  air_temp_c double precision,
  humidity_pct double precision,
  water_temp_c double precision,
  water_level_ok boolean,
  ph double precision,
  lights jsonb
)
language sql
stable
set search_path = ''
as $$
  with readings as (
    select e.device,
           (floor(extract(epoch from coalesce(e.ts, e.created_at)) * 1000 / p_bucket_ms) * p_bucket_ms)::bigint as bucket,
           e.air_temp_c, e.humidity_pct, e.water_temp_c, e.water_level_ok, e.ph, e.lights
      from public.sensor_events e
     where e.farm_id = p_farm_id
       and e.device is not null
       -- created_at too, for sensor_events_farm_idx: a row is stored after it's read
       and e.created_at >= p_from
       and coalesce(e.ts, e.created_at) >= p_from
       and p_bucket_ms >= 1000
  ),
  level_means as (
    select r.device, r.bucket, (l->>'level')::int as level, avg((l->>'lux')::double precision) as lux
      from readings r
      cross join lateral jsonb_array_elements(r.lights) as l
     group by 1, 2, 3
  )
  select r.device,
         r.bucket,
         avg(r.air_temp_c)::double precision,
         avg(r.humidity_pct)::double precision,
         avg(r.water_temp_c)::double precision,
         bool_and(r.water_level_ok),
         avg(r.ph)::double precision,
         coalesce((select jsonb_agg(jsonb_build_object('level', m.level, 'lux', m.lux) order by m.level)
                     from level_means m
                    where m.device = r.device and m.bucket = r.bucket), '[]'::jsonb)
    from readings r
   group by 1, 2
   order by 2 desc, 1;
$$;

revoke execute on function public.shelf_history(text, timestamptz, bigint) from public;
grant execute on function public.shelf_history(text, timestamptz, bigint) to anon, authenticated, service_role;
