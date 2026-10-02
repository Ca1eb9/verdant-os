# Firmware Architecture (ESP32)

Specification for the robot firmware in `firmware/esp32`: how it is structured
and the contract it keeps with the orchestrator on the Pi. Sections marked
**TBD** are still open.

The simulator (`farm-controller/simulator/src/index.ts`, run with
`AUTONOMOUS=false`) is the reference implementation of the robot-side state
machine and command handling described here. When this document and the
simulator disagree, fix one of them.

State machine diagrams: `firmware/esp32/docs/state-machine.md` (robot) and
`farm-controller/orchestrator/docs/state-machine.md` (orchestrator).

## Guiding principle: the robot is the source of truth

The orchestrator treats the robot's telemetry as truth, including its status and
which task it is on. It does not predict what the robot is doing. The firmware
must therefore always report its real state, and must be able to keep working
without the Pi.

The robot never decides what work to do. It carries out commands, keeps its task
through interruptions, and reports honestly. (The simulator's autonomous mode,
where it picks its own targets, is for testing only.)

## Tasks

Four FreeRTOS tasks. `loop()` is empty.

| Task | Priority | Core | Responsibility |
|---|---|---|---|
| Motor | Highest | 1 | Drives motors from the drive queue. Checks safety flags every cycle and stops immediately if one is set. |
| Sensor | High | 1 | RFID reads, battery voltage, front and rear obstacle distance. Writes the sensor queue and sets safety flags. |
| Navigation | Medium | 1 | Robot state machine, survival overrides, path following, turn decisions. Produces telemetry and events. |
| Comms | Lowest | 0 | WiFi and MQTT. Publishes outbound messages and pushes received commands onto the command queue. |

Networking runs on its own core so WiFi never blocks motor control.

## Queues and shared flags

| Queue | Producer | Consumer | Contents |
|---|---|---|---|
| Sensor | Sensor | Navigation | Latest tag UID, battery %, front and rear obstacle distance |
| Drive | Navigation | Motor | Speed and direction per motor |
| Command | Comms | Navigation | Parsed orchestrator command |
| Telemetry | Navigation | Comms | Telemetry snapshots |
| Event | Navigation | Comms | Events (see below) |

Shared `volatile` flags (front obstacle, rear obstacle, battery kill) are used for safety signals that
must be checked every cycle without queue overhead.

### Events before telemetry

A telemetry message must never overtake the event that caused the change (for
example, telemetry reporting `idle` before the `task_complete` event), or the
orchestrator acts on the wrong order. So:

- The navigation task pushes the event **before** changing the status that
  telemetry will report.
- The comms task publishes **every queued event before any queued telemetry**
  on each loop. While offline, events wait in their queue (in order) and stale
  telemetry is discarded.

## Reported states

`status` in telemetry is one of these. The robot never reports `lost`; only the
orchestrator uses it, for a robot that has gone silent.

| Status | Meaning | `task_id` |
|---|---|---|
| `initializing` | Booted, position unknown, looking for a tag | always `null` |
| `idle` | Stopped with no task | always `null` |
| `en_route` | Driving to its task's target | the task |
| `working` | Doing the action at the target | the task |
| `returning_to_dock` | Driving to the dock | the kept task, the dock task, or `null` |
| `docking` | Alignment sequence at the dock | same as above |
| `charging` | Connected to the charger | kept task or `null` (a dock task is complete by now) |
| `stopped` | Paused by `stop` until `resume` | the paused task, or `null` |
| `error` | Can't continue (e.g. missed tag, position lost) | kept |
| `manual` | Driven by the dashboard (`jog`) or the Bluetooth controller | kept |

The orchestrator only assigns work to `idle` robots with a known node, and never
sends `stopped`, `manual`, `error` or `initializing` robots to the dock.

## Task context

The navigation task holds:

- **Current task:** `task_id`, `target_node`, `action_at_target`, `duration_ms`,
  the path (node ids) and the index along it, the time the action started, and
  whether the task is a **dock task** (a `task_id` adopted from `return_to_dock`).
- **Kept task:** the task interrupted by a trip to the dock (target, action,
  duration, `task_id`). While it is kept, telemetry keeps reporting its `task_id`.
  After charging, the robot re-plans from the dock and resumes it.
- **Paused status:** the status `stop` interrupted, restored by `resume`.
- **Stop latch:** set by `stop`, cleared by `resume` or a new `navigate`. It
  survives a trip to the dock: after charging, a latched robot reports `stopped`
  instead of resuming.
- **`last_completed_task_id`:** see below.

