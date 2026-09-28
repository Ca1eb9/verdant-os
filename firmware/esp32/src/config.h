// config.h
// Pin assignments, WiFi credentials, thresholds, timing constants.
// Nothing tunable should be hardcoded anywhere else.

#pragma once

#include <stdint.h>

// Defines CONFIG_IDF_TARGET_* so the pin section below picks the right chip
// no matter which header a .cpp includes first.
#if __has_include(<sdkconfig.h>)
#include <sdkconfig.h>
#endif

// ---- Identity ----------------------------------------------------------------

#define ROBOT_ID "robot-1"

// ---- Network (see docs/WIFI-SETUP.md) ---------------------------------------
// Real credentials go in secrets.h (gitignored). Copy secrets.example.h to
// secrets.h and edit it. The repo is public, so never commit the password.

#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "src/secrets.h not found - using placeholder WiFi credentials"
#define WIFI_SSID "FarmNet"
#define WIFI_PASS "CHANGE-THIS-PASSWORD"
#endif

#ifndef MQTT_BROKER_IP
#define MQTT_BROKER_IP "192.168.4.1"  // use the IP, not "farmnet"
#endif
#ifndef MQTT_PORT
#define MQTT_PORT 1883
#endif

// FarmNet has no internet, so the Pi must serve NTP (see COMMS-SENSOR.md).
#ifndef NTP_SERVER
#define NTP_SERVER MQTT_BROKER_IP
#endif

// Topic the orchestrator publishes its heartbeat on. Matches
// TOPICS.system.heartbeat("orchestrator") in shared/src/topics.ts.
#define ORCHESTRATOR_HEARTBEAT_TOPIC "farm/system/orchestrator/heartbeat"

// ---- Comms timing -------------------------------------------------------------

constexpr uint32_t COMMS_LOOP_MS = 10;          // comms task tick
constexpr uint32_t WIFI_RETRY_MS = 10000;       // restart WiFi.begin() after this
constexpr uint32_t MQTT_RETRY_MIN_MS = 1000;    // reconnect backoff, doubles...
constexpr uint32_t MQTT_RETRY_MAX_MS = 16000;   // ...up to this
constexpr uint16_t MQTT_KEEPALIVE_S = 15;
constexpr uint16_t MQTT_SOCKET_TIMEOUT_S = 2;
constexpr uint16_t MQTT_BUFFER_SIZE = 2048;     // a 24-waypoint command is ~900 B

// ---- Pins ------------------------------------------------------------------------
// The compiler picks the set for whichever chip the board in platformio.ini
// uses. ADC note: only ADC1 pins work while WiFi is on.

#if defined(CONFIG_IDF_TARGET_ESP32S3)
// ESP32-S3 (ESP32-S3-WROOM-1 DevKitC). Avoid: 0/3/45/46 (strapping),
// 19/20 (USB D-/D+), 26-32 (flash), 33-37 (octal PSRAM on R8 modules),
// 43/44 (UART0).

// SPI (FSPI default pins) - RFID reader
constexpr int PIN_SPI_SCK = 12;
constexpr int PIN_SPI_MISO = 13;
constexpr int PIN_SPI_MOSI = 11;
constexpr int PIN_RFID_SS = 10;
constexpr int PIN_RFID_RST = 14;   // RC522 only; PN532 over SPI doesn't need it

// I2C - VL53L4CX time-of-flight sensor
constexpr int PIN_I2C_SDA = 8;
constexpr int PIN_I2C_SCL = 9;
constexpr int PIN_TOF_XSHUT = -1;  // set to a GPIO (e.g. 5) if XSHUT is wired, else -1

// Battery voltage divider tap (ADC1 = GPIO1-10 on the S3)
constexpr int PIN_BATTERY_ADC = 4;

#else
// Classic ESP32 (ESP32-WROOM-32 DevKit / esp32dev). ADC1 = GPIO32-39.

// SPI (VSPI) - RFID reader
constexpr int PIN_SPI_SCK = 18;
constexpr int PIN_SPI_MISO = 19;
constexpr int PIN_SPI_MOSI = 23;
constexpr int PIN_RFID_SS = 5;
constexpr int PIN_RFID_RST = 27;   // RC522 only; PN532 over SPI doesn't need it

