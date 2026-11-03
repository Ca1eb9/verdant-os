// comms_task.cpp
// See comms_task.h for what flows where.

#include "comms_task.h"

#include <Arduino.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <math.h>

#include "../comms/comms_json.h"
#include "../config.h"
#include "../log.h"
#include "../types.h"

namespace {

WiFiClient s_net;
PubSubClient s_mqtt(s_net);

char s_topic_telemetry[64];
char s_topic_events[64];
char s_topic_command[64];
char s_client_id[40];

// Scratch buffer for outgoing JSON; only this task touches it.
char s_json[1024];

// ---- Inbound -----------------------------------------------------------------

void on_message(char* topic, uint8_t* payload, unsigned int len) {
  if (strcmp(topic, s_topic_command) != 0) return;
  g_last_command_ms = millis();

  Command cmd;
  CommandParseResult r = parse_command_json((const char*)payload, len, cmd);
  if (r != CommandParseResult::Ok) {
    LOG("comms", "rejected command (%s): %.*s", to_string(r), (int)min(len, 200u), payload);
    return;
  }
  if (cmd.type == CommandType::ConnectController) {
    // The pad task's, in any status (initializing too): nav has no part in it.
    g_pad_connect_requests = g_pad_connect_requests + 1;  // only comms writes it
    LOG("comms", "command connect_controller -> pad");
    return;
  }
  if (xQueueSend(g_command_queue, &cmd, 0) != pdTRUE) {
    LOG("comms", "command queue full, dropped '%s'", to_wire(cmd.type));
    return;
  }
  LOG("comms", "command %s -> nav (%u waypoints, task '%s')", to_wire(cmd.type),
      cmd.path_len, cmd.task_id);
}

// ---- Connection management -------------------------------------------------

enum class Link { WifiDown, MqttDown, Up };

volatile int s_wifi_fail_reason = 0;  // set by the disconnect event
bool s_wifi_was_up = false;
uint32_t s_last_mqtt_try = 0;
uint32_t s_mqtt_backoff = MQTT_RETRY_MIN_MS;
bool s_mqtt_ever_tried = false;

// Getting onto the network: a scan for it, then (found) Bluetooth gives up
// the radio, then the join. A scan shares the radio fine, so a connected
// controller is only dropped once there's a network to join.
enum class WifiStep { Idle, Scanning, FreeingRadio, Joining };
WifiStep s_wifi_step = WifiStep::Idle;
bool s_wifi_tried = false;
uint32_t s_wifi_tried_ms = 0;  // the last scan's start
uint32_t s_wifi_step_ms = 0;
bool s_not_found_logged = false;
int32_t s_ap_channel = 0;
uint8_t s_ap_bssid[6];
int32_t s_ap_rssi = 0;
uint8_t s_join_fails = 0;       // failed joins in a row
uint32_t s_last_join_ms = 0;
bool s_backoff_logged = false;

void start_scan(uint32_t now) {
  if (s_wifi_fail_reason) {  // how the last link ended
    int r = s_wifi_fail_reason;
    LOG("comms", "WiFi disconnected: reason %d (%s)", r, WiFi.disconnectReasonName((wifi_err_reason_t)r));
    s_wifi_fail_reason = 0;
  }
  WiFi.disconnect();
  s_wifi_tried = true;
  s_wifi_tried_ms = now;
  // Async; only WIFI_SSID, which also finds it hidden
  if (WiFi.scanNetworks(true, false, false, WIFI_SCAN_CHANNEL_MS, 0, WIFI_SSID) == WIFI_SCAN_FAILED) {
    LOG("comms", "WiFi scan didn't start, retry in %lu ms", (unsigned long)WIFI_RETRY_MS);
    return;
  }
  s_wifi_step = WifiStep::Scanning;
}

// True when the scan found WIFI_SSID: its strongest access point is kept.
bool scan_found() {
  int n = WiFi.scanComplete();
  bool found = false;
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) != WIFI_SSID || (found && WiFi.RSSI(i) <= s_ap_rssi)) continue;
    found = true;
    s_ap_rssi = WiFi.RSSI(i);
    s_ap_channel = WiFi.channel(i);
    memcpy(s_ap_bssid, WiFi.BSSID(i), sizeof(s_ap_bssid));
  }
  WiFi.scanDelete();
  return found;
}

