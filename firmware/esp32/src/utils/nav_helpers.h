// nav_helpers.h
// Dijkstra, heading math, turn computation over the flash graph.
//
// Mirrors farm-controller/shared/src/navigation.ts. The orchestrator plans
// the same routes to check for deviations, so these must give exactly the
// same answers, ties included. test_host/check_nav.mjs compares every route,
// heading and turn against the TypeScript.
//
// Pure C++ (no Arduino or FreeRTOS calls), so test_host can build it.

#pragma once

#include <stdint.h>

#include "../graph.h"
#include "../types.h"

// Node lookups. NO_NODE if there's no match (or the argument is null).
NodeIndex node_by_id(const char* id);
NodeIndex node_by_tag(const char* tag_id);

// Shortest path from `start` to `goal`, both ends included, written to `out`.
// Returns the number of nodes (1 when start == goal), or 0 if there's no
// path, either index is invalid, or the path doesn't fit in `cap`.
uint8_t dijkstra(NodeIndex start, NodeIndex goal, NodeIndex* out, uint8_t cap);

// computeHeading(): direction of travel from `from` to `to`. Returns false
// for a move with no x/y change (elevator): the heading doesn't change.
bool compute_heading(NodeIndex from, NodeIndex to, Heading& out);

// computeTurn(): turn needed to face `desired` when facing `current`.
Turn compute_turn(Heading current, Heading desired);
