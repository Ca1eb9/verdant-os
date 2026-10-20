# Dashboard architecture

How the dashboard gets farm data and sends commands. Every page reads the
farm through one interface, `FarmDataSource` (`src/lib/farm/data-source.ts`),
so the UI is the same on the farm's WiFi (FarmNet) and on Vercel. Only the
source behind it changes.

The page picks the source itself from how it was opened: over http it was
served by the farm's Pi (FarmNet), over https by Vercel (remote).

## Components

```mermaid
flowchart LR
    subgraph Pages["Pages (src/app)"]
        Dash["/ Dashboard"]
        Farm["/farm"]
        Hist["/history"]
        Alerts["/alerts"]
        Settings["/settings"]
    end

    subgraph Hooks["Hooks (src/hooks)"]
        Live["useFarmLive<br/>topology + robots"]
        Tele["useFarmTelemetry<br/>newest shelf reading"]
        AlertsH["useFarmAlerts"]
        HistH["useShelfHistory"]
        Conn["useFarmConnection<br/>header pill, banner, overlay"]
        Prefs["PreferencesProvider<br/>theme, units (localStorage)"]
    end

    FarmCtx["FarmContext<br/>which farm"]
    DS{{"FarmDataSource<br/>data-source.ts"}}

    Dash --> Tele & AlertsH & Live
    Farm --> Live
    Farm -- "ControlPanel: commands,<br/>history, jog" --> DS
    Hist --> HistH
    Alerts --> AlertsH & Tele
    Settings --> Prefs

    Live & Tele & AlertsH & HistH & Conn --> DS
    FarmCtx -- "selectFarm()" --> DS

    DS --> Local["local-source.ts<br/>(FarmNet)"]
    DS --> Remote["remote-source.ts<br/>(remote)"]

    Local -- "MQTT over WebSocket :9001" --> Broker[("Mosquitto on the Pi")]
    Local -- "GET /commands /alerts /shelves<br/>once each" --> DApi["Dashboard API<br/>(Pi :3001, SQLite)"]

    Remote -- "/api/commands" --> Next["Next.js API routes"]
    FarmCtx -- "remote: /api/farms" --> Next
    Next --> Supa[("Supabase")]
    Remote -- "tables, then Realtime:<br/>farm-data, farm-status" --> Supa
    Bridge["Supabase bridge (Pi)"] --> Supa
```

- **On FarmNet** the local source reads everything live from the broker:
  `farm/robot/+/telemetry` and `farm/robot/+/state`, `farm/system/topology`,
  `farm/system/alert-thresholds`,
  `farm/shelf/+/sensors`, `farm/alerts` (and `farm/alerts/clear`), and every
  command on `farm/commands/+`. The Dashboard API fills in what happened
  before the page opened: recent commands per robot, the latest 500 alerts,
  and 7 days of shelf readings as 5-minute means.
