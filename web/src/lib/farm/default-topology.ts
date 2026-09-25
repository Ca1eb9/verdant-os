import type { FarmTopology } from "@/lib/farm/types";

/**
 * Layout shown until the farm publishes its real topology. It reproduces the
 * side-view design mockup: two aisles (y = 0, 1), three levels (z = 0..2),
 * one charging dock and an elevator shaft per aisle.
 */
export const DEFAULT_TOPOLOGY: FarmTopology = {
  version: "0.0.0-default",
  name: "Default farm layout",
  nodes: [
    { id: "dock-1", tag_id: "0x1D5E", x: 0, y: 0, z: 0, type: "dock" },

    // Aisle A
    { id: "cp-a01", tag_id: "0x2A01", x: 1, y: 0, z: 0, type: "checkpoint" },
    { id: "water-a0", tag_id: "0x3A00", x: 2, y: 0, z: 0, type: "water" },
    { id: "elev-a-L0", tag_id: "0x8A00", x: 4, y: 0, z: 0, type: "elevator" },
    { id: "elev-a-L1", tag_id: "0x8A01", x: 4, y: 0, z: 1, type: "elevator" },
    { id: "water-a1", tag_id: "0x3A01", x: 2, y: 0, z: 1, type: "water" },
    { id: "elev-a-L2", tag_id: "0x8A02", x: 4, y: 0, z: 2, type: "elevator" },
    { id: "cp-a21", tag_id: "0x2A21", x: 3, y: 0, z: 2, type: "checkpoint" },

    // Aisle B
    { id: "elev-b-L0", tag_id: "0x8B00", x: 4, y: 1, z: 0, type: "elevator" },
    { id: "cp-b01", tag_id: "0x2B01", x: 3, y: 1, z: 0, type: "checkpoint" },
    { id: "elev-b-L1", tag_id: "0x8B01", x: 4, y: 1, z: 1, type: "elevator" },
    { id: "cp-b11", tag_id: "0x2B11", x: 1, y: 1, z: 1, type: "checkpoint" },
    { id: "cp-b12", tag_id: "0x2B12", x: 3, y: 1, z: 1, type: "checkpoint" },
    { id: "elev-b-L2", tag_id: "0x8B02", x: 4, y: 1, z: 2, type: "elevator" },
    { id: "water-b2", tag_id: "0x3B02", x: 2, y: 1, z: 2, type: "water" },
  ],
  edges: [
    { from: "dock-1", to: "cp-a01", cost: 1 },
    { from: "cp-a01", to: "water-a0", cost: 1 },
    { from: "water-a0", to: "elev-a-L0", cost: 1 },
    { from: "elev-a-L1", to: "water-a1", cost: 1 },
    { from: "elev-a-L2", to: "cp-a21", cost: 1 },
    { from: "elev-a-L0", to: "elev-a-L1", cost: 3 },
    { from: "elev-a-L1", to: "elev-a-L2", cost: 3 },

    { from: "elev-a-L0", to: "elev-b-L0", cost: 2 },
    { from: "elev-b-L0", to: "cp-b01", cost: 1 },
    { from: "elev-b-L1", to: "cp-b12", cost: 1 },
    { from: "cp-b12", to: "cp-b11", cost: 1 },
    { from: "elev-b-L2", to: "water-b2", cost: 1 },
    { from: "elev-b-L0", to: "elev-b-L1", cost: 3 },
    { from: "elev-b-L1", to: "elev-b-L2", cost: 3 },
  ],
};
