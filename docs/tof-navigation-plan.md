# ToF navigation backup: design and implementation plan

Status: **Phases 1 and 2 implemented** (`firmware/esp32/src/nav/tof_locator`,
wired in `tasks/nav_task.cpp`, off by default); see "As built" at the end for
where the code differs from this plan. Owner: Caleb, Jameson. For the case where
RFID tags can't be mounted on the farm in time (see the Final Build and
Integration Plan).

This is a plan for an agent or person to implement in three phases. Each
phase builds, passes host tests and leaves the robot **behaving exactly as
today while `TOF_NAV_ENABLED` is false**. Read `AGENTS.md` first; every rule
there applies.

---

## 1. The idea

Every level of the farm is one straight line along x (`topology.json`: every
node has `y = 0`). The robot never turns and always faces `ROBOT_HEADING`
(east), so:

- the **front** VL53L4CX always looks east, along the track, at the elevator end;
- the **rear** VL53L4CX always looks west, along the track, at the dock end.

The distance to the end wall therefore tells us where the robot is along
its level. For each node we measure, once on the real farm, the front and
rear reading with the robot centred on that node. While driving an edge, the
robot takes the edge's end node as **reached** when the reading crosses that
node's measured distance. That is the exact moment an RFID tag would have
been read, so the rest of the firmware doesn't need to change.

**The integration point is `NavCore::on_tag(node, now)`.** A ToF arrival is
handed to `on_tag()` exactly like a tag, the same way the `encoder-assist`
branch hands in a guessed tag. `NavCore`, `Survival`, the orchestrator, the
simulator and the dashboard don't change: they still see node ids, the same
events and the same telemetry.

### What stays true (AGENTS.md)

- The robot is the source of truth: the position is still decided on the
  robot and reported as a node id.
- Node ids on the wire: tag-to-node *and* ToF-to-node lookup happen on the robot.
- The robot never turns; elevator nodes are never navigate targets; a stop
  beats a low-battery return; no Pi heartbeat watchdog. None of this is touched.
- No magic numbers: every distance, tolerance and count goes in `config.h`.

---

## 2. Contract changes (keep minimal)

| Change | Where | Needed? |
|---|---|---|
| None on MQTT. Arrivals still go out as `arrived`/`task_started` with node ids | `types.ts`, `topics.ts` | No change |
| `topology.json`: **no change.** The ToF distances are physical calibration (like `ENCODER_EDGES`), so they live in `config.h`, not the shared topology | `farm-controller/topology.json` | No change |
| `SensorData` gains each ToF sensor's **last fresh reading time**: firmware-internal, not a wire type | `firmware/esp32/src/types.h` | Phase 1 |
| Design doc: "position comes from a tag, **or a ToF wall distance when `TOF_NAV_ENABLED`**" | `docs/firmware-architecture.md`, `firmware/esp32/docs/state-machine.md`, the "Node ids on the wire" line in `AGENTS.md` | Phase 2 (team decision; say so in the PR) |
| *Optional:* telemetry `position_source: "tag" \| "tof" \| "encoder"`, so the dashboard can show a position is estimated | `types.ts` and every copy (web types, orchestrator validators, simulator, `comms_json.cpp`) | Phase 3, **only if the team agrees**. The system works without it |

Nothing else. Specifically: **no new events, no new commands, no orchestrator
changes.**

---

## 3. Facts from the current code that drive the design

Read these before writing anything:

