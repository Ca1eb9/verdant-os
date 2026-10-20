# Vertical Farm Control PWA

A production-oriented Next.js App Router Progressive Web App for monitoring and operating a vertical farm environment. The UI is designed as a premium dark industrial dashboard with offline-capable shell caching and persistent history.

How the dashboard gets farm data and sends commands, as diagrams: [`docs/architecture.md`](./docs/architecture.md).

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

Opened over http, as the Pi serves it, the dashboard is on FarmNet: it connects to Mosquitto's WebSocket listener on port 9001 of the page's own host, shows live robots from MQTT and sends commands, jog included, straight to the farm (`src/lib/farm/local-source.ts`), with no operator key: only the farm network reaches the broker. Opened over https (Vercel) it reads the farm from Supabase instead (`src/lib/farm/remote-source.ts`, see "Remote Farm Data"). Nothing to configure: `isFarmNet()` in `src/lib/farm/data-source.ts` decides. **Connect to RC** (Manual control) sends `connect_controller`: the robot looks for its Bluetooth controller for 10 s, and the panel says when it connects (telemetry's `controller_connected`, also shown as **Controller**) or that none was found. The control panel's recent commands come live from `farm/commands/+`, so commands sent from other browsers or relayed from Supabase show up too. To also list the ones sent before the page opened, set `NEXT_PUBLIC_DASHBOARD_API_URL` to the Pi's Dashboard API (`GET /commands`, see `farm-controller/README.md`); it's asked once per robot. The same API gives the Alerts page the alerts raised before the page opened (`GET /alerts`, the latest 500) and the History page the last 7 days of shelf readings as 5-minute means (`GET /shelves?bucket_ms=`), each loaded once. Without it, leave it unset: those lists start empty and fill live. The map uses the layout the orchestrator publishes, so start the orchestrator too.

`npm run dev` is http, so on your own machine it's FarmNet too, with the broker at `ws://localhost:9001`. Set these in `web/.env.local` (from `web/.env.example`, step 2):

```
NEXT_PUBLIC_FARM_ID=your-farm-id
NEXT_PUBLIC_FARM_NAME=Your Farm
```

Restart the dev server after changing it; its startup output lists `Environments: .env.local` when the file is read. A local Mosquitto needs the WebSocket listener from `farm-controller/README.md`; a stock install doesn't have one, and the dashboard stays "Disconnected". From another device, open it by this machine's LAN IP: the broker is then looked for there.

Also set `NEXT_PUBLIC_FARM_ID` and `NEXT_PUBLIC_FARM_NAME` to that Pi's farm (its row in Supabase's `farms` table). On FarmNet the dashboard belongs to that one farm, and the header's farm picker is locked to it.

Manual control is hidden for a robot that hasn't read its first tag yet (`initializing`). Set `NEXT_PUBLIC_JOG_WHILE_INITIALIZING=true` to offer it there too, e.g. to drive a robot onto a tag; the robot accepts those jogs either way. It's read at build time.

## Operator Sign-In

