// nav_core.h
// The robot state machine (docs/firmware-architecture.md and
// firmware/esp32/docs/state-machine.md): statuses, commands, task context
// and events.
//
// Pure C++ with no Arduino or FreeRTOS calls, so test_host can drive it. The
// nav task feeds it commands, tags, battery readings and the time, and sends
// telemetry from snapshot(). Everything it does goes out through NavOutput.
//
// Events are emitted before the status they explain changes, so telemetry
// taken after any call can never report a status ahead of its event.
//
// Physical work is behind the NavOutput motion hooks and a few inputs, for
// the cards that own it:
//   - driving between tags, turns, the missed-tag fault: RFID navigation
//     (follow_edge, creep, jog, halt; fault())
//   - battery and obstacle checks: survival overrides (survival_return())
//   - dock alignment and charge contact: dock sequence (start_docking,
//     on_charge_contact())

#pragma once

#include <math.h>
#include <stdint.h>

#include "../graph.h"
#include "../types.h"
#include "task_context.h"

class NavOutput {
 public:
  // Queue an event. `node` is NO_NODE before the first tag.
  virtual void event(RobotEventType type, const char* task_id, NodeIndex node,
                     const char* details) = 0;

  // ---- Motion hooks ----
  // Each call replaces whatever the robot was doing.

  // Stop the motors now.
  virtual void halt() = 0;
  // Face `to` and drive along the edge from `from` until the next tag.
  // `heading_known`/`heading` is the way the robot faced before the call. It
  // may be called while the robot is already between `from` and `to` (e.g.
  // resuming after a stop), facing `to`.
  virtual void follow_edge(NodeIndex from, NodeIndex to, bool heading_known,
                           Heading heading) = 0;
  // Drive forward slowly until a tag is read (localizing).
  virtual void creep() = 0;
  // Drive one JOG_PULSE_MS pulse. Backward reverses without turning.
  virtual void jog(JogDirection direction) = 0;
  // Run the dock alignment sequence; report contact with on_charge_contact().
  virtual void start_docking() = 0;

  // Why a command or input was ignored, for the serial log.
  virtual void note(const char* message) = 0;

  virtual ~NavOutput() {}
};

class NavCore {
 public:
  explicit NavCore(NavOutput& out) : out_(out) {
    ctx_.current.target = NO_NODE;
    ctx_.kept.target = NO_NODE;
  }

  // Boot: reports `initializing` and creeps until the first tag.
  void begin();

  // ---- Inputs ----
  void on_command(const Command& cmd, uint32_t now);
  // A new tag arrival (SensorData.tag_seq changed). NO_NODE for a tag that
  // isn't in the graph: ignored.
  void on_tag(NodeIndex node, uint32_t now);
  // Latest battery reading, every nav loop. NAN until the first one.
  void on_battery(float battery_pct);
  // Timers: action duration, manual timeout, charge complete. Every nav loop.
  void tick(uint32_t now);

  // Dock sequence: the charger contacts closed while `docking`.
  void on_charge_contact();
  // RFID navigation: can't continue (e.g. missed tag, or no tag found while
  // creeping after boot). Reports `error`, keeping the task, until a known
  // tag is read again. While initializing it only halts and publishes the
  // event.
  void fault(const char* details);
  // Survival overrides: forced return to dock, keeping the task. Publishes
  // battery_critical. Ignored while stopped (a stop beats it), in manual
  // (only the motor cutoff applies in both), while already on a dock trip
  // and while initializing.
  void survival_return(const char* details, uint32_t now);

  // ---- State ----
  RobotStatus status() const { return status_; }
  NodeIndex current_node() const { return node_; }
  // True after reversing (backward jog): obstacle_cm comes from the rear sensor.
  bool reversing() const { return reversing_; }
  const TaskContext& context() const { return ctx_; }
  // The task_id telemetry reports: the current task, else the kept task.
  const char* reported_task_id() const;
  // Fills status, current_node, task_id, last_completed_task_id and heading.
  // The caller adds uptime, battery and sensor readings.
  void snapshot(TelemetryMsg& t) const;

 private:
  // Commands
  void navigate(const Command& cmd, uint32_t now);
  void stop(uint32_t now);
  void resume(uint32_t now);
  void return_to_dock(const char* dock_task_id, uint32_t now);
  void cancel(const char* task_id);
  void jog(JogDirection direction, uint32_t now);

  // Transitions
  void emit(RobotEventType type, const char* details = "");
  void emit_for(RobotEventType type, const char* task_id, const char* details = "");
  bool has_task() const { return ctx_.current.target != NO_NODE; }
  // The status stop or manual interrupted, else the current one.
  RobotStatus paused_or_current() const;
  void clear_task(TaskSpec& t);
  uint8_t command_path(const Command& cmd, NodeIndex goal, NodeIndex* out) const;
  bool set_path(NodeIndex goal);
  void follow_path(uint32_t now);
  void arrive(uint32_t now);
  void redock();
  void complete_task();
  void go_to_task(uint32_t now);
  void go_to_dock(uint32_t now);
  void resume_kept(uint32_t now);
  void resume_paused(uint32_t now);
  void continue_from(RobotStatus from, uint32_t now);
  void go_idle(const char* details);
  void exit_manual(bool timed_out, uint32_t now);

  NavOutput& out_;
  RobotStatus status_ = RobotStatus::Initializing;
  NodeIndex node_ = NO_NODE;
  bool heading_known_ = false;
  Heading heading_ = Heading::North;
  bool reversing_ = false;
  TaskContext ctx_ = {};

  float battery_pct_ = NAN;

  // Status `error` interrupted, continued after recovery.
  RobotStatus error_from_ = RobotStatus::Idle;

  // Manual control
  RobotStatus manual_from_ = RobotStatus::Idle;
  uint32_t last_manual_input_ms_ = 0;
};
