// nav_task.cpp
// See nav_task.h.

#include "nav_task.h"

#include <Adafruit_NeoPixel.h>
#include <Arduino.h>
#include <math.h>
#include <string.h>

#include "../comms/comms_json.h"
#include "../config.h"
#include "../graph.h"
#include "../log.h"
#include "../nav/motion.h"
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

  void halt() override { motion.halt(); }

  void jog(JogDirection direction) override {
    last_jog_ms = millis();
    motion.jog(direction);
  }

  void follow_edge(NodeIndex from, NodeIndex to, EdgeDrive drive) override {
    LOG("nav", "follow %s -> %s (%s)", GRAPH_NODES[from].id, GRAPH_NODES[to].id,
        drive == EdgeDrive::Backward || drive == EdgeDrive::ElevatorBackward ? "backward"
                                                                             : "forward");
    motion.follow_edge(from, to, drive, millis());
  }
  void creep() override { motion.creep(millis()); }

  // Placeholder for the dock sequence card.
  void start_docking() override {
    LOG("nav", "dock alignment: not implemented (dock sequence card)");
    halt();
  }

  void note(const char* message) override {
    last_note_ms = millis();
    LOG("nav", "%s", message);
  }

  // For the status LED's flashes. 0 = never.
  uint32_t last_jog_ms = 0;
  uint32_t last_note_ms = 0;

 private:
  class MailboxSink : public DriveSink {
   public:
    void send(const DriveCommand& c) override {
      // Mailbox: replaces a command the motor task hasn't picked up yet.
      xQueueOverwrite(g_drive_queue, &c);
    }
  };

  MailboxSink drive_;  // before motion, which holds it

 public:
  Motion motion{drive_};
};

