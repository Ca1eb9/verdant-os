// nav_core.cpp
// See nav_core.h. The simulator (farm-controller/simulator) implements the
// same behaviour and is the reference when in doubt.

#include "nav_core.h"

#include <stdio.h>
#include <string.h>

#include "../comms/comms_json.h"
#include "../config.h"
#include "../utils/nav_helpers.h"

namespace {

bool is_dock_trip(RobotStatus s) {
  return s == RobotStatus::ReturningToDock || s == RobotStatus::Docking ||
         s == RobotStatus::Charging;
}

bool is_on_task(RobotStatus s) { return s == RobotStatus::EnRoute || s == RobotStatus::Working; }

uint32_t default_duration_ms(TargetAction a) {
  switch (a) {
    case TargetAction::Water: return DEFAULT_WATER_MS;
    case TargetAction::Grow: return DEFAULT_GROW_MS;
    case TargetAction::Harvest: return DEFAULT_HARVEST_MS;
    default: return DEFAULT_IDLE_MS;
  }
}

template <size_t N>
void copy_id(char (&dst)[N], const char* src) {
  strncpy(dst, src, N - 1);
  dst[N - 1] = '\0';
}

}  // namespace

// ---- State ----------------------------------------------------------------------

const char* NavCore::reported_task_id() const {
  if (has_task()) return ctx_.current.task_id;
  if (ctx_.kept.target != NO_NODE) return ctx_.kept.task_id;
  return "";
}

void NavCore::snapshot(TelemetryMsg& t) const {
  t.status = status_;
  copy_id(t.current_node, node_ == NO_NODE ? "" : GRAPH_NODES[node_].id);
  copy_id(t.task_id, reported_task_id());
  copy_id(t.last_completed_task_id, ctx_.last_completed_task_id);
  t.heading_known = heading_known_;
  t.heading = heading_;
}

// ---- Inputs ----------------------------------------------------------------------

void NavCore::begin() {
  status_ = RobotStatus::Initializing;
  out_.creep();
}

void NavCore::on_battery(float battery_pct) { battery_pct_ = battery_pct; }

void NavCore::on_command(const Command& cmd, uint32_t now) {
  // No position yet: no path can be planned, and the orchestrator never
  // gives work to a robot without a node.
  if (status_ == RobotStatus::Initializing) {
    out_.note("ignored: still initializing");
    return;
  }
  switch (cmd.type) {
    case CommandType::Navigate: navigate(cmd, now); break;
    case CommandType::Stop: stop(now); break;
    case CommandType::Resume: resume(now); break;
    case CommandType::ReturnToDock: return_to_dock(cmd.task_id, now); break;
    case CommandType::Cancel: cancel(cmd.task_id); break;
    case CommandType::Jog: jog(cmd.direction, now); break;
  }
}

void NavCore::on_tag(NodeIndex node, uint32_t now) {
  if (node == NO_NODE) {
    out_.note("ignored: tag isn't in the graph");
    return;
  }
  NodeIndex prev = node_;
  node_ = node;
  // Reversing doesn't turn the robot, so the heading stays.
  Heading h;
  if (prev != NO_NODE && !reversing_ && compute_heading(prev, node, h)) {
    heading_ = h;
    heading_known_ = true;
  }

  switch (status_) {
    case RobotStatus::Initializing:
      out_.halt();
      status_ = RobotStatus::Idle;
      break;
    case RobotStatus::Error:
      emit(RobotEventType::Recovery, "known tag read");
      continue_from(error_from_, now);
      break;
    case RobotStatus::EnRoute:
    case RobotStatus::ReturningToDock: {
      // Usually the next node on the path. A tag further along means one was
      // missed; any other tag means the robot left its path: re-plan.
      for (uint8_t i = ctx_.path_index + 1; i < ctx_.path_len; i++) {
        if (ctx_.path[i] == node) {
          ctx_.path_index = i;
          follow_path(now);
          return;
        }
      }
      if (set_path(ctx_.path[ctx_.path_len - 1])) follow_path(now);
      else go_idle("can't follow the path");
      break;
    }
    default:
      break;  // moved by hand while not driving: position updated
  }
}

