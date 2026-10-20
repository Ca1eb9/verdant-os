# Farm Controller — Developer Setup

## Prerequisites

- **Node.js** 18+ and npm
- **Mosquitto** MQTT broker (local install)

### Install Mosquitto

**Mac:**
```bash
brew install mosquitto
brew services start mosquitto
```

**Ubuntu / WSL / Raspberry Pi:**
```bash
sudo apt install mosquitto mosquitto-clients
sudo systemctl enable mosquitto
sudo systemctl start mosquitto
```

**Windows:**
Download and install from https://mosquitto.org/download — it runs as a service automatically.

### Add the WebSocket listener (for the dashboard)

The services use port 1883, but a browser can only reach the broker over
WebSockets. A fresh install only listens on 1883, so the dashboard's live
data (`web/README.md`) can't connect until you add port 9001, the same
listeners as the Pi ([docs/WIFI-SETUP.md](../docs/WIFI-SETUP.md)):

```
listener 1883
listener 9001
protocol websockets
allow_anonymous true
```

Mosquitto 2.x rejects clients without a username once any `listener` is set,
so keep `allow_anonymous true`. Only use it on a trusted network.

**Mac:** append to `$(brew --prefix)/etc/mosquitto/mosquitto.conf`, then
`brew services restart mosquitto`.

**Ubuntu / WSL / Raspberry Pi:** put the lines in
`/etc/mosquitto/conf.d/verdant.conf` (`sudo nano`), then
`sudo systemctl restart mosquitto`.

**Windows:** append to `C:\Program Files\mosquitto\mosquitto.conf` (editor run
as administrator), then restart the Mosquitto service.

If it doesn't start, run `mosquitto -c <that file> -v` to see the config error.