| Fact | Where | Consequence for ToF navigation |
|---|---|---|
| `nav_task` turns `SensorData.tag_seq` changes into `core.on_tag(node, now)` | `src/tasks/nav_task.cpp` | ToF arrivals are injected in the same loop, right after the tag loop |
| `on_tag()` in `en_route`/`returning_to_dock` with a node **not later in the path** re-plans and calls `follow_edge` again | `src/nav/nav_core.cpp` `NavCore::on_tag` | A **duplicate** arrival (ToF then a late tag for the same node) re-plans needlessly and restarts `Motion`'s timer and slow-zone state. The locator must fire once per node, and in ToF mode a real tag equal to `current_node()` must be dropped (Phase 2) |
| `on_tag()` while `initializing` → idle; while `error` → `recovery` and continue; otherwise only updates the position | same | Boot localisation and error recovery work through `on_tag` without touching `NavCore` |
| `on_tag()` sets `elevator_exit_backward_` when the node is an elevator and differs from `node_` | same | A ToF arrival at an elevator node must also be **edge-triggered**, never repeated |
| `Motion` phases: `Driving`, `Creeping`, `Entering`, `Riding`, `Docking`, `AtDock`, `Manual` | `src/nav/motion.{h,cpp}` | The locator may only fire while `Motion` is `Driving` (or `Creeping` at boot). On the elevator platform (`Entering`/`Riding`) and while docking, the readings are platform or dock walls, not track position |
| The obstacle flag stops the motors at `OBSTACLE_STOP_CM` (15 cm) and slows inside `SLOW_ZONE_CM` (40 cm) | `config.h`, `sensor_task.cpp`, `motion.cpp` | A node's trigger distance toward a wall **must be above `OBSTACLE_STOP_CM` plus roll-on**, or the obstacle stop holds the robot short of the node forever (`path_blocked`, then `missed tag`). Validated at boot |
| The sensor task **holds the last good distance up to `TOF_HOLD_MS` (3 s)** through untrusted readings | `src/tasks/sensor_task.cpp` `update_obstacle` | `obstacle_*_cm` can be 3 s stale. Navigation must use only **fresh** readings: add the time of the last real target to `SensorData` |
| Every stop ramps down over `STOP_RAMP_MS` (300 ms) and rolls on | `config.h` | The final stop overshoots by a few cm. Measure the node distances the way the robot will be used: drive to the node and read where it stops. Optional lead distance `TOF_ARRIVE_LEAD_CM` |
| `MISSED_TAG_TIMEOUT_MS` faults an edge with no arrival | `motion.cpp` | It stays the backstop in ToF mode: a missed ToF crossing faults `missed tag` exactly as today |
| Error recovery needs "a known tag read" | `NavCore::on_tag` | Without tags the robot could never leave `error`. Phase 2 adds **static re-localisation**: stationary, both readings match one node on the current level → `on_tag(node)` |
| The VL53L4CX runs in medium mode with a 33 ms budget (~30 Hz); the sensor loop is 50 Hz, the nav loop 20 ms | `tof_sensor.cpp`, `config.h` | At cruise speed the robot moves about 1 cm a reading, so crossing detection plus a 2-reading confirm is precise enough |
| `encoder-assist` only guesses after a **real** tag (`placed_`), at most once in a row, and resets on every `on_tag()` | `origin/encoder-assist`: `src/nav/encoder_assist.h` | With no tags it never acts. See section 7 for how the two combine |

---

## 4. Physical requirements (check before Phase 2 on the farm)

1. **Each level needs a flat, solid target at both ends**, square to the
   track, at sensor height: at least a 10 × 10 cm board. On L0 the dock is the
   west wall. Every other end (the elevator side on each level, the west end of
   L1 at `cp-13` and of L2 at `cp-22`) needs a board the mechanical engineers
   fit. **Ask for this with the track spec.**
2. **Range.** Medium mode is reliable to roughly 1.5-2 m indoors against a
   light board. Measure the longest level. If a node is further than that from
   *both* boards, it can only be measured from one side, or the level needs a
   mid-board (not supported in this plan; raise it).
3. **Clear sight line.** The sensors' cone (about 18°) must not see the track
   floor, rails, plant pots or leaves before the end board. Aim or shield
   them, and test with plants in place.
4. **Elevator side.** When the elevator isn't on the robot's level, the front
   sensor may look into the shaft. Decide on the farm whether elevator-side
   nodes are referenced from the **rear** board instead (the table allows
   either).

---

