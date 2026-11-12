"use client";

import { useState } from "react";
import { useGrowLights } from "@/hooks/useGrowLights";
import { levelName } from "@/lib/format";
import type { LightState } from "@/lib/farm/types";
import styles from "@/components/dashboard/DashboardView.module.css";

function statusOf(light: LightState, robotsDocked: boolean) {
  if (light.on) return "Lit";
  if (!light.operator_on) return "Switched off";
  return robotsDocked ? "Off while the robots are docked" : "Off: no robot on this level";
}

/**
 * The operator's switch for each level's grow lights, on FarmNet only (the
 * remote dashboard has none, like jog). A level is lit while it's switched on
 * and a robot is out on the farm (with the bridge's follow_robots, on that
 * level); the shelf bridge turns them all off while every robot is docked.
 */
export function LightsCard() {
  const { lights, setLight } = useGrowLights();
  const [sending, setSending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!lights?.lights.length) return null;

  const flip = async (level: number, on: boolean) => {
    setSending(level);
    setError(null);
    try {
      await setLight(level, on);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch the light.");
    } finally {
      setSending(null);
    }
  };

  return (
    <article className={`glassPanel ${styles.sensorCard}`}>
      <div className={styles.sensorTop}>
        <h2 className={styles.sensorTitle}>Lights</h2>
      </div>
      <ul className={styles.robotList}>
        {lights.lights.map((light) => (
          <li key={light.level} className={styles.metricTile}>
            <div className={styles.metricLabelRow}>
              <strong>{levelName(light.level)}</strong>
              <div className="segmented" role="group" aria-label={`${levelName(light.level)} lights`}>
                {[true, false].map((on) => (
                  <button
                    key={String(on)}
                    type="button"
                    className="segment"
                    aria-pressed={light.operator_on === on}
                    disabled={sending !== null}
                    onClick={() => light.operator_on !== on && flip(light.level, on)}
                  >
                    {on ? "On" : "Off"}
                  </button>
                ))}
              </div>
            </div>
            <span className={styles.metricLabel}>{statusOf(light, lights.robots_docked)}</span>
          </li>
        ))}
      </ul>
      {error ? <p className={styles.emptyNote} role="alert">{error}</p> : null}
    </article>
  );
}
