import type { FarmIdentity } from "@/lib/types";

/** Same rule as the id check in web/supabase/farms.sql */
export const FARM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const farmId = process.env.NEXT_PUBLIC_FARM_ID?.trim() ?? "";

/**
 * The farm whose Pi serves this dashboard (FarmNet): NEXT_PUBLIC_FARM_ID and
 * NEXT_PUBLIC_FARM_NAME in its dashboard.env, the same values as the farm's
 * row in Supabase's farms table. Null when unset or not a valid id.
 */
export const LOCAL_FARM: FarmIdentity | null = FARM_ID_PATTERN.test(farmId)
  ? { id: farmId, name: process.env.NEXT_PUBLIC_FARM_NAME?.trim() || farmId }
  : null;
