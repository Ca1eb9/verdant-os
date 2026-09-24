// comms_json.cpp
// See comms_json.h. Every string literal here must match types.ts exactly.

#include "comms_json.h"

#include <ArduinoJson.h>
#include <ctype.h>
#include <math.h>
#include <string.h>

// ---- enum <-> string tables ---------------------------------------------------

const char* to_wire(RobotStatus s) {
  switch (s) {
    case RobotStatus::Idle: return "idle";
    case RobotStatus::EnRoute: return "en_route";
    case RobotStatus::Working: return "working";
    case RobotStatus::ReturningToDock: return "returning_to_dock";
    case RobotStatus::Docking: return "docking";
    case RobotStatus::Charging: return "charging";
    case RobotStatus::Lost: return "lost";
    case RobotStatus::Error: return "error";
    case RobotStatus::Manual: return "manual";
  }
  return "error";
}

const char* to_wire(RobotEventType e) {
  switch (e) {
    case RobotEventType::Arrived: return "arrived";
    case RobotEventType::TaskStarted: return "task_started";
    case RobotEventType::TaskComplete: return "task_complete";
    case RobotEventType::TaskFailed: return "task_failed";
    case RobotEventType::BatteryLow: return "battery_low";
    case RobotEventType::BatteryCritical: return "battery_critical";
    case RobotEventType::ObstacleDetected: return "obstacle_detected";
    case RobotEventType::PathBlocked: return "path_blocked";
    case RobotEventType::DockConnected: return "dock_connected";
    case RobotEventType::ChargeComplete: return "charge_complete";
    case RobotEventType::Error: return "error";
    case RobotEventType::Recovery: return "recovery";
  }
  return "error";
}

const char* to_wire(CommandType c) {
  switch (c) {
    case CommandType::Navigate: return "navigate";
    case CommandType::ReturnToDock: return "return_to_dock";
    case CommandType::Stop: return "stop";
    case CommandType::Resume: return "resume";
  }
  return "stop";
}

const char* to_wire(TargetAction a) {
  switch (a) {
    case TargetAction::None: return nullptr;
    case TargetAction::Water: return "water";
    case TargetAction::Grow: return "grow";
    case TargetAction::Harvest: return "harvest";
    case TargetAction::Charge: return "charge";
    case TargetAction::Idle: return "idle";
  }
  return nullptr;
}

const char* to_wire(TaskPriority p) {
  switch (p) {
    case TaskPriority::Low: return "low";
    case TaskPriority::Normal: return "normal";
    case TaskPriority::High: return "high";
    case TaskPriority::Critical: return "critical";
  }
  return "normal";
}

const char* to_wire(CommandSource s) {
  switch (s) {
    case CommandSource::Scheduler: return "scheduler";
    case CommandSource::Alert: return "alert";
    case CommandSource::Remote: return "remote";
    case CommandSource::Local: return "local";
  }
  return "local";
}

// Reverse lookup: tries every enum value until to_wire() matches.
template <typename E>
static bool from_wire(const char* s, E first, E last, E& out) {
  if (!s) return false;
  for (int i = static_cast<int>(first); i <= static_cast<int>(last); i++) {
    const char* w = to_wire(static_cast<E>(i));
    if (w && strcmp(w, s) == 0) {
      out = static_cast<E>(i);
      return true;
    }
  }
  return false;
}

const char* to_string(CommandParseResult r) {
  switch (r) {
    case CommandParseResult::Ok: return "ok";
    case CommandParseResult::BadJson: return "invalid JSON";
    case CommandParseResult::NotAnObject: return "payload is not a JSON object";
    case CommandParseResult::MissingCommand: return "missing 'command'";
    case CommandParseResult::UnknownCommand: return "unknown 'command'";
    case CommandParseResult::MissingPath: return "navigate needs a non-empty 'path'";
    case CommandParseResult::PathTooLong: return "'path' has too many waypoints";
    case CommandParseResult::BadPathEntry: return "bad entry in 'path'";
    case CommandParseResult::FieldTooLong: return "'task_id' or 'target_node' too long";
    case CommandParseResult::BadAction: return "unknown 'action_at_target'";
    case CommandParseResult::BadPriority: return "unknown 'priority'";
    case CommandParseResult::BadSource: return "unknown 'source'";
    case CommandParseResult::BadDuration: return "'duration_ms' is not a non-negative integer";
  }
  return "?";
}

