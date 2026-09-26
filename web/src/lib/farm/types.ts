// ============================================================
// Farm system types used by the dashboard.
//
// Mirrors farm-controller/shared/src/types.ts. Vercel only builds web/,
// so the shared package cannot be imported directly. Keep in sync.
// ============================================================

export type RobotStatus =
  | "idle"
  | "en_route"
  | "working"
  | "returning_to_dock"
  | "docking"
  | "charging"
  | "lost"
  | "error"
  | "manual";

export type RobotEventType =
  | "arrived"
  | "task_started"
  | "task_complete"
  | "task_failed"
  | "battery_low"
  | "battery_critical"
  | "obstacle_detected"
  | "path_blocked"
  | "dock_connected"
  | "charge_complete"
  | "error"
  | "recovery";

/** N = 0, E = 1, S = 2, W = 3 */
export type Heading = 0 | 1 | 2 | 3;

export type TaskPriority = "low" | "normal" | "high" | "critical";

export type CommandSource = "scheduler" | "alert" | "remote" | "local";

export type PlantType =
  | "basil"
  | "lettuce"
  | "spinach"
  | "cilantro"
  | "mint"
  | "strawberry"
  | "custom";

export type GrowthStage = "seedling" | "vegetative" | "mature" | "harvest_ready";

export type CommandType = "navigate" | "return_to_dock" | "stop" | "resume";

export type ActionAtTarget = "water" | "grow" | "harvest" | "charge" | "idle";

/** Published by robot to farm/robot/{id}/telemetry */
export interface RobotTelemetry {
  robot_id: string;
  status: RobotStatus;
  /** RFID tag id of the last node the robot read */
  current_node: string;
  battery_pct: number;
  heading: Heading;
  obstacle_cm?: number | null;
  temperature_c?: number;
  humidity_pct?: number;
  light_lux?: number;
  timestamp: number;
}

/** Published to farm/robot/{id}/command */
export interface RobotCommand {
  command: CommandType;
  task_id?: string;
  path?: string[];
  target_node?: string;
  action_at_target?: ActionAtTarget;
  duration_ms?: number;
  priority: TaskPriority;
  source: CommandSource;
  /** Interrupt the current task instead of queueing behind it */
  immediate?: boolean;
}

/** Published by robot to farm/robot/{id}/events */
export interface RobotEvent {
  robot_id: string;
  event: RobotEventType;
  task_id?: string;
  node_id?: string;
  details?: string;
  timestamp: number;
}

/** Published by elevator to farm/elevator/{id}/telemetry */
export interface ElevatorTelemetry {
  elevator_id: string;
  current_level: number;
  status: "idle" | "moving" | "loading" | "error";
  target_level: number;
  load_detected: boolean;
  timestamp: number;
}

/**
 * Published to farm/commands/remote by the Supabase bridge.
 * robot_id is not in the shared type yet; the bridge needs it to pick
 * farm/robot/{id}/command.
 */
export interface RemoteCommand {
  id: string;
  robot_id: string;
  command: RobotCommand;
  issued_by: string;
  issued_at: number;
}

export interface PlantRecord {
  robot_id: string;
  plant_type: PlantType;
  growth_stage: GrowthStage;
  planted_date: string;
  last_watered_at: number | null;
  last_light_at: number | null;
  total_light_ms: number;
  total_water_cycles: number;
  notes?: string;
}

// --- Topology ------------------------------------------------

export type NodeType = "checkpoint" | "elevator" | "dock" | "water";

export interface GraphNode {
  id: string;
  tag_id: string;
  /** Along the shelf row (left to right) */
  x: number;
  /** Depth of the farm (front to back), one aisle per value */
  y: number;
  /** Shelf level, 0 = lowest */
  z: number;
  type: NodeType;
}

export interface GraphEdge {
  from: string;
  to: string;
  cost: number;
  bidirectional?: boolean;
}

export interface FarmTopology {
  version: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
