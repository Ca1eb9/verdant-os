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

### Ingester (telemetry recorder)

Subscribes to all telemetry topics and writes to a local SQLite database.

```bash
npm run ingest
```

The database file is created at `farm-controller/ingester/farm_telemetry.db`.

### Orchestrator

Tracks each robot's state from telemetry and events, queues and assigns tasks,
and sends commands. Start it alongside the simulator in non-autonomous mode:

```bash
AUTONOMOUS=false npm run sim
npm run orch
```

- Settings load from `orchestrator-config.json` at startup.
- Queued, assigned and finished tasks are saved to
  `farm-controller/orchestrator-state.json` (gitignored) and restored on restart.
- Environment overrides: `BROKER_URL`, `CONFIG_PATH`, `TOPOLOGY_PATH`, `STATE_PATH`.
- It exits if the broker isn't reachable at startup; on the Pi, run it under
  systemd with `Restart=on-failure` (or start it after Mosquitto).
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
  `silence_timeout_ms` raises one alert on `farm/alerts`.
- Environment overrides: `BROKER_URL`, `CONFIG_PATH`. Run it under systemd like
  the orchestrator; the user needs to be in the `dialout` group.

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
├── alert-engine/        # (to be built) Threshold monitoring
├── supabase-bridge/     # (to be built) Cloud sync
├── dashboard-api/       # (to be built) REST API for dashboard
├── topology.json        # Farm layout (nodes + edges)
├── orchestrator-config.json  # Tunable orchestrator settings
├── shelf-bridge-config.json  # Shelf serial ports and pH calibration
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