// The status LED (README "Status LED"): colour = status, animation = the
// detail, short flashes on top = what just happened. Called every nav loop;
// writes the LED only when the colour changes.
void show_status_led(Adafruit_NeoPixel& led, const NavCore& core, const QueueOutput& out,
                     const SensorData& s, uint32_t known_tag_ms, uint32_t unknown_tag_ms,
                     uint32_t now) {
  // ColorHSV hues (0-65535 around the wheel)
  constexpr uint16_t RED = 0, ORANGE = 3641, AMBER = 6372, YELLOW = 10923, GREEN = 21845,
                     CYAN = 32768, BLUE = 43691, PURPLE = 49152, MAGENTA = 54613;
  constexpr uint8_t DIM = 70, FULL = 255;
  auto breathe = [&]() -> uint8_t {
    float phase = (float)(now % LED_BREATHE_MS) / LED_BREATHE_MS;
    return 30 + (uint8_t)(225 * (0.5f - 0.5f * cosf(2 * (float)M_PI * phase)));
  };
  auto since = [&](uint32_t t) { return t ? now - t : UINT32_MAX; };
  bool blink_on = (now / LED_BLINK_MS) % 2 == 0;
  RobotStatus status = core.status();
  const TaskContext& ctx = core.context();
  uint16_t hue = 0;
  uint8_t sat = 255, val = FULL;

  switch (status) {
    case RobotStatus::Initializing: sat = 0; val = breathe(); break;  // white
    case RobotStatus::Idle: hue = GREEN; val = DIM; break;
    case RobotStatus::EnRoute: hue = BLUE; break;
    case RobotStatus::Working: {
      // Hue by action; brightness climbs from dim to full over the action.
      switch (ctx.current.action) {
        case TargetAction::Water: hue = CYAN; break;
        case TargetAction::Grow: hue = MAGENTA; break;
        case TargetAction::Harvest: hue = YELLOW; break;
        default: hue = GREEN; break;
      }
      uint32_t d = ctx.current.duration_ms;
      float done = d ? (float)(now - ctx.action_started_ms) / d : 1.0f;
      val = DIM + (uint8_t)((FULL - DIM) * (done < 1.0f ? done : 1.0f));
      break;
    }
    case RobotStatus::ReturningToDock: hue = AMBER; break;
    case RobotStatus::Docking: hue = AMBER; val = blink_on ? FULL : 0; break;
    case RobotStatus::Charging: {
      // Red at empty, through yellow, to green at charge complete.
      float pct = isnan(s.battery_pct) ? 0 : s.battery_pct / CHARGE_COMPLETE_PCT;
      hue = (uint16_t)(GREEN * (pct < 1.0f ? pct : 1.0f));
      val = breathe();
      break;
    }
    case RobotStatus::Stopped: hue = RED; val = DIM; break;
    case RobotStatus::Error: hue = RED; val = blink_on ? FULL : 0; break;
    case RobotStatus::Manual:
      hue = PURPLE;
      val = since(out.last_jog_ms) < LED_FLASH_MS ? FULL : DIM;
      break;
  }

  // Overlays, most important last.
  bool low = !isnan(s.battery_pct) && s.battery_pct <= BATTERY_WARN_PCT &&
             status != RobotStatus::Charging && status != RobotStatus::Docking;
  if (low && now % LED_BATTERY_WARN_EVERY_MS < LED_FLASH_MS) {
    hue = AMBER; sat = 255; val = FULL;
  }
  // Blocked while it should be moving: explains why it isn't.
  bool moving = status == RobotStatus::EnRoute || status == RobotStatus::ReturningToDock ||
                status == RobotStatus::Manual;
  if (moving && (g_obstacle_front_flag || g_obstacle_rear_flag) && blink_on) {
    hue = ORANGE; sat = 255; val = FULL;
  }
  if (!g_mqtt_connected && now % LED_OFFLINE_EVERY_MS < 2 * LED_FLASH_MS) val = 0;
  // Two quick dim blips: a command arrived but was ignored (the log says why).
  uint32_t t = since(out.last_note_ms);
  if (t < 4 * LED_FLASH_MS) {
    sat = 0;
    val = (t / LED_FLASH_MS) % 2 == 0 ? DIM : 0;
  }
  if (since(unknown_tag_ms) < LED_FLASH_MS) { hue = RED; sat = 255; val = FULL; }
  if (since(known_tag_ms) < LED_FLASH_MS) { sat = 0; val = FULL; }

  static uint32_t shown = UINT32_MAX;
  uint32_t color = Adafruit_NeoPixel::gamma32(Adafruit_NeoPixel::ColorHSV(hue, sat, val));
  if (color == shown) return;
  led.setPixelColor(0, color);
  led.show();
  shown = color;
}

}  // namespace

void nav_task(void* /*param*/) {
  QueueOutput out;
  NavCore core(out);
  SensorData sensors = {};
  sensors.obstacle_front_cm = NAN;
  sensors.obstacle_rear_cm = NAN;
  sensors.battery_pct = NAN;
  uint32_t seen_tag_seq = 0;
  uint32_t known_tag_ms = 0;
  uint32_t unknown_tag_ms = 0;
  Adafruit_NeoPixel led(1, PIN_STATUS_LED, NEO_GRB + NEO_KHZ800);
  led.begin();
  led.setBrightness(STATUS_LED_BRIGHTNESS);

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
      if (node == NO_NODE) {
        LOG("nav", "tag %s isn't in the graph (topology.json)", d.tag_uid);
        unknown_tag_ms = now;
      } else {
        known_tag_ms = now;
      }
      core.on_tag(node, now);
    }

    Command cmd;
    while (xQueueReceive(g_command_queue, &cmd, 0) == pdTRUE) core.on_command(cmd, now);

    core.tick(now);
    bool ahead_blocked = core.reversing() ? g_obstacle_rear_flag : g_obstacle_front_flag;
    const char* fault = out.motion.check(now, ahead_blocked || g_motor_kill_flag);
    if (fault) core.fault(fault);

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

    show_status_led(led, core, out, sensors, known_tag_ms, unknown_tag_ms, now);
    vTaskDelay(pdMS_TO_TICKS(NAV_LOOP_MS));
  }
}
