// ============================================================
// Payload validation — incoming MQTT JSON is untrusted until
// it matches the shared types. Invalid messages are dropped.
// ============================================================

import {
  type RobotTelemetry,
  type RobotEvent,
  type RemoteCommand,
  RobotStatus,
  RobotEventType,
  Heading,
  TaskPriority,
  CommandSource,
} from "@farm/shared";

const STATUSES = new Set<string>(Object.values(RobotStatus));
const EVENT_TYPES = new Set<string>(Object.values(RobotEventType));
const HEADINGS = new Set<unknown>([Heading.NORTH, Heading.EAST, Heading.SOUTH, Heading.WEST]);
const PRIORITIES = new Set<string>(Object.values(TaskPriority));
const SOURCES = new Set<string>(Object.values(CommandSource));
const COMMANDS = new Set(["navigate", "return_to_dock", "stop", "resume"]);
const ACTIONS = new Set(["water", "grow", "harvest", "charge", "idle"]);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optStr = (v: unknown) => v === undefined || typeof v === "string";
const optNum = (v: unknown) => v === undefined || isNum(v);
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";

/** `nodes` is the set of valid node ids from the topology */
export function isRobotTelemetry(v: unknown, nodes: ReadonlySet<string>): v is RobotTelemetry {
  return (
    isObj(v) &&
    isStr(v.robot_id) &&
    STATUSES.has(v.status as string) &&
    (v.current_node === null || (isStr(v.current_node) && nodes.has(v.current_node))) &&
    (v.task_id === null || isStr(v.task_id)) &&
    (v.last_completed_task_id === null || isStr(v.last_completed_task_id)) &&
    isNum(v.battery_pct) &&
    (v.heading === null || HEADINGS.has(v.heading)) &&
    (v.obstacle_cm === undefined || v.obstacle_cm === null || isNum(v.obstacle_cm)) &&
    optNum(v.temperature_c) &&
    optNum(v.humidity_pct) &&
    optNum(v.light_lux) &&
    isNum(v.timestamp)
  );
}

export function isRobotEvent(v: unknown): v is RobotEvent {
  return (
    isObj(v) &&
    isStr(v.robot_id) &&
    EVENT_TYPES.has(v.event as string) &&
    optStr(v.task_id) &&
    optStr(v.node_id) &&
    optStr(v.details) &&
    isNum(v.timestamp)
  );
}

export function isRemoteCommand(v: unknown): v is RemoteCommand {
  if (!isObj(v) || !isObj(v.command)) return false;
  const c = v.command;
  return (
    isStr(v.id) &&
    optStr(v.robot_id) &&
    optBool(v.immediate) &&
    optBool(v.include_path) &&
    isStr(v.issued_by) &&
    isNum(v.issued_at) &&
    COMMANDS.has(c.command as string) &&
    optStr(c.task_id) &&
    (c.path === undefined || (Array.isArray(c.path) && c.path.every(isStr))) &&
    optStr(c.target_node) &&
    (c.action_at_target === undefined || ACTIONS.has(c.action_at_target as string)) &&
    optNum(c.duration_ms) &&
    PRIORITIES.has(c.priority as string) &&
    SOURCES.has(c.source as string)
  );
}