## 5. Configuration

The block is in `firmware/esp32/src/config.h`, "ToF navigation": the flag,
the tunables, `TOF_NODES` (front and rear readings on each node, 0 for a side
that can't see its board) and `TOF_LEVEL_LENGTH_CM` (front + rear on each
level). Same pattern as `ENCODER_EDGES` on the encoder branch: node ids as
strings, resolved to `NodeIndex` once at boot.

## 6. The three phases

### Phase 1: pure locator, sensor freshness, host tests (no behaviour change)

**Goal:** all the logic exists and is tested on the host. The robot runs exactly as
today; nothing calls the new code yet.

1. **`src/types.h` `SensorData`:** add `uint32_t tof_front_ms` and
   `uint32_t tof_rear_ms`: the `millis()` of that side's last *real* target
   (0: none yet).
   **`src/tasks/sensor_task.cpp`:** fill them from `ObstacleState::last_target_ms`
   when building `SensorData` (next to `d.obstacle_front_cm = s_front.cm`).
   Don't change the hold, flag or fault logic.
2. **`src/config.h`:** the block in section 5, `TOF_NAV_ENABLED = false`, and
   `TOF_NODES` listing every node in `graph.cpp` with zeros.
3. **New `src/nav/tof_locator.{h,cpp}`:** pure C++, no Arduino or FreeRTOS,
   same style as `motion.h` and the encoder branch's `encoder_assist.h`.
   ```cpp
   struct TofSample {           // built by nav_task from SensorData
     float front_cm, rear_cm;   // NAN when not fresh (TOF_NAV_FRESH_MS)
   };
   class TofLocator {
    public:
     TofLocator(const TofNode* nodes, size_t count);
     // Resolves ids and checks the table. False: the reason (logged at boot),
     // and nav_task leaves ToF navigation off: tags only.
     bool begin(const char** error);
     void on_tag(NodeIndex node);                         // any arrival, real or ToF
     void on_edge(NodeIndex from, NodeIndex to, EdgeDrive drive);
     void on_creep();                                     // boot: TOF_BOOT_LEVEL
     void on_untracked_move();                            // jog, drive, docking, elevator
     // While driving an edge (or creeping): the node crossed, once, or NO_NODE.
     NodeIndex check_edge(const TofSample& s, uint32_t now);
     // Stopped, error or manual, robot still: the node it's on, or NO_NODE.
     NodeIndex localize(uint8_t level, const TofSample& s, uint32_t now);
   };
   ```
   Rules it must implement:
   - **Target:** only the `to` of the last `on_edge()`. Elevator edges
     (`ElevatorForward/Backward`) arm only for `to` (the level it drives off
     at) **and only after** `nav_task` says `Motion` is back to `Driving`
     (see Phase 2). The ride itself is untracked.
   - **Which sensor:** prefer the side the robot **drives toward** (front for
     `Forward`, rear for `Backward`) when that node has a value for it. The
     reading shrinks toward the board, and nearer is more accurate. Otherwise
     use the trailing side (the reading grows).
   - **Crossing, not equality:** reached when the reading is at or past the
     node's distance (minus `TOF_ARRIVE_LEAD_CM`) in the direction of travel
     for `TOF_NAV_CONFIRM_COUNT` fresh readings in a row. A level test, not
     an edge, so a robot resumed after a stop that has already crossed still
     arrives.
   - **Continuity:** a step larger than `TOF_NAV_MAX_STEP_CM` from the
     previous reading resets the count and is never a crossing (hand, leaf,
     second robot).
   - **Length check:** with both fresh and the level length set,
     front + rear short of the level's length by more than `TOF_NAV_LENGTH_TOL_CM` → not trusted.
   - **Once:** after returning a node, return `NO_NODE` until the next `on_edge()`/`on_tag()`.
   - **Boot (`on_creep`):** creeping forward, the first node on
     `TOF_BOOT_LEVEL` whose front distance is crossed.
   - **`localize()`:** both sides within `TOF_LOCALIZE_TOL_CM` of exactly one
     node on `level` (single-sided nodes: that side only), steady within
     `TOF_LOCALIZE_TOL_CM` for `TOF_STILL_MS`. Ambiguous → `NO_NODE`.
   - **`begin()` validation:** every graph node is listed and resolves; each
     has at least one non-zero value; any front value of a node approached
     forward (and rear value of one approached backward) is above
     `OBSTACLE_STOP_CM + TOF_ARRIVE_LEAD_CM`.     Along each level, front values fall and rear values rise as x grows,
     and neighbours differ by at least `TOF_MIN_NODE_GAP_CM`.
