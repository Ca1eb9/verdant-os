// nav_task.cpp
// See nav_task.h.

#include "nav_task.h"

#include <Arduino.h>
#include <math.h>
#include <string.h>

#include "../comms/comms_json.h"
#include "../config.h"
#include "../graph.h"
#include "../log.h"
#include "../nav/nav_core.h"
#include "../types.h"
#include "../utils/nav_helpers.h"

namespace {

// NavOutput over the FreeRTOS queues.
class QueueOutput : public NavOutput {
 public:
  void event(RobotEventType type, const char* task_id, NodeIndex node,
             const char* details) override {
    RobotEventMsg ev = {};
    ev.uptime_ms = millis();
    ev.event = type;
    strncpy(ev.task_id, task_id, sizeof(ev.task_id) - 1);
    if (node != NO_NODE) strncpy(ev.node_id, GRAPH_NODES[node].id, sizeof(ev.node_id) - 1);
    strncpy(ev.details, details, sizeof(ev.details) - 1);
    LOG("nav", "event %s task='%s' %s", to_wire(type), ev.task_id, ev.details);
    // Events wait here while offline. If even that overflows, telemetry
    // (task_id, last_completed_task_id) still lets the Pi catch up.
    if (xQueueSend(g_event_queue, &ev, 0) != pdTRUE) {
      LOG("nav", "event queue full, dropped %s", to_wire(type));
    }
  }

  void halt() override { drive(DriveMode::Stop, 0, 0); }

  void jog(JogDirection direction) override {
    int16_t speed = direction == JogDirection::Backward ? -JOG_SPEED : JOG_SPEED;
    drive(DriveMode::Drive, speed, JOG_PULSE_MS);
  }

  // Placeholders for the RFID navigation and dock sequence cards. Until
  // then the robot stays put: place it on a tag to localize it.
  void follow_edge(NodeIndex from, NodeIndex to, bool, Heading) override {
    LOG("nav", "follow %s -> %s: not implemented (RFID navigation card)", GRAPH_NODES[from].id,
        GRAPH_NODES[to].id);
    halt();
  }
  void creep() override {
    LOG("nav", "creep to a tag: not implemented (RFID navigation card)");
    halt();
  }
  void start_docking() override {
    LOG("nav", "dock alignment: not implemented (dock sequence card)");
    halt();
  }

  void note(const char* message) override { LOG("nav", "%s", message); }

 private:
  void drive(DriveMode mode, int16_t speed, uint32_t duration_ms) {
    DriveCommand c = {};
    c.seq = ++seq_;
    c.mode = mode;
    c.left_speed = speed;
    c.right_speed = speed;
    c.duration_ms = duration_ms;
    // Mailbox: replaces a command the motor task hasn't picked up yet.
    xQueueOverwrite(g_drive_queue, &c);
  }

  uint32_t seq_ = 0;
};

}  // namespace

void nav_task(void* /*param*/) {
  QueueOutput out;
  NavCore core(out);
  SensorData sensors = {};
  sensors.obstacle_front_cm = NAN;
  sensors.obstacle_rear_cm = NAN;
  sensors.battery_pct = NAN;
  uint32_t seen_tag_seq = 0;

  RobotStatus sent_status = RobotStatus::Initializing;
  NodeIndex sent_node = NO_NODE;
  uint32_t last_telemetry = 0;
  bool telemetry_sent = false;

  LOG("nav", "graph '%s': %u nodes, dock %s", GRAPH_VERSION, GRAPH_NODE_COUNT,
      GRAPH_NODES[GRAPH_DOCK].id);
  core.begin();

  for (;;) {
    uint32_t now = millis();

    // Every reading, in order, so no tag arrival is skipped. tag_seq still
    // shows an arrival whose reading was dropped from a full queue.
    SensorData d;
    while (xQueueReceive(g_sensor_queue, &d, 0) == pdTRUE) {
      sensors = d;
      core.on_battery(d.battery_pct);
      if (d.tag_seq == seen_tag_seq) continue;
      seen_tag_seq = d.tag_seq;
      NodeIndex node = node_by_tag(d.tag_uid);
      if (node == NO_NODE) LOG("nav", "tag %s isn't in the graph (topology.json)", d.tag_uid);
      core.on_tag(node, now);
    }

    Command cmd;
    while (xQueueReceive(g_command_queue, &cmd, 0) == pdTRUE) core.on_command(cmd, now);

    core.tick(now);

    // After the step's events are queued: comms sends those first.
    bool changed = core.status() != sent_status || core.current_node() != sent_node;
    if (changed || !telemetry_sent || now - last_telemetry >= TELEMETRY_PERIOD_MS) {
      TelemetryMsg t = {};
      core.snapshot(t);
      t.uptime_ms = now;
      t.battery_pct = sensors.battery_pct;  // NAN until the first sample: comms skips it
      t.obstacle_cm = core.reversing() ? sensors.obstacle_rear_cm : sensors.obstacle_front_cm;
      t.temperature_c = NAN;  // no environment sensors on the robot
      t.humidity_pct = NAN;
      t.light_lux = NAN;
      // Full only while comms is offline, when telemetry is discarded anyway.
      xQueueSend(g_telemetry_queue, &t, 0);
      if (changed) LOG("nav", "%s at %s, task '%s'", to_wire(t.status), t.current_node, t.task_id);
      sent_status = core.status();
      sent_node = core.current_node();
      last_telemetry = now;
      telemetry_sent = true;
    }

    vTaskDelay(pdMS_TO_TICKS(NAV_LOOP_MS));
  }
}
