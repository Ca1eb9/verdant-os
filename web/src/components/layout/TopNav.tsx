"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSelectedFarm } from "@/components/farms/FarmContext";
import { isActive, NAV_ITEMS } from "@/components/layout/nav-items";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";
import { VerdantMark } from "@/components/brand/VerdantMark";
import { AssetImage } from "@/components/ui/AssetImage";
import { useFarmConnection } from "@/hooks/useFarmConnection";
import styles from "@/components/layout/TopNav.module.css";

// The farm connection, not the browser's network: being online is no use
// if the farm can't be reached.
const NET_LABEL = { connected: "Connected", connecting: "Connecting", offline: "Disconnected" };
const NET_CLASS = {
  connected: styles.netOnline,
  connecting: styles.netConnecting,
  offline: styles.netOffline,
};

export function TopNav() {
  const pathname = usePathname();
  const { farms, activeFarmId, setActiveFarmId, locked, loading } = useSelectedFarm();
  const connection = useFarmConnection();
  const state = connection?.state ?? "connecting";

  return (
    <header className={styles.wrap}>
      <div className={`glassPanel ${styles.topBar}`}>
        <Link href="/" className={styles.brand}>
          <VerdantMark className={styles.logo} />
          <div className={styles.brandMeta}>
            <span className="eyebrow">Vertical Farm Control</span>
            <strong className={styles.brandTitle}>VerdantOS</strong>
          </div>
        </Link>

        <div className={styles.actions}>
          {/* On FarmNet the dashboard is its Pi's farm; remotely, any farm in Supabase */}
          <select
            id="active-farm"
            className={`controlSelect ${styles.farmSelect}`}
            value={activeFarmId ?? ""}
            onChange={(event) => setActiveFarmId(event.target.value)}
            disabled={locked || farms.length === 0}
            title={locked ? "This dashboard runs on this farm's Pi" : undefined}
            aria-label="Active farm"
          >
            {farms.length === 0 ? <option value="">{loading ? "Loading farms…" : "No farms"}</option> : null}
            {farms.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          <span
            className={`${styles.netBadge} ${NET_CLASS[state]}`}
            title={`Farm connection: ${connection?.state === "connected" ? "connected" : connection?.reason ?? "connecting…"}`}
          >
            <span className="statusDot" />
            {NET_LABEL[state]}
          </span>
          <InstallAppButton className={styles.installButton} />
        </div>
      </div>

      <nav className={styles.bottomDock} aria-label="Main navigation">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navItem} ${active ? styles.active : ""}`}
              aria-current={active ? "page" : undefined}
            >
              <AssetImage
                src={item.icon}
                alt=""
                fallback={item.fallback}
                className={styles.navIcon}
                fallbackClassName={`${styles.navIcon} assetFallback`}
              />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
