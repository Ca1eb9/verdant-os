# Agent guide — VerdantOS

Read this before changing anything. It covers how to work in this repo and what
must stay consistent. It doesn't say what to build: that's your task.

## The project

An autonomous vertical farm. Robots (ESP32) carry plants between water, light
and charging stations, navigating by RFID tags. A Raspberry Pi runs Node.js
services that talk to the robots over MQTT, and a Next.js dashboard shows the
farm locally and through Supabase.

| Path | What it is |
|---|---|
| `farm-controller/shared/` | Types, MQTT topics, navigation, MQTT client. Used by every Pi service |
| `farm-controller/<service>/` | One Pi service per folder (orchestrator, simulator, ingester, …) |
| `firmware/esp32/` | Robot firmware (PlatformIO, FreeRTOS) |
| `web/` | Dashboard (Next.js) |
| `docs/` | Architecture docs and the team timeline |

## Sources of truth

When sources disagree, this order wins: **code contract > design docs > timeline**.

- `farm-controller/shared/src/types.ts` and `topics.ts`: every MQTT message and topic.
- `docs/firmware-architecture.md`: the robot–orchestrator contract.
- `farm-controller/orchestrator/docs/state-machine.md` and
  `firmware/esp32/docs/state-machine.md`: orchestrator and robot state machines.
- `docs/dev-team-timeline.html`: who owns what and when. Plans only; it may be
  older than the docs above.

## Contract rules

- **The robot is the source of truth.** Pi services react to what the robot
  reports; they don't predict or override its state.
- **Services only talk over MQTT.** Never import one service from another.
  Build topic strings with the `TOPICS` helpers, never by hand.
- **Node ids on the wire, not RFID tag ids.** Tag-to-node lookup happens on the robot.
- **Shared types have copies.** Changing `types.ts` means updating every copy
  in the same PR: `web/src/lib/farm/types.ts`, the orchestrator's validators,
  the simulator, and the firmware's JSON code. Search the repo for the field name.
- **Validate everything that arrives over MQTT or HTTP.** Never trust a payload's shape.
- **Contract changes are a team decision.** If your task needs one, say so in
  the PR rather than quietly redesigning it.

## Intentional decisions (don't "fix" these)

- The robot has **no Pi heartbeat watchdog**. Losing the Pi doesn't send it to
  the dock; only its battery thresholds do.
- There is **no clock sync**. Pi services use their own receive time.
- The orchestrator only requeues a task when the robot reports **no `task_id`**.
  Dock trips, stop, error and manual mode keep the task.
- A **pending stop beats a low-battery return**. Only firmware survival
  overrides beat a stop.
- **Manual driving (`jog`) is local-network only.**

If one of these blocks your task, raise it; don't work around it.

## Writing code here

- **Read before you write.** Match the surrounding code's patterns, naming,
  structure and comment density. New code should look like it was always there.
- **Reuse first.** Check `shared/` and neighbouring files before writing a
  helper. Don't duplicate logic that already exists.
- **Smallest change that solves the task.** No drive-by refactors, no
  speculative abstractions, no options or features nobody asked for.
- **Don't hedge.** If a decision (hardware, library, behaviour) is open, ask.
  Don't build support for every possibility.
- **New files, folders and dependencies need a reason** tied to the task.
  Prefer what the project already uses.
- **No magic numbers.** Tunable values go in the config file for that part
  (`orchestrator-config.json`, `config.h`, …).
- **Handle failure paths:** lost messages, reconnects, restarts, missing
  hardware, bad input. "Works on the happy path" isn't done.
- **Log clearly, never crash** a long-running service on bad input.
- **No secrets in git.** The repo is public. Credentials go in gitignored files
  or env vars, with a checked-in example file.
- **Comments explain why, not what.** Delete dead code rather than commenting
  it out.

## Before you open a PR

1. **Build and check** each part you touched:
   - Pi services: `npm install` and `npm -w @farm/shared run build` at the root,
     then `npm run typecheck`, and run the service.
   - Dashboard: `cd web && npm run lint && npm run typecheck && npm run build`.
   - Firmware: `pio run`, plus any host tests in `firmware/esp32`.
2. **Run it for real.** For anything touching robot behaviour, run the
   orchestrator against `AUTONOMOUS=false npm run sim` and exercise the change,
   including an edge case (disconnect, restart, stop, low battery).
3. **Update docs** when behaviour or a contract changes. Diagrams included.
4. **Rebase onto `main`**; no merge commits in feature branches.
5. **Commits:** short imperative messages, authored by you, one logical change each.
6. **PR description:** what changed, how you tested it, and what you
   deliberately left out or couldn't verify.
7. **Re-read your own diff** as a reviewer would: leftover debug code, unused
   files, unrelated changes, anything you can't explain.