4. **`test_host/tof_locator_test.cpp`**, plus a line in `test_host/run.sh`.
   Cover: forward and backward crossings; confirm count; stale (NAN) readings
   ignored; a step jump (hand) rejected; length check rejects; fires once;
   resume after a stop already past the line; elevator edge doesn't fire
   during the ride; boot creep on `TOF_BOOT_LEVEL`; `localize` unique, ambiguous and
   still-moving cases; every `begin()` validation error.

**Done when:** `pio run` and `test_host/run.sh` pass, `git diff` shows no
behaviour change outside the new files, `types.h`/`sensor_task.cpp` (two
fields) and `config.h`, and the robot on the bench behaves as before.

### Phase 2: wire it in behind the flag, docs, bench and farm test

**Goal:** with `TOF_NAV_ENABLED = true` the robot navigates the farm with no
tags. With it false, **every changed line is skipped** (`if (TOF_NAV_ENABLED && ...)`).

1. **`src/nav/motion.h`:** add one read-only accessor,
   `bool driving_edge() const { return phase_ == Phase::Driving; }` and
   `bool creeping() const { return phase_ == Phase::Creeping; }`. No logic change.
2. **`src/tasks/nav_task.cpp`**, in this order inside the loop:
   - At boot: `bool tof_nav = TOF_NAV_ENABLED && locator.begin(&err)`. Log
     "ToF navigation on" or the config error, and run tags-only on error. Never crash.
   - `QueueOutput` hooks, guarded by `tof_nav`: `follow_edge` → `locator.on_edge()`;
     `creep` → `on_creep()`; `jog`, `drive`, `start_docking` → `on_untracked_move()`.
   - **Tag loop (unchanged when off):** with `tof_nav`, drop a real tag whose
     node equals `core.current_node()` while `en_route` or
     `returning_to_dock` (it was already reached by ToF; see section 3). Every
     other real tag calls `locator.on_tag(node)` then `core.on_tag()`. Real tags
     always win.
   - **After commands, before `core.tick()`:** build `TofSample` from
     `sensors` (NAN when `now - tof_*_ms > TOF_NAV_FRESH_MS`).
     - If `out.motion.driving_edge() || out.motion.creeping()`: `n = locator.check_edge(...)`.
     - Else if status is `error`, `stopped` or `manual` and the robot has a
       last node: `n = locator.localize(GRAPH_NODES[current].z, ...)`, and
       only act if `n != current_node()` **or** status is `error`.
     - If `n != NO_NODE`: log `"tof: front %.1f rear %.1f, taking %s as reached"`,
       call `locator.on_tag(n)`, then `core.on_tag(n, now)`, and set
       `known_tag_ms = now` (LED flash).
     - **At most one arrival a loop** (real or ToF). If a real tag arrived this
       loop, skip ToF.
