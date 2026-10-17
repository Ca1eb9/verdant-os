# Vertical Farm Control PWA

A production-oriented Next.js App Router Progressive Web App for monitoring and operating a vertical farm environment. The UI is designed as a premium dark industrial dashboard with offline-capable shell caching and persistent history.

## Stack

- Next.js App Router
- TypeScript
- Recharts for interactive analytics
- MQTT over WebSocket for live farm data on the farm network (FarmNet)
- Supabase for the farm list and remote commands
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

Fill in `.env.local` (gitignored): each value is described in `.env.example`. Next only reads env files in `web/`.

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

Set `NEXT_PUBLIC_MQTT_WS_URL` (for example `ws://192.168.4.1:9001`, Mosquitto's WebSocket listener on the Pi) before `npm run dev` or `npm run build` to show live robots from MQTT and send commands, jog included, straight to the farm (`src/lib/farm/local-source.ts`), with no operator key: only the farm network reaches the broker. It's read at build time. Without it the app uses the default source. **Connect to RC** (Manual control) sends `connect_controller`: the robot looks for its Bluetooth controller for 10 s, and the panel says when it connects (telemetry's `controller_connected`, also shown as **Controller**) or that none was found. The control panel's recent commands come live from `farm/commands/+`, so commands sent from other browsers or relayed from Supabase show up too. To also list the ones sent before the page opened, set `NEXT_PUBLIC_DASHBOARD_API_URL` to the Pi's Dashboard API (`GET /commands`, see `farm-controller/README.md`); it's asked once per robot. The same API gives the Alerts page the alerts raised before the page opened (`GET /alerts`, the latest 500) and the History page the last 7 days of shelf readings as 5-minute means (`GET /shelves?bucket_ms=`), each loaded once. Without it, leave it unset: those lists start empty and fill live. The map uses the layout the orchestrator publishes, so start the orchestrator too.

For `npm run dev` on your own machine, set these in `web/.env.local` (from `web/.env.example`, step 2):

```
NEXT_PUBLIC_MQTT_WS_URL=ws://localhost:9001
NEXT_PUBLIC_FARM_ID=your-farm-id
NEXT_PUBLIC_FARM_NAME=Your Farm
```

Restart the dev server after changing it; its startup output lists `Environments: .env.local` when the file is read. A local Mosquitto needs the WebSocket listener from `farm-controller/README.md`; a stock install doesn't have one, and the dashboard stays "Disconnected". From another device, use this machine's LAN IP instead of `localhost`.

Also set `NEXT_PUBLIC_FARM_ID` and `NEXT_PUBLIC_FARM_NAME` to that Pi's farm (its row in Supabase's `farms` table). On FarmNet the dashboard belongs to that one farm, and the header's farm picker is locked to it.

Manual control is hidden for a robot that hasn't read its first tag yet (`initializing`). Set `NEXT_PUBLIC_JOG_WHILE_INITIALIZING=true` to offer it there too, e.g. to drive a robot onto a tag; the robot accepts those jogs either way. It's read at build time.

## Farms

One Supabase project serves every farm, and each farm has its own Pi. Every Supabase row has a `farm_id`, which the farm's Supabase bridge stamps on it; MQTT carries no farm id. Remotely (Vercel), the header's farm picker lists the `farms` table (`/api/farms`), and switching farms swaps the data source for that farm's (`selectFarm()` in `src/lib/farm/data-source.ts`). Readings and commands are scoped to the selected farm. The pages show why when there's no farm to show: the list is loading, empty or failed, or the Pi's `NEXT_PUBLIC_FARM_ID` is missing.

## Mock Data

`MOCK_DATA_ENABLED` in `src/lib/mock-data.ts` is off: every page shows only real data, and says so when there's none yet. Turn it on to fill the UI with three generated farms, readings and history while working on it without a farm.

The header pill shows the farm connection, never the browser's network: "Connected" while the active data source reaches the farm (the MQTT broker here; the Supabase bridge's presence remotely, once the remote source exists), "Connecting" on the first attempt, and "Disconnected" otherwise, with a banner on every page saying why. Data sources report it through `FarmDataSource.subscribeConnection()`.

