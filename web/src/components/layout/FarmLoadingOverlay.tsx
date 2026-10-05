"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { VerdantMark } from "@/components/brand/VerdantMark";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { useFarmConnection } from "@/hooks/useFarmConnection";
import styles from "@/components/layout/FarmLoadingOverlay.module.css";

// Pages that show farm data; Settings and Config work without the farm
const FARM_PAGES = ["/", "/farm", "/history", "/alerts"];
// A quick load or reconnect shouldn't flash the overlay
const SHOW_AFTER_MS = 400;

/** The growing mark over a farm page while the farm loads, or while it's disconnected */
export function FarmLoadingOverlay() {
  const pathname = usePathname();
  const { farm, loading } = useSelectedFarm();
  const connection = useFarmConnection();
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);

  // Without a farm there's nothing to load: the page itself says why
  const connecting = loading || (farm !== null && (connection === null || connection.state === "connecting"));
  const offline = farm !== null && connection?.state === "offline" ? connection : null;
  const wanted = FARM_PAGES.includes(pathname) && (connecting || (offline !== null && !dismissed));

  // Dismissing holds until the farm is back; the next disconnect shows it again
  useEffect(() => {
    if (connection?.state === "connected") setDismissed(false);
  }, [connection?.state]);

  useEffect(() => {
    if (!wanted) {
      setVisible(false);
      return undefined;
    }
    const id = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [wanted]);

  if (!visible) return null;

  return (
    <div className={styles.overlay} role="status" aria-live="polite">
      <div className={styles.content}>
        <VerdantMark animation="grow" className={styles.mark} />
        <p className={styles.title}>{offline ? "Reconnecting to the farm…" : "Loading your farm…"}</p>
        {offline ? (
          <>
            <p className={styles.reason}>{offline.reason}</p>
            <button type="button" className={styles.dismiss} onClick={() => setDismissed(true)}>
              Show the page anyway
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