Then point the dashboard at it with `web/.env.local` (see "Live Farm Data On
FarmNet" in [web/README.md](../web/README.md)).

### Verify Mosquitto is running

Open two terminals:

```bash
# Terminal 1 — subscribe to everything
mosquitto_sub -t 'farm/#' -v

# Terminal 2 — publish a test message
mosquitto_pub -t 'farm/test' -m 'hello'
```

You should see `farm/test hello` appear in terminal 1. If it does, the broker is working.

---

## Project setup

From the repo root:

```bash
# Install all workspace dependencies
npm install

# Build the shared package (every service depends on this)
npm -w @farm/shared run build
```

> **Important:** Rebuild shared after any changes to `farm-controller/shared/src/`:
> ```bash
> npm -w @farm/shared run build
> ```

---

## Running services

Each service runs independently. Open a separate terminal for each one.

### Simulator (fake robot)

Pretends to be an ESP32 robot. Publishes telemetry, follows paths, responds to commands.

```bash
npm run sim
```

The simulator runs in **autonomous mode** by default — it picks random targets and drives to them. To make it wait for orchestrator commands instead:

```bash
AUTONOMOUS=false npm run sim
```

**Connect to RC** (`connect_controller`) "connects" a pretend Bluetooth controller 2 s later (`controller_connected` in telemetry), so the dashboard's confirmation can be tried without a robot. It never drops.

### Ingester (telemetry recorder)

Subscribes to all telemetry topics, to operator commands
(`farm/commands/+`, jogs excepted) and to alerts (`farm/alerts`), and writes
them to a local SQLite database.

The `alerts` table holds every `FarmAlert` (stored once per `alert_id`) with
its `received_at`, and the `commands` table is the dashboard's command history
on FarmNet. The Dashboard API serves both.

Every table keeps `RETENTION_DAYS` (default 7) of rows: older ones, alerts
still open included, are deleted at startup and once a day. It logs one line
a minute of what it stored, and a malformed message once per topic until that
topic is valid again.

```bash
npm run ingest
```

### Dashboard API (stored data for the dashboard)

Serves the ingester's database to the dashboard over HTTP, read-only. On
FarmNet the dashboard sends commands straight over MQTT, so there is no
command endpoint.

```bash
npm run api          # port 3001, reads ingester/farm_telemetry.db
```

| Route | Returns |
|---|---|
| `GET /health` | `{ ok, database }`: `database` is false until the ingester has created it (the data routes answer 503 until then) |
| `GET /robots` | `{ robots }`: each robot's newest telemetry |
| `GET /telemetry?robot_id=&from=&to=&limit=` | `{ telemetry }`: robot telemetry received between `from` and `to` (default: the last hour), oldest first. `robot_id` optional; `limit` default 1000, at most 10000 (the newest rows are kept) |
| `GET /shelves?shelf_id=&from=&to=&limit=&bucket_ms=` | `{ readings }`: `ShelfSensorData` plus `received_at`, oldest first, with the same `from`/`to`/`limit` rules as `/telemetry`. `shelf_id` optional. With `bucket_ms` (at least 1000), one row per shelf per bucket instead: each reading's mean (`null` if it never read there), `water_level_ok` false if any reading was low, `received_at` the bucket's first; `limit` then counts buckets. The dashboard loads its History page this way |
| `GET /alerts?severity=&source=&limit=` | `{ alerts }`: `FarmAlert`s, newest first. Filters optional; `limit` default 50, at most 500 |
| `GET /commands?robot_id=` | `{ commands }`: the last 10 operator commands, newest first, each `{ id, robot_id, command, issued_by, issued_at, status: "sent" }` (the dashboard's own `/api/commands` shape). `robot_id` optional |

Times are milliseconds since 1970. Everything sorts and filters on
`received_at` (the Pi's clock), which telemetry rows include; a payload's own
`timestamp` is the sender's clock (a shelf reading's is already the Pi's). Bad query values get a 400 with an `error`.

Settings: `PORT` (3001), `DB_PATH` (`../ingester/farm_telemetry.db`) and
`CORS_ORIGINS`, the comma-separated pages allowed to call it (default
`http://localhost:3000`, `npm run dev`). On the Pi they're in
`/etc/verdant/dashboard-api.env` (`deploy/env/dashboard-api.env.example`).
Point the dashboard at it with `NEXT_PUBLIC_DASHBOARD_API_URL`
(`http://localhost:3001` locally).

```bash
npm -w @farm/dashboard-api test
```

The database file is created at `farm-controller/ingester/farm_telemetry.db`.

### Orchestrator

Tracks each robot's state from telemetry and events, queues and assigns tasks,
and sends commands. Start it alongside the simulator in non-autonomous mode:

```bash
AUTONOMOUS=false npm run sim
npm run orch
```

- Settings load from `orchestrator-config.json` at startup. Missing keys take
  their default; a value of the wrong type or out of range stops it with
  `[FATAL] Bad orchestrator config`, and an unknown key only warns.
- It publishes `topology.json` (retained) to `farm/system/topology` at startup,
  for the dashboard's map.
- The plant scheduler queues water and grow tasks for each robot in
  `robot_plants` (`orchestrator/docs/state-machine.md`, section 6). Tests:
  `npm -w @farm/orchestrator test`.
- Queued, assigned and finished tasks, and each robot's open lost, error and
  unknown-node alerts, are saved to `farm-controller/orchestrator-state.json`
  (gitignored) and restored on restart. "Robot recovered" resolves an open
  lost or error alert and "Robot is back on the farm layout" an unknown-node
  one, also after a restart; a lost or error alert raised again while one is
  open replaces it (`resolves` set to the old one).
- Environment overrides: `BROKER_URL`, `CONFIG_PATH`, `TOPOLOGY_PATH`, `STATE_PATH`.
- It exits if the broker isn't reachable at startup. On the Pi it runs as a
  systemd service that starts after Mosquitto and restarts on failure: see
  [docs/PI-SERVICES.md](../docs/PI-SERVICES.md).
- State machine diagrams: `orchestrator/docs/state-machine.md`. The robot-side
  contract is in `docs/firmware-architecture.md`.

### Shelf bridge

Reads the shelf sensor node (Arduino Uno, `firmware/shelf-sensor/`) over USB
serial and publishes its readings to `farm/shelf/{id}/sensors`.

```bash
npm run shelf
```

- Settings load from `shelf-bridge-config.json`: one entry per node with its
  serial port, shelf id, level and pH calibration. On the Pi, prefer the
  `/dev/serial/by-id/...` path over `/dev/ttyACM0`.
- An unplugged node is reopened automatically; a shelf with no readings for
  `silence_timeout_ms` raises one alert on `farm/alerts`, and its next reading
  publishes an info alert resolving it. Open silence alerts are saved to
  `farm-controller/shelf-bridge-state.json` (gitignored), so this works across
  a restart or reboot.
- Environment overrides: `BROKER_URL`, `CONFIG_PATH`, `STATE_PATH`. On the Pi
  it runs as the `farm-shelf-bridge` service with its config in `/etc/verdant/`
  ([docs/PI-SERVICES.md](../docs/PI-SERVICES.md)); by hand, your user needs to
  be in the `dialout` group.

### Alert engine

Watches robot telemetry and shelf readings and publishes a `FarmAlert` to
`farm/alerts` when a reading stays outside its range.

```bash
npm run alert
```

- Ranges load from `alert-engine-config.json`: per telemetry field, a warning
  band inside a critical band, and a deadband. They apply to every payload
  carrying that field, so a robot's AHT20 `temperature_c` and `humidity_pct`
  use the shelf air ranges. The dashboard shows these alerts (its sensor dots
  included) and checks no ranges of its own.
- At startup it publishes the limits it loaded (`AlertThresholds`, retained)
  to `farm/system/alert-thresholds`, so the dashboard's History charts draw
  them as the alert engine applies them. A config change reaches them on the
  next restart.
- A shelf's `water_level_ok: false` is critical. A `null` or missing reading
  raises nothing and keeps the metric's state; silence is the shelf bridge's
  and the orchestrator's to alert on.
- An alert is raised, or escalated from warning to critical, only after the
  readings have stayed out of range for `hold_ms`, so a one-off spike raises
  nothing. Easing or clearing is immediate, but a raised alert clears only once
  the value is back inside its limit by the deadband, so a value sitting on a
  limit doesn't flap. While a metric stays in the same band, it repeats at most
  every `cooldown_ms`.
- Easing from critical to warning publishes a warning, and clearing publishes
  an info alert (`resolved_template`), each with `resolves` set to the
  metric's last alert. The dashboard shows that alert as resolved.
- Optional email: with `RESEND_API_KEY`, `ALERT_EMAIL_FROM` and
  `ALERT_EMAIL_TO` set, every critical alert on `farm/alerts` (from any
  service, e.g. a lost robot) is emailed through [Resend](https://resend.com),
  except this service's repeats. Without all three, or without internet, it
  runs the same and sends nothing; a failed send is logged and dropped. See
  `deploy/env/alert-engine.env.example`.
- `npm run clear-alerts` (`src/clear.ts`) publishes `farm/alerts/clear`:
  the ingester deletes its stored alerts, the Supabase bridge deletes this
  farm's alerts in Supabase, this service, the orchestrator and
  the shelf bridge forget their open ones, and open dashboards empty their
  lists. See "Common tasks" in [docs/PI-SERVICES.md](../docs/PI-SERVICES.md).
- Raised metrics and their last alert are saved to
  `farm-controller/alert-engine-state.json` (gitignored) and restored on
  restart, so a reading back in range after a restart or reboot still resolves
  its alert. Hold times and cooldowns are in memory and start over.
- Environment overrides: `BROKER_URL`, `CONFIG_PATH`, `STATE_PATH`. On the Pi
  it runs as the `farm-alert-engine` service ([docs/PI-SERVICES.md](../docs/PI-SERVICES.md)).

### Supabase bridge

Syncs this farm's MQTT bus with the team's Supabase project for the remote
dashboard. One bridge per farm (Pi); every row it writes carries `FARM_ID`.

```bash
set -a; source /path/to/supabase-bridge.env; set +a   # a copy of the example, kept outside the repo
cd farm-controller/supabase-bridge && ../../node_modules/.bin/tsx src/index.ts
```

Run it with tsx directly rather than `npm run bridge`: on Ctrl+C npm stops
before the bridge has sent what's buffered.

- Settings: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (the secret key),
  `FARM_ID`, `BROKER_URL`, `CONFIG_PATH` (`deploy/env/supabase-bridge.env.example`).
  It stops at startup if `FARM_ID` has no row in `farms` or the key is
  refused, and waits if Supabase is unreachable. Tunables are in
  `supabase-bridge-config.json`.
- **Commands in:** follows this farm's `remote_commands` rows with Realtime and,
  on each new row and every (re)connect, sends every `pending` row, oldest
  first, to `farm/commands/remote`, then marks it `sent` (or `failed` with a
  reason). Rows the orchestrator would drop, and `jog` / `connect_controller`
  (farm network only), fail instead. Rows pending longer than
  `stale_command_ms`, by Supabase's clock, fail as `stale`. With the broker
  down nothing is sent; rows wait and go stale. If Supabase fails partway, it
  tries again every `retry_interval_ms`.
- **Farm online:** tracks presence on `farm-status` under `FARM_ID` while the
  broker is connected.
- **Data out:** robot telemetry (one row per robot per `sample_interval_ms`,
  plus any status or node change), robot state, alerts, alert clears, topology,
  the alert engine's limits and shelf readings (one per shelf per `sample_interval_ms`) go to the tables
  in `web/supabase/farm_sync.sql` and `sensor_events.sql`. Rows queue in order
  and go out every `flush_interval_ms`. Without internet they wait (up to
  `max_buffer_rows`, telemetry and readings dropped first) and are sent when
  it's back; a clear waits its turn behind the alerts before it. The same goes
  for any other error that may pass (Supabase restarting or overloaded, a
  rejected key, a missing grant). Only a row Supabase refuses as invalid
  (a data or constraint error) is logged and dropped, alone, so it can't hold
  up the rest.

### Other services

As new services are added, they'll follow the same pattern:

```bash
npm -w @farm/<package-name> run start
# or for auto-reload during development:
npm -w @farm/<package-name> run dev
```

---

## Project structure

```
farm-controller/
├── shared/              # Types, topics, MQTT client, navigation utils
├── simulator/           # Fake ESP32 robot for testing
├── ingester/            # Telemetry → SQLite recorder
├── orchestrator/        # Robot state, task queue, commands
├── shelf-bridge/        # Shelf sensor node (USB serial) → MQTT
├── alert-engine/        # Sensor readings out of range → alerts
├── supabase-bridge/     # MQTT ↔ Supabase: remote commands in, farm data out
├── dashboard-api/       # Stored data → dashboard (HTTP, read-only)
├── topology.json        # Farm layout (nodes + edges)
├── orchestrator-config.json  # Tunable orchestrator settings
├── shelf-bridge-config.json  # Shelf serial ports and pH calibration
├── alert-engine-config.json  # Alert ranges, hold time and cooldown
├── supabase-bridge-config.json  # Sampling, flush and buffer settings
└── package.json         # Workspace root
```

### Shared package

`shared/src/` contains everything services share:

- **`types.ts`** — All MQTT message types, state enums, topology types, config types
- **`topics.ts`** — MQTT topic constants and helper functions
- **`navigation.ts`** — Graph builder, Dijkstra pathfinding, heading/turn math
- **`mqtt.ts`** — Typed MQTT client wrapper with auto-reconnect

Every service imports from `@farm/shared`. Read through these files before starting any task.

---

## Testing with Mosquitto CLI

Useful commands for debugging:

```bash
# Watch all farm MQTT traffic
mosquitto_sub -t 'farm/#' -v

# Watch only robot telemetry
mosquitto_sub -t 'farm/robot/+/telemetry'

# Watch only robot events
mosquitto_sub -t 'farm/robot/+/events'

# Watch alerts
mosquitto_sub -t 'farm/alerts'

# Send a fake telemetry message
mosquitto_pub -t 'farm/robot/robot-1/telemetry' -m '{"robot_id":"robot-1","status":"idle","current_node":"0x1D5E","battery_pct":85,"heading":1,"timestamp":1234567890}'
```

---

## Creating a new service

1. Create `farm-controller/<service-name>/` with `src/index.ts` and `package.json`
2. Use the ingester as a template for the package.json structure
3. Add `@farm/shared` as a dependency
4. Connect to MQTT using `createMqttClient()` from the shared package
5. Add a run script to the root `package.json` if convenient
6. Rebuild shared if you've added new types: `npm -w @farm/shared run build`
