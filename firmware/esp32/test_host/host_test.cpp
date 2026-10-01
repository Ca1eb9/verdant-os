// host_test.cpp
// Runs the firmware's JSON + battery code on a laptop (no ESP32 needed).
//
//   1. Asserts command parsing and battery math behave.
//   2. Writes sample telemetry/event JSON to out/ so check_contract.mjs can
//      validate it against the real TypeScript types in @farm/shared.
//
// Build + run everything with ./run.sh

#include <math.h>
#include <stdio.h>
#include <string.h>

#include <string>

#include "comms/comms_json.h"
#include "drivers/battery.h"

static int failures = 0;
#define CHECK(cond)                                                   \
  do {                                                                \
    if (!(cond)) {                                                    \
      printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);        \
      failures++;                                                     \
    }                                                                 \
  } while (0)

static void write_file(const std::string& path, const char* text) {
  FILE* f = fopen(path.c_str(), "w");
  if (!f) {
    printf("cannot write %s\n", path.c_str());
    failures++;
    return;
  }
  fputs(text, f);
  fclose(f);
}

static CommandParseResult parse(const char* json, Command& c) {
  return parse_command_json(json, strlen(json), c);
}

static void test_outbound(const std::string& out_dir) {
  char buf[1024];
  const int64_t ts = 123456;  // robot uptime (millis())

  // Typical robot telemetry: on a task, no environment sensors, obstacle in view.
  TelemetryMsg t = {};
  t.status = RobotStatus::EnRoute;
  strcpy(t.current_node, "cp-01");
  strcpy(t.task_id, "3f2b8c1e-9a4d-4e6f-b1c2-7d8e9f0a1b2c");
  strcpy(t.last_completed_task_id, "9a1b");
  t.battery_pct = 87.46f;
  t.heading_known = true;
  t.heading = Heading::East;
  t.obstacle_cm = 42.37f;
  t.temperature_c = NAN;
  t.humidity_pct = NAN;
  t.light_lux = NAN;
  size_t n = build_telemetry_json(t, "robot-1", ts, buf, sizeof(buf));
  CHECK(n > 0);
  CHECK(strstr(buf, "\"status\":\"en_route\""));
  CHECK(strstr(buf, "\"battery_pct\":87.5"));
  CHECK(strstr(buf, "\"current_node\":\"cp-01\""));
  CHECK(strstr(buf, "\"task_id\":\"3f2b8c1e"));
  CHECK(strstr(buf, "\"timestamp\":123456"));
  CHECK(!strstr(buf, "temperature_c"));
  printf("  telemetry: %s\n", buf);
  write_file(out_dir + "/telemetry_basic.json", buf);

  // No obstacle -> obstacle_cm: null. With environment readings present.
  t.status = RobotStatus::ReturningToDock;
  t.obstacle_cm = NAN;
  t.temperature_c = 23.44f;
  t.humidity_pct = 61.0f;
  t.light_lux = 412.6f;
  n = build_telemetry_json(t, "robot-1", ts, buf, sizeof(buf));
  CHECK(n > 0);
  CHECK(strstr(buf, "\"obstacle_cm\":null"));
  CHECK(strstr(buf, "\"light_lux\":413"));
  printf("  telemetry: %s\n", buf);
  write_file(out_dir + "/telemetry_full.json", buf);

  // Before the first tag: no node, no heading, no task -> nulls.
  TelemetryMsg boot = {};
  boot.status = RobotStatus::Initializing;
  boot.battery_pct = 91.0f;
  boot.obstacle_cm = NAN;
  boot.temperature_c = boot.humidity_pct = boot.light_lux = NAN;
  n = build_telemetry_json(boot, "robot-1", ts, buf, sizeof(buf));
  CHECK(n > 0);
  CHECK(strstr(buf, "\"current_node\":null"));
  CHECK(strstr(buf, "\"heading\":null"));
  CHECK(strstr(buf, "\"task_id\":null"));
  CHECK(strstr(buf, "\"last_completed_task_id\":null"));
  printf("  telemetry: %s\n", buf);
  write_file(out_dir + "/telemetry_boot.json", buf);

  // No battery reading yet -> not built (battery_pct is required).
  boot.battery_pct = NAN;
  CHECK(build_telemetry_json(boot, "robot-1", ts, buf, sizeof(buf)) == 0);

  // Buffer too small -> 0, never a truncated payload.
  CHECK(build_telemetry_json(t, "robot-1", ts, buf, 20) == 0);

  // Event with every optional field.
  RobotEventMsg ev = {};
  ev.event = RobotEventType::ObstacleDetected;
  strcpy(ev.task_id, "3f2b8c1e-9a4d-4e6f-b1c2-7d8e9f0a1b2c");
  strcpy(ev.node_id, "cp-02");
  strcpy(ev.details, "12.5 cm");
  n = build_event_json(ev, "robot-1", ts, buf, sizeof(buf));
  CHECK(n > 0);
  CHECK(strstr(buf, "\"event\":\"obstacle_detected\""));
  printf("  event:     %s\n", buf);
  write_file(out_dir + "/event_full.json", buf);

  // Event with no optional fields -> keys omitted, not "".
  RobotEventMsg ev2 = {};
  ev2.event = RobotEventType::ChargeComplete;
  n = build_event_json(ev2, "robot-1", ts, buf, sizeof(buf));
  CHECK(n > 0);
  CHECK(!strstr(buf, "task_id") && !strstr(buf, "node_id") && !strstr(buf, "details"));
  printf("  event:     %s\n", buf);
  write_file(out_dir + "/event_minimal.json", buf);

  // Every enum value must serialise (the checker validates each one).
  std::string all = "[";
  for (int s = 0; s <= (int)RobotStatus::Initializing; s++) {
    t.status = (RobotStatus)s;
    t.heading = (Heading)(s % 4);
    build_telemetry_json(t, "robot-1", ts, buf, sizeof(buf));
    all += (s ? "," : "") + std::string(buf);
  }
  write_file(out_dir + "/telemetry_all_statuses.json", (all + "]").c_str());

  all = "[";
  for (int e = 0; e <= (int)RobotEventType::Recovery; e++) {
    ev2.event = (RobotEventType)e;
    build_event_json(ev2, "robot-1", ts, buf, sizeof(buf));
    all += (e ? "," : "") + std::string(buf);
  }
  write_file(out_dir + "/event_all_types.json", (all + "]").c_str());
}

