import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseReadConfig } from "@/lib/supabase-config";
import type { SensorEventRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_SERIAL_PORT = "/dev/ttyACM0";
const DEFAULT_SERIAL_BAUD = "9600";
const DEFAULT_DEVICE_ID = "arduino-uno-r3-1";

function isSet(value: string | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

export async function GET() {
  const readConfig = getSupabaseReadConfig();
  const serialPort = process.env.SERIAL_PORT ?? DEFAULT_SERIAL_PORT;
  const serialBaud = process.env.SERIAL_BAUD ?? DEFAULT_SERIAL_BAUD;
  const deviceId = process.env.DEVICE_ID ?? DEFAULT_DEVICE_ID;
  const env = {
    supabaseUrl: Boolean(readConfig.url),
    readKey: Boolean(readConfig.key),
    serviceRoleKey: isSet(process.env.SUPABASE_SERVICE_ROLE_KEY),
    serialPort,
    serialBaud,
    deviceId,
  };

  if (!readConfig.url || !readConfig.key) {
    return NextResponse.json({
      env,
      supabase: {
        configured: false,
        tableReady: false,
        latestEvent: null,
        latestAgeSeconds: null,
        error: "Supabase read configuration is not available.",
      },
    });
  }

  const supabase = createClient(readConfig.url, readConfig.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase
    .from("sensor_events")
    .select("id,created_at,device,source,ts,light_lux,light_ppfd")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<Pick<SensorEventRecord, "created_at" | "device" | "source" | "ts" | "light_lux" | "light_ppfd">>();

  if (error) {
    return NextResponse.json({
      env,
      supabase: {
        configured: true,
        tableReady: false,
        latestEvent: null,
        latestAgeSeconds: null,
        error: error.message,
      },
    });
  }

  const latestCreatedAt = data?.created_at ? new Date(data.created_at) : null;
  const latestAgeSeconds =
    latestCreatedAt && !Number.isNaN(latestCreatedAt.getTime())
      ? Math.max(0, Math.round((Date.now() - latestCreatedAt.getTime()) / 1000))
      : null;

  return NextResponse.json({
    env,
    supabase: {
      configured: true,
      tableReady: true,
      latestEvent: data ?? null,
      latestAgeSeconds,
      error: null,
    },
  });
}
