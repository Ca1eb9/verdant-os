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
import { createMqttClient, LogOnce, type TypedMqttClient } from "@farm/shared";

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
  });
  console.log("[BRIDGE] Running");

  const shutdown = async () => {
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