static void test_inbound(const std::string& in_dir) {
  Command c;

  // Commands generated by check_contract.mjs from the TypeScript types.
  for (int i = 0;; i++) {
    std::string path = in_dir + "/command_" + std::to_string(i) + ".json";
    FILE* f = fopen(path.c_str(), "r");
    if (!f) break;
    char json[2048];
    size_t len = fread(json, 1, sizeof(json) - 1, f);
    fclose(f);
    json[len] = '\0';
    CommandParseResult r = parse_command_json(json, len, c);
    printf("  %s -> %s (%s, %u waypoints)\n", path.c_str(), to_string(r), to_wire(c.type), c.path_len);
    CHECK(r == CommandParseResult::Ok);
  }

  // Full navigate command with a path of node ids.
  CHECK(parse(R"({"command":"navigate","task_id":"t-1","path":["dock-1","cp-01","water-01"],
                  "target_node":"water-01","action_at_target":"water","duration_ms":900000,
                  "priority":"high","source":"scheduler"})", c) == CommandParseResult::Ok);
  CHECK(c.type == CommandType::Navigate);
  CHECK(c.path_len == 3);
  CHECK(strcmp(c.path[1], "cp-01") == 0);
  CHECK(strcmp(c.target_node, "water-01") == 0);
  CHECK(c.action_at_target == TargetAction::Water);
  CHECK(c.has_duration && c.duration_ms == 900000);
  CHECK(c.priority == TaskPriority::High);
  CHECK(c.source == CommandSource::Scheduler);

  // Minimal stop, priority/source defaulted.
  CHECK(parse(R"({"command":"stop"})", c) == CommandParseResult::Ok);
  CHECK(c.type == CommandType::Stop && c.priority == TaskPriority::Normal);
  CHECK(c.action_at_target == TargetAction::None && !c.has_duration);

  // navigate without a path: the robot plans its own route.
  CHECK(parse(R"({"command":"navigate","task_id":"t-2","target_node":"cp-12"})", c) == CommandParseResult::Ok);
  CHECK(c.path_len == 0);

  // cancel carries a task_id; jog a direction. immediate is ignored.
  CHECK(parse(R"({"command":"cancel","task_id":"t-2","immediate":true})", c) == CommandParseResult::Ok);
  CHECK(c.type == CommandType::Cancel && strcmp(c.task_id, "t-2") == 0);
  CHECK(parse(R"({"command":"jog","direction":"forward"})", c) == CommandParseResult::Ok);
  CHECK(c.type == CommandType::Jog && c.direction == JogDirection::Forward);

  // null optional fields are treated as absent.
  CHECK(parse(R"({"command":"return_to_dock","task_id":null,"priority":"critical","source":"alert"})", c) ==
        CommandParseResult::Ok);

  // Rejections
  CHECK(parse("not json", c) == CommandParseResult::BadJson);
  CHECK(parse("[1,2]", c) == CommandParseResult::NotAnObject);
  CHECK(parse(R"({"path":["0x1"]})", c) == CommandParseResult::MissingCommand);
  CHECK(parse(R"({"command":"dance"})", c) == CommandParseResult::UnknownCommand);
  CHECK(parse(R"({"command":"cancel"})", c) == CommandParseResult::MissingTaskId);
  CHECK(parse(R"({"command":"jog"})", c) == CommandParseResult::BadDirection);
  CHECK(parse(R"({"command":"jog","direction":"sideways"})", c) == CommandParseResult::BadDirection);
  CHECK(parse(R"({"command":"navigate","path":[42]})", c) == CommandParseResult::BadPathEntry);
  CHECK(parse(R"({"command":"navigate","path":[""]})", c) == CommandParseResult::BadPathEntry);
  CHECK(parse(R"({"command":"navigate","path":["a-node-id-much-too-long-to-fit"]})", c) ==
        CommandParseResult::BadPathEntry);
  CHECK(parse(R"({"command":"stop","priority":"urgent"})", c) == CommandParseResult::BadPriority);
  CHECK(parse(R"({"command":"stop","source":"martians"})", c) == CommandParseResult::BadSource);
  CHECK(parse(R"({"command":"navigate","path":["cp-01"],"action_at_target":"dance"})", c) ==
        CommandParseResult::BadAction);
  CHECK(parse(R"({"command":"stop","duration_ms":-5})", c) == CommandParseResult::BadDuration);

  std::string big = R"({"command":"navigate","path":[)";
  for (int i = 0; i < 25; i++) big += std::string(i ? "," : "") + "\"cp-01\"";
  big += "]}";
  CHECK(parse(big.c_str(), c) == CommandParseResult::PathTooLong);
}

