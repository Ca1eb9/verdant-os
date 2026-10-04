import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseReadConfig } from "@/lib/supabase-config";
import type { FarmIdentity } from "@/lib/types";

export const dynamic = "force-dynamic";

/** The farms in Supabase's farms table, for the header's farm picker */
export async function GET() {
  const config = getSupabaseReadConfig();
  if (!config.url || !config.key) {
    return NextResponse.json({ farms: [], error: "Supabase is not configured." });
  }

  const { data, error } = await createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
    .from("farms")
    .select("id,name")
    .order("name");

  if (error) return NextResponse.json({ farms: [], error: error.message });
  return NextResponse.json({ farms: (data ?? []) as FarmIdentity[] });
}
