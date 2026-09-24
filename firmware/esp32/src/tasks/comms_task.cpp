// comms_task.cpp
// See comms_task.h for what flows where.

#include "comms_task.h"

#include <Arduino.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <sys/time.h>
#include <time.h>

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

// ---- Time ----------------------------------------------------------------------
// FarmNet has no internet, so SNTP talks to the Pi (NTP_SERVER). Until the
// clock syncs, timestamps are sent as 0 and Pi services should fall back to
// their own receive time.

bool s_sntp_started = false;
bool s_time_synced_logged = false;

bool time_synced() { return time(nullptr) > 1700000000; }  // after Nov 2023

int64_t epoch_ms_for(uint32_t uptime_ms) {
  if (!time_synced()) return 0;
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  int64_t now_ms = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
  uint32_t age_ms = millis() - uptime_ms;  // unsigned math survives wraparound
  return now_ms - (int64_t)age_ms;
}

// ---- Inbound -----------------------------------------------------------------

void on_message(char* topic, uint8_t* payload, unsigned int len) {
  // Any message from the Pi proves it is alive; the nav watchdog reads this.
  g_last_pi_msg_ms = millis();

  if (strcmp(topic, s_topic_command) != 0) return;  // heartbeat: done

  Command cmd;
  CommandParseResult r = parse_command_json((const char*)payload, len, cmd);
  if (r != CommandParseResult::Ok) {
    LOG("comms", "rejected command (%s): %.*s", to_string(r), (int)min(len, 200u), payload);
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

uint32_t s_last_wifi_begin = 0;
bool s_wifi_begun = false;
bool s_wifi_was_up = false;
uint32_t s_last_mqtt_try = 0;
uint32_t s_mqtt_backoff = MQTT_RETRY_MIN_MS;
bool s_mqtt_ever_tried = false;

void start_wifi() {
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);  // returns immediately
  s_last_wifi_begin = millis();
  s_wifi_begun = true;
  LOG("comms", "WiFi connecting to '%s'...", WIFI_SSID);
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
  s_mqtt.subscribe(ORCHESTRATOR_HEARTBEAT_TOPIC, 0);
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
    if (!s_wifi_begun || now - s_last_wifi_begin >= WIFI_RETRY_MS) start_wifi();
    return Link::WifiDown;
  }

  if (!s_wifi_was_up) {
    s_wifi_was_up = true;
    s_mqtt_backoff = MQTT_RETRY_MIN_MS;
    s_mqtt_ever_tried = false;  // try MQTT right away on a fresh WiFi link
    LOG("comms", "WiFi up, IP %s, RSSI %d dBm", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    if (!s_sntp_started) {
      configTime(0, 0, NTP_SERVER);  // UTC; keeps syncing in the background
      s_sntp_started = true;
    }
  }

  if (!s_time_synced_logged && time_synced()) {
    s_time_synced_logged = true;
    LOG("comms", "clock synced via NTP (%s)", NTP_SERVER);
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
    size_t n = build_event_json(ev, ROBOT_ID, epoch_ms_for(ev.uptime_ms), s_json, sizeof(s_json));
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
    size_t n = build_telemetry_json(t, ROBOT_ID, epoch_ms_for(t.uptime_ms), s_json, sizeof(s_json));
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
  WiFi.setSleep(false);        // lower latency for commands
  WiFi.setAutoReconnect(false);  // service_link() handles reconnects

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