// `failed`: the join was refused or timed out. Stops the driver's own retries,
// which would otherwise contend with Bluetooth once it restarts.
void end_join(uint32_t now, bool failed) {
  if (failed) {
    WiFi.disconnect();
    if (s_join_fails < 255) s_join_fails++;
  } else {
    s_join_fails = 0;
    s_backoff_logged = false;
  }
  // The next scan waits WIFI_RETRY_MS from here, so Bluetooth gets that long
  // to find the controller again
  if (s_wifi_step != WifiStep::Idle || g_wifi_joining) s_wifi_tried_ms = now;
  s_wifi_fail_reason = 0;
  s_wifi_step = WifiStep::Idle;
  g_wifi_joining = false;
}

// One step of getting onto the network, while WiFi is down.
void service_wifi(uint32_t now) {
  switch (s_wifi_step) {
    case WifiStep::Idle:
      if (!s_wifi_tried || now - s_wifi_tried_ms >= WIFI_RETRY_MS) start_scan(now);
      break;

    case WifiStep::Scanning: {
      int n = WiFi.scanComplete();
      if (n == WIFI_SCAN_RUNNING) break;
      s_wifi_step = WifiStep::Idle;
      if (n < 0) {
        LOG("comms", "WiFi scan failed, retry in %lu ms", (unsigned long)WIFI_RETRY_MS);
        break;
      }
      if (!scan_found()) {
        if (!s_not_found_logged) LOG("comms", "WiFi network '%s' not found (retrying quietly)", WIFI_SSID);
        s_not_found_logged = true;
        break;
      }
      s_not_found_logged = false;
      if (s_join_fails >= WIFI_JOIN_FAILS_BEFORE_BACKOFF && g_pad_connected &&
          now - s_last_join_ms < WIFI_JOIN_BACKOFF_MS) {
        if (!s_backoff_logged) {
          LOG("comms", "WiFi refused %u times: keeping the controller, joining every %lu ms",
              s_join_fails, (unsigned long)WIFI_JOIN_BACKOFF_MS);
        }
        s_backoff_logged = true;
        break;
      }
      s_last_join_ms = now;
      g_wifi_joining = true;
      s_wifi_step = WifiStep::FreeingRadio;
      s_wifi_step_ms = now;
      break;
    }

    case WifiStep::FreeingRadio:
      if (g_pad_radio_on) {
        if (now - s_wifi_step_ms < WIFI_RADIO_FREE_MS) break;
        LOG("comms", "Bluetooth didn't stop: joining WiFi anyway");
      }
      s_wifi_fail_reason = 0;  // the scan's disconnect() may have set one
      // The scan's channel and access point: no second scan
      WiFi.begin(WIFI_SSID, WIFI_PASS, s_ap_channel, s_ap_bssid);  // returns immediately
      LOG("comms", "WiFi connecting to '%s' (channel %ld, RSSI %ld dBm)...", WIFI_SSID,
          (long)s_ap_channel, (long)s_ap_rssi);
      s_wifi_step = WifiStep::Joining;
      s_wifi_step_ms = now;
      break;

    case WifiStep::Joining:
      if (s_wifi_fail_reason) {
        int r = s_wifi_fail_reason;
        LOG("comms", "WiFi attempt failed: reason %d (%s)", r,
            WiFi.disconnectReasonName((wifi_err_reason_t)r));
        end_join(now, true);
      } else if (now - s_wifi_step_ms >= WIFI_JOIN_TIMEOUT_MS) {
        LOG("comms", "WiFi attempt timed out");
        end_join(now, true);
      }
      break;
  }
}

bool try_mqtt_connect() {
  s_last_mqtt_try = millis();
  s_mqtt_ever_tried = true;
  LOG("comms", "MQTT connecting to %s:%d as %s...", MQTT_BROKER_IP, MQTT_PORT, s_client_id);
  // Blocks for up to the TCP connect timeout (~3 s) if the broker is down.
  // That only stalls this task.
  if (!s_mqtt.connect(s_client_id)) {
    LOG("comms", "MQTT connect failed (state %d), retry in %lu ms", s_mqtt.state(),
        (unsigned long)s_mqtt_backoff);
    return false;
  }
  s_mqtt.subscribe(s_topic_command, 1);
  LOG("comms", "MQTT connected, subscribed to %s", s_topic_command);
  return true;
}

