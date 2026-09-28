# Firmware Architecture (ESP32)

Working document for the robot firmware in `firmware/esp32`. It defines how the
firmware is structured and the contract it keeps with the orchestrator on the Pi.
Sections marked **TBD** are still open.

## Guiding principle: the robot is the source of truth

The orchestrator treats the robot's telemetry as truth, including its status and
which task it is on. It does not predict what the robot is doing. The firmware
must therefore always report its real state, and must be able to keep working
without the Pi.

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

## MQTT contract

Payload types are defined in `farm-controller/shared/src/types.ts`. JSON field
names must match exactly.

- Publish telemetry to `farm/robot/{id}/telemetry` at a fixed interval.
- Publish events to `farm/robot/{id}/events`.
- Subscribe to `farm/robot/{id}/command`, using QoS 1 for the subscription.

### Node ids, not tag ids

The robot stores the full topology graph in flash, so it converts every RFID
tag UID to its node id on board. All positions sent to the Pi (`current_node`,
`node_id` on events) and all paths received from the Pi are **node ids**.
Telemetry whose `current_node` is not a node in the topology is dropped.
`current_node` is `null` only until the first tag has been read after boot.

### Telemetry `task_id`

Telemetry carries `task_id`: the task the robot is carrying out, or `null` if
it has none. Events can be lost (PubSubClient publishes at QoS 0); telemetry
repeats, so the orchestrator uses it to correct itself:

- The robot **keeps** its `task_id` through anything that interrupts a task:
  a survival-override return to dock, charging, an orchestrator low-battery
  return, or an immediate `stop`. Once charged or resumed, it continues the
  task.
- The robot clears `task_id` only when the task is finished, failed or
  abandoned, after publishing the matching `task_complete` or `task_failed`
  event with that `task_id`.
- If the orchestrator has a task assigned and the robot reports a `null`
  `task_id` for longer than the grace period (`command_ack_timeout_ms`), the
  orchestrator requeues the task.

## Commands

| Command | Behaviour |
|---|---|
| `navigate` | Replaces the current task with `task_id`. If `path` is included, follow it; otherwise compute the shortest path to `target_node` on board. On arrival, publish `arrived`, then `task_started`, perform `action_at_target` for `duration_ms`, then `task_complete`. |
| `stop` | Pause in place and report `stopped`. Keep the current `task_id`. The robot takes no new work until `resume`. |
| `resume` | Leave `stopped` and continue what was paused (or return to `idle`). |
| `return_to_dock` | Go to the dock and charge. If the robot is on a task, keep that `task_id` and resume the task after charging. If it has no task and the command carries a `task_id`, adopt it and publish `task_complete` for it once connected to the dock. |

The orchestrator sends a queued `stop` only when the robot is idle, so it acts as
"pause after the current task". An immediate `stop` pauses mid-task.

## Survival overrides

Checked at the top of every navigation loop, before any other logic. They
override orchestrator commands.

- **Battery:** three levels. Warn (publish `battery_low`), force return to dock
  (publish `battery_critical`), kill motors.
- **Obstacle:** the sensor task sets the obstacle flag; the motor task hard-stops.

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

- Missed-tag timeout value and recovery behaviour
- Dock alignment sequence and charge-contact detection
- Battery ADC calibration curve
- Turn calibration constants
