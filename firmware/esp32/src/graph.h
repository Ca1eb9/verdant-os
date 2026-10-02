// graph.h
// Navigation graph as a const array (in flash), so the robot can plan routes
// (e.g. back to the dock) without the Pi.
//
// graph.cpp is generated from farm-controller/topology.json by
// tools/gen_graph.mjs, keeping node and edge order exactly. Node ids, tag ids
// and coordinates match the Pi; the dock is the node with type "dock".

#pragma once

#include <stdint.h>

// Index of a node in the flash graph, in topology.json node order.
using NodeIndex = uint8_t;
constexpr NodeIndex NO_NODE = 0xFF;

enum class NodeType : uint8_t { Checkpoint, Elevator, Dock, Water };

struct GraphNode {
  const char* id;      // node id: what goes on the wire
  const char* tag_id;  // RFID UID as the sensor task formats it ("0x04A1B2C3")
  // double, like the JS numbers the Pi compares
  double x;            // +x is east
  double y;            // +y is north
  double z;            // level
  NodeType type;
};

// Usable both ways unless bidirectional is false.
struct GraphEdge {
  NodeIndex from;
  NodeIndex to;
  double cost;         // double, like the JS numbers the Pi sums
  bool bidirectional;
};

extern const char GRAPH_VERSION[];  // topology.json "version"
extern const GraphNode GRAPH_NODES[];
extern const uint8_t GRAPH_NODE_COUNT;
extern const GraphEdge GRAPH_EDGES[];
extern const uint16_t GRAPH_EDGE_COUNT;
extern const NodeIndex GRAPH_DOCK;
