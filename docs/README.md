# docs

Every doc in the repo, by topic. New to the project? Start with the root
[README](../README.md) and [AGENTS.md](../AGENTS.md).

## Contracts and design

| Doc | What it covers |
|---|---|
| [firmware-architecture.md](firmware-architecture.md) | The robot–orchestrator contract: statuses, events, commands, the MQTT topics, path planning, survival overrides, manual control |
| [orchestrator state machine](../farm-controller/orchestrator/docs/state-machine.md) | How the orchestrator tracks robots, runs tasks and schedules plants |
| [robot state machine](../firmware/esp32/docs/state-machine.md) | The firmware's state machine, as diagrams |
| [web/docs/architecture.md](../web/docs/architecture.md) | How the dashboard gets farm data, sends commands and signs operators in |
| [coordinate-convention.pdf](coordinate-convention.pdf) | The farm's axes and heading convention |

## Setting up and running the farm

| Doc | What it covers |
|---|---|
| [WIFI-SETUP.md](WIFI-SETUP.md) | FarmNet (the Pi's access point), DHCP, Mosquitto, the uplink. Do this first |
| [PI-SERVICES.md](PI-SERVICES.md) | Running the farm services on the Pi with systemd: setup, deploys, updates, troubleshooting |
| [PI-RELIABILITY.md](PI-RELIABILITY.md) | Power cuts, a UPS, SD card wear, booting from USB |
| [SUPABASE-SETUP.md](SUPABASE-SETUP.md) | The Supabase project for the remote dashboard: tables, keys, operator sign-in |

## Code

| Doc | What it covers |
|---|---|
| [farm-controller/README.md](../farm-controller/README.md) | Developer setup and every Pi service: what it does, its settings, how to run it |
| [firmware/esp32/README.md](../firmware/esp32/README.md) | Robot firmware: building, tasks, motor, sensors, controller, status LED, tests |
| [firmware/shelf-sensor/README.md](../firmware/shelf-sensor/README.md) | Shelf sensor node firmware: its serial output and the grow light input |
| [web/README.md](../web/README.md) | Dashboard: running it, env settings, pages, sign-in, deploying to Vercel |
| [scripts/README.md](../scripts/README.md) | The Pi helper scripts |

## Hardware

| Doc | What it covers |
|---|---|
| [shelf-sensors.md](shelf-sensors.md) | Shelf sensors and grow lights end to end: hardware, the shelf bridge, pH calibration, failures |
| [battery-monitoring.md](battery-monitoring.md) | The robot's battery voltage divider and its calibration |
| [wiring/README.md](wiring/README.md) | Breadboards, pull-up resistors and editing the diagrams; links to each board's wiring |
| [wiring/robot.md](wiring/robot.md) | Robot wiring: parts, pins, power and charging, bring-up |
| [wiring/shelf-sensor.md](wiring/shelf-sensor.md) | Shelf sensor node wiring: sensors, grow light relays, bring-up |

## Planning

| Doc | What it covers |
|---|---|
| [dev-team-timeline.html](dev-team-timeline.html) | Who owns what and when, and what each task must do |
| `Project Planning - Caleb.docx` | Early project planning |
