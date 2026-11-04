# Confirmed navigation backup: design

Status: **implemented, off by default** (`CONFIRM_NAV_ENABLED` in
`firmware/esp32/src/config.h`, `NEXT_PUBLIC_CONFIRM_NAV` on the Pi's dashboard).
Owner: Caleb. For when neither RFID nor ToF navigation
([tof-navigation-plan.md](tof-navigation-plan.md)) can tell the robot where
it is, e.g. at a live demo.

## 1. The idea

An operator watches the robot and taps **Reached next node** on their phone
the moment it reaches each node, in **Backup navigation** at the bottom of the dashboard's Settings. The command, `node_reached`, carries **no
node id**: it only says "the node you were driving to is reached". The robot
knows which one that is, because it planned the path itself.

**The integration point is `NavCore::on_tag(node, now)`**, as for ToF
navigation and encoder assist. The nav task hands a tap to `on_tag()` exactly
like a tag read, so `NavCore`, `Survival`, the orchestrator's task logic and
the dashboard's map don't change: they see node ids, the same events and the
same telemetry.

What stays true (AGENTS.md): the robot is the source of truth (it decides
which node a tap means); node ids on the wire; the robot never turns;
elevator nodes are never targets; a stop beats everything but the motor
cutoff; no Pi heartbeat watchdog.

## 2. Contract change

One new `RobotCommand.command` value, `node_reached`, with no fields. It's a
**team decision** (AGENTS.md), so say so in the PR. Copies updated together:
`types.ts`, `web/src/lib/farm/types.ts` and `validate.ts`, the orchestrator's
`validate.ts`, the Supabase bridge's `commands.ts`, the simulator (logs and
ignores it: it reads its own tags), `comms_json.cpp` and its host tests.

**Farm network only**, like `jog` and `connect_controller`. A tap that arrives
late moves the robot on one node at the wrong moment, and the online path
(Vercel → Supabase → bridge) can hold a command and deliver it after a
reconnect. So it's refused at every step off FarmNet: the dashboard never
shows it there, `/api/commands` refuses it, the bridge marks the row
failed, and the orchestrator only forwards it from `farm/commands/local`.
FarmNet has no sign-in, so it can't be limited to one account: it's
shown only by a Pi built with `NEXT_PUBLIC_CONFIRM_NAV=true`. Without the flag Settings looks as it always did. Anyone on the
farm Wi-Fi who opens Settings there can use it, as they can already stop or jog a robot.

## 3. Robot side

`src/nav/confirm_nav.{h,cpp}` (pure C++, host-tested), wired in
`src/tasks/nav_task.cpp`:

- the `follow_edge()` hook remembers the edge's end (`on_edge`);
- each loop, `update(motion.driving_edge())`, so an elevator ride's end
  only counts once the robot is driving off the platform;
- `node_reached` is taken in the nav task, before `NavCore`:
  `reached(status)` gives the node, then `on_tag()` disarms it and
  `core.on_tag(node)` runs as for a tag read. Ignored taps go to
  `NavOutput::note()` (log, and the LED's two dim blips);
- every real tag also calls `on_tag()`. A real tag for the node a tap just
  reached is dropped while driving, so it doesn't re-plan; any other real tag
  counts as usual.

| Status | A tap means | Why |
|---|---|---|
| `initializing` | on the dock (`GRAPH_DOCK`) | there's no "next" yet; it's set down there with `BOOT_CREEP` off (enforced by a `static_assert`) |
| `en_route`, `returning_to_dock` | the end of the edge it's driving | the normal case |
| the same, turned back partway along an edge | the node it left | a return to the dock, or a task the other way: `NavCore` plans from the last node reached, so the robot reaches that one first. The dashboard's "Driving to" (the orchestrator's path) may show the node after it |
| `stopped`, `error`, `manual` | the end of the edge it was driving | an operator stopped it there, or drove it there after a missed node; `NavCore` re-plans from that node when it carries on |
| anything else | ignored | nothing to drive to: idle, working, docking, charging. A cancelled task leaves nothing either, so a later stop or jog doesn't bring it back |

Also ignored: during an elevator ride (on the platform, not at the node),
and within `CONFIRM_NAV_MIN_MS` (1 s) of setting off for that node. That
catches a double tap or a duplicated message: the time is read when the next
edge starts, so the second tap of a pair always lands inside it. A resume
toward the same node keeps the time it first set off. After an elevator ride
the time counts from the start of the ride, so it's long past when it drives
off: a tap during the ride is what's refused there.

## 4. Safety for a live demo

| Risk | What happens |
|---|---|
| Double tap, or a duplicated message | the second is within 1 s of setting off: ignored. The button also waits 1 s |
| Tap during the elevator ride | ignored until it drives off |
| No tap (the phone died, the operator looked away) | the missed-tag timeout (5 s) stops it with `error`, as for a missed tag; the obstacle stop still applies |
| Late tap | it overshoots by the delay. FarmNet goes straight to the broker (tens of ms); the robot's Wi-Fi power saving adds up to a few hundred ms while Bluetooth runs |
| Tap from the online dashboard | refused at every step (section 2) |
| Firmware built without it | `node_reached` is ignored with a note; RFID behaviour unchanged |
| Wrong node after a mistake | Stop, drive it by hand to the node it was heading for, tap, Resume |

The panel also has **Stop** and **Resume**, and says when the robot didn't take
a tap: no node change within 2.5 s.

## 5. With the other backups

**Never enable it with ToF navigation or encoder assist.** Both reach nodes
by themselves, and a tap after one of them would count the same node twice
(skipping one). Encoder assist only guesses after a real tag, so with every
tag dead it does nothing, but one readable tag (the dock's, say) is enough.
Neither branch is on `main` yet. Whichever merges second adds to `config.h`:

```cpp
static_assert(!(CONFIRM_NAV_ENABLED && TOF_NAV_ENABLED), "pick one backup navigation");
static_assert(!(CONFIRM_NAV_ENABLED && ENCODER_ASSIST_ENABLED), "pick one backup navigation");
```

Merging with `ToF-nav-backup` is otherwise mechanical: the `driving_edge()`
and `creeping()` accessors in `motion.h` are the same lines, and both modules
hook `follow_edge()` and the tag loop the same way.

## 6. Testing

- `test_host/confirm_nav_test.cpp`: `ConfirmNav` with the real `NavCore` and
  `Motion` on the farm graph, no tags. Covers boot on the dock, a route by taps, the
  double tap in one loop, the elevator ride, a missed node (error, then a tap;
  and error, jog, tap), stop and resume, manual, cancel, and a real tag mixed in.
- Run for real: the Pi services, the dashboard built with
  `NEXT_PUBLIC_CONFIRM_NAV=true` on FarmNet (Settings → Backup navigation), and the robot with
  `CONFIRM_NAV_ENABLED`. Drive dock → water-01 → dock by taps, then: double tap,
  no tap (missed-tag error and recovery), a stop mid-edge, and an elevator ride.
