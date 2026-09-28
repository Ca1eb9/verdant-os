# Firmware Architecture (ESP32)

Specification for the robot firmware in `firmware/esp32`: how it is structured
and the contract it keeps with the orchestrator on the Pi. Sections marked
**TBD** are still open.

The simulator (`farm-controller/simulator/src/index.ts`, run with
`AUTONOMOUS=false`) is the reference implementation of the robot-side state
machine and command handling described here. When this document and the
simulator disagree, fix one of them.

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
| Sensor | High | 1 | RFID reads, battery voltage, obstacle distance. Writes the sensor queue and sets safety flags. |
| Navigation | Medium | 1 | Robot state machine, survival overrides, path following, turn decisions. Produces telemetry and events. |
| Comms | Lowest | 0 | WiFi and MQTT. Publishes outbound messages and pushes received commands onto the command queue. |

Networking runs on its own core so WiFi never blocks motor control.

## Queues and shared flags

| Queue | Producer | Consumer | Contents |
|---|---|---|---|
| Sensor | Sensor | Navigation | Latest tag UID, battery %, obstacle distance |
| Drive | Navigation | Motor | Speed and direction per motor |
| Command | Comms | Navigation | Parsed orchestrator command |
| Outbound | Navigation | Comms | Telemetry **and** events (see below) |

Shared `volatile` flags (obstacle, battery kill) are used for safety signals that
must be checked every cycle without queue overhead.

### Single outbound FIFO

Telemetry and events go through **one** outbound queue in the order the
navigation task produced them. Separate queues could let a telemetry message
overtake the event that caused the change (for example, telemetry reporting
`idle` before the `task_complete` event), and the orchestrator would act on the
wrong order. Always push the event before changing the status that telemetry
will report.

## Reported states

`status` in telemetry is one of these. The robot never reports `lost`; only the
orchestrator uses it, for a robot that has gone silent.

| Status | Meaning | `task_id` |
|---|---|---|
| `initializing` | Booted, position unknown, looking for a tag | kept from NVS if any, else `null` |
| `idle` | Stopped with no task | always `null` |
| `en_route` | Driving to its task's target | the task |
| `working` | Doing the action at the target | the task |
| `returning_to_dock` | Driving to the dock | the kept task, the dock task, or `null` |
| `docking` | Alignment sequence at the dock | same as above |
| `charging` | Connected to the charger | kept task or `null` (a dock task is complete by now) |
| `stopped` | Paused by `stop` until `resume` | the paused task, or `null` |
| `error` | Can't continue (e.g. missed tag, position lost) | kept |
| `manual` | Driven by the RC controller | kept |

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
- **`last_completed_task_id`:** see below. Store it in NVS.

## Transitions and events

Events carry the current `task_id` and `node_id`. In each row the event(s) are
pushed first, then the status changes.

| From | Trigger | Events | To |
|---|---|---|---|
| `initializing` | First known tag read | — | `idle`, or `en_route` for a task restored from NVS |
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

Keep this value in NVS (Preferences) if possible. Otherwise a reboot right after
a lost `task_complete` makes the orchestrator redo that task.

## Commands

The robot never queues commands: each one acts on the current state right away.
`priority`, `source` and `immediate` are for the orchestrator and can be ignored.

| Command | Behaviour |
|---|---|
| `navigate` | Replaces the current task (and clears the stop latch, paused status and kept task). If `path` is included, follow it; otherwise compute the shortest path to `target_node` on board. Target already reached: `arrived` straight away. Unknown or unreachable target: publish `task_failed` with the command's `task_id` and stay as you were. **Ignore** a `navigate` whose `task_id` equals the current `task_id` or `last_completed_task_id` (a redelivered duplicate). |
| `stop` | Pause in place: halt motors, hold the action timer, report `stopped`, keep `task_id`, set the stop latch. Ignored if already stopped. |
| `resume` | Only acts if the stop latch is set: clear it and restore the paused status (the action timer continues with the remaining time). If the robot is stopped at the dock with a kept task, re-plan and continue it. |
| `return_to_dock` | Ignored if already returning, docking or charging. Otherwise head to the dock. A task in progress or paused is kept and resumed after charging. With no task and a `task_id` on the command, adopt it as a dock task and publish `task_complete` for it once connected to the charger. If already at the dock but not charging, run the dock sequence again. A latched stop stays latched. |
| `cancel` | Drop the task with this `task_id` if it is the current, paused or kept task: clear it without setting `last_completed_task_id` and without an event. A cancelled task that was moving or working goes to `idle` (or stays `stopped`). Cancelling a dock task stops the trip to the dock. Cancelling a kept task leaves the dock trip running, so the robot still charges. Ignore it if the id doesn't match. The orchestrator resends it whenever telemetry still shows the cancelled task, e.g. after the robot was offline. |

The orchestrator sends a queued `stop` only when the robot is idle, so it acts as
"pause after the current task". An immediate `stop` pauses mid-task.

### Actions at the target

| `action_at_target` | Meaning |
|---|---|
| `water` | Water the plant for `duration_ms` |
| `grow` | Stay under the grow lights for `duration_ms` |
| `harvest` | TBD |
| `idle` | Nothing: `task_complete` right after `task_started` |

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
  above the firmware threshold:
  - warn at 20%: publish `battery_low`;
  - force return to dock at 15%: publish `battery_critical` and go to the dock,
    keeping the task (and the stop latch);
  - kill motors at about 5%.
- **Obstacle:** the sensor task sets the obstacle flag and the motor task
  hard-stops. The robot keeps its status (e.g. `en_route`) and publishes
  `obstacle_detected` once. If it is still blocked after a timeout, it publishes
  `path_blocked` and keeps waiting. The orchestrator only raises alerts for
  these.

### Faults and manual driving

- **Missed tag:** if the next tag isn't read within a timeout, stop, publish
  `error` and report `error`, keeping `task_id` and the last known node. When a
  known tag is read again, publish `recovery`, re-plan from that node and
  continue.
- **Manual (RC controller):** entered and left locally, not over MQTT. Report
  `manual` and keep `task_id`. On leaving manual, re-localize from the next tag
  read, then continue the task or go `idle`.

### No Pi heartbeat watchdog

The firmware does **not** expect heartbeats from the Pi, and losing the Pi is
not a reason to return to dock. The robot keeps working on its current task
until the battery thresholds send it to charge. When the connection returns, it
reports its real state and the orchestrator adopts it. (This replaces the
"Pi heartbeat watchdog" item in the development timeline.)

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
