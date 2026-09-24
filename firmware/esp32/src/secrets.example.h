// secrets.example.h
// Copy this file to secrets.h (same folder) and fill in the real values.
// secrets.h is gitignored so the FarmNet password never lands on GitHub.

#pragma once

#define WIFI_SSID "FarmNet"
#define WIFI_PASS "CHANGE-THIS-PASSWORD"

// Optional overrides, e.g. to test against Mosquitto on your laptop:
// #define MQTT_BROKER_IP "192.168.1.50"
// #define MQTT_PORT 1883
// #define NTP_SERVER "pool.ntp.org"   // only works on a network with internet