Remotely (Vercel), every page and API route needs an operator signed in with Supabase Auth: email and password on `/login`, which matches the rest of the app (theme, `VerdantMark`). `src/middleware.ts` checks the session on each request and refreshes it, so operators stay signed in until they sign out from **Settings**, or for 365 days without a visit (the session cookies' lifetime, `SESSION_COOKIE_MAX_AGE_S` in `src/lib/auth.ts`). The login page forgets the farm readings saved in the browser, so the next person at a shared device doesn't see them. Remote commands are authorized by the session (no operator key) and record the operator's email as `issued_by`. Setup, including adding operators and turning off public sign-ups: [docs/SUPABASE-SETUP.md](../docs/SUPABASE-SETUP.md) step 6.

- **On a farm's Pi there's no sign-in.** A build that names its farm (`NEXT_PUBLIC_FARM_ID`: the Pi's, or `npm run dev` with it set) never asks and never calls Supabase Auth, so the farm works offline. Vercel never counts as a Pi. The server can't see how a page was opened, so `signInRequired()` (`src/lib/auth.ts`) goes by the build rather than by `isFarmNet()`. To try sign-in locally, leave `NEXT_PUBLIC_FARM_ID` unset and set the Supabase URL and publishable key.
- **`AUTH_DISABLED=true`** turns sign-in off anywhere (redeploy on Vercel); commands then need `OPERATOR_KEY` again. Unset or anything else: sign-in stays on.
- **Fails closed.** Without the Supabase URL and publishable key, or while Supabase Auth is unreachable (each call gives up after 8 s), only the login page loads and it says why; API routes answer 401 / 503. Each route also checks the session itself.
- **Security.** The password goes over HTTPS to this app's server (a server action) and on to Supabase Auth; it's never logged. Session cookies are httpOnly, Secure and SameSite=Lax, `?next=` only leads to paths on this site, and `vercel.json` sends HSTS and forbids framing. The service worker never caches `/login`, `/settings` (it shows the email) or a redirect, and sign-out clears its cached pages.

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
- `/history` - shelf readings over time (`FarmDataSource.subscribeShelfHistory`: the last 7 days as 5-minute means, from the Dashboard API on FarmNet or Supabase's `shelf_history` remotely, then live), over the last 15 minutes, hour, 6 hours, 24 hours or 7 days. One chart per measurement (air temperature, humidity, water temperature, pH, light), each on its own axis: the time axis always spans the whole window, so missing readings show as empty time, and the value axis fits the readings with a minimum span so sensor noise doesn't look like a swing. Each chart with alert limits draws them as faint dashed lines, warning (amber) and critical (red), from the alert engine's retained `farm/system/alert-thresholds` (`FarmDataSource.subscribeThresholds`; remotely from Supabase's `alert_thresholds`). Its axis always takes in the warning limits, so a reading shows against its safe band; the critical ones appear once readings come near them. Settings → Charts turns the limit lines (on by default) and a dotted average line (off by default) on or off. Each chart but light shows its average over the window in its top right; light has none, since the grow lights switch on and off and an average of the two means nothing. History and Alerts share that window, kept with the other preferences on the device (`src/lib/time-windows.ts`, `TimeWindowPicker`)
- `/alerts` - alerts from the farm's robots, shelves and services (`FarmDataSource.subscribeAlerts`: live from `farm/alerts` on FarmNet, from Supabase's `alerts` remotely). Open warnings and critical alerts are always pinned on top, whatever the window; below them, newest first and 25 at a time, every other alert raised or resolved in the window. Alert times are the farm's clock and the window the browser's (there's no clock sync), which is why open alerts never depend on it. An alert another one resolved (`FarmAlert.resolves`) is faded with its resolve time (`listAlerts` in `src/hooks/useFarmAlerts.ts`); the Dashboard's Alerts card and sensor dots follow the same alerts. The dashboard checks no sensor ranges itself: that's the alert engine's job. `npm run clear-alerts` on the Pi (`farm/alerts/clear`) empties the list. **Devices** lists every robot and shelf sensor with when the browser last heard from it, silent ones first, and the summary counts how many are reporting (`useDeviceHeartbeats`). A robot is silent after 30 s (the orchestrator's `heartbeat_timeout_ms`), a shelf after 20 s (the shelf bridge's `silence_timeout_ms`). Robots come from the robot list, shelves from their live readings and the stored history, so one that went quiet before the page opened shows as "not heard since this page opened". Remotely the times are this browser's when a row arrived live, and Supabase's when it was loaded
- `/settings` - theme, units, chart lines and other preferences, kept in this browser; signed in, the account and **Sign out**
- `/login` - operator sign-in (remote only)
- `/api/farms` - the farms in Supabase's `farms` table
- `/api/commands?farm_id=` - a farm's recent remote commands (GET), or send one (POST, with `farm_id` in the body)

## Shelf Sensors

The shelf sensor node (Arduino Uno R3) publishes over MQTT on the Pi through the `shelf-bridge` service; see [`docs/shelf-sensors.md`](../docs/shelf-sensors.md). On FarmNet the dashboard reads them live from `farm/shelf/+/sensors` (`src/lib/farm/local-source.ts`); remotely from the `sensor_events` rows the Supabase bridge writes (`src/lib/farm/remote-source.ts`).

## Remote Farm Data

Opened over https (Vercel, or `npm run dev -- --experimental-https` to try it locally), the dashboard reads the selected farm from Supabase with the publishable key (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`). Robots, the map, alerts, alert limits, shelf readings and their history come from the tables the farm's Supabase bridge mirrors (`web/supabase/farm_sync.sql`), loaded once and then followed through Realtime on the private channel `farm-data`; the header pill says **Connected** while the farm's bridge is present on `farm-status`. Commands still go through `/api/commands`, and are refused while the farm isn't online. Without the two Supabase values the pill says "Remote access isn't set up." and the pages show nothing. Note that sign-in doesn't protect this data: the publishable key is in the page's JavaScript and RLS lets it read every farm (`docs/architecture.md`, "Sign-in").

## Deploy To Vercel

- Import the repository into Vercel as a Next.js project.
- Use Node.js 20 or newer.
- Set the Supabase keys and the `NEXT_PUBLIC_SUPABASE_*` values in the project environment: [docs/SUPABASE-SETUP.md](../docs/SUPABASE-SETUP.md) step 5 lists each one, and step 6 sets up operator sign-in. `OPERATOR_KEY` is only needed with `AUTH_DISABLED=true`. The tables are in [`supabase/`](./supabase).
- The included [`vercel.json`](./vercel.json) sets cache behavior for the service worker, manifest, and `/images` assets so the PWA works cleanly in deployment.
- No custom server is required. Vercel can build and deploy the app directly with the default `next build` flow.

## Project Notes

- Fonts (IBM Plex Sans/Mono) are stored in [`src/app/fonts`](./src/app/fonts) and loaded with `next/font/local`, so `npm run build` and the running app need no internet access. This lets the dashboard be built and served on the farm's Raspberry Pi offline.

- Runtime visuals are served from [`public/images`](./public/images), which maps to the `/images` URL path used throughout the app.
- The logo is [`VerdantMark`](./src/components/brand/VerdantMark.tsx): its colours follow the app theme and its grow lights pulse (`animation="grow"` is the loading version). `public/images/app-icon.svg` and `favicon.svg` are static copies of the same drawing (the favicon switches to its glowing version on a dark browser theme), and the PNG icons and the splash screens (one per iPhone and iPad screen in `public/images/splash/`, listed in `src/lib/splash-screens.ts`) are rendered from them, so redraw all of these together.
- The navigation and sensor icons are [`AppIcon`](./src/components/ui/AppIcon.tsx), drawn inline in the theme's accent colours (`--cyan`, `--teal`, `--lime`, `--amber`), so they switch with the theme like the rest of the app. `public/images/dashboard-icon.svg` and `history-icon.svg` are static dark-theme copies for the PWA manifest's shortcuts.
- Supabase reads require explicit environment values. The app does not fall back to a bundled project key.
- The latest reading stays on screen when no new one arrives, marked stale after 10 s without one.
- With mock data on, readings come from a TypeScript `MockSensorGenerator` and the history page uses deterministic time-series data for the selected farm.
- Vercel Analytics only loads on Vercel (`process.env.VERCEL` at build time): a Pi can't reach it.
