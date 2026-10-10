// config.h
// Pin assignments, thresholds, timing constants.
// Nothing tunable should be hardcoded anywhere else.

#pragma once

#include <stdint.h>

#include "types.h"

// ---- Identity ----------------------------------------------------------------

#define ROBOT_ID "robot-1"

// ---- Network (see docs/WIFI-SETUP.md) ---------------------------------------
// Real credentials go in secrets.h (gitignored). Copy secrets.example.h to
// secrets.h and edit it. Never commit the password.

#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "src/secrets.h not found"
#endif

#ifndef MQTT_BROKER_IP
#define MQTT_BROKER_IP "192.168.4.1"  // use the IP, not "farmnet"
#endif
#ifndef MQTT_PORT
#define MQTT_PORT 1883
#endif

// ---- Comms timing -------------------------------------------------------------

constexpr uint32_t COMMS_LOOP_MS = 10;          // comms task tick
constexpr uint32_t WIFI_RETRY_MS = 10000;       // restart WiFi.begin() after this
constexpr uint32_t MQTT_RETRY_MIN_MS = 1000;    // reconnect backoff, doubles...
constexpr uint32_t MQTT_RETRY_MAX_MS = 16000;   // ...up to this
constexpr uint16_t MQTT_KEEPALIVE_S = 15;
constexpr uint16_t MQTT_SOCKET_TIMEOUT_S = 2;
constexpr uint16_t MQTT_BUFFER_SIZE = 2048;     // a 24-waypoint command is ~900 B

// ---- Pins (ESP32-S3-WROOM-1 DevKitC) ----------------------------------------------
// Avoid: 0/3/45/46 (strapping), 19/20 (USB D-/D+), 26-32 (flash), 33-37
// (octal PSRAM on R8 modules), 43/44 (UART0). Only ADC1 pins (GPIO1-10) can
// read voltages while WiFi is on.

// SPI (FSPI default pins) - PN532 RFID reader
constexpr int PIN_SPI_SCK = 12;
constexpr int PIN_SPI_MISO = 13;
constexpr int PIN_SPI_MOSI = 11;
constexpr int PIN_RFID_SS = 10;

// I2C - VL53L4CX time-of-flight sensors. Both have the same fixed address,
// so each gets its own I2C bus. XSHUT: set a GPIO if wired, else -1.
constexpr int PIN_I2C_FRONT_SDA = 8;   // front sensor (Wire)
constexpr int PIN_I2C_FRONT_SCL = 9;
constexpr int PIN_TOF_FRONT_XSHUT = -1;
constexpr int PIN_I2C_REAR_SDA = 17;   // rear sensor (Wire1)
constexpr int PIN_I2C_REAR_SCL = 18;
constexpr int PIN_TOF_REAR_XSHUT = -1;
// The AHT20 (address 0x38) shares the front sensor's bus.

// Battery voltage divider tap
constexpr int PIN_BATTERY_ADC = 4;

// Onboard NeoPixel (GPIO38 on DevKitC-1 v1.1 boards)
constexpr int PIN_STATUS_LED = 38;

// ---- RFID (PN532) ---------------------------------------------------------------

constexpr uint16_t RFID_READ_TIMEOUT_MS = 30;   // max time one poll may block
constexpr uint32_t RFID_TAG_GONE_MS = 300;      // no read for this long = tag left
constexpr uint32_t RFID_REINIT_MS = 5000;       // retry a dead reader this often

// ---- Obstacle sensor (VL53L4CX) --------------------------------------------------

constexpr float OBSTACLE_STOP_CM = 15.0f;       // set that side's obstacle flag below this
// Must read above this to clear. During a dock or elevator approach the stop
// distance is lower; the clear distance moves with it (same 5 cm gap).
constexpr float OBSTACLE_CLEAR_CM = 20.0f;
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

// ---- Air temperature + humidity (AHT20, drivers/env_sensor.h) ----------------------

// Measuring more often warms the chip and skews the temperature (datasheet).
constexpr uint32_t ENV_PERIOD_MS = 2000;
constexpr uint32_t ENV_MEASURE_MS = 80;         // a measurement takes this long
constexpr uint32_t ENV_MEASURE_TIMEOUT_MS = 500; // still busy after this: re-init
// No good reading this long: report none rather than a frozen value.
constexpr uint32_t ENV_STALE_MS = 10000;
constexpr uint32_t ENV_REINIT_MS = 5000;

// ---- Sensor task timing -----------------------------------------------------------

constexpr uint32_t SENSOR_PERIOD_MS = 20;       // sensor loop (50 Hz)
constexpr uint32_t SENSOR_REPORT_MS = 100;      // push SensorData at least this often

// ---- Navigation task (docs/firmware-architecture.md) -------------------------------