void NavCore::tick(uint32_t now) {
  switch (status_) {
    case RobotStatus::Working:
      if (now - ctx_.action_started_ms >= ctx_.current.duration_ms) complete_task();
      break;
    case RobotStatus::Manual:
      if (now - last_manual_input_ms_ >= MANUAL_TIMEOUT_MS) {
        exit_manual(true, now);
      }
      break;
    case RobotStatus::Charging:
      if (!isnan(battery_pct_) && battery_pct_ >= CHARGE_COMPLETE_PCT) {
        char details[EVENT_DETAILS_LEN];
        snprintf(details, sizeof(details), "%.1f%%", battery_pct_);
        emit(RobotEventType::ChargeComplete, details);
        // A stop that came in before or during the dock trip still holds.
        if (ctx_.stop_latched) {
          ctx_.has_paused_status = false;
          out_.halt();
          status_ = RobotStatus::Stopped;
        } else if (ctx_.kept.target != NO_NODE) {
          resume_kept(now);
        } else {
          go_idle("");
        }
      }
      break;
    default:
      break;
  }
}

void NavCore::on_charge_contact() {
  if (status_ != RobotStatus::Docking) {
    out_.note("ignored: charge contact while not docking");
    return;
  }
  emit(RobotEventType::DockConnected);
  // A dock task is done once connected; a kept task waits for the charge.
  if (ctx_.dock_task) {
    emit(RobotEventType::TaskComplete, "docked");
    copy_id(ctx_.last_completed_task_id, ctx_.current.task_id);
    clear_task(ctx_.current);
    ctx_.dock_task = false;
  }
  status_ = RobotStatus::Charging;
}

void NavCore::fault(const char* details) {
  // Couldn't find a tag after boot: stop looking, but with no node it can
  // only report initializing. A tag read still brings it to idle.
  if (status_ == RobotStatus::Initializing) {
    emit(RobotEventType::Error, details);
    out_.halt();
    return;
  }
  if (status_ == RobotStatus::Error || status_ == RobotStatus::Stopped ||
      status_ == RobotStatus::Manual) {
    out_.note("ignored: fault while not driving on its own");
    return;
  }
  error_from_ = status_;
  emit(RobotEventType::Error, details);
  out_.halt();
  status_ = RobotStatus::Error;
}

void NavCore::survival_return(const char* details, uint32_t now) {
  // A stop beats it: an operator stopped the robot on purpose. So does an
  // operator driving it by hand.
  if (status_ == RobotStatus::Initializing || status_ == RobotStatus::Stopped ||
      status_ == RobotStatus::Manual || is_dock_trip(status_)) {
    return;
  }
  emit(RobotEventType::BatteryCritical, details);
  return_to_dock("", now);
}

// ---- Commands ----------------------------------------------------------------------

void NavCore::navigate(const Command& cmd, uint32_t now) {
  const char* id = cmd.task_id;
  // A redelivered command: the task is in hand or already done.
  if (id[0] && (strcmp(id, reported_task_id()) == 0 ||
                strcmp(id, ctx_.last_completed_task_id) == 0)) {
    out_.note("ignored: duplicate navigate");
    return;
  }
  NodeIndex goal = node_by_id(cmd.target_node);
  char details[EVENT_DETAILS_LEN];
  if (goal == NO_NODE) {
    snprintf(details, sizeof(details), "unknown target %s", cmd.target_node);
    emit_for(RobotEventType::TaskFailed, id, details);
    return;
  }
  NodeIndex path[MAX_PATH_LEN];
  uint8_t len = command_path(cmd, goal, path);
  if (!len) len = dijkstra(node_, goal, path, MAX_PATH_LEN);
  if (!len) {
    snprintf(details, sizeof(details), "no path to %s", cmd.target_node);
    emit_for(RobotEventType::TaskFailed, id, details);
    return;
  }

  // Replaces everything: task, kept task, paused status, stop latch, manual.
  clear_task(ctx_.kept);
  ctx_.dock_task = false;
  ctx_.has_paused_status = false;
  ctx_.stop_latched = false;
  copy_id(ctx_.current.task_id, id);
  ctx_.current.target = goal;
  ctx_.current.action =
      cmd.action_at_target == TargetAction::None ? TargetAction::Idle : cmd.action_at_target;
  ctx_.current.duration_ms =
      cmd.has_duration ? cmd.duration_ms : default_duration_ms(ctx_.current.action);
  memcpy(ctx_.path, path, len * sizeof(NodeIndex));
  ctx_.path_len = len;
  ctx_.path_index = 0;
  status_ = RobotStatus::EnRoute;
  follow_path(now);
}

