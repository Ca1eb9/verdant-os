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

void send(CommandType type, JogDirection direction) {
  Command cmd = {};
  cmd.type = type;
  cmd.direction = direction;
  cmd.priority = TaskPriority::Critical;
  cmd.source = CommandSource::Local;
  if (xQueueSend(g_command_queue, &cmd, 0) != pdTRUE) {
    LOG("pad", "command queue full, dropped an input");
  }
}

}  // namespace

void pad_task(void* /*param*/) {
  XboxSeriesXControllerESP32_asukiaaa::Core pad;  // any Xbox controller in pairing mode
  pad.begin();
  LOG("pad", "looking for a controller");

  PadCore core;
  bool connected = false;
  bool link_ok = false;
  uint32_t last_ok_ms = 0;
  PadAction last_logged = PadAction::None;

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(PAD_LOOP_MS));
    pad.onLoop();

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
