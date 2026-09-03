"use client";

import { useEffect, useState } from "react";
import { formatTimestamp } from "@/lib/format";
import styles from "@/components/config/ConfigView.module.css";

type StatusTone = "good" | "watch" | "bad";

interface ConfigStatus {
  env: {
    supabaseUrl: boolean;
    readKey: boolean;
    serviceRoleKey: boolean;
    serialPort: string;
    serialBaud: string;
    deviceId: string;
  };
  supabase: {
    configured: boolean;
    tableReady: boolean;
    latestEvent: {
      created_at?: string;
      device: string | null;
      source: string | null;
      ts: string | null;
      light_lux: number | null;
      light_ppfd: number | null;
    } | null;
    latestAgeSeconds: number | null;
    error: string | null;
  };
}

const setupCommands = [
  "lsusb",
  "ls /dev/ttyACM* /dev/ttyUSB*",
  "npm run bridge:serial",
  "npm run dev",
];

const schemaColumns = [
  "device",
  "source",
  "ts",
  "air_temp_c",
  "humidity_pct",
  "water_temp_c",
  "water_level_ok",
  "ph_voltage",
  "ph",
  "light_lux",
  "light_ppfd",
  "raw_text",
];

function toneLabel(tone: StatusTone) {
  if (tone === "good") {
    return "Live";
  }

  if (tone === "watch") {
    return "Stale";
  }

  return "Blocked";
}

