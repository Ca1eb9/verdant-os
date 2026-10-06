# Supabase setup

Supabase is the farm's cloud side: the dashboard on Vercel reads farm data from it and sends commands through it, and the Supabase bridge on the Pi keeps it in sync with the farm's MQTT bus. This doc sets up a single project that serves every farm: each farm has its own Pi and bridge, and every row carries its `farm_id`. Setup takes about an hour and a quarter, most of it pasting SQL.

One account owns the organization, the project, its keys and its settings. Anyone else working on it is invited to the organization and reads the keys from the project settings. Don't share logins, and never paste keys into chat or git.

## 1. Create the project (15 min)

1. Sign up at [supabase.com](https://supabase.com) (GitHub login is fine) and create an organization, **Free** plan.
2. **New project**: name `verdant-os`, the region closest to the farm, and a generated database password. Save the password in a password manager; nothing in the farm uses it, but you need it to reset or connect directly.
3. Wait for the project to finish provisioning (a couple of minutes).

## 2. Invite collaborators (5 min)

**Organization settings → Team → Invite**: add each person who needs access as **Developer** (tables, SQL editor and logs; no billing, team or project-settings changes). If that role can't reveal the secret key, share it through a password manager rather than chat. Skip this step if you're working alone.

## 3. Create the tables (15 min)

In **SQL Editor**, run these files from the repo, in this order (paste each, **Run**). Each is safe to run again.

| File | Creates |
|---|---|
| [`web/supabase/farms.sql`](../web/supabase/farms.sql) | `farms`: one row per farm, the list the dashboard's farm picker shows. Every other table's `farm_id` must name one |
| [`web/supabase/sensor_events.sql`](../web/supabase/sensor_events.sql) | `sensor_events`: shelf sensor readings, the dashboard's environment feed. The Supabase bridge mirrors them from `farm/shelf/+/sensors` ([shelf-sensors.md](shelf-sensors.md)) |
| [`web/supabase/remote_commands.sql`](../web/supabase/remote_commands.sql) | `remote_commands`: commands the dashboard sends from anywhere; the bridge relays them to the farm |
| [`web/supabase/farm_sync.sql`](../web/supabase/farm_sync.sql) | `robot_telemetry`, `robot_state`, `alerts`, `farm_topology` (what the bridge mirrors), Realtime for them, the presence rule and daily cleanup |

Then **Table Editor** should list all seven tables, each with RLS enabled.

**Add each farm** in the SQL editor, one row per farm (one Pi each):

```sql
insert into public.farms (id, name) values ('atlas', 'Atlas Farm');
```

The id is lowercase letters, digits and dashes, and never changes: it's what that farm's Pi is configured with (step 5). A Pi whose id has no row here can't write anything, so a typo fails loudly instead of creating a second farm. Add a farm the same way later; the dashboard lists it within seconds.

These files are the contract between the bridge and the dashboard. Change the schema by editing them in a PR, never only in the Supabase UI.

## 4. Realtime (2 min)

**Realtime → Settings** (in the sidebar): turn **Allow public access** off. Every channel then has to be private, and `farm_sync.sql` only lets the dashboard listen on `farm-data` (table changes) and `farm-status` (presence). Only the bridge, with the secret key, can mark the farm online.

## 5. Keys (15 min)

**Project Settings → API Keys** (and **Data API** for the URL). There are two keys: the **publishable** key (also called *anon*), safe in a browser because RLS only lets it read; and the **secret** key (also called *service_role*), which bypasses RLS and must stay on servers.

| Value | Vercel (Project → Settings → Environment Variables) | Pi `/etc/verdant/dashboard.env` | Pi `/etc/verdant/supabase-bridge.env` |
|---|---|---|---|
| Project URL | `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` | `SUPABASE_URL` | `SUPABASE_URL` |
| Publishable (anon) key | `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `SUPABASE_ANON_KEY` | — |
| Secret (service_role) key | `SUPABASE_SERVICE_ROLE_KEY` | — | `SUPABASE_SERVICE_ROLE_KEY` |

Each Pi also names its farm (not a secret): `FARM_ID` in `supabase-bridge.env`, and `NEXT_PUBLIC_FARM_ID` / `NEXT_PUBLIC_FARM_NAME` in `dashboard.env`, all matching its row in `farms`. Vercel needs none: it lists every farm.

Also on Vercel: `OPERATOR_KEY`, the passphrase the dashboard asks for before sending commands (`openssl rand -hex 16`). Without it and the secret key, remote commands are turned off.

- Never put the secret key in a `NEXT_PUBLIC_*` variable: those are built into the page.
- The `NEXT_PUBLIC_*` values are fixed at build time: after adding or changing them, redeploy on Vercel.
- `supabase-bridge.env` comes with the bridge (its example file, and the unit, per "Adding a service" in [PI-SERVICES.md](PI-SERVICES.md)).
- A leaked secret key: **Project Settings → API Keys → roll** it, then update Vercel and the Pi.

## 6. Check it

1. **Table Editor**: seven tables; `farms`, `remote_commands`, `robot_telemetry` and the rest show "RLS enabled", and `farms` has a row for each farm.
2. **Database → Publications → supabase_realtime**: `robot_telemetry`, `robot_state`, `alerts`, `farm_topology` and `remote_commands` are on.
3. **Integrations → Cron** (or `select jobname, schedule from cron.job;`): four `trim-*` jobs.
4. The anon key can't write. With `URL` and `ANON` set to the project URL and the publishable key, `curl -X POST "$URL/rest/v1/farm_topology" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" -d '{"topology":{}}'` returns a row-level security error (the row is otherwise valid, so nothing else can be the reason).
5. Once Vercel has the keys: the header's farm picker lists your farms, and sending a command adds a `pending` row to `remote_commands` with the selected farm's `farm_id`.
6. Once the bridge runs: the row turns `sent`, `robot_telemetry`, `robot_state` and `sensor_events` fill, the dashboard's environment feed loads, and the remote dashboard's pill shows **Connected**. A client with only the anon key trying to track presence on `farm-status` is refused.

## Things to know

- **Free projects pause after about a week without activity.** The bridge keeps the project active once it runs; until then, un-pause it from the dashboard (one click, data kept).
- **Size.** The free tier has 500 MB. Robots publish telemetry every second, so the bridge sends at most one row per robot every few seconds (configurable), and the cleanup jobs delete telemetry after 14 days, sensor events and commands after 30, alerts after 90. The Pi's SQLite database keeps the full history.
- **Multiple farms.** One project, one `farms` row and one Pi per farm. MQTT carries no farm id; each farm's bridge stamps its `FARM_ID` on what it writes and relays only its own farm's commands. Remotely the dashboard can switch between farms; on FarmNet it shows only its Pi's farm. Robot ids only need to be unique within a farm.
- **Only the farms' Pis write farm data to Supabase** (the dashboard's command route only adds `remote_commands` rows). The shelf sensors go through the Pi's shelf bridge and MQTT like everything else.
- **Anyone with the dashboard's URL can read farm data.** The publishable key is in the page and RLS allows reads (there's no login). Commands still need `OPERATOR_KEY`, and nothing but the secret key can write.
- **Backups.** The free tier has no downloadable backups. The schema is in git (step 3) and the Pi keeps the history, so a lost project means recreating it from this doc, not lost data.
- **Clocks.** `created_at` and `updated_at` are Supabase's clock. Compare ages in SQL with `now()`, never against a robot's or the Pi's clock (e.g. the bridge's stale-command check).
