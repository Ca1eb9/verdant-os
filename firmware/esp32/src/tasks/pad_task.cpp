// pad_task.cpp
// See pad_task.h.

#include "pad_task.h"

#include <Arduino.h>
#include <WiFi.h>
#include <XboxSeriesXControllerESP32_asukiaaa.hpp>

#include "../config.h"
#include "../log.h"
#include "../pad/pad_core.h"
#include "../types.h"

namespace {

// Bluetooth's Battery Service and its Battery Level characteristic.
const NimBLEUUID BATTERY_SERVICE((uint16_t)0x180f);
const NimBLEUUID BATTERY_LEVEL((uint16_t)0x2a19);

// True when the controller answered: the link is alive right now. Blocks
// until it answers, or (a dead controller) until the link is given up on.
bool probe_link() {
  NimBLEClient* client = XboxSeriesXControllerESP32_asukiaaa::pConnectedClient;
  if (!client || !client->isConnected()) return false;
  NimBLERemoteService* service = client->getService(BATTERY_SERVICE);
  NimBLERemoteCharacteristic* level = service ? service->getCharacteristic(BATTERY_LEVEL) : nullptr;
  return level && level->readValue().size() > 0;
}

// While looking, keeps one scan running so the library's onLoop() never
// starts its own. Each scan lasts PAD_SCAN_CHUNK_MS: a restart clears the
// scan's results, which otherwise grow with every device nearby. Never while
// the library holds a found controller (advDevice) it hasn't connected to
// yet: that points into those results.
void keep_scanning(XboxSeriesXControllerESP32_asukiaaa::Core& pad) {
  if (XboxSeriesXControllerESP32_asukiaaa::advDevice != nullptr) return;
  NimBLEScan* scan = NimBLEDevice::getScan();
  if (scan->isScanning()) return;
  scan->setDuplicateFilter(false);
  scan->setScanCallbacks(pad.scanCBs);
  scan->setInterval(PAD_SCAN_MS);
  scan->setWindow(PAD_SCAN_MS);
  scan->start(PAD_SCAN_CHUNK_MS);  // if it fails, tried again next cycle
}

// One short buzz of the centre motor: connected, for the operator at the robot.
void rumble(XboxSeriesXControllerESP32_asukiaaa::Core& pad) {
  XboxSeriesXHIDReportBuilder_asukiaaa::ReportBase report;
  report.v.select.center = true;
  report.v.select.left = false;
  report.v.select.right = false;
  report.v.select.shake = false;
  report.v.power.center = PAD_RUMBLE_PCT;
  report.v.timeActive = PAD_RUMBLE_MS / 10;
  report.v.timeSilent = 0;
  report.v.countRepeat = 0;
  pad.writeHIDReport(report);
}

// Stopping keeps the results, so a found controller can still be connected.
void stop_scanning() {
  NimBLEScan* scan = NimBLEDevice::getScan();
  if (scan->isScanning()) scan->stop();
}

// WiFi power saving has to be on before Bluetooth starts: the ESP32 won't
// run both with it off. This task is the only one that sets it.
void start_bluetooth(XboxSeriesXControllerESP32_asukiaaa::Core& pad) {
  WiFi.setSleep(true);
  pad.begin();
  LOG("pad", "Bluetooth on (WiFi power saving on)");
}

bool s_stop_failed_logged = false;  // a failed stop is retried every loop

// Only with no controller connected or found: that frees what the library
// points into. False if Bluetooth is still running.
bool stop_bluetooth() {
  stop_scanning();
  // The library hands each client its one callbacks object to delete with
  // the client; detach it first, or the next connection uses freed memory.
  for (NimBLEClient* client; (client = NimBLEDevice::getDisconnectedClient()) != nullptr;) {
    client->setClientCallbacks(nullptr);
    if (!NimBLEDevice::deleteClient(client)) break;
  }
  XboxSeriesXControllerESP32_asukiaaa::pConnectedClient = nullptr;
  if (!NimBLEDevice::deinit(true)) {
    if (!s_stop_failed_logged) LOG("pad", "Bluetooth didn't stop: WiFi power saving stays on (retrying quietly)");
    s_stop_failed_logged = true;
    return false;
  }
  s_stop_failed_logged = false;
  if (WIFI_POWER_SAVE == WifiPowerSave::Auto) WiFi.setSleep(false);
  LOG("pad", "Bluetooth off%s", WIFI_POWER_SAVE == WifiPowerSave::Auto ? " (WiFi power saving off)" : "");
  return true;
}

void send(CommandType type, int16_t speed = 0) {
  Command cmd = {};
  cmd.type = type;
  cmd.speed = speed;
  cmd.priority = TaskPriority::Critical;
  cmd.source = CommandSource::Controller;
  if (xQueueSend(g_command_queue, &cmd, 0) != pdTRUE) {
    LOG("pad", "command queue full, dropped an input");
  }
}

}  // namespace

