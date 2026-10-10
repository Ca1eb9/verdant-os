// sensor_task.cpp
// See sensor_task.h.

#include "sensor_task.h"

#include <Arduino.h>
#include <math.h>
#include <string.h>

#include "../config.h"
#include "../drivers/battery.h"
#include "../drivers/env_sensor.h"
#include "../drivers/rfid_reader.h"
#include "../drivers/tof_sensor.h"
#include "../log.h"
#include "../types.h"

namespace {

RfidReader s_rfid;
TofSensor s_tof_front("front", Wire, PIN_I2C_FRONT_SDA, PIN_I2C_FRONT_SCL, PIN_TOF_FRONT_XSHUT);
TofSensor s_tof_rear("rear", Wire1, PIN_I2C_REAR_SDA, PIN_I2C_REAR_SCL, PIN_TOF_REAR_XSHUT);
Battery s_battery;
EnvSensor s_env(Wire);  // after s_tof_front, which starts Wire

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
// One per sensor. Sets that side's flag on the FIRST reading under its stop
// distance (OBSTACLE_STOP_CM, or lower while nav approaches the elevator or
// dock). Clears it only after OBSTACLE_CLEAR_COUNT readings beyond the clear
// distance, so the robot doesn't stutter at the threshold. When nav changes
// the stop distance, the next reading is judged against it straight away:
// otherwise a robot stopped a few cm from the elevator wall would hold its
// flag and never creep the rest of the way in.

struct ObstacleState {
  TofSensor* tof;
  volatile bool* flag;
  volatile float* stop_cm;
  float judged_stop_cm = OBSTACLE_STOP_CM;  // the stop distance last applied
  float cm = NAN;
  uint8_t clear_count = 0;
  uint32_t last_data_ms = 0;
  uint32_t last_reinit_ms = 0;
  bool fault_logged = false;

  // Needed because the toolchain builds as C++11, where default member
  // initializers stop this struct being brace-initializable as an aggregate.
  ObstacleState(TofSensor* t, volatile bool* f, volatile float* s)
      : tof(t), flag(f), stop_cm(s) {}
};
ObstacleState s_front{&s_tof_front, &g_obstacle_front_flag, &g_obstacle_front_stop_cm};
ObstacleState s_rear{&s_tof_rear, &g_obstacle_rear_flag, &g_obstacle_rear_stop_cm};

void set_obstacle_flag(ObstacleState& obs, bool on, const char* why) {
  if (*obs.flag == on) return;
  *obs.flag = on;
  LOG("sensor", "%s obstacle flag %s (%s)", obs.tof->name(), on ? "SET" : "cleared", why);
}

void update_obstacle(ObstacleState& obs, uint32_t now) {
  float cm = NAN;
  TofReading r = obs.tof->poll(&cm);

  switch (r) {
    case TofReading::Pending:
      break;
    case TofReading::Target:
    case TofReading::Clear: {
      obs.last_data_ms = now;
      obs.fault_logged = false;
      obs.cm = (r == TofReading::Target) ? cm : NAN;
      float stop_cm = *obs.stop_cm;
      bool rejudge = stop_cm != obs.judged_stop_cm;
      obs.judged_stop_cm = stop_cm;
      if (r == TofReading::Target && cm < stop_cm) {
        obs.clear_count = 0;
        set_obstacle_flag(obs, true, "target in range");
      } else if (rejudge) {
        obs.clear_count = OBSTACLE_CLEAR_COUNT;
        set_obstacle_flag(obs, false, "stop distance changed");
      } else if (r == TofReading::Clear ||
                 cm > stop_cm + (OBSTACLE_CLEAR_CM - OBSTACLE_STOP_CM)) {
        if (obs.clear_count < OBSTACLE_CLEAR_COUNT) obs.clear_count++;
        if (obs.clear_count >= OBSTACLE_CLEAR_COUNT) set_obstacle_flag(obs, false, "path clear");
      }
      // Between stop and clear: hold the current flag state.
      break;
    }
    case TofReading::Error:
      break;
  }

  // Fault: sensor dead or silent. Optionally fail safe (hold motors).
  bool faulted = !obs.tof->ok() || (now - obs.last_data_ms >= TOF_TIMEOUT_MS);
  if (faulted) {
    obs.cm = NAN;
    obs.clear_count = 0;
    if (!obs.fault_logged) {
      LOG("sensor", "%s ToF sensor fault%s", obs.tof->name(),
          OBSTACLE_FAILSAFE ? " - holding its obstacle flag" : "");
      obs.fault_logged = true;
    }
    if (OBSTACLE_FAILSAFE) set_obstacle_flag(obs, true, "sensor fault");
    if (now - obs.last_reinit_ms >= TOF_REINIT_MS) {
      obs.last_reinit_ms = now;
      if (obs.tof->begin()) obs.last_data_ms = now;  // give it a fresh timeout
    }
  }
}

// ---- Air temperature + humidity ------------------------------------------------
// Not used for any decision on the robot: it only goes out in telemetry.

struct EnvState {
  float temperature_c = NAN;
  float humidity_pct = NAN;
  uint32_t last_data_ms = 0;
  uint32_t last_reinit_ms = 0;
};
EnvState s_air;

void update_env(uint32_t now) {
  if (!s_env.ok()) {
    if (now - s_air.last_reinit_ms >= ENV_REINIT_MS) {
      s_air.last_reinit_ms = now;
      s_env.begin();
    }
  } else if (s_env.poll(now, &s_air.temperature_c, &s_air.humidity_pct)) {
    s_air.last_data_ms = now;
  }
  if (now - s_air.last_data_ms >= ENV_STALE_MS) {
    s_air.temperature_c = NAN;
    s_air.humidity_pct = NAN;
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
  s_tof_front.begin();
  s_tof_rear.begin();
  s_env.begin();
  s_battery.begin();
  s_battery.sample();  // have a value before the first report

  uint32_t start = millis();
  for (ObstacleState* s : {&s_front, &s_rear}) {
    s->last_data_ms = start;
    s->last_reinit_ms = start;
  }
  s_tag.last_reinit_ms = start;
  s_air.last_data_ms = start - ENV_STALE_MS;  // no reading yet
  s_air.last_reinit_ms = start;

  uint32_t last_report_ms = 0;
  uint32_t last_battery_ms = start;
  uint32_t last_reported_seq = 0;
  TickType_t wake = xTaskGetTickCount();

  for (;;) {
    uint32_t now = millis();

    // safety first: flags are set before anything else runs
    update_obstacle(s_front, now);
    update_obstacle(s_rear, now);
    update_rfid(now);
    update_env(now);
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
      d.tof_front_ok = s_tof_front.ok();
      d.obstacle_front_cm = s_front.cm;
      d.obstacle_front_stop = g_obstacle_front_flag;
      d.tof_rear_ok = s_tof_rear.ok();
      d.obstacle_rear_cm = s_rear.cm;
      d.obstacle_rear_stop = g_obstacle_rear_flag;
      d.battery_v = s_battery.volts();
      d.battery_pct = s_battery.pct();
      d.temperature_c = s_air.temperature_c;
      d.humidity_pct = s_air.humidity_pct;
      push_sensor_data(d);
      last_report_ms = now;
      last_reported_seq = s_tag.seq;
    }

    vTaskDelayUntil(&wake, pdMS_TO_TICKS(SENSOR_PERIOD_MS));
  }
}
