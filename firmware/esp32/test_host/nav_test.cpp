// nav_test.cpp
// Runs the firmware's flash graph + nav helpers on a laptop (no ESP32).
//
//   1. Asserts the edge cases (bad indices, unknown tags, short buffers).
//   2. Writes every route, heading and turn to a JSON file so check_nav.mjs
//      can compare them with navigation.ts, the orchestrator's code.
//
// run.sh builds it twice: with src/graph.cpp (the farm) and with a graph
// generated from fixtures/tie_topology.json (equal-cost ties, one-way edges).
//
//   nav_test <out.json>

#include <stdio.h>
#include <string.h>

#include "graph.h"
#include "utils/nav_helpers.h"

static int failures = 0;
#define CHECK(cond)                                                   \
  do {                                                                \
    if (!(cond)) {                                                    \
      printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);        \
      failures++;                                                     \
    }                                                                 \
  } while (0)

static void test_edge_cases() {
  NodeIndex path[MAX_PATH_LEN];
  const NodeIndex last = GRAPH_NODE_COUNT - 1;

  CHECK(node_by_id(nullptr) == NO_NODE);
  CHECK(node_by_id("") == NO_NODE);
  CHECK(node_by_id("no-such-node") == NO_NODE);
  CHECK(node_by_tag(nullptr) == NO_NODE);
  CHECK(node_by_tag("0x00") == NO_NODE);
  // Tag ids are exact: the sensor task always formats uppercase.
  CHECK(node_by_tag("") == NO_NODE);
  CHECK(GRAPH_NODES[GRAPH_DOCK].type == NodeType::Dock);

  CHECK(dijkstra(NO_NODE, 0, path, MAX_PATH_LEN) == 0);
  CHECK(dijkstra(0, NO_NODE, path, MAX_PATH_LEN) == 0);
  CHECK(dijkstra(GRAPH_NODE_COUNT, 0, path, MAX_PATH_LEN) == 0);
  CHECK(dijkstra(last, last, path, MAX_PATH_LEN) == 1 && path[0] == last);
  CHECK(dijkstra(last, last, path, 0) == 0);

  // A path that doesn't fit is refused whole, never truncated.
  for (NodeIndex a = 0; a < GRAPH_NODE_COUNT; a++) {
    for (NodeIndex b = 0; b < GRAPH_NODE_COUNT; b++) {
      uint8_t len = dijkstra(a, b, path, MAX_PATH_LEN);
      if (len > 1) CHECK(dijkstra(a, b, path, len - 1) == 0);
    }
  }

  Heading h = Heading::North;
  CHECK(!compute_heading(0, 0, h));
  CHECK(!compute_heading(NO_NODE, 0, h));
}

static void write_id(FILE* f, NodeIndex n) { fprintf(f, "\"%s\"", GRAPH_NODES[n].id); }

static bool write_json(const char* out_path) {
  FILE* f = fopen(out_path, "w");
  if (!f) {
    printf("cannot write %s\n", out_path);
    return false;
  }
  fprintf(f, "{\n\"version\": \"%s\",\n\"dock\": ", GRAPH_VERSION);
  write_id(f, GRAPH_DOCK);

  fprintf(f, ",\n\"nodes\": [");
  for (NodeIndex i = 0; i < GRAPH_NODE_COUNT; i++) {
    fprintf(f, "%s", i ? ", " : "");
    write_id(f, i);
  }

  // Tag -> node for every node, as the robot resolves an RFID read.
  fprintf(f, "],\n\"tags\": [");
  for (NodeIndex i = 0; i < GRAPH_NODE_COUNT; i++) {
    NodeIndex n = node_by_tag(GRAPH_NODES[i].tag_id);
    fprintf(f, "%s[\"%s\", ", i ? ", " : "", GRAPH_NODES[i].tag_id);
    if (n == NO_NODE) fprintf(f, "null]");
    else {
      write_id(f, n);
      fprintf(f, "]");
    }
  }

  fprintf(f, "],\n\"paths\": [\n");
  NodeIndex path[MAX_PATH_LEN];
  bool first = true;
  for (NodeIndex a = 0; a < GRAPH_NODE_COUNT; a++) {
    for (NodeIndex b = 0; b < GRAPH_NODE_COUNT; b++) {
      CHECK(node_by_id(GRAPH_NODES[a].id) == a);
      uint8_t len = dijkstra(a, b, path, MAX_PATH_LEN);
      fprintf(f, "%s  [", first ? "" : ",\n");
      first = false;
      write_id(f, a);
      fprintf(f, ", ");
      write_id(f, b);
      if (len == 0) {
        fprintf(f, ", null]");
        continue;
      }
      fprintf(f, ", [");
      for (uint8_t i = 0; i < len; i++) {
        fprintf(f, "%s", i ? ", " : "");
        write_id(f, path[i]);
      }
      fprintf(f, "]]");
    }
  }

  fprintf(f, "\n],\n\"headings\": [\n");
  first = true;
  for (NodeIndex a = 0; a < GRAPH_NODE_COUNT; a++) {
    for (NodeIndex b = 0; b < GRAPH_NODE_COUNT; b++) {
      Heading h;
      fprintf(f, "%s  [", first ? "" : ",\n");
      first = false;
      write_id(f, a);
      fprintf(f, ", ");
      write_id(f, b);
      if (compute_heading(a, b, h)) fprintf(f, ", %d]", (int)h);
      else fprintf(f, ", null]");
    }
  }

  fprintf(f, "\n],\n\"turns\": [");
  for (int c = 0; c < 4; c++) {
    for (int d = 0; d < 4; d++) {
      Turn t = compute_turn((Heading)c, (Heading)d);
      fprintf(f, "%s[%d, %d, %d]", c || d ? ", " : "", c, d, (int)t);
    }
  }
  fprintf(f, "]\n}\n");
  fclose(f);
  return true;
}

int main(int argc, char** argv) {
  if (argc < 2) {
    printf("usage: nav_test <out.json>\n");
    return 2;
  }
  test_edge_cases();
  if (!write_json(argv[1])) failures++;
  printf("nav_test (%s, %u nodes): %s\n", GRAPH_VERSION, GRAPH_NODE_COUNT,
         failures ? "FAILED" : "passed");
  return failures ? 1 : 0;
}