void NavCore::stop(uint32_t now) {
  if (status_ == RobotStatus::Stopped) {
    out_.note("ignored: already stopped");
    return;
  }
  RobotStatus from = status_;
  if (from == RobotStatus::Manual) {
    // Stop ends the manual session and pauses what manual interrupted.
    from = manual_from_;
  }
  ctx_.stop_latched = true;
  out_.halt();
  // Manual from a stop: that stop's paused status still applies.
  if (from != RobotStatus::Stopped) {
    ctx_.has_paused_status = true;
    ctx_.paused_status = from;
    ctx_.paused_at_ms = now;
  }
  status_ = RobotStatus::Stopped;
}

void NavCore::resume(uint32_t now) {
  if (status_ == RobotStatus::Manual) {
    exit_manual(false, now);
    return;
  }
  if (!ctx_.stop_latched) {
    out_.note("ignored: resume without a stop");
    return;
  }
  ctx_.stop_latched = false;
  // Latched through a dock trip: it now carries on after charging.
  if (status_ != RobotStatus::Stopped) return;
  resume_paused(now);
}

void NavCore::return_to_dock(const char* dock_task_id, uint32_t now) {
  if (is_dock_trip(status_) || is_dock_trip(paused_or_current())) {
    out_.note("ignored: already on a dock trip");
    return;
  }
  NodeIndex path[MAX_PATH_LEN];
  if (node_ != GRAPH_DOCK && !dijkstra(node_, GRAPH_DOCK, path, MAX_PATH_LEN)) {
    if (!has_task() && dock_task_id[0]) {
      emit_for(RobotEventType::TaskFailed, dock_task_id, "no path to the dock");
    } else {
      out_.note("ignored: no path to the dock");
    }
    return;
  }

  if (has_task() && !ctx_.dock_task) {
    // Carried on after charging; telemetry keeps reporting it.
    ctx_.kept = ctx_.current;
    clear_task(ctx_.current);
  } else if (!has_task() && ctx_.kept.target == NO_NODE && dock_task_id[0]) {
    copy_id(ctx_.current.task_id, dock_task_id);
    ctx_.current.target = GRAPH_DOCK;
    ctx_.current.action = TargetAction::Charge;
    ctx_.current.duration_ms = 0;
    ctx_.dock_task = true;
  }
  // The stop latch stays: after charging the robot reports stopped.
  ctx_.has_paused_status = false;
  go_to_dock(now);
}

void NavCore::cancel(const char* task_id) {
  if (!task_id[0]) return;
  // A kept task: the dock trip carries on, so the robot still charges.
  if (ctx_.kept.target != NO_NODE && strcmp(ctx_.kept.task_id, task_id) == 0) {
    clear_task(ctx_.kept);
  }
  if (!has_task() || strcmp(ctx_.current.task_id, task_id) != 0) return;

  bool was_dock_task = ctx_.dock_task;
  clear_task(ctx_.current);
  ctx_.dock_task = false;

  RobotStatus doing = paused_or_current();
  bool driving_for_it =
      is_on_task(doing) || (was_dock_task && (doing == RobotStatus::ReturningToDock ||
                                              doing == RobotStatus::Docking));
  if (!driving_for_it) return;  // e.g. error: stays there, with no task
  if (status_ == RobotStatus::Stopped) {
    ctx_.paused_status = RobotStatus::Idle;  // resume goes to idle
  } else if (status_ == RobotStatus::Manual) {
    manual_from_ = RobotStatus::Idle;
  } else {
    out_.halt();
    status_ = RobotStatus::Idle;
  }
}

