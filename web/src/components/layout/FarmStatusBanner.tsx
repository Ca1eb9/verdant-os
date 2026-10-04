"use client";

import { useFarmConnection } from "@/hooks/useFarmConnection";
import styles from "@/components/layout/FarmStatusBanner.module.css";

/** Says why the farm can't be reached, on every page, while it can't */
export function FarmStatusBanner() {
  const connection = useFarmConnection();
  // Only once it has failed: a normal page load shows "Connecting" in the header instead
  if (connection?.state !== "offline") return null;

  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <span className="statusDot" />
      <p>
        <strong>Disconnected from the farm.</strong> {connection.reason}
      </p>
    </div>
  );
}