// I2C - VL53L4CX time-of-flight sensor
constexpr int PIN_I2C_SDA = 21;
constexpr int PIN_I2C_SCL = 22;
constexpr int PIN_TOF_XSHUT = -1;  // set to a GPIO if XSHUT is wired, else -1

// Battery voltage divider tap (docs/battery-monitoring.md)
constexpr int PIN_BATTERY_ADC = 34;
#endif

// ---- RFID ----------------------------------------------------------------------
// Pick exactly one. platformio.ini pulls in both libraries; the timeline
// says RC522 but the repo was set up with the PN532, so both are supported.
#if !defined(RFID_READER_PN532) && !defined(RFID_READER_RC522)
#define RFID_READER_PN532
#endif

constexpr uint16_t RFID_READ_TIMEOUT_MS = 30;   // max time one poll may block
constexpr uint32_t RFID_TAG_GONE_MS = 300;      // no read for this long = tag left
constexpr uint32_t RFID_REINIT_MS = 5000;       // retry a dead reader this often

// ---- Obstacle sensor (VL53L4CX) --------------------------------------------------

constexpr float OBSTACLE_STOP_CM = 15.0f;       // set g_obstacle_flag below this
constexpr float OBSTACLE_CLEAR_CM = 20.0f;      // must read above this to clear
constexpr uint8_t OBSTACLE_CLEAR_COUNT = 3;     // consecutive clear readings needed
constexpr uint32_t TOF_TIMING_BUDGET_US = 33000;
constexpr uint32_t TOF_TIMEOUT_MS = 500;        // no data this long = sensor fault
constexpr uint32_t TOF_REINIT_MS = 5000;
// If the ToF sensor stops responding, hold the obstacle flag (motors stay
// stopped). Safer for the real robot; set false to bench-test without one.
constexpr bool OBSTACLE_FAILSAFE = true;

// ---- Battery (3S Li-ion, docs/battery-monitoring.md) ------------------------------
// Measure the real resistors with a multimeter and put the values here.

constexpr float BATTERY_R1_OHMS = 100000.0f;
constexpr float BATTERY_R2_OHMS = 33000.0f;
constexpr int BATTERY_CELLS = 3;
constexpr float BATTERY_CAL_FACTOR = 1.0f;      // tweak after multimeter check
constexpr uint8_t BATTERY_SAMPLES = 16;         // ADC reads averaged per sample
constexpr float BATTERY_EMA_ALPHA = 0.2f;       // smoothing, 0..1 (1 = none)
constexpr uint32_t BATTERY_PERIOD_MS = 500;

// ---- Sensor task timing -----------------------------------------------------------

constexpr uint32_t SENSOR_PERIOD_MS = 20;       // sensor loop (50 Hz)
constexpr uint32_t SENSOR_REPORT_MS = 100;      // push SensorData at least this often

// ---- Queue depths ------------------------------------------------------------------

constexpr uint8_t SENSOR_QUEUE_LEN = 8;
constexpr uint8_t DRIVE_QUEUE_LEN = 4;
constexpr uint8_t COMMAND_QUEUE_LEN = 4;
constexpr uint8_t TELEMETRY_QUEUE_LEN = 5;
constexpr uint8_t EVENT_QUEUE_LEN = 16;         // events wait here while offline

// ---- Tasks: priority / core / stack ----------------------------------------------
// Motor + sensor + nav on core 1 (APP_CPU); comms on core 0 with the WiFi stack.

constexpr uint8_t PRIO_MOTOR = 4;
constexpr uint8_t PRIO_SENSOR = 3;
constexpr uint8_t PRIO_NAV = 2;
constexpr uint8_t PRIO_COMMS = 1;

constexpr int CORE_REALTIME = 1;
constexpr int CORE_NETWORK = 0;

constexpr uint32_t STACK_SENSOR = 6144;
constexpr uint32_t STACK_COMMS = 8192;
