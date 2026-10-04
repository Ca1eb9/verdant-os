"use client";

import { useEffect, useState } from "react";
import { getFarmDataSource, onFarmDataSourceChange, type FarmConnection } from "@/lib/farm/data-source";

/** Whether the active data source can reach the farm, and why not */
export function useFarmConnection() {
  const [source, setSource] = useState(getFarmDataSource);
  const [connection, setConnection] = useState<FarmConnection | null>(null);

  useEffect(() => onFarmDataSourceChange(() => setSource(getFarmDataSource())), []);
  useEffect(() => source.subscribeConnection(setConnection), [source]);

  return connection;
}