void NavCore::jog(JogDirection direction, uint32_t now) {
  switch (status_) {
    case RobotStatus::Idle:
    case RobotStatus::EnRoute:
    case RobotStatus::Working:
    case RobotStatus::Stopped:
    case RobotStatus::Error:
    case RobotStatus::Manual:
      break;
    default:
      out_.note("ignored: jog not allowed now");
      return;
  }
  if (!isnan(battery_pct_) && battery_pct_ <= BATTERY_CUTOFF_PCT) {
    out_.note("ignored: battery below the motor cutoff");
    return;
  }
  if (status_ != RobotStatus::Manual) {
    manual_from_ = status_;
    status_ = RobotStatus::Manual;
  }
  last_manual_input_ms_ = now;
  reversing_ = direction == JogDirection::Backward;
  out_.jog(direction);
}

// ---- Transitions ----------------------------------------------------------------------

void NavCore::emit(RobotEventType type, const char* details) {
  out_.event(type, reported_task_id(), node_, details);
}

void NavCore::emit_for(RobotEventType type, const char* task_id, const char* details) {
  out_.event(type, task_id, node_, details);
}

RobotStatus NavCore::paused_or_current() const {
  if (status_ == RobotStatus::Stopped && ctx_.has_paused_status) return ctx_.paused_status;
  if (status_ == RobotStatus::Manual) return manual_from_;
  return status_;
}

void NavCore::clear_task(TaskSpec& t) {
  t = TaskSpec{};
  t.target = NO_NODE;
}

uint8_t NavCore::command_path(const Command& cmd, NodeIndex goal, NodeIndex* out) const {
  // The orchestrator plans from where it last saw the robot; follow its path
  // from the robot's current node on. Anything inconsistent: plan on board.
  uint8_t len = 0;
  bool started = false;
  for (uint8_t i = 0; i < cmd.path_len; i++) {
    NodeIndex n = node_by_id(cmd.path[i]);
    if (n == NO_NODE) return 0;
    if (!started && n != node_) continue;
    if (started && !has_edge(out[len - 1], n)) return 0;
    started = true;
    out[len++] = n;
  }
  return len && out[len - 1] == goal ? len : 0;
}

bool NavCore::set_path(NodeIndex goal) {
  NodeIndex path[MAX_PATH_LEN];
  uint8_t len = dijkstra(node_, goal, path, MAX_PATH_LEN);
  if (!len) return false;
  memcpy(ctx_.path, path, len * sizeof(NodeIndex));
  ctx_.path_len = len;
  ctx_.path_index = 0;
  return true;
}

void NavCore::follow_path(uint32_t now) {
  if (ctx_.path_index + 1 >= ctx_.path_len) {
    arrive(now);
    return;
  }
  NodeIndex from = ctx_.path[ctx_.path_index];
  NodeIndex to = ctx_.path[ctx_.path_index + 1];
  out_.follow_edge(from, to, heading_known_, heading_);
  // It now faces `to` (an elevator move keeps the heading).
  reversing_ = false;
  Heading h;
  if (compute_heading(from, to, h)) {
    heading_ = h;
    heading_known_ = true;
  }
}

void NavCore::arrive(uint32_t now) {
  out_.halt();
  if (status_ == RobotStatus::ReturningToDock) {
    emit(RobotEventType::Arrived, "at the dock");
    redock();
    return;
  }
  char details[EVENT_DETAILS_LEN];
  snprintf(details, sizeof(details), "at %s", GRAPH_NODES[node_].id);
  emit(RobotEventType::Arrived, details);
  snprintf(details, sizeof(details), "%s for %lu s", to_wire(ctx_.current.action),
           (unsigned long)(ctx_.current.duration_ms / 1000));
  emit(RobotEventType::TaskStarted, details);
  ctx_.action_started_ms = now;
  status_ = RobotStatus::Working;
  // With no duration, the task is done right after it starts.
  if (ctx_.current.duration_ms == 0) complete_task();
}

void NavCore::redock() {
  status_ = RobotStatus::Docking;
  out_.start_docking();
}