function formatAge(seconds: number | null) {
  if (seconds === null) {
    return "No rows yet";
  }

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

function getLiveTone(status: ConfigStatus | null): StatusTone {
  if (!status || !status.supabase.configured || !status.supabase.tableReady) {
    return "bad";
  }

  if (status.supabase.latestAgeSeconds === null) {
    return "watch";
  }

  return status.supabase.latestAgeSeconds <= 10 ? "good" : "watch";
}

export function ConfigView() {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;

    const loadStatus = async () => {
      try {
        const response = await fetch("/api/config/status", { cache: "no-store" });
        const payload = (await response.json()) as ConfigStatus;

        if (!isCancelled) {
          setStatus(payload);
          setStatusError(null);
        }
      } catch {
        if (!isCancelled) {
          setStatusError("Could not load deployment status.");
        }
      }
    };

    void loadStatus();
    const intervalId = window.setInterval(loadStatus, 3000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const liveTone = getLiveTone(status);
  const latestEvent = status?.supabase.latestEvent ?? null;

  return (
    <section className="pageSection">
      <div className={`glassPanel ${styles.hero}`}>
        <div className={styles.heroContent}>
          <span className="eyebrow">Deployment configuration</span>
          <h1 className="pageTitle">Config</h1>
          <p className="pageLead">
            Arduino Uno R3 serial bridge, Supabase ingestion, and dashboard read path are wired
            here for the production deployment.
          </p>
        </div>

        <aside className={`${styles.statusPanel} ${styles[`tone${liveTone}`]}`}>
          <span className={styles.statusLabel}>Pipeline Status</span>
          <strong>{toneLabel(liveTone)}</strong>
          <span>
            {statusError ??
              (status?.supabase.error
                ? status.supabase.error
                : `Latest row ${formatAge(status?.supabase.latestAgeSeconds ?? null)}`)}
          </span>
        </aside>
      </div>

      <div className={styles.grid}>
        <article className={`glassPanel ${styles.moduleCard}`}>
          <div className={styles.moduleHead}>
            <div>
              <span className="eyebrow">Server environment</span>
              <h2 className={styles.moduleTitle}>Secrets and Runtime</h2>
            </div>
            <span className={`${styles.badge} ${styles[status?.env.supabaseUrl && status.env.readKey ? "good" : "bad"]}`}>
              {status?.env.supabaseUrl && status.env.readKey ? "Configured" : "Missing"}
            </span>
          </div>

          <div className={styles.checkList}>
            <div className={styles.checkRow}>
              <span>SUPABASE_URL</span>
              <strong>{status?.env.supabaseUrl ? "Set" : "Missing"}</strong>
            </div>
            <div className={styles.checkRow}>
              <span>Publishable read key</span>
              <strong>{status?.env.readKey ? "Available" : "Missing"}</strong>
            </div>
            <div className={styles.checkRow}>
              <span>SUPABASE_SERVICE_ROLE_KEY</span>
              <strong>{status?.env.serviceRoleKey ? "Set for inserts" : "Local bridge only"}</strong>
            </div>
            <div className={styles.checkRow}>
              <span>DEVICE_ID</span>
              <strong>{status?.env.deviceId ?? "arduino-uno-r3-1"}</strong>
            </div>
          </div>
        </article>

        <article className={`glassPanel ${styles.moduleCard}`}>
          <div className={styles.moduleHead}>
            <div>
              <span className="eyebrow">Serial bridge</span>
              <h2 className={styles.moduleTitle}>Arduino Uno R3</h2>
            </div>
            <span className={`${styles.badge} ${styles.good}`}>9600 baud</span>
          </div>

          <div className={styles.checkList}>
            <div className={styles.checkRow}>
              <span>Primary port</span>
              <strong>{status?.env.serialPort ?? "/dev/ttyACM0"}</strong>
            </div>
            <div className={styles.checkRow}>
              <span>Alternate port</span>
              <strong>/dev/ttyUSB0</strong>
            </div>
            <div className={styles.checkRow}>
              <span>Bridge command</span>
              <strong>npm run bridge:serial</strong>
            </div>
          </div>
        </article>

        <article className={`glassPanel ${styles.moduleCard}`}>
          <div className={styles.moduleHead}>
            <div>
              <span className="eyebrow">Database</span>
              <h2 className={styles.moduleTitle}>Supabase sensor_events</h2>
            </div>
            <span className={`${styles.badge} ${styles[status?.supabase.tableReady ? "good" : "bad"]}`}>
              {status?.supabase.tableReady ? "Table ready" : "Not ready"}
            </span>
          </div>

          <p className={styles.moduleDescription}>
            Run `supabase/sensor_events.sql` once in the Supabase SQL editor before deployment.
          </p>

          <div className={styles.schemaGrid}>
            {schemaColumns.map((column) => (
              <span key={column}>{column}</span>
            ))}
          </div>
        </article>

        <article className={`glassPanel ${styles.moduleCard}`}>
          <div className={styles.moduleHead}>
            <div>
              <span className="eyebrow">Latest row</span>
              <h2 className={styles.moduleTitle}>Dashboard Feed</h2>
            </div>
            <span className={`${styles.badge} ${styles[liveTone]}`}>{formatAge(status?.supabase.latestAgeSeconds ?? null)}</span>
          </div>

          <div className={styles.checkList}>
            <div className={styles.checkRow}>
              <span>Device</span>
              <strong>{latestEvent?.device ?? "Waiting"}</strong>
            </div>
            <div className={styles.checkRow}>
              <span>Inserted</span>
              <strong>{latestEvent?.created_at ? formatTimestamp(latestEvent.created_at) : "No row"}</strong>
            </div>
            <div className={styles.checkRow}>
              <span>Light</span>
              <strong>
                {latestEvent?.light_ppfd === null || latestEvent?.light_ppfd === undefined
                  ? "No reading"
                  : `${latestEvent.light_ppfd.toFixed(1)} PPFD`}
              </strong>
            </div>
          </div>
        </article>
      </div>

      <div className={`glassPanel ${styles.runbook}`}>
        <div>
          <span className="eyebrow">Deployment runbook</span>
          <h2 className={styles.moduleTitle}>Start Order</h2>
        </div>

        <div className={styles.commandGrid}>
          {setupCommands.map((command, index) => (
            <div key={command} className={styles.commandRow}>
              <span>{index + 1}</span>
              <code>{command}</code>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