constexpr uint32_t NAV_LOOP_MS = 20;            // nav task tick
// Also sent right away on a status or node change. Must stay well below the
// orchestrator's command_ack_timeout_ms (5000).
constexpr uint32_t TELEMETRY_PERIOD_MS = 1000;

// TBD: tune on the real farm.
constexpr uint32_t MISSED_TAG_TIMEOUT_MS = 5000;   // no next tag this long while driving: error
constexpr uint32_t PATH_BLOCKED_TIMEOUT_MS = 10000; // obstacle this long: path_blocked
constexpr uint32_t CREEP_TIMEOUT_MS = 15000;        // no tag this long while creeping after boot
constexpr int16_t CRUISE_SPEED = 150;               // between tags (0..255)
constexpr int16_t CREEP_SPEED = 90;                 // looking for a tag after boot (0..255)
constexpr uint32_t ELEVATOR_WAIT_MS = 5000;         // per level ridden: stay put, then drive off

// Approach (ToF): slow down near anything ahead. After reading the elevator
// or dock tag, creep in until this close to the end wall instead of stopping
// at OBSTACLE_STOP_CM. TBD: tune on the real farm.
constexpr float SLOW_ZONE_CM = 40.0f;               // slow to APPROACH_SPEED inside this
constexpr int16_t APPROACH_SPEED = 60;              // (0..255)
constexpr float ELEVATOR_STOP_CM = 2.0f;            // stop this close to the elevator's end wall
constexpr float DOCK_STOP_CM = 1.0f;                // stop this close to the dock
constexpr uint32_t APPROACH_TIMEOUT_MS = 10000;     // not there after this long driving: error

// The way the robot faces. It has a single drive motor, so it never turns:
// set it down facing away from the dock (so it backs onto the charger). It
// drives backward to go the other way. Matches the simulator.
constexpr Heading ROBOT_HEADING = Heading::East;

// Used when a navigate has no duration_ms. With no duration, idle completes
// right after task_started.
constexpr uint32_t DEFAULT_WATER_MS = 60000;
constexpr uint32_t DEFAULT_GROW_MS = 600000;
constexpr uint32_t DEFAULT_HARVEST_MS = 0;       // TBD: harvest isn't specified yet
constexpr uint32_t DEFAULT_IDLE_MS = 0;

// ---- Survival overrides -------------------------------------------------------------
// Each level applies at or below its value. The forced return sits below the
// orchestrator's battery_low_pct (20), so the orchestrator handles normal
// charging. A stop beats the forced return; only the motor cutoff applies
// to a stopped robot.

constexpr float BATTERY_WARN_PCT = 20.0f;       // battery_low
constexpr float BATTERY_RETURN_PCT = 15.0f;     // battery_critical, go to dock
constexpr float BATTERY_CUTOFF_PCT = 5.0f;      // kill motors
constexpr float CHARGE_COMPLETE_PCT = 95.0f;    // matches orchestrator charge_complete_pct

// ---- Manual control -----------------------------------------------------------------

constexpr uint32_t JOG_PULSE_MS = 500;          // each jog drives this long from receipt
constexpr int16_t JOG_SPEED = 120;              // TBD: tune on the robot (0..255)
constexpr uint32_t MANUAL_TIMEOUT_MS = 5000;    // leave manual after this long without input

// ---- Motor task (tasks/motor_task.h) ------------------------------------------------

constexpr uint32_t REVERSE_RAMP_MS = 150;       // TBD: slow to 0 over this before reversing

// ---- Status LED (README "Status LED") ----------------------------------------------

constexpr uint8_t STATUS_LED_BRIGHTNESS = 40;   // 0-255 cap, so it isn't blinding on the bench
constexpr uint32_t LED_BREATHE_MS = 2000;       // one breath (initializing, charging)
constexpr uint32_t LED_BLINK_MS = 125;          // half a blink: 4 Hz (docking, error, obstacle)
constexpr uint32_t LED_FLASH_MS = 100;          // one blip (tag read, jog, ignored command)
constexpr uint32_t LED_OFFLINE_EVERY_MS = 2000; // MQTT down: dark gap this often
constexpr uint32_t LED_BATTERY_WARN_EVERY_MS = 5000;  // battery low: amber blip this often

// ---- Queue depths ------------------------------------------------------------------

constexpr uint8_t SENSOR_QUEUE_LEN = 8;
// The motor task only runs the newest command, so the drive queue is a
// one-slot mailbox (xQueueOverwrite): a halt can never be dropped as full.
constexpr uint8_t DRIVE_QUEUE_LEN = 1;
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

constexpr uint32_t STACK_MOTOR = 4096;
constexpr uint32_t STACK_SENSOR = 6144;
constexpr uint32_t STACK_NAV = 8192;            // TaskContext + path planning scratch
constexpr uint32_t STACK_COMMS = 8192;
