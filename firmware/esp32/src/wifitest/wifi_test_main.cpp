// wifi_test_main.cpp
// WiFi-only diagnostic. Built by the `wifitest` env; nothing else runs.
//
//   pio run -e wifitest -t upload && pio device monitor -e wifitest
//
// Every 30 s it:
//   1. prints the SSID it's configured for (with hex bytes, so hidden
//      characters like a curly apostrophe show up) and the password LENGTH
//   2. scans and lists every 2.4 GHz network it can see, marking an exact
//      match with the configured SSID
//   3. tries to connect and prints the exact reason if the AP refuses
//   4. if connected, opens a TCP connection to the MQTT broker to check the
//      laptop / Pi is reachable (catches firewall or wrong-IP problems)

#include <Arduino.h>
#include <WiFi.h>
#include <string.h>
#include <strings.h>

#include "../config.h"

static volatile int s_last_reason = 0;

static const char* auth_name(wifi_auth_mode_t a) {
  switch (a) {
    case WIFI_AUTH_OPEN: return "open";
    case WIFI_AUTH_WEP: return "WEP";
    case WIFI_AUTH_WPA_PSK: return "WPA";
    case WIFI_AUTH_WPA2_PSK: return "WPA2";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-Enterprise (ESP32 can't use this)";
    case WIFI_AUTH_WPA3_PSK: return "WPA3 only";
    case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/WPA3";
    default: return "other";
  }
}

static void print_hex(const char* s) {
  for (const unsigned char* p = (const unsigned char*)s; *p; p++) Serial.printf("%02X ", *p);
}

static bool has_non_ascii(const char* s) {
  for (const unsigned char* p = (const unsigned char*)s; *p; p++)
    if (*p > 0x7E) return true;
  return false;
}

// Letters and digits only, lowercased: "Jameson’s iPhone" -> "jamesonsiphone"
static String loose(const String& s) {
  String out;
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (isalnum((unsigned char)c)) out += (char)tolower((unsigned char)c);
  }
  return out;
}

static void explain_reason(int r) {
  const char* hint = "";
  switch (r) {
    case WIFI_REASON_NO_AP_FOUND:
      hint = "network not found: SSID doesn't match exactly, it's 5 GHz only, or it's hidden";
      break;
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_AUTH_EXPIRE:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_802_1X_AUTH_FAILED:
      hint = "password rejected (or the hotspot requires WPA3)";
      break;
    case WIFI_REASON_ASSOC_FAIL:
    case WIFI_REASON_ASSOC_EXPIRE:
    case WIFI_REASON_ASSOC_TOOMANY:
      hint = "hotspot refused the device (too many clients, or it went to sleep)";
      break;
    case WIFI_REASON_BEACON_TIMEOUT:
      hint = "signal lost - move closer";
      break;
    default:
      break;
  }
  Serial.printf("   reason %d = %s  %s\n", r, WiFi.disconnectReasonName((wifi_err_reason_t)r), hint);
}

static void run_test() {
  Serial.println("\n================ WiFi test ================");
  Serial.printf("Configured SSID: \"%s\"  (%u bytes)\n   hex: ", WIFI_SSID, (unsigned)strlen(WIFI_SSID));
  print_hex(WIFI_SSID);
  Serial.println();
  Serial.printf("Password length: %u characters (WPA2 needs 8-63)\n", (unsigned)strlen(WIFI_PASS));
  Serial.printf("MQTT broker: %s:%d\n", MQTT_BROKER_IP, MQTT_PORT);

  // --- Scan ---
  WiFi.disconnect(true);
  delay(100);
  Serial.println("\nScanning (2.4 GHz only - the ESP32 can't see 5 GHz)...");
  int n = WiFi.scanNetworks();
  bool exact = false;
  String want = loose(WIFI_SSID);
  for (int i = 0; i < n; i++) {
    String ssid = WiFi.SSID(i);
    bool is_exact = ssid == WIFI_SSID;
    bool is_close = !is_exact && want.length() && loose(ssid) == want;
    exact |= is_exact;
    Serial.printf("  %s %-32s %4d dBm  ch %2d  %s\n", is_exact ? "==>" : (is_close ? " ? " : "   "),
                  ssid.length() ? ssid.c_str() : "(hidden)", WiFi.RSSI(i), WiFi.channel(i),
                  auth_name(WiFi.encryptionType(i)));
    if (is_close || (is_exact && has_non_ascii(ssid.c_str()))) {
      Serial.print("        hex: ");
      print_hex(ssid.c_str());
      Serial.println();
    }
    if (is_close)
      Serial.println("        ^ same letters but NOT an exact match - compare the hex bytes above");
  }
  if (n <= 0) Serial.println("  (no networks found at all - antenna/board problem?)");
  WiFi.scanDelete();

  if (!exact) {
    Serial.println("\nRESULT: configured SSID was NOT seen in the scan.");
    Serial.println("  - Check Maximize Compatibility is ON (forces 2.4 GHz)");
    Serial.println("  - Keep the iPhone's Personal Hotspot screen open");
    Serial.println("  - If a '?' line appears above, fix WIFI_SSID to match its bytes");
  }

  // --- Connect ---
  Serial.printf("\nConnecting to \"%s\"...\n", WIFI_SSID);
  s_last_reason = 0;
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(500);
    Serial.print(".");
    if (s_last_reason) {
      Serial.println();
      explain_reason(s_last_reason);
      s_last_reason = 0;
    }
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("RESULT: NOT connected after 20 s (status %d)\n", (int)WiFi.status());
    WiFi.disconnect(true);
    return;
  }

  Serial.printf("RESULT: connected in %lu ms\n", (unsigned long)(millis() - t0));
  Serial.printf("   IP %s  gateway %s  RSSI %d dBm  channel %d\n", WiFi.localIP().toString().c_str(),
                WiFi.gatewayIP().toString().c_str(), WiFi.RSSI(), WiFi.channel());

  // --- Broker reachability ---
  WiFiClient c;
  Serial.printf("\nOpening TCP to broker %s:%d...\n", MQTT_BROKER_IP, MQTT_PORT);
  if (c.connect(MQTT_BROKER_IP, MQTT_PORT, 3000)) {
    Serial.println("RESULT: broker reachable - WiFi + network are good, the bench build should connect");
    c.stop();
  } else {
    Serial.println("RESULT: broker NOT reachable. Check:");
    Serial.println("  - MQTT_BROKER_IP in secrets.h matches the Mac's IP on this hotspot");
    Serial.println("  - Mac is on the same hotspot");
    Serial.println("  - mosquitto.conf has 'listener 1883 0.0.0.0' (lsof shows *:1883)");
    Serial.println("  - macOS firewall allows mosquitto");
  }
  WiFi.disconnect(true);
}

void setup() {
  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  for (uint32_t t0 = millis(); !Serial && millis() - t0 < 5000;) delay(10);
#endif
  delay(300);
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) { s_last_reason = info.wifi_sta_disconnected.reason; },
               ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
}

void loop() {
  run_test();
  Serial.println("\n(re-running in 30 s - press EN/RST to run now)");
  delay(30000);
}
