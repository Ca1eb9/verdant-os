import styles from "@/components/alerts/AlertsView.module.css";

/** Last message seen from one device (robot, shelf sensor, ...) */
export interface Heartbeat {
  id: string;
  kind: string;
  lastSeen: number;
  /** silent for longer than this counts as not reporting */
  staleAfterMs: number;
}

export function isSilent(beat: Heartbeat, now: number) {
  return now - beat.lastSeen > beat.staleAfterMs;
}

/** "just now", "12s ago", "4m ago", "3h ago" */
export function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Every device's last heartbeat, silent ones first */
export function HeartbeatPanel({ beats, now }: { beats: Heartbeat[]; now: number }) {
  const sorted = [...beats].sort(
    (a, b) => Number(isSilent(b, now)) - Number(isSilent(a, now)) || a.id.localeCompare(b.id),
  );

  return (
    <div className={styles.list}>
      <h2 className={styles.listTitle}>Heartbeats</h2>
      <ul className={`glassPanel ${styles.beats}`}>
        {sorted.map((beat) => {
          const silent = isSilent(beat, now);
          return (
            <li key={`${beat.kind}:${beat.id}`} className={styles.beat}>
              <span className={`statusDot ${silent ? styles.beatSilent : styles.beatLive}`} />
              <span className={styles.beatName}>
                <strong>{beat.id}</strong>
                <span>{beat.kind}</span>
              </span>
              <time
                className={styles.beatAge}
                dateTime={new Date(beat.lastSeen).toISOString()}
                title={new Date(beat.lastSeen).toLocaleString()}
              >
                {ago(now - beat.lastSeen)}
              </time>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
