"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { FARMS, getFarmById } from "@/lib/mock-data";
import type { FarmIdentity } from "@/lib/types";

const STORAGE_KEY = "verdantos:selected-farm";

interface FarmContextValue {
  activeFarmId: string;
  farm: FarmIdentity;
  setActiveFarmId: Dispatch<SetStateAction<string>>;
}

const FarmContext = createContext<FarmContextValue | null>(null);

function readStoredFarmId() {
  if (typeof window === "undefined") {
    return FARMS[0].id;
  }

  const value = window.localStorage.getItem(STORAGE_KEY);
  return FARMS.some((farm) => farm.id === value) ? value ?? FARMS[0].id : FARMS[0].id;
}

export function FarmProvider({ children }: { children: ReactNode }) {
  const [activeFarmId, setActiveFarmId] = useState(() => readStoredFarmId());

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, activeFarmId);
  }, [activeFarmId]);

  const farm = useMemo(() => getFarmById(activeFarmId), [activeFarmId]);

  const value = useMemo(
    () => ({
      activeFarmId,
      farm,
      setActiveFarmId,
    }),
    [activeFarmId, farm],
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
