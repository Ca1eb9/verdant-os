import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getOperator } from "@/lib/auth";
import { getSupabaseReadConfig } from "@/lib/supabase-config";
import type { CommandRecord } from "@/lib/farm/data-source";
import type { ActionAtTarget, CommandType, RemoteCommand, RobotCommand, TaskPriority } from "@/lib/farm/types";

export const dynamic = "force-dynamic";

const TABLE = "remote_commands";
const COLUMNS = "id,robot_id,command,issued_by,issued_at,status,error";
const COMMANDS: CommandType[] = ["navigate", "return_to_dock", "stop", "resume"];
const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "critical"];
const ACTIONS: ActionAtTarget[] = ["water", "grow", "harvest", "charge", "idle"];
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

function client(key: string, url: string) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Validate the operator's request and build the RobotCommand the farm will receive */
function parseCommand(body: unknown): { robotId: string; command: RobotCommand } | string {
  if (!isRecord(body) || !isRecord(body.command)) return "Request body must include robot_id and command.";
  const { robot_id: robotId } = body;
  const raw = body.command;

  if (typeof robotId !== "string" || !ID_PATTERN.test(robotId)) return "robot_id is missing or invalid.";
  if (!COMMANDS.includes(raw.command as CommandType)) return "command must be navigate, return_to_dock, stop or resume.";

  const type = raw.command as CommandType;
  const priority = PRIORITIES.includes(raw.priority as TaskPriority) ? (raw.priority as TaskPriority) : "normal";
  const command: RobotCommand = { command: type, priority, source: "remote" };

  if (typeof raw.immediate === "boolean") command.immediate = raw.immediate;
  // resume always takes effect right away
  if (type === "resume") command.immediate = true;

  if (type === "navigate") {
    if (typeof raw.target_node !== "string" || !ID_PATTERN.test(raw.target_node)) {
      return "navigate needs a target_node.";
    }
    command.target_node = raw.target_node;
    if (raw.action_at_target !== undefined) {
      if (!ACTIONS.includes(raw.action_at_target as ActionAtTarget)) return "action_at_target is not a known action.";
      command.action_at_target = raw.action_at_target as ActionAtTarget;
    }
    if (raw.duration_ms !== undefined) {
      const ms = raw.duration_ms;
      if (typeof ms !== "number" || !Number.isInteger(ms) || ms <= 0 || ms > MAX_DURATION_MS) {
        return "duration_ms must be a whole number of milliseconds up to 24 hours.";
      }
      command.duration_ms = ms;
    }
  }

  return { robotId, command };
}

export async function GET(request: Request) {
  const config = getSupabaseReadConfig();
  if (!config.url || !config.key) {
    return NextResponse.json({ commands: [], error: "Supabase is not configured." });
  }

  const robotId = new URL(request.url).searchParams.get("robot_id");
  let query = client(config.key, config.url)
    .from(TABLE)
    .select(COLUMNS)
    .order("issued_at", { ascending: false })
    .limit(10);
  if (robotId && ID_PATTERN.test(robotId)) query = query.eq("robot_id", robotId);

  const { data, error: readError } = await query;
  if (readError) return NextResponse.json({ commands: [], error: readError.message });
  return NextResponse.json({ commands: (data ?? []) as CommandRecord[] });
}

export async function POST(request: Request) {
  // the middleware already requires a session; this also names who sent the command
  const operator = await getOperator();
  if (!operator) return error("Sign in to send commands.", 401);

  const parsed = parseCommand(await request.json().catch(() => null));
  if (typeof parsed === "string") return error(parsed, 400);

  const config = getSupabaseReadConfig();
  if (!config.url || !config.key || !config.hasServiceRoleKey) {
    return error("Commands need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.", 503);
  }

  const remote: RemoteCommand = {
    id: randomUUID(),
    robot_id: parsed.robotId,
    command: parsed.command,
    issued_by: operator.email,
    issued_at: Date.now(),
  };

  const { data, error: insertError } = await client(config.key, config.url)
    .from(TABLE)
    .insert({ ...remote, status: "pending" })
    .select(COLUMNS)
    .single<CommandRecord>();

  if (insertError) return error(insertError.message, 502);
  return NextResponse.json({ command: data }, { status: 201 });
}
