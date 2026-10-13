// pad_task.cpp
// See pad_task.h.

#include "pad_task.h"

#include <Arduino.h>
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

// Stopping keeps the results, so a found controller can still be connected.
void stop_scanning() {
  NimBLEScan* scan = NimBLEDevice::getScan();
  if (scan->isScanning()) scan->stop();
}

void send(CommandType type, JogDirection direction) {
  Command cmd = {};
  cmd.type = type;
  cmd.direction = direction;
  cmd.priority = TaskPriority::Critical;
  cmd.source = CommandSource::Controller;
  if (xQueueSend(g_command_queue, &cmd, 0) != pdTRUE) {
    LOG("pad", "command queue full, dropped an input");
  }
}

}  // namespace

void pad_task(void* /*param*/) {
  XboxSeriesXControllerESP32_asukiaaa::Core pad(PAD_ADDRESS);
  pad.begin();
  if (PAD_ADDRESS[0]) {
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

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(PAD_LOOP_MS));
    uint32_t loop_ms = millis();

    // connect_controller from the dashboard: look for PAD_CONNECT_WINDOW_MS.
    uint32_t requests = g_pad_connect_requests;
    if (requests != seen_requests) {
      seen_requests = requests;
      if (pad.isConnected()) {
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
    bool look = !pad.isConnected() && (!g_mqtt_connected || window_open);
    if (look != looking) {
      looking = look;
      if (look) {
        LOG("pad", "looking for a controller (%s)", window_open ? "connect_controller" : "no broker");
      } else if (!pad.isConnected()) {
        LOG("pad", "stopped looking for a controller");
      }
    }
    if (look) {
      keep_scanning(pad);
    } else {
      stop_scanning();
    }
    // onLoop() connects to a controller a scan found, but with none it starts
    // a scan of its own: only while looking, or to finish connecting.
    if (pad.isConnected() || look || XboxSeriesXControllerESP32_asukiaaa::advDevice != nullptr) {
      pad.onLoop();
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
      case PadAction::JogForward: send(CommandType::Jog, JogDirection::Forward); break;
      case PadAction::JogBackward: send(CommandType::Jog, JogDirection::Backward); break;
      case PadAction::Stop: send(CommandType::Stop, JogDirection::None); break;
      case PadAction::Resume: send(CommandType::Resume, JogDirection::None); break;
    }
    // Jogs repeat while held: log the first of a run only.
    if (action != PadAction::None && action != last_logged) {
      static const char* const names[] = {"", "jog forward", "jog backward", "stop", "resume"};
      LOG("pad", "%s", names[(int)action]);
    }
    bool centred = stick <= PAD_DEADZONE && stick >= -PAD_DEADZONE;
    if (action != PadAction::None || centred) last_logged = action;
  }
}
