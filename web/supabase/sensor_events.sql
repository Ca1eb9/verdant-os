create extension if not exists pgcrypto;

create table if not exists public.sensor_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  device text,
  source text,
  ts timestamptz,
  air_temp_c numeric,
  air_temp_f numeric,
  humidity_pct numeric,
  water_temp_c numeric,
  water_temp_f numeric,
  water_level_ok boolean,
  water_level_text text,
  ph_voltage numeric,
  ph numeric,
  light_lux numeric,
  light_ppfd numeric,
  raw_text text
);

create index if not exists sensor_events_created_at_desc_idx
  on public.sensor_events (created_at desc);

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