void NavCore::complete_task() {
  char details[EVENT_DETAILS_LEN];
  snprintf(details, sizeof(details), "%s at %s", to_wire(ctx_.current.action),
           GRAPH_NODES[node_].id);
  emit(RobotEventType::TaskComplete, details);
  // A navigate without a task_id has nothing to report: keep the last one.
  if (ctx_.current.task_id[0]) copy_id(ctx_.last_completed_task_id, ctx_.current.task_id);
  clear_task(ctx_.current);
  go_idle("");
}

void NavCore::go_to_task(uint32_t now) {
  if (!set_path(ctx_.current.target)) {
    go_idle("target unreachable");
    return;
  }
  status_ = RobotStatus::EnRoute;
  follow_path(now);
}

void NavCore::go_to_dock(uint32_t now) {
  if (node_ == GRAPH_DOCK) {
    // Already there but not charging: run the dock sequence again.
    out_.halt();
    redock();
    return;
  }
  if (!set_path(GRAPH_DOCK)) {
    go_idle("no path to the dock");
    return;
  }
  status_ = RobotStatus::ReturningToDock;
  follow_path(now);
}

void NavCore::resume_kept(uint32_t now) {
  ctx_.current = ctx_.kept;
  clear_task(ctx_.kept);
  ctx_.dock_task = false;
  go_to_task(now);
}

void NavCore::resume_paused(uint32_t now) {
  bool had = ctx_.has_paused_status;
  RobotStatus paused = ctx_.paused_status;
  ctx_.has_paused_status = false;

  // Stopped at the dock after charging: continue the kept task, if any.
  if (!had) {
    if (ctx_.kept.target != NO_NODE) resume_kept(now);
    else go_idle("");
    return;
  }
  // Still at its target: keep working for the remaining time.
  if (paused == RobotStatus::Working && has_task() && node_ == ctx_.current.target) {
    ctx_.action_started_ms += now - ctx_.paused_at_ms;
    status_ = RobotStatus::Working;
    return;
  }
  // Still on the charger.
  if (paused == RobotStatus::Charging && node_ == GRAPH_DOCK) {
    status_ = RobotStatus::Charging;
    return;
  }
  continue_from(paused, now);
}

// Picks an interrupted activity back up from the current node, re-planning
// since the robot may have moved.
void NavCore::continue_from(RobotStatus from, uint32_t now) {
  switch (from) {
    case RobotStatus::ReturningToDock:
    case RobotStatus::Docking:
    case RobotStatus::Charging:
      go_to_dock(now);
      return;
    case RobotStatus::Stopped:
      out_.halt();
      status_ = RobotStatus::Stopped;
      return;
    case RobotStatus::Error:
      out_.halt();
      status_ = RobotStatus::Error;
      return;
    default:
      // A working robot restarts its action on arrival.
      if (has_task()) go_to_task(now);
      else if (ctx_.kept.target != NO_NODE) resume_kept(now);
      else go_idle("");
      return;
  }
}

// idle never holds a task: anything still held has failed.
void NavCore::go_idle(const char* details) {
  if (has_task()) {
    emit_for(RobotEventType::TaskFailed, ctx_.current.task_id, details);
    clear_task(ctx_.current);
  }
  if (ctx_.kept.target != NO_NODE) {
    emit_for(RobotEventType::TaskFailed, ctx_.kept.task_id, details);
    clear_task(ctx_.kept);
  }
  ctx_.dock_task = false;
  out_.halt();
  status_ = RobotStatus::Idle;
}

// Re-plans from current_node, the last tag read. The robot may have been
// left a little past it; that doesn't change the route.
void NavCore::exit_manual(bool timed_out, uint32_t now) {
  RobotStatus from = manual_from_;
  // A timeout gives a stopped robot back stopped (latch kept); resume
  // releases the stop and continues instead.
  if (timed_out && from == RobotStatus::Stopped) {
    out_.halt();
    status_ = RobotStatus::Stopped;
    return;
  }
  if (!timed_out) ctx_.stop_latched = false;
  if (from == RobotStatus::Error) {
    emit(RobotEventType::Recovery, "position taken from the last tag after manual control");
    from = error_from_;
  }
  if (from == RobotStatus::Stopped) {
    resume_paused(now);
    return;
  }
  continue_from(from, now);
}