- **Remotely** the remote source reads what the farm's Supabase bridge
  mirrors, with the publishable key: `robot_state` and each robot's newest
  `robot_telemetry`, `farm_topology`, `alert_thresholds`, the latest 500
  `alerts`, each shelf's newest `sensor_events` row, and 7 days of shelf
  readings as 5-minute means (`shelf_history`). Then it follows their changes
  through Realtime on the private channel `farm-data`, filtered to the farm
  (alert deletes, which can't be filtered, by `alert_id`). Every (re)join
  loads again, since Realtime misses what changes while it's away; changes
  that arrive during a load are applied after it. The farm is online while
  its bridge's key is in `farm-status`'s presence state. Commands go through
  `/api/commands` into `remote_commands`, and are refused while the farm
  isn't online rather than left waiting there.

## Picking the source

```mermaid
flowchart TD
    Start([Page loads]) --> Detect{"FarmContext, after hydration:<br/>opened over http?"}
    Detect -- "yes: served by the Pi" --> LocalSrc["local source, broker at<br/>ws://(page host):9001, one farm:<br/>NEXT_PUBLIC_FARM_ID, picker locked"]
    Detect -- "no, https: Vercel" --> List["FarmContext loads /api/farms"]
    List -- "a farm picked" --> RemoteSrc["remote source (farm)"]
    List -- "loading, empty or failed" --> None["no-farm source:<br/>the pages say why"]
```

The Pi serves plain http on the farm network, and Vercel only https, where
the browser would refuse the broker's `ws://` anyway. `npm run dev` is http,
so it's FarmNet; `npm run dev -- --experimental-https` tries remote mode.
The detection runs in the browser after hydration, so the server's render and
the browser's first one match.

Swapping farms remotely swaps the whole source (`selectFarm()`), so every
hook resubscribes to the new farm, and the old source closes its connection
once its last listener has gone.

## A command on FarmNet

```mermaid
sequenceDiagram
    autonumber
    participant U as Operator
    participant C as ControlPanel
    participant L as local source
    participant B as Mosquitto
    participant O as Orchestrator
    participant R as Robot (ESP32)

    U->>C: Stop / Navigate / Return to dock
    C->>L: sendCommand()
    L->>B: farm/commands/local (RemoteCommand)
    alt the broker isn't reachable
        L-->>C: fails at once: never queued for later
    end
    B->>O: farm/commands/local
    O->>B: farm/robot/{id}/command
    B->>R: command
    R->>B: farm/robot/{id}/telemetry and events (status, task)
    O->>B: farm/robot/{id}/state (the orchestrator's view, retained)
    B->>L: telemetry and state
    L-->>C: robot updates, and the command in the history (farm/commands/+)

    loop jog: every 150 ms while the button is held
        C->>L: jog
        L->>B: farm/commands/local
        B->>O: (farm network only: remote jogs are refused)
        O->>B: farm/robot/{id}/command
        B->>R: drives 500 ms from each one
    end
```

## A command remotely

```mermaid
sequenceDiagram
    autonumber
    participant U as Operator
    participant C as ControlPanel
    participant A as /api/commands (Next.js)
    participant S as Supabase remote_commands
    participant SB as Supabase bridge (Pi)
    participant O as Orchestrator

    U->>C: command
    C->>A: POST, farm_id in the body (session cookie)
    A->>A: check the signed-in operator (OPERATOR_KEY with sign-in off), validate (no jog)
    A->>S: insert, status pending, issued_by = the operator's email
    A-->>C: the command record
    S--)SB: Realtime insert (and pending rows on reconnect)
    SB->>O: farm/commands/remote
    SB--)S: status sent, or failed
```

## Sign-in (remote only)

Operators sign in with Supabase Auth (email and password) everywhere but a
farm's Pi: the Pi's build, which names its farm (`NEXT_PUBLIC_FARM_ID`, never
set on Vercel), never asks, and never calls Supabase Auth, so it works offline.
The server can't see how a page was opened, so this goes by the build. `AUTH_DISABLED=true` turns sign-in off
elsewhere too (`signInRequired()` in `src/lib/auth.ts`). The password only
travels over HTTPS, to this app's server and on to Supabase Auth; the session
lives in httpOnly cookies that no browser script can read.

```mermaid
sequenceDiagram
    autonumber
    participant U as Operator's browser
    participant M as middleware.ts
    participant P as /login (server action)
    participant SA as Supabase Auth

    U->>M: any page or /api route
    M->>SA: getClaims(): verify the session (cached signing keys), refresh it near expiry
    alt signed in
        M-->>U: the page, with refreshed cookies
    else signed out
        M-->>U: redirect to /login?next= (API: 401)
    else Supabase Auth unreachable or slow (8 s)
        M-->>U: redirect to /login?reason=unavailable (API: 503)
    end
    U->>P: email + password
    P->>SA: signInWithPassword
    P-->>U: httpOnly session cookies, redirect to next (this site only)
```

Each API route checks the session again itself (`getSession()`, `refuse()`).
Fails closed: without the Supabase URL and publishable key, or with Supabase
Auth down, only the login page loads, and it says why.

Sign-in guards this app's pages and API routes, not Supabase itself: the
remote source reads farm data straight from Supabase with the publishable
key, which RLS lets read every farm's rows. Anyone with that key (it's in the
page's JavaScript) can read them, signed in or not; only writes are closed.

## Connection and loading

`subscribeConnection()` is the farm connection, never the browser's network:
on FarmNet, whether the broker answers; remotely, whether the farm's Supabase
bridge is present on the `farm-status` channel (it untracks while its broker
is down), or "Can't reach the cloud service." when Realtime is. The header
pill, the offline banner and the loading overlay all follow it. A command
sent while it's offline fails rather than waiting, so a stop or jog can't
arrive late.
