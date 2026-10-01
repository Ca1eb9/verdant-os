// comms_json.h
// JSON <-> struct conversion for the MQTT messages in @farm/shared types.ts.
//
// Pure C++ + ArduinoJson with no Arduino or FreeRTOS calls, so it also
// compiles on a laptop. test_host/ uses that to check the output against
// the real TypeScript types.

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "../types.h"

// ---- enum -> wire string (exact values from types.ts) ------------------------

const char* to_wire(RobotStatus s);
const char* to_wire(RobotEventType e);
const char* to_wire(CommandType c);
const char* to_wire(JogDirection d);   // None -> nullptr
const char* to_wire(TargetAction a);   // None -> nullptr
const char* to_wire(TaskPriority p);
const char* to_wire(CommandSource s);

// ---- Outbound: robot -> Pi -------------------------------------------------------
// Both return the JSON length written to `out` (NUL-terminated), or 0 if
// `cap` is too small. `timestamp_ms` is the robot's uptime (millis()); the Pi
// uses its own receive time. Telemetry also returns 0 while battery_pct is
// NAN, since battery_pct is required.

size_t build_telemetry_json(const TelemetryMsg& msg, const char* robot_id,
                            int64_t timestamp_ms, char* out, size_t cap);

size_t build_event_json(const RobotEventMsg& msg, const char* robot_id,
                        int64_t timestamp_ms, char* out, size_t cap);

// ---- Inbound: Pi -> robot ----------------------------------------------------------

enum class CommandParseResult : uint8_t {
  Ok,
  BadJson,
  NotAnObject,
  MissingCommand,
  UnknownCommand,
  MissingTaskId,     // cancel without a task_id
  BadDirection,      // jog without a valid direction
  PathTooLong,       // more than MAX_PATH_LEN waypoints
  BadPathEntry,      // non-string entry, or node id longer than NODE_ID_LEN-1
  FieldTooLong,      // task_id or target_node doesn't fit
  BadAction,
  BadPriority,
  BadSource,
  BadDuration,
};

const char* to_string(CommandParseResult r);

// Parses a RobotCommand JSON payload into `out`. On anything other than Ok,
// `out` must not be used. `priority` and `source` are required in types.ts,
// but if they are missing this defaults them to Normal / Local rather than
// dropping the command. A value that IS present but unknown is rejected.
CommandParseResult parse_command_json(const char* json, size_t len, Command& out);

// Formats a raw RFID UID as a tag ID ({0x04,0xA1} -> "0x04A1"). The nav task
// maps tag IDs to node ids with the flash graph.
bool format_tag_uid(const uint8_t* uid, uint8_t uid_len, char* out, size_t cap);
