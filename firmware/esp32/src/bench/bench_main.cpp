// bench_main.cpp
// Sprint 1 test build for the comms + sensor tasks. Built only by the
// `bench` PlatformIO env (`pio run -e bench -t upload`); main.cpp is left out.
//
// Runs the real sensor_task and comms_task, plus a stand-in for the nav
// task that:
//   - turns SensorData into a TelemetryMsg once a second
//   - publishes an "arrived" event for each new RFID tag
//   - publishes "obstacle_detected" when the obstacle flag goes up
//   - prints every command that arrives from the Pi
//
// Serial monitor commands (115200 baud, newline line ending):
//   tag 0x2A01      pretend that tag was just read (no RFID reader needed)
//   status          print link state, heartbeat age, stack headroom
//
// Watch it on the Pi / laptop with:
//   mosquitto_sub -h <broker> -t 'farm/robot/#' -v

#include <Arduino.h>
#include <math.h>

#include "../comms/comms_json.h"
#include "../config.h"
#include "../log.h"
#include "../tasks/comms_task.h"
#include "../tasks/sensor_task.h"
#include "../types.h"

static TaskHandle_t s_sensor_handle = nullptr;
static TaskHandle_t s_comms_handle = nullptr;
static TaskHandle_t s_nav_handle = nullptr;

static void send_event(RobotEventType type, const char* node, const char* details) {
  RobotEventMsg ev = {};
  ev.uptime_ms = millis();
  ev.event = type;
  if (node) strncpy(ev.node_id, node, sizeof(ev.node_id) - 1);
  if (details) strncpy(ev.details, details, sizeof(ev.details) - 1);
  if (xQueueSend(g_event_queue, &ev, 0) != pdTRUE) LOG("bench", "event queue full");
}

static void print_command(const Command& c) {
  LOG("bench", "CMD %s task='%s' target='%s' action=%s dur=%s%lu prio=%s src=%s",
      to_wire(c.type), c.task_id, c.target_node,
      c.action_at_target == TargetAction::None ? "-" : to_wire(c.action_at_target),
      c.has_duration ? "" : "-", c.has_duration ? (unsigned long)c.duration_ms : 0UL,
      to_wire(c.priority), to_wire(c.source));
  for (uint8_t i = 0; i < c.path_len; i++) LOG("bench", "    path[%u] = %s", i, c.path[i]);
}

static void print_status() {
  uint32_t hb = g_last_pi_msg_ms;
  LOG("bench", "mqtt=%s  last Pi msg=%s%lu ms ago  obstacle=%d",
      g_mqtt_connected ? "up" : "down", hb ? "" : "never/", hb ? (unsigned long)(millis() - hb) : 0UL,
      (int)g_obstacle_flag);
  LOG("bench", "stack free (bytes): sensor=%u comms=%u nav=%u",
      (unsigned)uxTaskGetStackHighWaterMark(s_sensor_handle),
      (unsigned)uxTaskGetStackHighWaterMark(s_comms_handle),
      (unsigned)uxTaskGetStackHighWaterMark(s_nav_handle));
}

// Reads one line from Serial without blocking.
static bool read_serial_line(char* buf, size_t cap, size_t& len) {
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      buf[len] = '\0';
      len = 0;
      return true;
    }
    if (len + 1 < cap) buf[len++] = ch;
  }
  return false;
}

static void bench_nav_task(void*) {
  SensorData latest = {};
  latest.obstacle_cm = NAN;
  latest.battery_pct = NAN;
  char current_node[TAG_ID_LEN] = "";
  uint32_t seen_seq = 0;
  bool obstacle_was = false;
  uint32_t last_telemetry = 0;
  char line[64];
  size_t line_len = 0;

  for (;;) {
    // Sensor data (wait up to 50 ms so this loop also services Serial).
    SensorData d;
    while (xQueueReceive(g_sensor_queue, &d, pdMS_TO_TICKS(50)) == pdTRUE) {
      latest = d;
      if (d.tag_seq != seen_seq) {
        seen_seq = d.tag_seq;
        strncpy(current_node, d.tag_uid, sizeof(current_node));
        send_event(RobotEventType::Arrived, current_node, "bench: RFID read");
      }
      if (uxQueueMessagesWaiting(g_sensor_queue) == 0) break;
    }

    // Obstacle rising edge -> event.
    bool obstacle = g_obstacle_flag;
    if (obstacle && !obstacle_was) {
      char details[32];
      if (isnan(latest.obstacle_cm)) snprintf(details, sizeof(details), "sensor fault");
      else snprintf(details, sizeof(details), "%.1f cm", latest.obstacle_cm);
      send_event(RobotEventType::ObstacleDetected, current_node, details);
    }
    obstacle_was = obstacle;

    // Commands from the Pi.
    Command cmd;
    while (xQueueReceive(g_command_queue, &cmd, 0) == pdTRUE) print_command(cmd);

    // Serial test commands.
    if (read_serial_line(line, sizeof(line), line_len)) {
      if (strncmp(line, "tag ", 4) == 0) {
        char tag[TAG_ID_LEN];
        if (canonical_tag_id(line + 4, tag, sizeof(tag))) {
          strncpy(current_node, tag, sizeof(current_node));
          LOG("bench", "fake tag %s", tag);
          send_event(RobotEventType::Arrived, current_node, "bench: fake tag");
        }
      } else if (strcmp(line, "status") == 0) {
        print_status();
      } else if (line[0]) {
        LOG("bench", "commands: 'tag 0x2A01', 'status'");
      }
    }

    // Telemetry at 1 Hz, same rate as the simulator.
    uint32_t now = millis();
    if (now - last_telemetry >= 1000) {
      last_telemetry = now;
      TelemetryMsg t = {};
      t.uptime_ms = now;
      t.status = RobotStatus::Idle;
      strncpy(t.current_node, current_node, sizeof(t.current_node));
      t.battery_pct = isnan(latest.battery_pct) ? 0.0f : latest.battery_pct;
      t.heading = Heading::East;
      t.obstacle_cm = latest.obstacle_cm;
      t.temperature_c = NAN;  // no environment sensors on the robot
      t.humidity_pct = NAN;
      t.light_lux = NAN;
      if (xQueueSend(g_telemetry_queue, &t, 0) != pdTRUE) {
        // comms is offline and hasn't drained yet; fine to skip
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);  // let the USB serial settle; setup() only, before any tasks
  LOG("bench", "=== comms + sensor bench, robot '%s' ===", ROBOT_ID);

  if (!create_queues()) {
    LOG("bench", "queue allocation failed");
    for (;;) vTaskDelay(portMAX_DELAY);
  }

  xTaskCreatePinnedToCore(sensor_task, "sensor", STACK_SENSOR, nullptr, PRIO_SENSOR,
                          &s_sensor_handle, CORE_REALTIME);
  xTaskCreatePinnedToCore(bench_nav_task, "nav", 4096, nullptr, PRIO_NAV, &s_nav_handle,
                          CORE_REALTIME);
  xTaskCreatePinnedToCore(comms_task, "comms", STACK_COMMS, nullptr, PRIO_COMMS,
                          &s_comms_handle, CORE_NETWORK);
}

void loop() { vTaskDelete(nullptr); }  // all work happens in tasks
