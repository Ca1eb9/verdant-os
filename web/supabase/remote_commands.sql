-- Proposed table for operator commands sent from the dashboard.
-- The Supabase bridge on the Pi watches for status = 'pending' rows,
-- publishes each one to farm/commands/remote (RemoteCommand) and then
-- marks it 'sent' (or 'failed' with an error) so it is not processed twice.
--
-- Rows match RemoteCommand in farm-controller/shared/src/types.ts,
-- plus robot_id so the bridge knows which farm/robot/{id}/command to use.

create table if not exists public.remote_commands (
  id uuid primary key,
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
  on public.remote_commands (status, issued_at);

create index if not exists remote_commands_robot_idx
  on public.remote_commands (robot_id, issued_at desc);

alter table public.remote_commands enable row level security;

-- The dashboard reads recent commands with the anon key. Inserts go through
-- the /api/commands route with the service role key, which bypasses RLS.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'remote_commands'
      and policyname = 'Allow dashboard command reads'
  ) then
    create policy "Allow dashboard command reads"
      on public.remote_commands
      for select
      to anon
      using (true);
  end if;
end $$;
