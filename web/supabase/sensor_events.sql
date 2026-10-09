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
  light_lux numeric
);

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

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'sensor_events'
      and policyname = 'Allow public dashboard reads'
  ) then
    create policy "Allow public dashboard reads"
      on public.sensor_events
      for select
      to anon
      using (true);
  end if;
end $$;
