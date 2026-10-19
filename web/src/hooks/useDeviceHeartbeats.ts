"use client";

import { useEffect, useMemo, useState } from "react";
import { getFarmDataSource, onFarmDataSourceChange, type ShelfReading } from "@/lib/farm/data-source";
import { ROBOT_STALE_MS, type RobotView } from "@/lib/farm/robots";

/** Same as shelf-bridge-config.json silence_timeout_ms: the bridge raises its own alert then */
const SHELF_SILENT_MS = 20_000;
const SILENT_AFTER_MS = { robot: ROBOT_STALE_MS, shelf: SHELF_SILENT_MS } as const;
const CLOCK_MS = 5_000;

/** A device that reports to the farm: a robot or a shelf sensor node */
export interface Heartbeat {
  id: string;
  kind: keyof typeof SILENT_AFTER_MS;
  /** Browser receive time of its last message (there's no clock sync); 0 when none since the page opened */
  lastSeen: number;
}

export function isSilent(beat: Heartbeat, now: number) {
  return now - beat.lastSeen > SILENT_AFTER_MS[beat.kind];
}

/**
 * Every robot and shelf sensor the farm knows of, with when each was last
 * heard from, silent ones first. Robots come from the robot list (including
 * those the orchestrator knows of that haven't reported since the page
 * opened); shelves from their live readings, plus any in the stored history,
 * so a shelf that went quiet before the page opened shows as silent too.
 * Null when the data source has no device feed (remotely, without Supabase set up).
 */
export function useDeviceHeartbeats() {
  const [source, setSource] = useState(getFarmDataSource);
  const [robots, setRobots] = useState<RobotView[]>([]);
  const [shelves, setShelves] = useState<ShelfReading[] | null>(null);
  const [storedShelfIds, setStoredShelfIds] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => onFarmDataSourceChange(() => setSource(getFarmDataSource())), []);

  useEffect(() => {
    // another farm (or none): drop the last one's devices
    setRobots([]);
    setShelves(null);
    setStoredShelfIds([]);
    const offRobots = source.subscribeRobots(setRobots);
    const offShelves = source.subscribeShelves(setShelves);
    const offHistory = source.subscribeShelfHistory((readings) =>
      setStoredShelfIds((known) => {
        const ids = [...new Set((readings ?? []).map((reading) => reading.data.shelf_id))].sort();
        // the history emits on every reading; keep the same list unless a shelf was added
        return ids.length === known.length && ids.every((id, i) => id === known[i]) ? known : ids;
      }),
    );
    return () => {
      offRobots();
      offShelves();
      offHistory();
    };
  }, [source]);

  // "silent" turns on by itself, without a new message
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(id);
  }, []);

  const beats = useMemo<Heartbeat[] | null>(() => {
    if (shelves === null && robots.length === 0) return null;
    const shelfSeen = new Map<string, number>(storedShelfIds.map((id) => [id, 0]));
    shelves?.forEach((shelf) => shelfSeen.set(shelf.data.shelf_id, shelf.receivedAt));
    return [
      ...robots.map((robot): Heartbeat => ({ id: robot.id, kind: "robot", lastSeen: robot.lastSeen })),
      ...[...shelfSeen].map(([id, lastSeen]): Heartbeat => ({ id, kind: "shelf", lastSeen })),
    ];
  }, [robots, shelves, storedShelfIds]);

  const sorted = useMemo(
    () =>
      beats &&
      [...beats].sort(
        (a, b) =>
          Number(isSilent(b, now)) - Number(isSilent(a, now)) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
      ),
    [beats, now],
  );

  return { beats: sorted, now };
}
