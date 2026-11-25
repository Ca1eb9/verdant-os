# Dashboard (Next.js PWA)

The farm's dashboard: a Next.js App Router Progressive Web App for monitoring
and operating the farm, with a dark industrial look, an installable offline
shell and stored history. The same build runs in two places:

- **On FarmNet** (served by the Pi over http, or `npm run dev`): live data and commands straight over MQTT. No sign-in.
- **Remotely** (Vercel, over https): the farm's data and commands through Supabase. Operators sign in.

How it gets farm data and sends commands, as diagrams: [docs/architecture.md](./docs/architecture.md).

## Stack

- Next.js App Router, TypeScript
- Recharts for the charts
- MQTT over WebSocket for live farm data on FarmNet
- Supabase for the farm list, remote data, remote commands and operator sign-in
- A custom service worker for installability and the offline shell

## Local development

```bash
npm ci
cp .env.example .env.local   # fill it in: each value is described in .env.example
npm run dev
```

`.env.local` is gitignored. Next only reads env files in `web/`. Restart the
dev server after changing it; its startup output lists
`Environments: .env.local` when the file is read.

`npm run dev` is http, so on your own machine it's FarmNet too, with the broker
at `ws://localhost:9001`:

1. Run a local Mosquitto with the WebSocket listener from [farm-controller/README.md](../farm-controller/README.md#add-the-websocket-listener-for-the-dashboard). A stock install doesn't have one, and the dashboard stays "Disconnected".
2. Set `NEXT_PUBLIC_FARM_ID` and `NEXT_PUBLIC_FARM_NAME` in `.env.local`.
3. Start the orchestrator (the map uses the layout it publishes) and the simulator, and optionally the Dashboard API for stored history.

From another device, open it by this machine's LAN IP: the broker is then looked for there.

To try the remote mode locally, run `npm run dev -- --experimental-https` with the two Supabase values set.

## Settings

Each is described in [`.env.example`](./.env.example); on the Pi they're in
`/etc/verdant/dashboard.env` ([docs/PI-SERVICES.md](../docs/PI-SERVICES.md)).
`NEXT_PUBLIC_*` values are fixed at build time.

| Setting | What it does |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase: the farm list and, remotely, readings and commands. The publishable key, never the secret one |
| `NEXT_PUBLIC_FARM_ID`, `NEXT_PUBLIC_FARM_NAME` | This Pi's farm (its row in Supabase's `farms` table). On FarmNet the dashboard shows only this farm. Set, it also turns sign-in off. Leave unset on Vercel |
| `NEXT_PUBLIC_DASHBOARD_API_URL` | The Pi's Dashboard API, for data from before the page opened. Unset: those lists start empty and fill live |
| `NEXT_PUBLIC_JOG_WHILE_INITIALIZING` | `true` offers manual control for a robot that hasn't read its first tag yet (`initializing`), e.g. to drive it onto one. The robot accepts those jogs either way |
| `NEXT_PUBLIC_MANUAL_ELEVATOR` | On unless `false`. Shows **Elevator arrived** while a robot is on the elevator, on FarmNet only, for robots flashed with `MANUAL_ELEVATOR` (firmware `config.h`), which wait for that button instead of a fixed time. Turn both off together |
| `NEXT_PUBLIC_MAP_LIGHTS_FROM_SWITCHES` | On unless `false`. The farm map draws the grow lights from the Lights card's switches; `false` draws them from the light sensors. Remotely there are no switches, so the sensors draw either way |
| `NEXT_PUBLIC_MAP_LIGHTS_ON_OFF` | `true` draws each light fully on or off from its sensor instead of as bright as it reads. Only when the map draws from the sensors |
| `AUTH_DISABLED` | `true` turns operator sign-in off; remote commands then need `OPERATOR_KEY`. Server-side |
| `SUPABASE_SERVICE_ROLE_KEY`, `OPERATOR_KEY` | Remote commands on Vercel ([docs/SUPABASE-SETUP.md](../docs/SUPABASE-SETUP.md) step 5). Server-side, never committed |

## Where the data comes from

`isFarmNet()` in `src/lib/farm/data-source.ts` decides by how the page was
opened; there's nothing to configure. Either way the UI only talks to a
`FarmDataSource`.

### On FarmNet

Opened over http, the dashboard connects to Mosquitto's WebSocket listener on
port 9001 of the page's own host (`src/lib/farm/local-source.ts`).

