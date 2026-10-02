// graph.h
// Navigation graph as a const array

#pragma once

#include <stdint.h>

// Index of a node in the flash graph, in topology.json node order.
using NodeIndex = uint8_t;
constexpr NodeIndex NO_NODE = 0xFF;
