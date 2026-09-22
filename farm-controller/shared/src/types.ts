// ============================================================
// Farm system types — shared between all Pi services
// ============================================================

// --- Enums ------------

export enum RobotStatus {
  IDLE = "idle",
  EN_ROUTE = "en_route",
  WORKING = "working",
  RETURNING_TO_DOCK = "returning_to_dock",
  DOCKING = "docking",
  CHARGING = "charging",
  LOST = "lost",
  ERROR = "error",
  MANUAL = "manual",
}

// --- Robot event types (discrete, one-time signals)
export enum RobotEventType {
  ARRIVED = "arrived",
  TASK_STARTED = "task_started",
  TASK_COMPLETE = "task_complete",
  TASK_FAILED = "task_failed",
  BATTERY_LOW = "battery_low",
  BATTERY_CRITICAL = "battery_critical",
  OBSTACLE_DETECTED = "obstacle_detected",
  PATH_BLOCKED = "path_blocked",
  DOCK_CONNECTED = "dock_connected",
  CHARGE_COMPLETE = "charge_complete",
  ERROR = "error",
  RECOVERY = "recovery",
}

export enum Heading {
  NORTH = 0,
  EAST = 1,
  SOUTH = 2,
  WEST = 3,
}

export enum Turn {
  STRAIGHT = 0,
  RIGHT = 1,
  U_TURN = 2,
  LEFT = 3,
}

export enum AlertSeverity {
  INFO = "info",
  WARNING = "warning",
  CRITICAL = "critical",
}

export enum TaskPriority {
  LOW = "low",
  NORMAL = "normal",
  HIGH = "high",
  CRITICAL = "critical",
}

export enum TaskStatus {
  PENDING = "pending",
  ASSIGNED = "assigned",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  FAILED = "failed",
}

export enum CommandSource {
  SCHEDULER = "scheduler",
  ALERT = "alert",
  REMOTE = "remote",
  LOCAL = "local",
}

export enum PlantType {
  BASIL = "basil",
  LETTUCE = "lettuce",
  SPINACH = "spinach",
  CILANTRO = "cilantro",
  MINT = "mint",
  STRAWBERRY = "strawberry",
  CUSTOM = "custom",
}

export enum GrowthStage {
  SEEDLING = "seedling",
  VEGETATIVE = "vegetative",
  MATURE = "mature",
  HARVEST_READY = "harvest_ready",
}

// --- MQTT message payloads -----------

/** Published by robot to farm/robot/{id}/telemetry */
export interface RobotTelemetry {
  robot_id: string;
  status: RobotStatus;
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
  command: "navigate" | "return_to_dock" | "stop" | "resume";
  task_id?: string;
  path?: string[];
  target_node?: string;
  action_at_target?: "water" | "grow" | "harvest" | "charge" | "idle";
  duration_ms?: number;
  priority: TaskPriority;
  source: CommandSource;
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

/** Published to farm/elevator/{id}/command */
export interface ElevatorCommand {
  command: "go_to_level" | "stop" | "calibrate";
  target_level: number;
  requested_by: string;
}

/** Published by shelf sensor nodes to farm/shelf/{id}/sensors */
export interface ShelfSensorData {
  shelf_id: string;
  level: number;
  temperature_c: number;
  humidity_pct: number;
  light_lux: number;
  soil_moisture_pct: number;
  ph: number;
  timestamp: number;
}

/** Published to farm/alerts by alert engine or any service */
export interface FarmAlert {
  alert_id: string;
  severity: AlertSeverity;
  source: string;
  source_type: "robot" | "elevator" | "shelf" | "system";
  message: string;
  metric: string;
  value: number;
  threshold: number;
  timestamp: number;
}

/** Published to farm/commands/remote by Supabase bridge */
export interface RemoteCommand {
  id: string;
  command: RobotCommand;
  issued_by: string;
  issued_at: number;
}

// --- Orchestrator internal types --------

export interface FarmTask {
  task_id: string;
  type: "water" | "grow" | "harvest" | "custom";
  target_node: string;
  duration_ms?: number;
  priority: TaskPriority;
  source: CommandSource;
  created_at: number;
  status: TaskStatus;
  assigned_robot?: string;
  assigned_at?: number;
  completed_at?: number;
  error?: string;
}

export interface RobotState {
  id: string;
  status: RobotStatus;
  current_node: string;
  heading: Heading;
  battery_pct: number;
  assigned_task: FarmTask | null;
  expected_path: string[];
  waypoints_hit: string[];
  last_seen: number;
  plant?: PlantRecord;
}

// --- Topology types -------------

export type NodeType = "checkpoint" | "elevator" | "dock" | "water";

export interface GraphNode {
  id: string;
  tag_id: string;
  x: number;
  y: number;
  z: number;
  type: NodeType;
}

export interface GraphEdge {
  from: string;
  to: string;
  cost: number;
  bidirectional: boolean;
}

export interface FarmTopology {
  version: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface PlantRecord {
  robot_id: string;
  plant_type: PlantType;
  growth_stage: GrowthStage;
  planted_date: string;            // ISO 8601
  last_watered_at: number | null;  // Unix ms
  last_light_at: number | null;    // Unix ms
  total_light_ms: number;
  total_water_cycles: number;
  notes?: string;
}

// --- Alert threshold config ---------

export interface SensorThreshold {
  metric: string;
  min: number;
  max: number;
  severity: AlertSeverity;
  message_template: string;
}

export interface AlertConfig {
  thresholds: SensorThreshold[];
  robot_heartbeat_timeout_ms: number;
  elevator_heartbeat_timeout_ms: number;
}

export interface PlantSchedule {
  plant_type: PlantType;
  light_duration_ms: number;
  light_interval_ms: number;
  water_duration_ms: number;
  water_interval_ms: number;
  harvest_after_days?: number;
}

export interface OrchestratorConfig {
  watchdog_interval_ms: number;
  heartbeat_timeout_ms: number;
  battery_low_pct: number;
  battery_critical_pct: number;
  charge_complete_pct: number;
  max_task_retries: number;
  task_retry_delay_ms: number;
  plant_schedules: PlantSchedule[];
}