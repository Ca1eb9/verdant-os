-- What the Supabase bridge (farm-controller/supabase-bridge) mirrors from
-- the farm's MQTT bus, for the remote dashboard. It also writes the shelf
-- readings (farm/shelf/+/sensors) into sensor_events. Run after
-- sensor_events.sql and remote_commands.sql (docs/SUPABASE-SETUP.md). Safe to
-- run again.
--
-- Columns follow farm-controller/shared/src/types.ts. Times in bigint are
-- Unix ms: `timestamp` is the sender's (a robot's is its uptime, there's no
-- clock sync), `received_at` is the Pi's receive time. created_at is
-- Supabase's own clock.
--
-- Access: the dashboard reads everything with the anon (publishable) key.
-- Only the secret (service_role) key writes, and it bypasses RLS, so no
-- table here has a write policy.

-- ---- Tables -----------------------------------------------------------------

-- RobotTelemetry from farm/robot/+/telemetry. The bridge downsamples it
-- (docs/SUPABASE-SETUP.md, "Size"), so this isn't every message.
create table if not exists public.robot_telemetry (
  id bigint generated always as identity primary key,
  robot_id text not null,
  status text not null,
  current_node text,
  task_id text,
  last_completed_task_id text,
  battery_pct real not null,
  heading smallint,
  obstacle_cm real,
  temperature_c real,
  humidity_pct real,
  light_lux real,
  "timestamp" bigint not null,
  received_at bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists robot_telemetry_robot_idx
  on public.robot_telemetry (robot_id, created_at desc);

-- RobotStateUpdate from farm/robot/+/state (the orchestrator's view: task,
-- planned path, "lost"). One row per robot, upserted.
create table if not exists public.robot_state (
  robot_id text primary key,
  status text not null,
  task jsonb,
  expected_path jsonb not null default '[]'::jsonb,
  "timestamp" bigint not null,
  updated_at timestamptz not null default now()
);

-- FarmAlert from farm/alerts.
create table if not exists public.alerts (
  alert_id text primary key,
  severity text not null,
  source text not null,
  source_type text not null,
  message text not null,
  metric text not null,
  value double precision not null,
  threshold double precision not null,
  "timestamp" bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists alerts_created_at_idx on public.alerts (created_at desc);

-- FarmTopology from farm/system/topology (retained). A single row.
create table if not exists public.farm_topology (
  id smallint primary key default 1 check (id = 1),
  topology jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---- Read access for the dashboard --------------------------------------------

alter table public.robot_telemetry enable row level security;
alter table public.robot_state enable row level security;
alter table public.alerts enable row level security;
alter table public.farm_topology enable row level security;

drop policy if exists "Dashboard reads" on public.robot_telemetry;
create policy "Dashboard reads" on public.robot_telemetry for select to anon, authenticated using (true);
drop policy if exists "Dashboard reads" on public.robot_state;
create policy "Dashboard reads" on public.robot_state for select to anon, authenticated using (true);
drop policy if exists "Dashboard reads" on public.alerts;
create policy "Dashboard reads" on public.alerts for select to anon, authenticated using (true);
drop policy if exists "Dashboard reads" on public.farm_topology;
create policy "Dashboard reads" on public.farm_topology for select to anon, authenticated using (true);

-- ---- Realtime -------------------------------------------------------------------
-- Changes the dashboard follows live, plus remote_commands for the bridge.

do $$
declare t text;
begin
  foreach t in array array['robot_telemetry', 'robot_state', 'alerts', 'farm_topology', 'remote_commands'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Private channels only (Realtime settings: "Allow public access" off).
-- The dashboard may join "farm-data" (table changes) and "farm-status"
-- (the bridge's presence) and listen. Nothing here lets it send or track:
-- only the bridge's secret key, which bypasses RLS, can mark the farm online.
drop policy if exists "Dashboard listens" on realtime.messages;
create policy "Dashboard listens" on realtime.messages
  for select to anon, authenticated
  using (realtime.topic() in ('farm-data', 'farm-status'));

-- ---- Retention -------------------------------------------------------------------
-- Keeps the free tier's 500 MB from filling up. The Pi's SQLite keeps the
-- full history. Runs daily at 03:00 UTC.

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule('trim-robot-telemetry', '0 3 * * *',
  $$delete from public.robot_telemetry where created_at < now() - interval '14 days'$$);
select cron.schedule('trim-sensor-events', '5 3 * * *',
  $$delete from public.sensor_events where created_at < now() - interval '30 days'$$);
select cron.schedule('trim-alerts', '10 3 * * *',
  $$delete from public.alerts where created_at < now() - interval '90 days'$$);
select cron.schedule('trim-remote-commands', '15 3 * * *',
  $$delete from public.remote_commands where created_at < now() - interval '30 days'$$);
