-- Proposed table for operator commands sent from the dashboard.
-- The Supabase bridge on the Pi watches for status = 'pending' rows,
-- publishes each one to farm/commands/remote (RemoteCommand) and then
-- marks it 'sent' (or 'failed' with an error) so it is not processed twice.
--
-- Rows match RemoteCommand in farm-controller/shared/src/types.ts,
-- plus robot_id so the bridge knows which farm/robot/{id}/command to use,
-- and farm_id: each farm's bridge relays only its own farm's rows. Run after
-- farms.sql.

create table if not exists public.remote_commands (
  id uuid primary key,
  farm_id text not null references public.farms (id),
  robot_id text not null,
  command jsonb not null,          -- RobotCommand (includes "immediate")
  issued_by text not null,
  issued_at bigint not null,       -- Unix ms
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists remote_commands_status_idx
  on public.remote_commands (farm_id, status, issued_at);

create index if not exists remote_commands_robot_idx
  on public.remote_commands (farm_id, robot_id, issued_at desc);

alter table public.remote_commands enable row level security;

-- Table privileges. New Supabase projects no longer grant them by default,
-- and RLS only filters rows a role may already read: without these every
-- query fails with "permission denied for table". The dashboard's keys only
-- read; the secret key (the bridge, the dashboard's server) also writes.
grant select on public.remote_commands to anon, authenticated;
grant select, insert, update, delete on public.remote_commands to service_role;

-- The dashboard reads recent commands with the anon key. Inserts go through
-- the /api/commands route with the service role key, which bypasses RLS.
-- Signed-in operators read as authenticated.
drop policy if exists "Allow dashboard command reads" on public.remote_commands;
create policy "Allow dashboard command reads"
  on public.remote_commands
  for select
  to anon, authenticated
  using (true);

-- ---- For the Supabase bridge ---------------------------------------------------
-- Ages are measured with Supabase's clock (now()): neither the Pi's nor
-- Vercel's is synced, so the bridge can't compare times itself. Only the
-- secret key may call these. An empty search_path keeps a same-named object
-- elsewhere from standing in for the tables (Supabase's security advisor).

-- Fails this farm's pending commands older than p_max_age_ms instead of
-- sending them late (e.g. queued while the farm was offline). Returns their ids.
create or replace function public.fail_stale_remote_commands(p_farm_id text, p_max_age_ms bigint)
returns setof uuid
language sql
set search_path = ''
as $$
  update public.remote_commands
     set status = 'failed', error = 'stale', processed_at = now()
   where farm_id = p_farm_id
     and status = 'pending'
     and created_at < now() - make_interval(secs => p_max_age_ms / 1000.0)
  returning id;
$$;

-- Marks a command sent or failed, only while it's still pending, so it's
-- never processed twice. Returns false when it wasn't pending.
create or replace function public.finish_remote_command(
  p_id uuid, p_farm_id text, p_status text, p_error text default null
)
returns boolean
language sql
set search_path = ''
as $$
  with done as (
    update public.remote_commands
       set status = p_status, error = p_error, processed_at = now()
     where id = p_id and farm_id = p_farm_id and status = 'pending'
    returning 1
  )
  select exists (select 1 from done);
$$;

revoke execute on function public.fail_stale_remote_commands(text, bigint) from public, anon, authenticated;
revoke execute on function public.finish_remote_command(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fail_stale_remote_commands(text, bigint) to service_role;
grant execute on function public.finish_remote_command(uuid, text, text, text) to service_role;