- **Live data:** robots, the map layout (published by the orchestrator), alerts, shelf readings (`farm/shelf/+/sensors`, from the [shelf bridge](../docs/shelf-sensors.md)) and grow light states, all from MQTT.
- **Commands,** jog included, go straight to the farm with no operator key: only the farm network reaches the broker. They're never queued for a reconnect.
- **Recent commands** come live from `farm/commands/+`, so commands sent from other browsers or relayed from Supabase show up too.
- **Data from before the page opened** comes from the Dashboard API (`NEXT_PUBLIC_DASHBOARD_API_URL`, [farm-controller/README.md](../farm-controller/README.md#dashboard-api)), each loaded once: each robot's recent commands (`GET /commands`), the Alerts page's alerts (`GET /alerts`, the latest 500) and the History page's last 7 days of shelf readings as 5-minute means (`GET /shelves?bucket_ms=`).
- **Connect to RC** (manual control) sends `connect_controller`. The robot looks for its Bluetooth controller for 10 s, and the panel says when it connects (telemetry's `controller_connected`, also shown as **Controller**) or that none was found.
- The header's farm picker is locked to `NEXT_PUBLIC_FARM_ID`.

### Remotely

Opened over https, the dashboard reads the selected farm from Supabase with the
publishable key (`src/lib/farm/remote-source.ts`).

- **Data:** robots, the map, alerts, alert limits, shelf readings (`sensor_events`) and their history come from the tables the farm's Supabase bridge mirrors (`web/supabase/farm_sync.sql`). They're loaded once, then followed through Realtime on the private channel `farm-data`.
- **Commands** go through `/api/commands`, and are refused while the farm isn't online.
- **Farms:** one Supabase project serves every farm, and each farm has its own Pi, whose Supabase bridge stamps its `farm_id` on every row (MQTT carries none). The header's farm picker lists the `farms` table (`/api/farms`), and switching farms swaps the data source for that farm's (`selectFarm()` in `src/lib/farm/data-source.ts`).
- Without the two Supabase values the pill says "Remote access isn't set up." and the pages show nothing.
- Sign-in doesn't protect this data: the publishable key is in the page's JavaScript and RLS lets it read every farm ([docs/architecture.md](./docs/architecture.md#sign-in-remote-only)).

### Connection and loading

The header pill shows the **farm connection**, never the browser's network:
the MQTT broker on FarmNet, the farm's Supabase bridge (its presence on
`farm-status`) remotely. It reads "Connecting" on the first attempt,
"Connected" while the farm is reachable and "Disconnected" otherwise, with a
banner on every page saying why. Data sources report it through
`FarmDataSource.subscribeConnection()`.

On the farm pages (Dashboard, Farm, History, Alerts), the growing logo covers
the page while the farm loads and while it's disconnected, with the same reason
and a **Show the page anyway** button that holds until the farm is back or
another farm is picked (`src/components/layout/FarmLoadingOverlay.tsx`).

- It waits 400 ms first, so a quick load doesn't flash it.
- The covered page is inert, so the keyboard can't reach it either.
- Settings never shows it, and neither does mock mode.

When there's no farm to show, the pages say why: the list is loading, empty or
failed, or the Pi's `NEXT_PUBLIC_FARM_ID` is missing. The latest reading stays
on screen when no new one arrives, marked stale after 10 s.

## Operator sign-in

Remotely, every page and API route needs an operator signed in with Supabase
Auth: email and password on `/login`. Setup, including adding operators and
turning off public sign-ups: [docs/SUPABASE-SETUP.md](../docs/SUPABASE-SETUP.md) step 6.

- **Sessions.** `src/middleware.ts` checks the session on each request and refreshes it, so operators stay signed in until they sign out from **Settings**, or for 365 days without a visit (`SESSION_COOKIE_MAX_AGE_S` in `src/lib/auth.ts`).
- **Commands** are authorized by the session (no operator key) and record the operator's email as `issued_by`.
- **No sign-in on a farm's Pi.** A build that names its farm (`NEXT_PUBLIC_FARM_ID`) never asks and never calls Supabase Auth, so the farm works offline. The server can't see how a page was opened, so `signInRequired()` (`src/lib/auth.ts`) goes by the build rather than by `isFarmNet()`. Vercel never counts as a Pi. To try sign-in locally, leave `NEXT_PUBLIC_FARM_ID` unset and set the Supabase URL and publishable key.
- **`AUTH_DISABLED=true`** turns sign-in off anywhere (redeploy on Vercel); commands then need `OPERATOR_KEY` again.
- **Fails closed.** Without the Supabase URL and publishable key, or while Supabase Auth is unreachable (each call gives up after 8 s), only the login page loads and it says why; API routes answer 401 / 503. Each route also checks the session itself.
- **Security.** The password goes over HTTPS to this app's server (a server action) and on to Supabase Auth; it's never logged. Session cookies are httpOnly, Secure and SameSite=Lax, `?next=` only leads to paths on this site, and `vercel.json` sends HSTS and forbids framing. The service worker never caches `/login`, `/settings` (it shows the email) or a redirect, and sign-out clears its cached pages. The login page forgets the farm readings saved in the browser, so the next person at a shared device doesn't see them.

## Pages and routes

| Route | What it is |
|---|---|
| `/` | Live dashboard: shelf readings, robots, grow lights, alerts and the farm map |
| `/farm` | The farm map and each robot's control panel (commands, manual control) |
| `/history` | Shelf readings over time ([below](#history)) |
| `/alerts` | Alerts from the farm's robots, shelves and services, and every device's last report ([below](#alerts)) |
| `/settings` | Theme, units, chart lines and other preferences, kept in this browser; when signed in, the account and **Sign out** |
| `/login` | Operator sign-in (remote only) |
| `/api/farms` | The farms in Supabase's `farms` table |
| `/api/commands?farm_id=` | A farm's recent remote commands (GET), or send one (POST, with `farm_id` in the body) |

### History

Shelf readings over the last 15 minutes, hour, 6 hours, 24 hours or 7 days
(`FarmDataSource.subscribeShelfHistory`): the last 7 days as 5-minute means,
from the Dashboard API on FarmNet or Supabase's `shelf_history` remotely, then
live.

- **One chart per measurement** (air temperature, humidity, water temperature, pH, light), each on its own axis. The time axis always spans the whole window, so missing readings show as empty time. The value axis fits the readings with a minimum span, so sensor noise doesn't look like a swing.
- **Alert limits** are drawn as faint dashed lines, warning (amber) and critical (red), from the alert engine's retained `farm/system/alert-thresholds` (`FarmDataSource.subscribeThresholds`; remotely Supabase's `alert_thresholds`). The axis always takes in the warning limits, so a reading shows against its safe band; the critical ones appear once readings come near them.
- **Averages:** each chart but light shows its average over the window in its top right. Light has none, since the grow lights switch on and off and an average of the two means nothing.
- **Settings → Charts** turns the limit lines (on by default) and a dotted average line (off by default) on or off.
- History and Alerts share the window, kept with the other preferences on the device (`src/lib/time-windows.ts`, `TimeWindowPicker`).

### Alerts

Alerts come from `FarmDataSource.subscribeAlerts`: live from `farm/alerts` on
FarmNet, from Supabase's `alerts` remotely. The dashboard checks no sensor
ranges itself; that's the alert engine's job.

- **Open warnings and critical alerts are always pinned on top,** whatever the window. Below them, newest first and 25 at a time, every other alert raised or resolved in the window. Alert times are the farm's clock and the window the browser's (there's no clock sync), which is why open alerts never depend on it.
- **An alert another one resolved** (`FarmAlert.resolves`) is faded, with its resolve time (`listAlerts` in `src/hooks/useFarmAlerts.ts`). The Dashboard's Alerts card and sensor dots follow the same alerts.
- `npm run clear-alerts` on the Pi (`farm/alerts/clear`) empties the list.
- **Devices** lists every robot and shelf sensor with when the browser last heard from it, silent ones first, and the summary counts how many are reporting (`useDeviceHeartbeats`). A robot is silent after 30 s (the orchestrator's `heartbeat_timeout_ms`), a shelf after 20 s (the shelf bridge's `silence_timeout_ms`). Robots come from the robot list, shelves from their live readings and the stored history, so one that went quiet before the page opened shows as "not heard since this page opened". Remotely, the times are this browser's when a row arrived live, and Supabase's when it was loaded.

## Mock data

`MOCK_DATA_ENABLED` in `src/lib/mock-data.ts` is off: every page shows only
real data, and says so when there's none yet. Turn it on to fill the UI with
three generated farms, readings (`MockSensorGenerator`) and deterministic
history while working without a farm. Don't commit it on.

## Checks

Before opening a pull request:

```bash
npm run check
```

That runs lint, TypeScript and a production build.

## Deploy to Vercel

- Import the repository into Vercel as a Next.js project with `web/` as its root. Use Node.js 20 or newer.
- Set the environment variables from [docs/SUPABASE-SETUP.md](../docs/SUPABASE-SETUP.md) step 5; step 6 sets up operator sign-in. `OPERATOR_KEY` is only needed with `AUTH_DISABLED=true`. The tables are in [`supabase/`](./supabase).
- [`vercel.json`](./vercel.json) sets cache behaviour for the service worker, manifest and `/images` assets so the PWA updates cleanly.
- No custom server: Vercel builds it with the default `next build`.

## Project notes

- **Fonts** (IBM Plex Sans/Mono) are in [`src/app/fonts`](./src/app/fonts), loaded with `next/font/local`, so building and running need no internet. That's what lets the Pi build and serve the dashboard offline.
- **Images** are in [`public/images`](./public/images), served at `/images`.
- **The logo** is [`VerdantMark`](./src/components/brand/VerdantMark.tsx): its colours follow the theme and its grow lights pulse (`animation="grow"` is the loading version). `public/images/app-icon.svg` and `favicon.svg` are static copies of the same drawing (the favicon switches to its glowing version on a dark browser theme). The PNG icons and the splash screens (one per iPhone and iPad screen in `public/images/splash/`, listed in `src/lib/splash-screens.ts`) are rendered from them, so redraw all of these together.
- **Icons** are [`AppIcon`](./src/components/ui/AppIcon.tsx), drawn inline in the theme's accent colours (`--cyan`, `--teal`, `--lime`, `--amber`), so they switch with the theme. `public/images/dashboard-icon.svg` and `history-icon.svg` are static dark-theme copies for the PWA manifest's shortcuts.
- **No bundled Supabase key.** Supabase reads need the environment values.
- **Vercel Analytics** only loads on Vercel (`process.env.VERCEL` at build time): a Pi can't reach it.