void pad_task(void* /*param*/) {
  XboxSeriesXControllerESP32_asukiaaa::Core pad(PAD_ADDRESS);
  const bool bluetooth = WIFI_POWER_SAVE != WifiPowerSave::Off;
  // Auto: on until Bluetooth has run and stopped (it starts at boot, as the
  // broker isn't connected yet)
  WiFi.setSleep(bluetooth);
  if (!bluetooth) {
    LOG("pad", "WIFI_POWER_SAVE is Off: no Bluetooth, so no controller");
  } else if (PAD_ADDRESS[0]) {
    LOG("pad", "accepting only controller %s", PAD_ADDRESS);
  } else {
    LOG("pad", "accepting any Xbox controller: set PAD_ADDRESS in secrets.h");
  }

  PadCore core;
  bool connected = false;
  bool link_ok = false;
  uint32_t last_ok_ms = 0;
  PadAction last_logged = PadAction::None;
  uint32_t seen_requests = g_pad_connect_requests;
  bool window_open = false;
  uint32_t window_opened_ms = 0;
  bool looking = false;
  PadRadio radio;
  bool radio_on = false;

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(PAD_LOOP_MS));
    uint32_t loop_ms = millis();

    // connect_controller from the dashboard: look for PAD_CONNECT_WINDOW_MS.
    uint32_t requests = g_pad_connect_requests;
    if (requests != seen_requests) {
      seen_requests = requests;
      if (!bluetooth) {
        LOG("pad", "connect_controller: WIFI_POWER_SAVE is Off, so no Bluetooth");
      } else if (pad.isConnected()) {
        LOG("pad", "connect_controller: a controller is already connected");
      } else {
        window_open = true;
        window_opened_ms = loop_ms;
      }
    }
    if (window_open && (pad.isConnected() || loop_ms - window_opened_ms >= PAD_CONNECT_WINDOW_MS)) {
      window_open = false;
      if (!pad.isConnected()) LOG("pad", "connect_controller: no controller found");
    }

    // Only look while the robot is on its own (no broker: there's no
    // heartbeat to tell otherwise) or during a connect_controller window.
    bool look = bluetooth && !pad.isConnected() && (!g_mqtt_connected || window_open);
    if (look != looking) {
      looking = look;
      if (look) {
        LOG("pad", "looking for a controller (%s)", window_open ? "connect_controller" : "no broker");
      } else if (!pad.isConnected()) {
        LOG("pad", "stopped looking for a controller");
      }
    }
    // Bluetooth runs only while in use: off, WiFi answers without the delays
    // its power saving adds.
    bool in_use = look || pad.isConnected() || XboxSeriesXControllerESP32_asukiaaa::advDevice != nullptr;
    bool want_radio = radio.update(in_use, loop_ms);
    if (want_radio && !radio_on) {
      start_bluetooth(pad);
      radio_on = true;
    } else if (!want_radio && radio_on) {
      radio_on = !stop_bluetooth();  // tried again next loop
    }
    if (radio_on) {
      if (look) {
        keep_scanning(pad);
      } else {
        stop_scanning();
      }
      // onLoop() connects to a controller a scan found, but with none it
      // starts a scan of its own: only while looking, or to finish connecting.
      if (in_use) pad.onLoop();
    }

    bool ready = pad.isConnected() && !pad.isWaitingForFirstNotification();
    if (ready != connected) {
      connected = ready;
      link_ok = false;
      core.reset();
      g_pad_connected = connected;
      g_pad_link_changed_ms = millis();
      if (connected) {
        // The address to pin as PAD_ADDRESS. The library pins public
        // addresses only, so say when it's a random one.
        NimBLEClient* client = XboxSeriesXControllerESP32_asukiaaa::pConnectedClient;
        bool is_public = !client || client->getPeerAddress().getType() == BLE_ADDR_PUBLIC;
        LOG("pad", "controller connected (%s%s)", pad.buildDeviceAddressStr().c_str(),
            is_public ? "" : ", a random address: PAD_ADDRESS can't pin it");
        rumble(pad);
      } else {
        LOG("pad", "controller disconnected");
      }
    }
    if (!connected) continue;

    bool ok = probe_link();
    uint32_t now = millis();
    if (!ok || (link_ok && now - last_ok_ms >= PAD_LINK_LOST_MS)) {
      // No answer, or a slow one: whatever the stick last said is too old.
      if (link_ok) LOG("pad", "controller link lost");
      link_ok = false;
      core.reset();
      if (!ok) continue;
    }
    if (!link_ok) {
      link_ok = true;
      LOG("pad", "controller link ok");
    }
    last_ok_ms = now;

    // 0 = stick fully up, maxJoy = fully down.
    float stick = 1.0f - 2.0f * (float)pad.xboxNotif.joyLVert /
                             (float)XboxControllerNotificationParser::maxJoy;
    PadAction action = core.update(stick, pad.xboxNotif.btnB, pad.xboxNotif.btnA, now);
    switch (action) {
      case PadAction::None: break;
      case PadAction::Drive: send(CommandType::Drive, core.speed()); break;
      case PadAction::Stop: send(CommandType::Stop); break;
      case PadAction::Resume: send(CommandType::Resume); break;
    }
    // Drives repeat while held: log the first of a run only.
    if (action != PadAction::None && action != last_logged) {
      if (action == PadAction::Drive) {
        LOG("pad", "drive %s at %d", core.speed() < 0 ? "backward" : "forward", abs(core.speed()));
      } else {
        LOG("pad", "%s", action == PadAction::Stop ? "stop" : "resume");
      }
    }
    bool centred = stick <= PAD_DEADZONE && stick >= -PAD_DEADZONE;
    if (action != PadAction::None || centred) last_logged = action;
  }
}
