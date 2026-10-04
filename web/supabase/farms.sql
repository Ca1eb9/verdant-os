-- The farms this Supabase project serves, one row per farm (one Pi each).
-- Run first (docs/SUPABASE-SETUP.md): every other table's farm_id
-- references it. Safe to run again.
--
-- Rows are added by hand in the SQL editor when a farm is set up:
--
--   insert into public.farms (id, name) values ('atlas', 'Atlas Farm');
--
-- id is the FARM_ID that farm's Supabase bridge and dashboard are configured
-- with. A bridge whose FARM_ID has no row here can't write anything (the
-- foreign keys refuse it), so a typo fails loudly instead of creating a farm.

create table if not exists public.farms (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text not null,
  created_at timestamptz not null default now()
);

alter table public.farms enable row level security;

-- The dashboard lists farms with the anon key; only the SQL editor (or the
-- secret key) adds them.
drop policy if exists "Dashboard reads" on public.farms;
create policy "Dashboard reads" on public.farms for select to anon, authenticated using (true);