The task context lives in RAM only: the robot writes nothing to flash. It
survives a lost network or a Pi outage, but not a reboot. A rebooted robot
starts with no task, and the orchestrator requeues the task it had assigned
(see [Telemetry `task_id`](#telemetry-task_id)).

## Transitions and events

Events carry the current `task_id` and `node_id`. In each row the event(s) are
pushed first, then the status changes.

| From | Trigger | Events | To |
|---|---|---|---|
| `initializing` | First known tag read | — | `idle` |
| `idle` | `navigate` accepted | — | `en_route` |
| `en_route` | Tag read (not the target) | — | `en_route` (update `current_node`, heading) |
| `en_route` | Target reached (including already there) | `arrived`, `task_started` | `working` |
| `working` | `duration_ms` elapsed | `task_complete` | `idle` (clear `task_id`, set `last_completed_task_id`) |
| any moving state | Target unreachable / path can't be followed | `task_failed` | `idle` (clear `task_id`) |
| any | `return_to_dock`, survival return | `battery_critical` if survival | `returning_to_dock` |
| `returning_to_dock` | Dock node reached | `arrived` | `docking` |
| `docking` | Charge contact detected | `dock_connected`, then `task_complete` if on a dock task | `charging` |
| `charging` | Battery ≥ `charge_complete_pct` (95) | `charge_complete` | `stopped` if latched; else `en_route` for a kept task; else `idle` |
| any | `stop` | — | `stopped` |
| `stopped` | `resume` | — | paused status, or `en_route` for a kept task after charging |
| any | Unrecoverable fault | `error` | `error` |
| `error` | Fault cleared (e.g. known tag read again) | `recovery` | re-plan and continue the task, else `idle` |
| `idle`, `en_route`, `working`, `stopped`, `error` | `jog` | — | `manual` |
| any but `initializing` | Bluetooth controller input | — | `manual` |
| `manual` | `resume`, or manual timeout | `recovery` if it was in `error` | continue from `current_node` (see [Manual control](#manual-control)) |

Battery events (`battery_low`, `battery_critical`) are published once per
discharge and re-armed after `charge_complete`.

## MQTT contract

Payload types are defined in `farm-controller/shared/src/types.ts`. JSON field
names must match exactly. Unknown fields must be ignored.

- Publish telemetry to `farm/robot/{id}/telemetry` every 1 s, and also right
  away when `status` or `current_node` changes. The interval must stay well
  below the orchestrator's `command_ack_timeout_ms` (5 s).
- Publish events to `farm/robot/{id}/events`.
- Subscribe to `farm/robot/{id}/command`, using QoS 1 for the subscription.
- `robot_id` in every payload must match the `{id}` in the topic. Pi services
  identify the robot by the topic.
- The robot does not subscribe to anything else. `farm/robot/{id}/state` is the
  orchestrator's view for dashboards, not for the robot.

Telemetry:

```json
{
  "robot_id": "robot-1", "status": "en_route", "current_node": "cp-01",
  "task_id": "3f2c…", "last_completed_task_id": "9a1b…",
  "battery_pct": 82.5, "heading": 1, "obstacle_cm": null,
  "temperature_c": 24.1, "humidity_pct": 61.0, "light_lux": 410,
  "timestamp": 123456
}
```

`heading` is 0 N, 1 E, 2 S, 3 W, or `null` until known. `battery_pct` is 0–100.

Event:

```json
{ "robot_id": "robot-1", "event": "task_complete", "task_id": "3f2c…",
  "node_id": "water-01", "details": "water at water-01", "timestamp": 123999 }
```

### Node ids, not tag ids

The robot stores the full topology graph in flash, so it converts every RFID
tag UID to its node id on board. All positions sent to the Pi (`current_node`,
`node_id` on events) and all paths received from the Pi are **node ids**.
Telemetry whose `current_node` is not a node in the topology is dropped.
`current_node` is `null` only until the first tag has been read after boot.

Generate the flash graph from `farm-controller/topology.json` so node ids, tag
ids, coordinates and **node and edge order** match the Pi exactly. The dock is
the node with `type: "dock"`.

### Boot and localization

After boot the robot reports `initializing` until it knows its node. It must
find a tag on its own (e.g. creep forward slowly until one is read, or be
placed on a tag). The orchestrator never assigns work to a robot without a
node, and the robot can't plan a path to the dock without one, so a robot that
reported `idle` with a `null` node would never move again.

### Telemetry `task_id`

Telemetry carries `task_id`: the task the robot is carrying out, or `null` if
it has none. Events can be lost (PubSubClient publishes at QoS 0); telemetry
repeats, so the orchestrator uses it to correct itself:

- The robot **keeps** its `task_id` through anything that interrupts a task:
  a survival-override return to dock, charging, an orchestrator low-battery
  return, an immediate `stop`, `error` or `manual`. Afterwards it continues the
  task.
- The robot clears `task_id` only when the task is finished, failed or
  cancelled, after publishing the matching `task_complete` or `task_failed`
  event with that `task_id` (no event for `cancel`).
- `idle` always means no task: never report `idle` with a `task_id` set. The
  orchestrator neither requeues nor replaces a task the robot still reports,
  so an `idle` robot holding its assigned `task_id` would sit idle forever.
- If the orchestrator has a task assigned and the robot reports a `null`
  `task_id` for longer than the grace period (`command_ack_timeout_ms`), the
  orchestrator requeues the task.

### Telemetry `last_completed_task_id`

The id of the last task the robot **completed successfully**, or `null` if none
since boot. It is set at the same moment `task_id` is cleared and the
`task_complete` event is pushed. If that event is lost, the orchestrator still
marks the task complete instead of requeuing it. A failed or cancelled task does
not set it, so a lost `task_failed` results in a retry.

It is not kept across a reboot, so a reboot right after a lost `task_complete`
makes the orchestrator redo that task. This is accepted to keep the robot from
writing to flash.

## Commands

The robot never queues commands: each one acts on the current state right away.
`priority`, `source` and `immediate` are for the orchestrator and can be ignored.

| Command | Behaviour |
|---|---|
| `navigate` | Replaces the current task (and clears the stop latch, paused status and kept task). If `path` is included, follow it; otherwise compute the shortest path to `target_node` on board. Target already reached: `arrived` straight away. Unknown or unreachable target: publish `task_failed` with the command's `task_id` and stay as you were. **Ignore** a `navigate` whose `task_id` equals the current `task_id` or `last_completed_task_id` (a redelivered duplicate). |
| `stop` | Pause in place: halt motors, hold the action timer, report `stopped`, keep `task_id`, set the stop latch. Ignored if already stopped. |
| `resume` | In `manual`: leave manual control (see [Manual control](#manual-control)) and clear the stop latch. Otherwise only acts if the stop latch is set: clear it and restore the paused status (the action timer continues with the remaining time). If it was on a task, re-plan from the current node first, since manual control may have moved it while stopped; a robot still at its target keeps working. If the robot is stopped at the dock with a kept task, re-plan and continue it. |
| `return_to_dock` | Ignored if already returning, docking or charging. Otherwise head to the dock. A task in progress or paused is kept and resumed after charging. With no task and a `task_id` on the command, adopt it as a dock task and publish `task_complete` for it once connected to the charger. If already at the dock but not charging, run the dock sequence again. A latched stop stays latched. |
| `jog` | Manual driving from the dashboard; `direction` is `forward` or `backward`. Accepted in `idle`, `en_route`, `working`, `stopped`, `error` and `manual`; ignored otherwise (dock trips, `initializing`) and below the motor cutoff. The first jog enters `manual`. Each jog drives for a fixed **500 ms** from when it is received (`JOG_PULSE_MS` in `config.h`); a jog arriving while driving restarts the 500 ms. When the window runs out, the motors stop by themselves. `backward` reverses without turning; the heading doesn't change. |
| `cancel` | Drop the task with this `task_id` if it is the current, paused or kept task: clear it without setting `last_completed_task_id` and without an event. A cancelled task that was moving or working goes to `idle` (or stays `stopped`). Cancelling a dock task stops the trip to the dock. Cancelling a kept task leaves the dock trip running, so the robot still charges. Ignore it if the id doesn't match. The orchestrator resends it whenever telemetry still shows the cancelled task, e.g. after the robot was offline. |

The orchestrator sends a queued `stop` only when the robot is idle, so it acts as
"pause after the current task". An immediate `stop` pauses mid-task.

### Actions at the target

| `action_at_target` | Meaning |
|---|---|
| `water` | Water the plant for `duration_ms` |
| `grow` | Stay under the grow lights for `duration_ms` |
| `harvest` | TBD |
| `idle` | Wait at the target for `duration_ms` (the dashboard's "Wait"); with no duration, `task_complete` right after `task_started` |

If `duration_ms` is missing, use a per-action default from `config.h`.

## Path planning

When `navigate` has no `path`, and when returning to or leaving the dock, the
robot computes its own shortest path. The orchestrator computes the same path to
check for deviations, so the firmware must produce **exactly** the same route,
including on ties between equal-cost routes. Mirror `dijkstra()` in
`farm-controller/shared/src/navigation.ts`:

1. If the start or target isn't a node in the graph, there is no path.
2. Build adjacency lists in topology edge order. For each edge, append
   `from → to`, then (unless `bidirectional` is `false`) `to → from`.
3. Each round, pick the unvisited node with the smallest distance by scanning
   nodes in topology order, replacing the current pick only on a **strictly
   smaller** distance (the first node in order wins a tie).
4. Stop as soon as the picked node is the target (or nothing reachable is left).
5. Relax neighbours in adjacency order, updating distance and previous node
   only on a **strictly smaller** distance.
6. Rebuild the path by following previous nodes back from the target.

Any different tie-break (e.g. a priority queue, `<=`, or a different node order)
can pick a different equal-cost route and trigger false deviation alerts.

Heading and turns follow `computeHeading()` / `computeTurn()` in the same file:
+y is north, +x is east, and a move with no x/y change (elevator) keeps the
current heading.

## Survival overrides

Checked at the top of every navigation loop, before any other logic. They
override orchestrator commands, including `stop`.

- **Battery:** three levels, set **below** the orchestrator's `battery_low_pct`
  (20%) so the orchestrator handles normal charging and a pending stop can win
  above the firmware threshold (in `manual`, only the motor cutoff applies):
  - warn at 20%: publish `battery_low`;
  - force return to dock at 15%: publish `battery_critical` and go to the dock,
    keeping the task (and the stop latch);
  - kill motors at about 5%.
- **Obstacle:** two VL53L4CX sensors, front and rear, each on its own I2C bus
  (they share one fixed address). The sensor task sets a front and a rear
  obstacle flag, and the motor task hard-stops only on the flag for the side
  it's driving toward, so the robot can still back away from an obstacle in
  front. Telemetry `obstacle_cm` comes from the sensor on the side of the last
  drive direction: front, or rear after reversing (kept while stopped). Note
  this is the drive direction, not `heading`, which doesn't change when the
  robot reverses. The robot keeps its status (e.g. `en_route`) and publishes
  `obstacle_detected` once. If it is still blocked after a timeout, it publishes
  `path_blocked` and keeps waiting. The orchestrator only raises alerts for
  these.

### Faults

- **Missed tag:** if the next tag isn't read within a timeout, stop, publish
  `error` and report `error`, keeping `task_id` and the last known node. When a
  known tag is read again, publish `recovery`, re-plan from that node and
  continue.

### No Pi heartbeat watchdog

The firmware does **not** expect heartbeats from the Pi, and losing the Pi is
not a reason to return to dock. The robot keeps working on its current task
until the battery thresholds send it to charge. When the connection returns, it
reports its real state and the orchestrator adopts it. (This replaces the
"Pi heartbeat watchdog" item in the development timeline.)

## Manual control

Two sources can drive the robot by hand. Both put it in `manual`, where it
reports `manual`, keeps `task_id` (and any kept task), and stops following its
path. The orchestrator gives a `manual` robot no work, never sends it to the
dock, and drops its planned route so the tags it passes aren't reported as
deviations.

- **Dashboard (`jog`):** each held button sends a `jog` about every 400 ms, just
  under the 500 ms pulse, so the robot drives smoothly while the button is held
  and stops within 500 ms of release, or of a lost message. Jogging is only
  offered on the farm network (the orchestrator rejects jogs that come through
  Supabase).
- **Bluetooth controller:** any drive input from the paired controller puts the
  robot in `manual` from any state except `initializing`. Each input also only
  drives briefly, like a jog, so losing the controller stops the robot.

**Timeout:** a manual session from either source ends by itself after
`MANUAL_TIMEOUT_MS` (5 s, in `config.h`) without a `jog` or controller input;
each input restarts the timer. `resume` ends it early. A dashboard operator who
lets go for longer than the timeout hands the robot back automatically, and the
dashboard asks for confirmation again before the next session.

**Leaving manual** (`resume` or the timeout):

1. Take `current_node`, the last tag read, as the robot's position, even if
   the operator left it a little past that tag. It doesn't look for a tag
   first. If it was in `error`, publish `recovery`.
2. Go back to what it was doing:
   - a task (`task_id`, or a kept task): re-plan from `current_node` and
     continue (`en_route`). If it was `working`, the action restarts on arrival.
     If the target can't be reached any more, publish `task_failed` and go
     `idle`, since `idle` never holds a task.
   - a dock trip (Bluetooth only): re-plan to the dock and continue.
   - `stopped` before the session: on a timeout, back to `stopped` (the stop
     latch is kept); `resume` clears the latch and continues the task instead.
   - nothing: `idle`.

**Safety in manual:** the obstacle flag still hard-stops the motors. Battery
survival is limited to the motor cutoff (about 5%): there is no forced return to
dock while an operator is driving, but `battery_critical` is still published.
The forced return applies again once the robot leaves manual.

## Time

The robot does not need clock sync. The Pi timestamps messages when it
receives them and ignores the robot's `timestamp` for liveness. The firmware only
measures elapsed time (`millis()`) for durations such as `duration_ms` and
missed-tag timeouts. `timestamp` in payloads may be `millis()`.

## TBD

- Missed-tag and path-blocked timeout values
- Dock alignment sequence and charge-contact detection
- Battery ADC calibration curve
- Turn calibration constants
- Elevator moves (how the robot rides between levels and confirms arrival)
- `harvest` action
- Bluetooth controller pairing and input mapping
- Graph updates from the orchestrator (the only case where the robot would
  write to flash)
