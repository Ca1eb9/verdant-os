// ============================================================
// Supabase bridge
//
// Syncs this farm's MQTT bus with the team's Supabase project, for
// the remote dashboard: relays remote commands in, mirrors farm
// data out and marks the farm online. One bridge per farm (Pi).
//
// Run:  npx tsx src/index.ts
// Env:  deploy/env/supabase-bridge.env.example
// ============================================================

import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";
import { createClient } from "@supabase/supabase-js";
import { createMqttClient, LogOnce, TOPICS, type TypedMqttClient } from "@farm/shared";

import { toRemoteCommand } from "./commands.js";
import { loadConfig, loadEnv, type BridgeConfig, type BridgeEnv } from "./config.js";

// --- Config --------------------------------------------------

const CONFIG_PATH = process.env.CONFIG_PATH ?? "../../supabase-bridge-config.json";

let env: BridgeEnv;
let config: BridgeConfig;
try {
  env = loadEnv(process.env);
} catch (err) {
  console.error(`[FATAL] Bad supabase bridge settings: ${(err as Error).message}`);
  process.exit(1);
}
try {
  config = loadConfig(fileURLToPath(new URL(CONFIG_PATH, import.meta.url)));
} catch (err) {
  console.error(`[FATAL] Bad supabase bridge config (${CONFIG_PATH}): ${(err as Error).message}`);
  process.exit(1);
}

const supabase = createClient(env.supabaseUrl, env.serviceKey, {
  // A server key: no user session to keep or refresh
  auth: { persistSession: false, autoRefreshToken: false },
});

let mqtt: TypedMqttClient;
let shuttingDown = false;
const logs = new LogOnce();

// --- Startup check -------------------------------------------

/**
 * A FARM_ID with no farms row can't write anything (the foreign keys refuse
 * it), so that and a rejected key stop the bridge. Anything else (no
 * internet at boot) is retried: the farm must not need the cloud to start.
 */
async function waitForFarm(): Promise<string> {
  for (;;) {
    const { data, error, status } = await supabase
      .from("farms")
      .select("name")
      .eq("id", env.farmId)
      .maybeSingle();

    if (!error && data) {
      logs.ok("farm check", "[BRIDGE] Supabase reachable again");
      return data.name as string;
    }
    if (!error) {
      throw new Error(`no row in the farms table with id "${env.farmId}": add it (docs/SUPABASE-SETUP.md, step 3) or fix FARM_ID`);
    }
    if (status === 401) {
      throw new Error(`Supabase refused the key (${error.message}): check SUPABASE_SERVICE_ROLE_KEY`);
    }
    // Postgres insufficient_privilege: the key is fine, the role has no grant on the table
    if (error.code === "42501") {
      throw new Error(`Supabase accepted the key but the database refused it (${error.message}): the tables are missing their grants`);
    }
    logs.warn("farm check",
      `[BRIDGE] Can't reach Supabase to check the farm (${error.message}), retrying every ${config.retry_interval_ms} ms (logged once)`);
    await sleep(config.retry_interval_ms);
  }
}

// --- Inbound: remote commands --------------------------------
//
// Realtime only says a row arrived; each drain then reads every pending row
// of this farm from the table, oldest first. That also picks up rows
// inserted while the bridge was offline, on every (re)connect.

let draining = false;
let drainAgain = false;

/** Runs drains one at a time; a trigger during a drain runs one more after it */
async function drainCommands() {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    do {
      drainAgain = false;
      await drainOnce();
    } while (drainAgain);
    logs.ok("commands", "[CMD] Relaying remote commands again");
  } catch (err) {
    logs.warn("commands", `[CMD] Can't relay remote commands: ${(err as Error).message} (logged once; retried on the next reconnect or command)`);
  } finally {
    draining = false;
  }
}

async function drainOnce() {
  // Never let mqtt.js queue a command to send late: it stays pending (and
  // goes stale if the broker is gone long) until the broker is back
  if (!mqtt?.raw.connected) return;

  const stale = await supabase.rpc("fail_stale_remote_commands", {
    p_farm_id: env.farmId,
    p_max_age_ms: config.stale_command_ms,
  });
  if (stale.error) throw new Error(stale.error.message);
  for (const id of (stale.data ?? []) as string[]) console.warn(`[CMD] ${id} failed: stale`);

  const { data: rows, error } = await supabase
    .from("remote_commands")
    .select("id, robot_id, command, issued_by, issued_at")
    .eq("farm_id", env.farmId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  for (const row of rows ?? []) {
    if (!mqtt.raw.connected) return;
    const remote = toRemoteCommand(row);
    if (typeof remote === "string") {
      await finishCommand(String(row.id), "failed", remote);
      console.warn(`[CMD] ${row.id} failed: ${remote}`);
      continue;
    }
    mqtt.publish(TOPICS.commands.remote, remote);
    await finishCommand(remote.id, "sent");
    console.log(`[CMD] ${remote.id} sent: ${remote.command.command} → ${remote.robot_id} (by ${remote.issued_by})`);
  }
}

async function finishCommand(id: string, status: "sent" | "failed", reason?: string) {
  const { data, error } = await supabase.rpc("finish_remote_command", {
    p_id: id,
    p_farm_id: env.farmId,
    p_status: status,
    p_error: reason ?? null,
  });
  if (error) throw new Error(error.message);
  if (data !== true) console.warn(`[CMD] ${id} was no longer pending when marked ${status}`);
}

function subscribeCommands() {
  supabase
    .channel(`remote-commands:${env.farmId}`, { config: { private: true } })
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "remote_commands", filter: `farm_id=eq.${env.farmId}` },
      () => void drainCommands(),
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        logs.ok("realtime", "[CMD] Realtime connected again");
        console.log("[CMD] Listening for remote commands");
        void drainCommands();
      } else if (!shuttingDown) {
        // supabase-js rejoins on its own
        logs.warn("realtime", `[CMD] Realtime ${status.toLowerCase()}${err ? `: ${err.message}` : ""}, rejoining (logged once)`);
      }
    });
}

// --- Main ----------------------------------------------------

async function main() {
  console.log("[BRIDGE] Supabase bridge starting");
  console.log(`[BRIDGE]   farm:     ${env.farmId}`);
  console.log(`[BRIDGE]   supabase: ${env.supabaseUrl}`);
  console.log(`[BRIDGE]   broker:   ${env.brokerUrl}`);

  const farmName = await waitForFarm();
  console.log(`[BRIDGE] Farm "${env.farmId}" (${farmName}) found in Supabase`);

  mqtt = await createMqttClient({
    serviceName: "supabase-bridge",
    brokerUrl: env.brokerUrl,
    // Commands that waited for the broker
    onConnect: () => void drainCommands(),
  });
  subscribeCommands();
  console.log("[BRIDGE] Running");

  const shutdown = async () => {
    shuttingDown = true;
    console.log("[BRIDGE] Shutting down");
    await supabase.removeAllChannels();
    await mqtt.disconnect();
    process.exit(0);
  };
  // systemd stops services with SIGTERM
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[FATAL] Supabase bridge failed:", (err as Error).message);
  process.exit(1);
});
