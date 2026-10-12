// pad_test_main.cpp
// Xbox controller diagnostic. Built by the `padtest` env; nothing else runs.
//
//   pio run -e padtest -t upload && pio device monitor -e padtest
//
// Checks that the controller pairs with the ESP32-S3 over Bluetooth LE and
// what its stick and buttons report, before any of it goes into the firmware.
// Put the controller in pairing mode (hold the pair button until the Xbox
// light flashes fast). It prints:
//   - connection changes, with the controller's address
//   - the left stick's drive direction, and A / B presses
//   - once a second while connected: the raw stick value, the battery, and
//     the longest gap between reports (how stale an input can get)
//   - when the reports stop: how long ago the last one came
//
// Link probe: the controller sends nothing while a stick is held still, and a
// dead controller takes about 3 s to show as disconnected. So a second task
// keeps reading the controller's battery level; each answer proves the link is
// alive. The status line shows the slowest answer ("probe max") and the time
// since the last one ("link age"); LINK LOST prints once that passes
// LINK_LOST_MS, which is when the robot would stop.

#include <Arduino.h>
#include <XboxSeriesXControllerESP32_asukiaaa.hpp>

// Fraction of full deflection the stick must pass to count as a direction.
static constexpr float DEADZONE = 0.5f;
static constexpr uint32_t STATUS_MS = 1000;
// No report for this long while "connected": say so.
static constexpr uint32_t SILENT_MS = 500;
static constexpr uint32_t PROBE_PERIOD_MS = 50;
// No answer from the controller for this long: treat it as gone.
static constexpr uint32_t LINK_LOST_MS = 400;

static volatile uint32_t s_probe_ok_ms = 0;      // millis() of the last answer
static volatile uint32_t s_probe_max_ms = 0;     // slowest answer since last printed
static volatile uint32_t s_probe_count = 0;

static XboxSeriesXControllerESP32_asukiaaa::Core s_pad;  // any Xbox controller

static const char* direction_name(int d) {
  return d > 0 ? "FORWARD" : d < 0 ? "BACKWARD" : "centre";
}

// Reads the battery level (Battery Service 0x180F, level 0x2A19) over and over.
static void probe_task(void*) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(PROBE_PERIOD_MS));
    NimBLEClient* client = XboxSeriesXControllerESP32_asukiaaa::pConnectedClient;
    if (!client || !client->isConnected()) continue;
    NimBLERemoteService* service = client->getService(NimBLEUUID((uint16_t)0x180f));
    NimBLERemoteCharacteristic* level =
        service ? service->getCharacteristic(NimBLEUUID((uint16_t)0x2a19)) : nullptr;
    if (!level) continue;
    uint32_t t0 = millis();
    // Blocks until the controller answers, or the link is declared dead.
    if (level->readValue().size() == 0) continue;
    uint32_t took = millis() - t0;
    if (took > s_probe_max_ms) s_probe_max_ms = took;
    s_probe_ok_ms = millis();
    s_probe_count = s_probe_count + 1;
  }
}

void setup() {
  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);
  for (uint32_t t0 = millis(); !Serial && millis() - t0 < 3000;) delay(10);
#endif
  Serial.println("=== Xbox controller test ===");
  Serial.println("Hold the controller's pair button until the light flashes fast.");
  s_pad.begin();
  xTaskCreatePinnedToCore(probe_task, "probe", 4096, nullptr, 1, nullptr, 1);
}

void loop() {
  static bool connected = false;
  static int direction = 0;
  static bool a = false, b = false;
  static unsigned long last_report_at = 0;
  static uint32_t max_gap_ms = 0, last_status_ms = 0, reports = 0;
  static bool silent = false;
  static bool link_lost = false;

  s_pad.onLoop();
  uint32_t now = millis();
  bool ready = s_pad.isConnected() && !s_pad.isWaitingForFirstNotification();

  if (ready != connected) {
    connected = ready;
    if (connected) {
      Serial.printf("[%7lu] CONNECTED %s\n", (unsigned long)now,
                    s_pad.buildDeviceAddressStr().c_str());
      last_report_at = s_pad.getReceiveNotificationAt();
      max_gap_ms = 0;
      s_probe_ok_ms = now;
      link_lost = false;
    } else {
      Serial.printf("[%7lu] DISCONNECTED (last report %lu ms ago)\n", (unsigned long)now,
                    (unsigned long)(now - last_report_at));
      direction = 0;
    }
  }

  if (!connected) {
    if (now - last_status_ms >= STATUS_MS) {
      last_status_ms = now;
      Serial.printf("[%7lu] searching... (failed connections: %u)\n", (unsigned long)now,
                    s_pad.getCountFailedConnection());
    }
    // The library's own advice: its scan can wedge after repeated failures.
    if (s_pad.getCountFailedConnection() > 2) ESP.restart();
    delay(10);
    return;
  }

  unsigned long at = s_pad.getReceiveNotificationAt();
  if (at != last_report_at) {
    uint32_t gap = at - last_report_at;
    if (gap > max_gap_ms) max_gap_ms = gap;
    last_report_at = at;
    reports++;
    silent = false;
  } else if (!silent && now - last_report_at >= SILENT_MS) {
    // The controller only reports changes, so this is normal when untouched.
    silent = true;
  }

  uint32_t link_age = now - s_probe_ok_ms;
  if (link_age >= LINK_LOST_MS && !link_lost) {
    link_lost = true;
    Serial.printf("[%7lu] LINK LOST: no answer for %lu ms (the robot would stop here)\n",
                  (unsigned long)now, (unsigned long)link_age);
  } else if (link_age < LINK_LOST_MS && link_lost) {
    link_lost = false;
    Serial.printf("[%7lu] link back\n", (unsigned long)now);
  }

  // 0 = stick fully up, maxJoy = fully down.
  float pos = (float)s_pad.xboxNotif.joyLVert / XboxControllerNotificationParser::maxJoy;
  float y = 1.0f - 2.0f * pos;  // +1 up, -1 down
  int d = y > DEADZONE ? 1 : y < -DEADZONE ? -1 : 0;
  if (d != direction) {
    direction = d;
    Serial.printf("[%7lu] stick %s (%.2f)\n", (unsigned long)now, direction_name(d), y);
  }
  if (s_pad.xboxNotif.btnA != a) {
    a = s_pad.xboxNotif.btnA;
    if (a) Serial.printf("[%7lu] A pressed (resume)\n", (unsigned long)now);
  }
  if (s_pad.xboxNotif.btnB != b) {
    b = s_pad.xboxNotif.btnB;
    if (b) Serial.printf("[%7lu] B pressed (stop)\n", (unsigned long)now);
  }

  if (now - last_status_ms >= STATUS_MS) {
    last_status_ms = now;
    Serial.printf("[%7lu] stick %.2f  reports %lu  last %lu ms ago  |  probes %lu  probe max %lu ms  link age %lu ms\n",
                  (unsigned long)now, y, (unsigned long)reports,
                  (unsigned long)(now - last_report_at), (unsigned long)s_probe_count,
                  (unsigned long)s_probe_max_ms, (unsigned long)link_age);
    s_probe_count = 0;
    s_probe_max_ms = 0;
    reports = 0;
    max_gap_ms = 0;
  }
  delay(5);
}
