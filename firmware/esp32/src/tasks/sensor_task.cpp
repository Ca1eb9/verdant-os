// sensor_task.cpp
// See sensor_task.h.

#include "sensor_task.h"

#include <Arduino.h>
#include <math.h>
#include <string.h>

#include "../config.h"
#include "../drivers/battery.h"
#include "../drivers/rfid_reader.h"
#include "../drivers/tof_sensor.h"
#include "../log.h"
#include "../types.h"

namespace {

RfidReader s_rfid;
TofSensor s_tof;
Battery s_battery;

// ---- RFID state --------------------------------------------------------------

struct TagState {
  char uid[TAG_ID_LEN] = "";
  bool in_field = false;
  uint32_t last_seen_ms = 0;
  uint32_t seq = 0;
  uint32_t last_reinit_ms = 0;
};
TagState s_tag;

void update_rfid(uint32_t now) {
  if (!s_rfid.ok()) {
    if (now - s_tag.last_reinit_ms >= RFID_REINIT_MS) {
      s_tag.last_reinit_ms = now;
      s_rfid.begin();
    }
    return;
  }

  char uid[TAG_ID_LEN];
  if (s_rfid.poll(uid, sizeof(uid))) {
    // New arrival: a different tag, or the same tag after it left the field
    // (e.g. the robot drove away and came back).
    if (!s_tag.in_field || strcmp(uid, s_tag.uid) != 0) {
      strncpy(s_tag.uid, uid, sizeof(s_tag.uid));
      s_tag.seq++;
      LOG("sensor", "tag %s (seq %lu)", s_tag.uid, (unsigned long)s_tag.seq);
    }
    s_tag.in_field = true;
    s_tag.last_seen_ms = now;
  } else if (s_tag.in_field && now - s_tag.last_seen_ms >= RFID_TAG_GONE_MS) {
    s_tag.in_field = false;
  }
}

// ---- Obstacle state ----------------------------------------------------------
// Sets the flag on the FIRST close reading. Clears it only after
// OBSTACLE_CLEAR_COUNT readings beyond OBSTACLE_CLEAR_CM, so the robot
// doesn't stutter at the threshold.

struct ObstacleState {
  float cm = NAN;
  uint8_t clear_count = 0;
  uint32_t last_data_ms = 0;
  uint32_t last_reinit_ms = 0;
  bool fault_logged = false;
};
ObstacleState s_obs;

void set_obstacle_flag(bool on, const char* why) {
  if (g_obstacle_flag == on) return;
  g_obstacle_flag = on;
  LOG("sensor", "obstacle flag %s (%s)", on ? "SET" : "cleared", why);
}

void update_obstacle(uint32_t now) {
  float cm = NAN;
  TofReading r = s_tof.poll(&cm);

  switch (r) {
    case TofReading::Pending:
      break;
    case TofReading::Target:
    case TofReading::Clear:
      s_obs.last_data_ms = now;
      s_obs.fault_logged = false;
      s_obs.cm = (r == TofReading::Target) ? cm : NAN;
      if (r == TofReading::Target && cm < OBSTACLE_STOP_CM) {
        s_obs.clear_count = 0;
        set_obstacle_flag(true, "target in range");
      } else if (r == TofReading::Clear || cm > OBSTACLE_CLEAR_CM) {
        if (s_obs.clear_count < OBSTACLE_CLEAR_COUNT) s_obs.clear_count++;
        if (s_obs.clear_count >= OBSTACLE_CLEAR_COUNT) set_obstacle_flag(false, "path clear");
      }
      // Between STOP and CLEAR: hold the current flag state.
      break;
    case TofReading::Error:
      break;
  }

  // Fault: sensor dead or silent. Optionally fail safe (hold motors).
  bool faulted = !s_tof.ok() || (now - s_obs.last_data_ms >= TOF_TIMEOUT_MS);
  if (faulted) {
    s_obs.cm = NAN;
    s_obs.clear_count = 0;
    if (!s_obs.fault_logged) {
      LOG("sensor", "ToF sensor fault%s", OBSTACLE_FAILSAFE ? " - holding obstacle flag" : "");
      s_obs.fault_logged = true;
    }
    if (OBSTACLE_FAILSAFE) set_obstacle_flag(true, "sensor fault");
    if (now - s_obs.last_reinit_ms >= TOF_REINIT_MS) {
      s_obs.last_reinit_ms = now;
      if (s_tof.begin()) s_obs.last_data_ms = now;  // give it a fresh timeout
    }
  }
}

// ---- Output --------------------------------------------------------------------

// Newest data matters most: if nav falls behind and the queue is full, drop
// the OLDEST entry. tag_seq means nav still spots a tag it missed.
void push_sensor_data(const SensorData& d) {
  if (xQueueSend(g_sensor_queue, &d, 0) == pdTRUE) return;
  SensorData stale;
  xQueueReceive(g_sensor_queue, &stale, 0);
  xQueueSend(g_sensor_queue, &d, 0);
}

}  // namespace

void sensor_task(void* /*param*/) {
  s_rfid.begin();
  s_tof.begin();
  s_battery.begin();
  s_battery.sample();  // have a value before the first report

  uint32_t start = millis();
  s_obs.last_data_ms = start;
  s_tag.last_reinit_ms = start;
  s_obs.last_reinit_ms = start;

  uint32_t last_report_ms = 0;
  uint32_t last_battery_ms = start;
  uint32_t last_reported_seq = 0;
  TickType_t wake = xTaskGetTickCount();

  for (;;) {
    uint32_t now = millis();

    update_obstacle(now);  // safety first: flag is set before anything else runs
    update_rfid(now);
    if (now - last_battery_ms >= BATTERY_PERIOD_MS) {
      last_battery_ms = now;
      s_battery.sample();
    }

    bool new_tag = s_tag.seq != last_reported_seq;
    if (new_tag || now - last_report_ms >= SENSOR_REPORT_MS) {
      SensorData d = {};
      d.uptime_ms = now;
      d.rfid_ok = s_rfid.ok();
      d.tag_in_field = s_tag.in_field;
      d.tag_seq = s_tag.seq;
      strncpy(d.tag_uid, s_tag.uid, sizeof(d.tag_uid));
      d.tof_ok = s_tof.ok();
      d.obstacle_cm = s_obs.cm;
      d.obstacle_stop = g_obstacle_flag;
      d.battery_v = s_battery.volts();
      d.battery_pct = s_battery.pct();
      push_sensor_data(d);
      last_report_ms = now;
      last_reported_seq = s_tag.seq;
    }

    vTaskDelayUntil(&wake, pdMS_TO_TICKS(SENSOR_PERIOD_MS));
  }
}