static void test_tags_and_battery() {
  char tag[TAG_ID_LEN];
  const uint8_t uid4[] = {0x04, 0xA1, 0xB2, 0xC3};
  CHECK(format_tag_uid(uid4, 4, tag, sizeof(tag)) && strcmp(tag, "0x04A1B2C3") == 0);
  const uint8_t uid10[10] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
  CHECK(format_tag_uid(uid10, 10, tag, sizeof(tag)));  // longest UID fits
  CHECK(!format_tag_uid(uid10, 10, tag, 8));

  CHECK(battery_pct_from_voltage(12.6f, 3) == 100.0f);
  CHECK(battery_pct_from_voltage(13.0f, 3) == 100.0f);
  CHECK(battery_pct_from_voltage(9.6f, 3) == 0.0f);
  CHECK(battery_pct_from_voltage(8.0f, 3) == 0.0f);
  CHECK(fabsf(battery_pct_from_voltage(3.79f * 3, 3) - 50.0f) < 0.01f);
  CHECK(isnan(battery_pct_from_voltage(NAN, 3)));
  float prev = -1;  // monotonic from empty to full
  for (float v = 9.6f; v <= 12.6f; v += 0.05f) {
    float p = battery_pct_from_voltage(v, 3);
    CHECK(p >= prev);
    prev = p;
  }
  printf("  battery: 12.6V=%.0f%%  11.4V=%.0f%%  11.1V=%.0f%%  10.5V=%.0f%%  9.6V=%.0f%%\n",
         battery_pct_from_voltage(12.6f, 3), battery_pct_from_voltage(11.4f, 3),
         battery_pct_from_voltage(11.1f, 3), battery_pct_from_voltage(10.5f, 3),
         battery_pct_from_voltage(9.6f, 3));
}

int main(int argc, char** argv) {
  std::string out_dir = argc > 1 ? argv[1] : "out";
  std::string in_dir = argc > 2 ? argv[2] : "in";

  printf("outbound (robot -> Pi)\n");
  test_outbound(out_dir);
  printf("inbound (Pi -> robot)\n");
  test_inbound(in_dir);
  printf("tags + battery\n");
  test_tags_and_battery();

  printf(failures ? "\n%d FAILURE(S)\n" : "\nall C++ checks passed\n", failures);
  return failures ? 1 : 0;
}
