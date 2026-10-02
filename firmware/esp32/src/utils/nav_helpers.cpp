// nav_helpers.cpp
// Dijkstra, heading math, turn computation. See nav_helpers.h.

#include "nav_helpers.h"

#include <math.h>
#include <string.h>

NodeIndex node_by_id(const char* id) {
  if (!id) return NO_NODE;
  for (uint8_t i = 0; i < GRAPH_NODE_COUNT; i++) {
    if (strcmp(GRAPH_NODES[i].id, id) == 0) return i;
  }
  return NO_NODE;
}

NodeIndex node_by_tag(const char* tag_id) {
  if (!tag_id) return NO_NODE;
  for (uint8_t i = 0; i < GRAPH_NODE_COUNT; i++) {
    if (strcmp(GRAPH_NODES[i].tag_id, tag_id) == 0) return i;
  }
  return NO_NODE;
}

// Step for step the same as dijkstra() in navigation.ts. Scanning the edge
// list in order and taking both directions of a bidirectional edge visits
// neighbours in the same order as its adjacency lists. Tie-breaks must stay
// as they are: strict < everywhere, first node in topology order wins.
uint8_t dijkstra(NodeIndex start, NodeIndex goal, NodeIndex* out, uint8_t cap) {
  if (start >= GRAPH_NODE_COUNT || goal >= GRAPH_NODE_COUNT) return 0;

  double dist[NO_NODE];
  NodeIndex prev[NO_NODE];
  bool visited[NO_NODE];
  for (uint8_t i = 0; i < GRAPH_NODE_COUNT; i++) {
    dist[i] = INFINITY;
    prev[i] = NO_NODE;
    visited[i] = false;
  }
  dist[start] = 0;

  for (;;) {
    NodeIndex current = NO_NODE;
    double current_dist = INFINITY;
    for (uint8_t i = 0; i < GRAPH_NODE_COUNT; i++) {
      if (!visited[i] && dist[i] < current_dist) {
        current = i;
        current_dist = dist[i];
      }
    }
    if (current == NO_NODE || current == goal) break;
    visited[current] = true;

    for (uint16_t e = 0; e < GRAPH_EDGE_COUNT; e++) {
      const GraphEdge& edge = GRAPH_EDGES[e];
      for (int dir = 0; dir < 2; dir++) {
        NodeIndex neighbor;
        if (dir == 0 && edge.from == current) neighbor = edge.to;
        else if (dir == 1 && edge.bidirectional && edge.to == current) neighbor = edge.from;
        else continue;
        if (visited[neighbor]) continue;
        double new_dist = current_dist + edge.cost;
        if (new_dist < dist[neighbor]) {
          dist[neighbor] = new_dist;
          prev[neighbor] = current;
        }
      }
    }
  }

  if (isinf(dist[goal])) return 0;

  uint8_t len = 0;
  for (NodeIndex n = goal; n != NO_NODE; n = prev[n]) len++;
  if (len > cap) return 0;
  uint8_t i = len;
  for (NodeIndex n = goal; n != NO_NODE; n = prev[n]) out[--i] = n;
  return len;
}

bool compute_heading(NodeIndex from, NodeIndex to, Heading& out) {
  if (from >= GRAPH_NODE_COUNT || to >= GRAPH_NODE_COUNT) return false;
  double dx = GRAPH_NODES[to].x - GRAPH_NODES[from].x;
  double dy = GRAPH_NODES[to].y - GRAPH_NODES[from].y;

  if (dx == 0 && dy == 0) return false;

  // Same precedence as computeHeading(): any y change wins over x.
  if (dy > 0) out = Heading::North;
  else if (dy < 0) out = Heading::South;
  else if (dx > 0) out = Heading::East;
  else out = Heading::West;
  return true;
}

Turn compute_turn(Heading current, Heading desired) {
  return static_cast<Turn>(((int)desired - (int)current + 4) % 4);
}
