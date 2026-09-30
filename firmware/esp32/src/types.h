// types.h
// Shared structs, queue handles, volatile flags.
//
// These structs are the ONLY interface between FreeRTOS tasks. Each one is
// copied by value through a queue, so keep them fixed-size (no pointers,
// no String).
//
// Enum values mirror farm-controller/shared/src/types.ts. The comms task
// converts them to the exact JSON strings the Pi services expect
// (see comms/comms_json.cpp). If types.ts changes, update both files.
//
// STATUS: proposed by Jameson for Sprint 1 so the comms + sensor tasks have
// something concrete to code against. Caleb owns the final shape: rename or
// extend freely, but keep comms_json.cpp in sync.

#pragma once

#include <stddef.h>
#include <stdint.h>

// ---- Fixed string sizes ------------------------------------------------------

// RFID tag IDs travel as strings: "0x" + uppercase hex UID.
// A 10-byte UID is 22 chars + NUL, so 24 covers every ISO14443A UID size.
constexpr size_t TAG_ID_LEN = 24;
// Orchestrator task IDs (UUIDs are 36 chars).
constexpr size_t TASK_ID_LEN = 40;
// Graph node IDs such as "elev-1-L0".
constexpr size_t NODE_ID_LEN = 24;
// Max waypoints in one navigate command. topology.json has 13 nodes today.
constexpr size_t MAX_PATH_LEN = 24;
constexpr size_t EVENT_DETAILS_LEN = 64;

// ---- Enums (mirror types.ts) -------------------------------------------------
// CamelCase names on purpose: Arduino #defines LOW and HIGH, which would
// break an enum member called LOW.

enum class RobotStatus : uint8_t {
  Idle,             // "idle"
  EnRoute,          // "en_route"
  Working,          // "working"
  ReturningToDock,  // "returning_to_dock"
  Docking,          // "docking"
  Charging,         // "charging"
  Lost,             // "lost"
  Error,            // "error"
  Manual,           // "manual"
};

enum class RobotEventType : uint8_t {
  Arrived,           // "arrived"
  TaskStarted,       // "task_started"
  TaskComplete,      // "task_complete"
  TaskFailed,        // "task_failed"
  BatteryLow,        // "battery_low"
  BatteryCritical,   // "battery_critical"
  ObstacleDetected,  // "obstacle_detected"
  PathBlocked,       // "path_blocked"
  DockConnected,     // "dock_connected"
  ChargeComplete,    // "charge_complete"
  Error,             // "error"
  Recovery,          // "recovery"
};

// Numeric on the wire, same values as types.ts.
enum class Heading : uint8_t { North = 0, East = 1, South = 2, West = 3 };
enum class Turn : uint8_t { Straight = 0, Right = 1, UTurn = 2, Left = 3 };

enum class CommandType : uint8_t { Navigate, ReturnToDock, Stop, Resume };

// action_at_target; None means the field was absent.
enum class TargetAction : uint8_t { None, Water, Grow, Harvest, Charge, Idle };

enum class TaskPriority : uint8_t { Low, Normal, High, Critical };
enum class CommandSource : uint8_t { Scheduler, Alert, Remote, Local };

// ---- sensor task -> nav task (g_sensor_queue) --------------------------------

struct SensorData {
  uint32_t uptime_ms;          // millis() when the reading was taken

  // RFID
  bool rfid_ok;                // reader initialised and responding
  bool tag_in_field;           // a tag is under the reader right now
  uint32_t tag_seq;            // increments on every NEW tag arrival
  char tag_uid[TAG_ID_LEN];    // most recent tag ("" until the first read)
  // Nav should act when tag_seq changes, not on tag_in_field. The sequence
  // number survives dropped queue messages; a one-shot bool would not.

  // Obstacle (VL53L4CX time-of-flight)
  bool tof_ok;                 // sensor producing measurements
  float obstacle_cm;           // nearest valid target, NAN when none in range
  bool obstacle_stop;          // copy of g_obstacle_flag at reading time

  // Battery
  float battery_v;             // pack voltage (smoothed), NAN until first read
  float battery_pct;           // 0-100, NAN until first read
};

// ---- nav task -> motor task (g_drive_queue) ---------------------------------
// Draft only: the motor task is Sprint 2 and depends on the ME team's motors.

enum class DriveMode : uint8_t { Stop, Drive, Turn };

struct DriveCommand {
  DriveMode mode;
  int16_t left_speed;   // -255..255, used when mode == Drive
  int16_t right_speed;  // -255..255, used when mode == Drive
  Turn turn;            // used when mode == Turn
};

// ---- comms task -> nav task (g_command_queue) --------------------------------
// Parsed form of RobotCommand (types.ts). Absent optional fields are marked
// with the has_* flags or empty strings.

struct Command {
  CommandType type;
  char task_id[TASK_ID_LEN];          // "" if absent
  uint8_t path_len;                   // 0 if absent
  char path[MAX_PATH_LEN][TAG_ID_LEN];// RFID tag IDs, canonical "0x..." form
  char target_node[NODE_ID_LEN];      // "" if absent
  TargetAction action_at_target;      // None if absent
  bool has_duration;
  uint32_t duration_ms;
  TaskPriority priority;
  CommandSource source;
};

// ---- nav task -> comms task (g_telemetry_queue) ------------------------------
// One RobotTelemetry message. The comms task adds robot_id and converts
// uptime_ms to a Unix-ms timestamp when it publishes.

struct TelemetryMsg {
  uint32_t uptime_ms;
  RobotStatus status;
  char current_node[TAG_ID_LEN];  // the TAG ID of the current node (the
                                  // simulator does the same)
  float battery_pct;
  Heading heading;
  float obstacle_cm;              // NAN -> JSON null
  float temperature_c;            // NAN -> field omitted
  float humidity_pct;             // NAN -> field omitted
  float light_lux;                // NAN -> field omitted
};

// ---- nav task -> comms task (g_event_queue) ----------------------------------

struct RobotEventMsg {
  uint32_t uptime_ms;
  RobotEventType event;
  char task_id[TASK_ID_LEN];          // "" -> field omitted
  char node_id[TAG_ID_LEN];           // "" -> field omitted
  char details[EVENT_DETAILS_LEN];    // "" -> field omitted
};

// ---- Queue handles + shared flags (firmware only) ---------------------------

#ifdef ARDUINO
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

extern QueueHandle_t g_sensor_queue;     // SensorData    sensor -> nav
extern QueueHandle_t g_drive_queue;      // DriveCommand  nav    -> motor
extern QueueHandle_t g_command_queue;    // Command       comms  -> nav
extern QueueHandle_t g_telemetry_queue;  // TelemetryMsg  nav    -> comms
extern QueueHandle_t g_event_queue;      // RobotEventMsg nav    -> comms

// Safety flags: checked every motor cycle with no queue overhead.
// Single-byte/word writes are atomic on the ESP32, so volatile is enough.
extern volatile bool g_obstacle_flag;    // set/cleared by sensor task
extern volatile bool g_motor_kill_flag;  // set by survival overrides (nav)

// Comms status for the nav task's heartbeat watchdog.
extern volatile bool g_mqtt_connected;
// millis() of the last message from the Pi (a command OR an orchestrator
// heartbeat). 0 means nothing received since boot.
extern volatile uint32_t g_last_pi_msg_ms;

// Creates every queue. Call once from setup() before creating tasks.
// Returns false if any allocation failed.
bool create_queues();
#endif
