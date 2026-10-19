// ============================================================
// remote_commands rows → RemoteCommand
//
// Rows come from Supabase, so they're untrusted until checked. The
// checks match the orchestrator's isRemoteCommand: it drops anything
// else without a word, so a row it would drop is marked failed here
// rather than "sent".
// ============================================================

import { type RemoteCommand, TaskPriority, CommandSource } from "@farm/shared";

const PRIORITIES = new Set<string>(Object.values(TaskPriority));
const SOURCES = new Set<string>(Object.values(CommandSource));
const COMMANDS = new Set([
  "navigate", "return_to_dock", "stop", "resume", "cancel", "jog", "connect_controller", "charge_complete",
]);
/** Farm network only (AGENTS.md); the dashboard's route refuses them too */
const LOCAL_ONLY = new Set(["jog", "connect_controller"]);
const DIRECTIONS = new Set(["forward", "backward"]);
const ACTIONS = new Set(["water", "grow", "harvest", "charge", "idle"]);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optStr = (v: unknown) => v === undefined || typeof v === "string";
const optNum = (v: unknown) => v === undefined || isNum(v);
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";

/** The RemoteCommand to publish, or why the row can't be sent */
export function toRemoteCommand(row: Obj): RemoteCommand | string {
  if (!isStr(row.id)) return "invalid: id";
  if (!isStr(row.robot_id)) return "invalid: robot_id";
  if (!isStr(row.issued_by)) return "invalid: issued_by";
  // bigint columns can arrive as strings
  const issuedAt = Number(row.issued_at);
  if (!isNum(issuedAt)) return "invalid: issued_at";

  const c = row.command;
  if (!isObj(c)) return "invalid: command";
  if (!COMMANDS.has(c.command as string)) return `invalid: unknown command "${String(c.command)}"`;
  if (LOCAL_ONLY.has(c.command as string)) return `${c.command} only works on the farm network`;
  const valid =
    optStr(c.task_id) &&
    (c.path === undefined || (Array.isArray(c.path) && c.path.every(isStr))) &&
    optStr(c.target_node) &&
    (c.action_at_target === undefined || ACTIONS.has(c.action_at_target as string)) &&
    optNum(c.duration_ms) &&
    optBool(c.immediate) &&
    (c.direction === undefined || DIRECTIONS.has(c.direction as string)) &&
    PRIORITIES.has(c.priority as string) &&
    SOURCES.has(c.source as string);
  if (!valid) return "invalid: command fields";

  return {
    id: row.id,
    robot_id: row.robot_id,
    command: c as unknown as RemoteCommand["command"],
    issued_by: row.issued_by,
    issued_at: issuedAt,
  };
}
