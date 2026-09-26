import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getOperator } from "@/lib/auth";
import { getSupabaseReadConfig } from "@/lib/supabase-config";
import type { SensorEventRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  // the middleware checks this too; a second check here in case it is ever bypassed
  if (!(await getOperator())) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const config = getSupabaseReadConfig();

  if (!config.url || !config.key) {
    return NextResponse.json(
      { event: null, error: "Supabase read configuration is not available." },
      { status: 200 },
    );
  }

  const supabase = createClient(config.url, config.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase
    .from("sensor_events")
    .select(
      "id,created_at,device,source,ts,air_temp_c,air_temp_f,humidity_pct,water_temp_c,water_temp_f,water_level_ok,water_level_text,ph_voltage,ph,light_lux,light_ppfd,raw_text",
    )
    .order("created_at", { ascending: false })
    .order("ts", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle<SensorEventRecord>();

  if (error) {
    return NextResponse.json({ event: null, error: error.message }, { status: 200 });
  }

  return NextResponse.json({ event: data ?? null });
}