// ---- Tag ID helpers ----------------------------------------------------------------

bool canonical_tag_id(const char* in, char* out, size_t cap) {
  if (!in || !out || cap < 3) return false;
  while (isspace((unsigned char)*in)) in++;
  size_t n = strlen(in);
  while (n > 0 && isspace((unsigned char)in[n - 1])) n--;

  size_t o = 0;
  size_t i = 0;
  if (n >= 2 && in[0] == '0' && (in[1] == 'x' || in[1] == 'X')) i = 2;
  out[o++] = '0';
  out[o++] = 'x';
  for (; i < n; i++) {
    if (o + 1 >= cap) return false;
    out[o++] = (char)toupper((unsigned char)in[i]);
  }
  out[o] = '\0';
  return o > 2;  // "0x" alone is not a tag
}

bool format_tag_uid(const uint8_t* uid, uint8_t uid_len, char* out, size_t cap) {
  static const char HEX_DIGITS[] = "0123456789ABCDEF";
  if (!uid || uid_len == 0 || cap < (size_t)(3 + 2 * uid_len)) return false;
  size_t o = 0;
  out[o++] = '0';
  out[o++] = 'x';
  for (uint8_t i = 0; i < uid_len; i++) {
    out[o++] = HEX_DIGITS[uid[i] >> 4];
    out[o++] = HEX_DIGITS[uid[i] & 0x0F];
  }
  out[o] = '\0';
  return true;
}

// ---- Outbound -------------------------------------------------------------------------

// One decimal place, like the simulator. Returned as double so ArduinoJson
// prints "72.3" rather than float noise such as "72.30000305".
static double round1(float v) { return round((double)v * 10.0) / 10.0; }

static size_t finish(JsonDocument& doc, char* out, size_t cap) {
  if (doc.overflowed()) return 0;
  size_t need = measureJson(doc);
  if (need + 1 > cap) return 0;
  return serializeJson(doc, out, cap);
}

size_t build_telemetry_json(const TelemetryMsg& m, const char* robot_id,
                            int64_t timestamp_ms, char* out, size_t cap) {
  JsonDocument doc;
  doc["robot_id"] = robot_id;
  doc["status"] = to_wire(m.status);
  doc["current_node"] = m.current_node;
  doc["battery_pct"] = isnan(m.battery_pct) ? 0.0 : round1(m.battery_pct);
  doc["heading"] = static_cast<uint8_t>(m.heading);

  // obstacle_cm?: number | null  -> always present, null when no target
  if (isnan(m.obstacle_cm)) {
    doc["obstacle_cm"] = nullptr;
  } else {
    doc["obstacle_cm"] = round1(m.obstacle_cm);
  }

  // Optional environment readings: omitted when the robot has no sensor.
  if (!isnan(m.temperature_c)) doc["temperature_c"] = round1(m.temperature_c);
  if (!isnan(m.humidity_pct)) doc["humidity_pct"] = round1(m.humidity_pct);
  if (!isnan(m.light_lux)) doc["light_lux"] = round(m.light_lux);

  doc["timestamp"] = timestamp_ms;
  return finish(doc, out, cap);
}