3. **Edge cases to handle and test on the bench:**
   - **Stop mid-edge, then resume:** `resume` calls `follow_edge` again, so
     `on_edge` re-arms the same `to`. A robot already past the line arrives
     at once (level test).
   - **Obstacle in front:** the step and length checks reject it. The
     existing obstacle flag stops the motors, and `path_blocked` fires as now.
   - **Missed crossing** (sensor glitch, board knocked off): `MISSED_TAG_TIMEOUT_MS`
     faults `missed tag` → `error`. Recovery: drive it by hand (dashboard
     jog or controller) onto a node. `localize()` → `on_tag()` → `recovery`.
     This is the same procedure as a missed tag today.
   - **ToF sensor dead:** `OBSTACLE_FAILSAFE` already holds the motors. No
     fresh readings → no arrivals → `missed tag`. Nothing new.
   - **Low-battery return / `return_to_dock`:** plans from `current_node()`
     as today. Backward edges use the rear board. Arriving at `dock-1` starts
     `start_docking` → existing ToF creep to `DOCK_STOP_CM` and the charge contact.
   - **Elevator:** arrival at `elev-1-L0` by ToF → `Entering` (existing ToF
     creep onto the platform) → `Riding` → `Driving` off. Only then does
     `driving_edge()` let the locator fire `elev-1-Lk` on the new level.
     **Known limit:** ToF can't tell which level it's on. If the elevator
     didn't move, the robot believes the wrong level. L0 and L1 are the same
     length, so the length check can't catch it. Log it, and say so in the PR.
   - **Boot:** it must be set down on `TOF_BOOT_LEVEL` (document it in the
     README). It creeps forward to the first node crossed.
   - **Wi-Fi / Pi loss:** unaffected (no Pi involvement).
4. **Docs (same PR):** `docs/firmware-architecture.md` (a "ToF navigation
   (optional)" section next to the "Missed tag" text, and the TBD list),
   `firmware/esp32/docs/state-machine.md` (the arrival and recovery inputs),
   `firmware/esp32/README.md` (enabling it, boot level, measurement
   procedure), and the `AGENTS.md` node-id line.
5. **Measurement procedure (README):** with `TOF_NAV_ENABLED = true` and a
   zeroed table, `begin()` fails and the robot runs tags-only. Add a boot
   option or the bench env to log `tof: front X rear Y` once a second while
   stopped. For each node, jog the robot until it's centred on the node, read
   both values three times, and put the average in `TOF_NODES`. Measure each
   level's length.

**Test (AGENTS.md "Run it for real"):** first on a bench track (two boards,
tape marks for nodes), then the farm. Run the orchestrator against the
real robot (not the simulator), send navigates to
each water node and back, and exercise: stop mid-edge and resume, a hand in
front mid-edge, a board covered (missed crossing → error → jog to recover),
low-battery return, and a Pi restart. **Done when:** 10 runs dock → water
node → dock in a row with no fault, plus every edge case above, and with
the flag false the RFID behaviour is unchanged (host tests and a tag run).

### Phase 3: encoder assist alongside ToF, optional telemetry, farm tuning

**Precondition:** `encoder-assist` rebased onto current `main` and merged on
its own first. Its 3 commits branch from an older `main` and conflict with later changes in
`nav_task.cpp` and `motion.h`; resolve those conflicts in that PR, not this one.

1. **Precedence (one rule, in `nav_task.cpp`):** **real tag > ToF > encoder.**
   Per loop: real tags first; if none, ToF; if none, encoder `check()`. At
   most one arrival a loop. **Every** arrival, whatever its source, calls
   both `locator.on_tag(n)` and `assist.on_tag()` before `core.on_tag()`, so
   neither module fires the same node again.
2. **Encoder anchoring:** the encoder only guesses after a real tag
   (`placed_`). In ToF mode, a ToF arrival counts as an anchor
   (`assist.on_tag()` above). The encoder then covers one missed ToF crossing
   (a leaf in the beam at the wrong moment) and still guesses at most once in
   a row. Two estimates can't chain beyond one guess: the next ToF crossing
   or real tag re-anchors.
3. **Encoder cross-check (ToF false arrivals):** when the edge has counts in
   `ENCODER_EDGES`, reject a ToF arrival before `ENCODER_MIN_RATIO` (new,
   e.g. 0.6) of them. It's an obstacle, not the node. Log it. Without counts
   for that edge, no check.
4. **Don't make both "primary".** The encoder alone slips (one motor, no
   second wheel to compare) and can't localise at boot or after a jog. ToF
   is the position source and the encoder fills one gap. With both on and
   tags mounted, tags win and both become backups. That is also the setup to
   keep if the tags arrive late.
