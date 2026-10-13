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

// The library starts a full-time 4 s scan whenever onLoop() runs without a
// controller. This keeps one running instead, so onLoop() never starts its
// own: flat out while the Pi is unreachable, otherwise a short window each
// interval. Restarted when that changes; stopped once connected.
//
// Each scan lasts PAD_SCAN_CHUNK_MS: a restart clears the scan's results,
// which otherwise grow with every device nearby. Never while the library
// holds a found controller (advDevice) it hasn't connected to yet: that
// points into those results.
void keep_scanning(XboxSeriesXControllerESP32_asukiaaa::Core& pad, bool full, bool& scan_full) {
  if (XboxSeriesXControllerESP32_asukiaaa::advDevice != nullptr) return;
  NimBLEScan* scan = NimBLEDevice::getScan();
  if (scan->isScanning() && full == scan_full) return;
  scan->setDuplicateFilter(false);
  scan->setScanCallbacks(pad.scanCBs);
  scan->setInterval(full ? PAD_SCAN_FULL_MS : PAD_SCAN_IDLE_INTERVAL_MS);
  scan->setWindow(full ? PAD_SCAN_FULL_MS : PAD_SCAN_IDLE_WINDOW_MS);
  if (!scan->start(PAD_SCAN_CHUNK_MS)) return;  // tried again next cycle
  scan_full = full;
  static int8_t logged = -1;  // one task calls this
  if (logged == (int8_t)full) return;
  logged = (int8_t)full;
  LOG("pad", "looking for a controller (%s)", full ? "flat out: no broker" : "low duty");
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
  bool scan_full = false;

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(PAD_LOOP_MS));
    if (!pad.isConnected()) {
      // TODO: also flat out after a "find controller" command from the
      // dashboard (docs/firmware-architecture.md, TBD).
      keep_scanning(pad, !g_mqtt_connected, scan_full);
    } else if (NimBLEDevice::getScan()->isScanning()) {
      NimBLEDevice::getScan()->stop();
    }
    pad.onLoop();  // connects to a controller the scan found

    bool ready = pad.isConnected() && !pad.isWaitingForFirstNotification();
    if (ready != connected) {
      connected = ready;
      link_ok = false;
      core.reset();
      if (connected) {
        LOG("pad", "controller connected (%s)", pad.buildDeviceAddressStr().c_str());
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