size_t build_event_json(const RobotEventMsg& m, const char* robot_id,
                        int64_t timestamp_ms, char* out, size_t cap) {
  JsonDocument doc;
  doc["robot_id"] = robot_id;
  doc["event"] = to_wire(m.event);
  if (m.task_id[0]) doc["task_id"] = m.task_id;
  if (m.node_id[0]) doc["node_id"] = m.node_id;
  if (m.details[0]) doc["details"] = m.details;
  doc["timestamp"] = timestamp_ms;
  return finish(doc, out, cap);
}

// ---- Inbound ---------------------------------------------------------------------------

// Copies an optional string field. Absent/null -> "". Returns false only if
// the value is present but not a string or doesn't fit.
static bool copy_optional_str(JsonVariantConst v, char* dst, size_t cap) {
  dst[0] = '\0';
  if (v.isNull()) return true;
  if (!v.is<const char*>()) return false;
  const char* s = v.as<const char*>();
  size_t n = strlen(s);
  if (n + 1 > cap) return false;
  memcpy(dst, s, n + 1);
  return true;
}

CommandParseResult parse_command_json(const char* json, size_t len, Command& out) {
  memset(&out, 0, sizeof(out));

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, json, len);
  if (err) return CommandParseResult::BadJson;
  if (!doc.is<JsonObjectConst>()) return CommandParseResult::NotAnObject;
  JsonObjectConst o = doc.as<JsonObjectConst>();

  // command (required)
  JsonVariantConst cmd = o["command"];
  if (!cmd.is<const char*>()) return CommandParseResult::MissingCommand;
  if (!from_wire(cmd.as<const char*>(), CommandType::Navigate, CommandType::Resume, out.type))
    return CommandParseResult::UnknownCommand;

  // task_id, target_node (optional strings)
  if (!copy_optional_str(o["task_id"], out.task_id, sizeof(out.task_id)) ||
      !copy_optional_str(o["target_node"], out.target_node, sizeof(out.target_node)))
    return CommandParseResult::FieldTooLong;

  // path (optional array of tag IDs; required for navigate)
  JsonVariantConst path = o["path"];
  if (!path.isNull()) {
    if (!path.is<JsonArrayConst>()) return CommandParseResult::BadPathEntry;
    JsonArrayConst arr = path.as<JsonArrayConst>();
    if (arr.size() > MAX_PATH_LEN) return CommandParseResult::PathTooLong;
    for (JsonVariantConst tag : arr) {
      if (!tag.is<const char*>()) return CommandParseResult::BadPathEntry;
      if (!canonical_tag_id(tag.as<const char*>(), out.path[out.path_len], TAG_ID_LEN))
        return CommandParseResult::BadPathEntry;
      out.path_len++;
    }
  }
  if (out.type == CommandType::Navigate && out.path_len == 0)
    return CommandParseResult::MissingPath;

  // action_at_target (optional)
  out.action_at_target = TargetAction::None;
  JsonVariantConst action = o["action_at_target"];
  if (!action.isNull()) {
    if (!from_wire(action.as<const char*>(), TargetAction::Water, TargetAction::Idle,
                   out.action_at_target))
      return CommandParseResult::BadAction;
  }

  // duration_ms (optional non-negative integer)
  JsonVariantConst dur = o["duration_ms"];
  if (!dur.isNull()) {
    if (!dur.is<uint32_t>()) return CommandParseResult::BadDuration;
    out.has_duration = true;
    out.duration_ms = dur.as<uint32_t>();
  }

  // priority, source (required in types.ts; lenient default if absent)
  out.priority = TaskPriority::Normal;
  JsonVariantConst prio = o["priority"];
  if (!prio.isNull() &&
      !from_wire(prio.as<const char*>(), TaskPriority::Low, TaskPriority::Critical, out.priority))
    return CommandParseResult::BadPriority;

  out.source = CommandSource::Local;
  JsonVariantConst src = o["source"];
  if (!src.isNull() &&
      !from_wire(src.as<const char*>(), CommandSource::Scheduler, CommandSource::Local, out.source))
    return CommandParseResult::BadSource;

  return CommandParseResult::Ok;
}
