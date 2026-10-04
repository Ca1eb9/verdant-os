"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ON_FARMNET, selectFarm } from "@/lib/farm/data-source";
import { LOCAL_FARM } from "@/lib/farms";
import { FARMS, MOCK_DATA_ENABLED } from "@/lib/mock-data";
import type { FarmIdentity } from "@/lib/types";

const STORAGE_KEY = "verdantos:selected-farm";
// Retry a farm list that failed to load or was empty (a farm may be added meanwhile)
const FARM_LIST_RETRY_MS = 15_000;

type FarmList =
  | { state: "loading" }
  | { state: "ready"; farms: FarmIdentity[] }
  | { state: "unavailable"; reason: string };

interface FarmContextValue {
  farms: FarmIdentity[];
  /** Null while there's no farm to show; `problem` then says why (unless still loading) */
  farm: FarmIdentity | null;
  activeFarmId: string | null;
  setActiveFarmId: (farmId: string) => void;
  /** On FarmNet the dashboard belongs to its Pi's farm and can't switch */
  locked: boolean;
  loading: boolean;
  problem: string | null;
}

const FarmContext = createContext<FarmContextValue | null>(null);

// Reasons are shown to the operator, so they stay plain; the details for
// whoever sets the farm up go to the console.
const LOAD_FAILED = "Couldn't load the farms. Retrying…";

function initialList(): FarmList {
  if (MOCK_DATA_ENABLED) return { state: "ready", farms: FARMS };
  if (!ON_FARMNET) return { state: "loading" };
  if (LOCAL_FARM) return { state: "ready", farms: [LOCAL_FARM] };
  if (typeof window !== "undefined") {
    console.warn("[farms] NEXT_PUBLIC_FARM_ID in /etc/verdant/dashboard.env is missing or invalid (docs/PI-SERVICES.md)");
  }
  return { state: "unavailable", reason: "This dashboard isn't set up for a farm yet." };
}

async function fetchFarmList(): Promise<FarmList> {
  try {
    const response = await fetch("/api/farms", { cache: "no-store" });
    const payload = (await response.json()) as { farms?: FarmIdentity[]; error?: string };
    if (payload.error) {
      console.warn(`[farms] /api/farms: ${payload.error}`);
      return { state: "unavailable", reason: LOAD_FAILED };
    }
    const farms = payload.farms ?? [];
    if (!farms.length) console.warn("[farms] the farms table is empty (docs/SUPABASE-SETUP.md)");
    return farms.length ? { state: "ready", farms } : { state: "unavailable", reason: "No farms have been added yet." };
  } catch {
    console.warn("[farms] /api/farms didn't answer");
    return { state: "unavailable", reason: LOAD_FAILED };
  }
}

function readStoredFarmId() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function FarmProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<FarmList>(initialList);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const fixedList = MOCK_DATA_ENABLED || ON_FARMNET;

  useEffect(() => setChosenId(readStoredFarmId()), []);

  useEffect(() => {
    if (fixedList || list.state === "ready") return undefined;
    let cancelled = false;
    const load = () => void fetchFarmList().then((next) => !cancelled && setList(next));
    if (list.state === "loading") load();
    const id = window.setInterval(load, FARM_LIST_RETRY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [fixedList, list.state]);

  const farms = useMemo(() => (list.state === "ready" ? list.farms : []), [list]);
  // A stored id that's no longer listed (or another farm's) falls back to the first farm
  const farm = farms.find((option) => option.id === chosenId) ?? farms[0] ?? null;
  const problem = list.state === "unavailable" ? list.reason : null;

  useEffect(() => {
    if (list.state !== "loading") selectFarm(farm?.id ?? null, problem ?? undefined);
  }, [farm?.id, list.state, problem]);

  const setActiveFarmId = useCallback((farmId: string) => {
    setChosenId(farmId);
    try {
      window.localStorage.setItem(STORAGE_KEY, farmId);
    } catch {
      // the choice just won't survive a reload
    }
  }, []);

  const value = useMemo(
    () => ({
      farms,
      farm,
      activeFarmId: farm?.id ?? null,
      setActiveFarmId,
      locked: ON_FARMNET && !MOCK_DATA_ENABLED,
      loading: list.state === "loading",
      problem,
    }),
    [farm, farms, list.state, problem, setActiveFarmId],
  );

  return <FarmContext.Provider value={value}>{children}</FarmContext.Provider>;
}

export function useSelectedFarm() {
  const context = useContext(FarmContext);

  if (!context) {
    throw new Error("useSelectedFarm must be used within a FarmProvider");
  }

  return context;
}
