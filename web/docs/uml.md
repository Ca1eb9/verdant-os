# VerdantOS UML

Mermaid diagrams below match current code shape in this repo.

The laptop serial bridge was retired in favour of the Pi's `shelf-bridge`
service, which publishes shelf readings over MQTT (`docs/shelf-sensors.md` at
the repo root). The Pi's Supabase bridge mirrors them into `sensor_events`
(`docs/SUPABASE-SETUP.md`).

## Component UML

```mermaid
flowchart LR
    User[User Browser]

    subgraph PWA[Next.js PWA]
        direction TB

        subgraph AppRouter[App Router]
            Layout["layout.tsx\nAppShell + TopNav"]
            DashboardPage["/ -> DashboardPage"]
            HistoryPage["/history"]
            AlertsPage["/alerts"]
            ConfigPage["/config"]
        end

        subgraph Views[Client Views]
            DashboardView["DashboardView"]
            HistoryView["HistoryView"]
            AlertsView["AlertsView"]
            ConfigView["ConfigView"]
        end

        subgraph ClientState[Client State + Browser Storage]
            FarmContext["FarmContext"]
            TelemetryHook["useFarmTelemetry"]
            LocalStorage["localStorage\nlast reading per farm"]
            ServiceWorker["service-worker.js\noffline shell cache"]
        end

        subgraph DomainLib[Shared Domain Libraries]
            MockData["mock-data.ts\nmock farms + telemetry (off)"]
            LightCal["light-calibration.ts"]
            FormatLib["format.ts"]
            Types["types.ts"]
            SupabaseConfig["supabase-config.ts"]
        end

        subgraph ApiRoutes[Server API Routes]
            LatestRoute["/api/sensor-events/latest"]
            FarmsRoute["/api/farms"]
            StatusRoute["/api/config/status"]
        end
    end

    DB[(Supabase\nfarms + sensor_events)]

    User --> DashboardPage
    User --> HistoryPage
    User --> AlertsPage
    User --> ConfigPage

    Layout --> DashboardPage
    Layout --> HistoryPage
    Layout --> AlertsPage
    Layout --> ConfigPage

    DashboardPage --> DashboardView
    HistoryPage --> HistoryView
    AlertsPage --> AlertsView
    ConfigPage --> ConfigView

    DashboardView --> FarmContext
    DashboardView --> TelemetryHook
    DashboardView --> FormatLib
    HistoryView --> FarmContext
    HistoryView -. mock on .-> MockData
    AlertsView --> FarmContext
    AlertsView --> TelemetryHook
    FarmContext --> FarmsRoute
    FarmContext -. mock on .-> MockData
    ConfigView --> StatusRoute

    TelemetryHook --> LatestRoute
    TelemetryHook -. mock on .-> MockData
    TelemetryHook --> LightCal
    TelemetryHook --> LocalStorage


    LatestRoute --> SupabaseConfig
    FarmsRoute --> SupabaseConfig
    FarmsRoute --> DB
    StatusRoute --> SupabaseConfig
    LatestRoute --> DB
    StatusRoute --> DB

    User -. install/offline .-> ServiceWorker
```

## Sequence UML

```mermaid
sequenceDiagram
    autonumber
    participant F as FarmContext
    participant D as Supabase sensor_events
    participant R as /api/sensor-events/latest
    participant H as useFarmTelemetry
    participant L as localStorage
    participant V as DashboardView
    participant U as User

    U->>V: Open dashboard
    V->>F: Selected farm (the Pi's own on FarmNet, else from /api/farms)
    V->>H: Initialize telemetry hook for that farm
    H->>L: Read the farm's last reading
    L-->>H: Stored reading or null
    H-->>V: Render it, or "Waiting for data"

    loop Every 2 seconds while browser online
        H->>R: GET /api/sensor-events/latest?farm_id=
        R->>D: Query the farm's newest sensor_events row
        D-->>R: Latest record
        R-->>H: JSON event payload
        H->>H: Map DB row to SensorReading
        H->>L: Store latest reading
        H-->>V: Updated reading and status
        V-->>U: Refresh dashboard cards and badges
    end

    opt No fresh heartbeat for threshold window
        H->>H: Mark stale/live status from lastUpdate
        H-->>V: Show stale state
    end
```