Link service_link() {
  uint32_t now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (s_wifi_was_up) {
      LOG("comms", "WiFi lost");
      s_wifi_was_up = false;
    }
    service_wifi(now);
    return Link::WifiDown;
  }

  if (!s_wifi_was_up) {
    s_wifi_was_up = true;
    end_join(now, false);
    s_mqtt_backoff = MQTT_RETRY_MIN_MS;
    s_mqtt_ever_tried = false;  // try MQTT right away on a fresh WiFi link
    LOG("comms", "WiFi up, IP %s, RSSI %d dBm", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  }

  if (s_mqtt.connected()) {
    s_mqtt.loop();  // handles keepalive + dispatches on_message
    return Link::Up;
  }

  if (!s_mqtt_ever_tried || now - s_last_mqtt_try >= s_mqtt_backoff) {
    if (try_mqtt_connect()) {
      s_mqtt_backoff = MQTT_RETRY_MIN_MS;
      return Link::Up;
    }
    s_mqtt_backoff = min(s_mqtt_backoff * 2, MQTT_RETRY_MAX_MS);
  }
  return Link::MqttDown;
}

// ---- Outbound -----------------------------------------------------------------

// Events are one-time signals (arrived, task_complete...), so they wait in
// the queue while offline and go out in order on reconnect. Peek first and
// only remove an event once it is actually published.
void publish_events() {
  RobotEventMsg ev;
  while (xQueuePeek(g_event_queue, &ev, 0) == pdTRUE) {
    size_t n = build_event_json(ev, ROBOT_ID, ev.uptime_ms, s_json, sizeof(s_json));
    if (n == 0) {
      LOG("comms", "event too large to serialise, dropped");
    } else if (!s_mqtt.publish(s_topic_events, (const uint8_t*)s_json, n)) {
      return;  // leave it queued; retry next tick
    }
    xQueueReceive(g_event_queue, &ev, 0);
  }
}

// Telemetry is periodic state, so an old reading is worthless: publish
// what is queued while online and throw it away while offline.
void publish_telemetry(bool online) {
  TelemetryMsg t;
  while (xQueueReceive(g_telemetry_queue, &t, 0) == pdTRUE) {
    if (!online) continue;
    if (isnan(t.battery_pct)) continue;  // no battery reading yet: battery_pct is required
    size_t n = build_telemetry_json(t, ROBOT_ID, t.uptime_ms, s_json, sizeof(s_json));
    if (n == 0) {
      LOG("comms", "telemetry too large to serialise, dropped");
      continue;
    }
    if (!s_mqtt.publish(s_topic_telemetry, (const uint8_t*)s_json, n)) {
      LOG("comms", "telemetry publish failed");
    }
  }
}

}  // namespace

void comms_task(void* /*param*/) {
  snprintf(s_topic_telemetry, sizeof(s_topic_telemetry), "farm/robot/%s/telemetry", ROBOT_ID);
  snprintf(s_topic_events, sizeof(s_topic_events), "farm/robot/%s/events", ROBOT_ID);
  snprintf(s_topic_command, sizeof(s_topic_command), "farm/robot/%s/command", ROBOT_ID);

  // Unique client ID so a rebooted robot kicks its own stale session.
  uint64_t mac = ESP.getEfuseMac();
  snprintf(s_client_id, sizeof(s_client_id), "%s-%04X", ROBOT_ID, (unsigned)(mac >> 32) & 0xFFFF);

  WiFi.persistent(false);      // don't write credentials to flash every boot
  WiFi.mode(WIFI_STA);
  // WiFi power saving (modem sleep) is the pad task's to set: it has to be on
  // whenever Bluetooth runs (WIFI_POWER_SAVE in config.h).
  WiFi.setAutoReconnect(false);  // service_link() handles reconnects
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    s_wifi_fail_reason = info.wifi_sta_disconnected.reason;
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

  s_mqtt.setServer(MQTT_BROKER_IP, MQTT_PORT);
  s_mqtt.setCallback(on_message);
  s_mqtt.setBufferSize(MQTT_BUFFER_SIZE);
  s_mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
  s_mqtt.setSocketTimeout(MQTT_SOCKET_TIMEOUT_S);

  bool was_online = false;
  for (;;) {
    bool online = service_link() == Link::Up;
    if (online != was_online) {
      g_mqtt_connected = online;
      if (!online) LOG("comms", "offline: holding events, discarding telemetry");
      was_online = online;
    }

    if (online) publish_events();
    publish_telemetry(online);

    vTaskDelay(pdMS_TO_TICKS(COMMS_LOOP_MS));
  }
}