5. **Optional, team decision:** telemetry `position_source`
   (`"tag" | "tof" | "encoder"`), sent with each node change. If agreed,
   update `types.ts`, `web/src/lib/farm/types.ts`, the orchestrator's
   validators, the simulator and `comms_json.cpp` in one PR (AGENTS.md
   "Shared types have copies"), and show "position estimated" on the dashboard.
6. **Farm tuning:** `TOF_ARRIVE_LEAD_CM` (stop overshoot), `TOF_NAV_MAX_STEP_CM`
   at `CRUISE_SPEED`, `MISSED_TAG_TIMEOUT_MS` for the longest edge at
   `APPROACH_SPEED` (the slow zone makes edges near boards slower), and
   `SLOW_ZONE_CM` against node distances.

**Test:** all of Phase 2's runs with both enabled, plus a covered board
(encoder must cover it once, then fault on the next), and a hand in the beam
early in an edge (cross-check must reject it).

---

## 7. Risks of this approach

| Risk | Effect | Mitigation |
|---|---|---|
| Sensor sees plants, rails or the floor | False or missed arrivals | Aim or shield the sensors, step and length checks, encoder cross-check |
| End boards missing, moved or knocked | Every node on that level is wrong | Boards fixed to the frame; re-measure after any change; `missed tag` faults safely |
| Elevator didn't move | Robot believes the wrong level | Known limit; log it; check on the dashboard after a ride |
| Level longer than the reliable range | Some nodes measurable from one side only | Measure first (section 4); raise it before Phase 2 if any node is out of range from both |
| Stop overshoot at targets | Plant a few cm off the station | `TOF_ARRIVE_LEAD_CM`, slower `APPROACH_SPEED` near boards |

---

## As built (Phases 1 and 2)

Changes from the plan above, mostly from review:

- **No `TOF_ROBOT_LENGTH_CM`.** `TOF_LEVEL_LENGTH_CM` is front + rear as read
  on the robot (the same anywhere on a level), so it's measured directly.
- **The length check is one-sided:** only a sum that's *short* is rejected
  (something in a beam). A longer sum means a board is missing (the elevator
  platform on another level), and the check is skipped.
- **Recovering the track:** after `TOF_NAV_RESEED_COUNT` rejected readings in a
  row the edge starts again from its bounds. Without it, 2-3 cm of sensor noise
  or a hand that came and went could leave an edge untrusted for good.
- **Seed window:** widened past the end node by a stop's roll-on
  (`TOF_NAV_MAX_SPEED_CM_S` over `STOP_RAMP_MS`), so a stop just before a node
  and a resume still arrive.
- **Elevator nodes** are read from the board behind when they have that reading:
  the board ahead is the platform, which may be on another level.
- **Readings must be above `OBSTACLE_CLEAR_CM`**, not `OBSTACLE_STOP_CM`: the
  flag clears only above that, and would hold the robot short of the node for good.
- **`begin()` also checks** each two-sided node's front + rear against its
  level's length (a typo on one side would make it unmatchable).
- **Localising:** in `error`, `manual` and `initializing` only (not `idle` or
  `stopped`, where nobody is moving the robot). Being "away" from the current
  node needs `TOF_STILL_MS` of readings that add up, so someone walking past a
  faulted robot doesn't restart it.
- **Readings reach nav as they come** (about 30 Hz while on), not every
  `SENSOR_REPORT_MS`; the sensor task's change is gated by the flag.
- **The per-loop decision** is `TofLocator::update()`, so the host tests drive
  the same code as the nav task (`test_host/tof_nav_test.cpp` runs the whole
  farm with no tags).

Not done, by decision: the optional `position_source` telemetry field (no
MQTT contract change was needed); a mid-level board.