On the farm pages (Dashboard, Farm, History, Alerts), the growing logo covers the page while the farm loads, and again while it's disconnected, with the same reason and a "Show the page anyway" button that holds until the farm is back or another farm is picked (`src/components/layout/FarmLoadingOverlay.tsx`). The covered page is inert, so the keyboard can't reach it either. It waits 400 ms first, so a quick load doesn't flash it. Settings never shows it, and neither does mock mode.

## Verification

Run the full handoff check before opening a pull request or handing off the repo:

```bash
npm run check
```

That runs lint, TypeScript, and production build validation.

## App Routes

- `/` - live dashboard: shelf readings, robots, alerts and the farm map
- `/farm` - the farm map and each robot's control panel (commands, manual control)
- `/history` - shelf readings over time (`FarmDataSource.subscribeShelfHistory`: on FarmNet the last 7 days from the Dashboard API, then live)
- `/alerts` - alerts from the farm's robots, shelves and services (`FarmDataSource.subscribeAlerts`: live from `farm/alerts` on FarmNet, not available remotely yet), newest first. An alert another one resolved (`FarmAlert.resolves`) is faded with its resolve time (`listAlerts` in `src/hooks/useFarmAlerts.ts`); the Dashboard's Alerts card and sensor dots follow the same alerts. The dashboard checks no sensor ranges itself: that's the alert engine's job. `npm run clear-alerts` on the Pi (`farm/alerts/clear`) empties the list
- `/settings` - theme, units and other preferences, kept in this browser
- `/api/farms` - the farms in Supabase's `farms` table
- `/api/sensor-events/latest?farm_id=` - a farm's latest Supabase sensor event
- `/api/commands?farm_id=` - a farm's recent remote commands (GET), or send one (POST, with `farm_id` in the body)

## Shelf Sensors

The shelf sensor node (Arduino Uno R3) publishes over MQTT on the Pi through the `shelf-bridge` service; see [`docs/shelf-sensors.md`](../docs/shelf-sensors.md). On FarmNet the dashboard reads them live from `farm/shelf/+/sensors` (`src/lib/farm/local-source.ts`). Remotely there's no live source yet: the readings hook polls the selected farm's newest Supabase `sensor_events` row (`/api/sensor-events/latest`) instead, and robots, alerts and history are empty until the remote data source exists (the dashboard data-flow task).

## Deploy To Vercel

- Import the repository into Vercel as a Next.js project.
- Use Node.js 20 or newer.
- Set the Supabase keys, `OPERATOR_KEY` and the `NEXT_PUBLIC_SUPABASE_*` values in the project environment: [docs/SUPABASE-SETUP.md](../docs/SUPABASE-SETUP.md) step 5 lists each one. The tables are in [`supabase/`](./supabase).
- The included [`vercel.json`](./vercel.json) sets cache behavior for the service worker, manifest, and `/images` assets so the PWA works cleanly in deployment.
- No custom server is required. Vercel can build and deploy the app directly with the default `next build` flow.

## Project Notes

- Fonts (IBM Plex Sans/Mono) are stored in [`src/app/fonts`](./src/app/fonts) and loaded with `next/font/local`, so `npm run build` and the running app need no internet access. This lets the dashboard be built and served on the farm's Raspberry Pi offline.

- Runtime visuals are served from [`public/images`](./public/images), which maps to the `/images` URL path used throughout the app.
- The logo is [`VerdantMark`](./src/components/brand/VerdantMark.tsx): its colours follow the app theme and its grow lights pulse (`animation="grow"` is the loading version). `public/images/app-icon.svg` and `favicon.svg` are static copies of the same drawing (the favicon switches to its glowing version on a dark browser theme), and the PNG icons and the splash screens (one per iPhone and iPad screen in `public/images/splash/`, listed in `src/lib/splash-screens.ts`) are rendered from them, so redraw all of these together.
- Supabase reads require explicit environment values. The app does not fall back to a bundled project key.
- The latest reading stays on screen when no new one arrives, marked stale after 10 s without one.
- With mock data on, readings come from a TypeScript `MockSensorGenerator` and the history page uses deterministic time-series data for the selected farm.
- Vercel Analytics only loads on Vercel (`process.env.VERCEL` at build time): a Pi can't reach it.
