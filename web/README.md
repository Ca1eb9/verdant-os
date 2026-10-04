# Vertical Farm Control PWA

A production-oriented Next.js App Router Progressive Web App for monitoring and operating a vertical farm environment. The UI is designed as a premium dark industrial dashboard with offline-capable shell caching and persistent history.

## Stack

- Next.js App Router
- TypeScript
- Recharts for interactive analytics
- Supabase for live sensor event reads
- Custom service worker for installability and offline shell behavior

## Local Development

1. Install dependencies:

```bash
npm ci
```

2. Configure environment:

```bash
cp .env.example .env.local
```

Fill in Supabase values in `.env.local`.

3. Start the development server:

```bash
npm run dev
```

4. Build for production:

```bash
npm run build
npm run start
```

## Live Farm Data On FarmNet

Set `NEXT_PUBLIC_MQTT_WS_URL` (for example `ws://192.168.4.1:9001`, Mosquitto's WebSocket listener on the Pi) before `npm run dev` or `npm run build` to show live robots from MQTT and send commands, jog included, straight to the farm (`src/lib/farm/local-source.ts`). It's read at build time. Without it the app uses the default source. For the command history, also set `NEXT_PUBLIC_DASHBOARD_API_URL` to the Pi's Dashboard API (`GET /commands`, see `farm-controller/README.md`); until that exists, leave it unset and the history stays empty. The map uses the layout the orchestrator publishes, so start the orchestrator too.

Also set `NEXT_PUBLIC_FARM_ID` and `NEXT_PUBLIC_FARM_NAME` to that Pi's farm (its row in Supabase's `farms` table). On FarmNet the dashboard belongs to that one farm, and the header's farm picker is locked to it.

## Farms

One Supabase project serves every farm, and each farm has its own Pi. Every Supabase row has a `farm_id`, which the farm's Supabase bridge stamps on it; MQTT carries no farm id. Remotely (Vercel), the header's farm picker lists the `farms` table (`/api/farms`), and switching farms swaps the data source for that farm's (`selectFarm()` in `src/lib/farm/data-source.ts`). Readings and commands are scoped to the selected farm. The pages show why when there's no farm to show: the list is loading, empty or failed, or the Pi's `NEXT_PUBLIC_FARM_ID` is missing.

## Mock Data

`MOCK_DATA_ENABLED` in `src/lib/mock-data.ts` is off: every page shows only real data, and says so when there's none yet (history has no source until the dashboard data-flow work). Turn it on to fill the UI with three generated farms, readings and history while working on it without a farm.

The header pill shows the farm connection, never the browser's network: "Connected" while the active data source reaches the farm (the MQTT broker here; the Supabase bridge's presence remotely, once the remote source exists), "Connecting" on the first attempt, and "Disconnected" otherwise, with a banner on every page saying why. Data sources report it through `FarmDataSource.subscribeConnection()`.

## Verification

Run the full handoff check before opening a pull request or handing off the repo:

```bash
npm run check
```

That runs lint, TypeScript, and production build validation.

## App Routes

- `/` - live dashboard
- `/history` - historical charts (mock data only, for now)
- `/alerts` - current and stored alert review
- `/config` - deployment and ingestion readiness
- `/api/farms` - the farms in Supabase's `farms` table
- `/api/sensor-events/latest?farm_id=` - a farm's latest Supabase sensor event
- `/api/commands?farm_id=` - a farm's recent remote commands (GET), or send one (POST, with `farm_id` in the body)
- `/api/config/status` - server-side environment and ingestion status

## Shelf Sensors

The shelf sensor node (Arduino Uno R3) publishes over MQTT on the Pi through the `shelf-bridge` service; see [`docs/shelf-sensors.md`](../docs/shelf-sensors.md). The old laptop serial bridge is retired. Supabase's `sensor_events` is filled by the Pi's Supabase bridge from those readings, and on FarmNet the dashboard will read them over MQTT; both are part of the Supabase bridge and dashboard data-flow work.

## Deploy To Vercel

- Import the repository into Vercel as a Next.js project.
- Use Node.js 20 or newer.
- Set the Supabase keys, `OPERATOR_KEY` and the `NEXT_PUBLIC_SUPABASE_*` values in the project environment: [docs/SUPABASE-SETUP.md](../docs/SUPABASE-SETUP.md) step 5 lists each one. The tables are in [`supabase/`](./supabase).
- The included [`vercel.json`](./vercel.json) sets cache behavior for the service worker, manifest, and `/images` assets so the PWA works cleanly in deployment.
- No custom server is required. Vercel can build and deploy the app directly with the default `next build` flow.

## Project Notes

- Fonts (IBM Plex Sans/Mono) are stored in [`src/app/fonts`](./src/app/fonts) and loaded with `next/font/local`, so `npm run build` and the running app need no internet access. This lets the dashboard be built and served on the farm's Raspberry Pi offline.

- Runtime visuals are served from [`public/images`](./public/images), which maps to the `/images` URL path used throughout the app.
- Supabase reads require explicit environment values. The app does not fall back to a bundled project key.
- The dashboard polls the selected farm's latest reading and keeps it in the browser, so the last known state still renders (marked stale) when offline.
- With mock data on, telemetry comes from a TypeScript `MockSensorGenerator` using the same top-level payload shape as the live sensor pipeline (`type`, `ts`, `device`, `seq`, `air`, `water`, `light`, `level`), and the history page uses deterministic time-series data for the selected farm.
- The config page surfaces deployment readiness, recent ingestion, and device health.
