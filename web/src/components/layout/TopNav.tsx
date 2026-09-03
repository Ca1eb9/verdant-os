"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";
import { AssetImage } from "@/components/ui/AssetImage";
import styles from "@/components/layout/TopNav.module.css";

const DASHBOARD_FALLBACK = "\uD83E\uDDED";
const HISTORY_FALLBACK = "\uD83D\uDCC8";
const ALERTS_FALLBACK = "\u26A0\uFE0F";
const CONFIG_FALLBACK = "\u2699\uFE0F";
const LOGO_FALLBACK = "\uD83C\uDF3F";

const navItems = [
  {
    href: "/",
    label: "Dashboard",
    icon: "/images/dashboard-icon.svg",
    fallback: DASHBOARD_FALLBACK,
  },
  {
    href: "/history",
    label: "History",
    icon: "/images/history-icon.svg",
    fallback: HISTORY_FALLBACK,
  },
  {
    href: "/alerts",
    label: "Alerts",
    icon: "/images/alert-danger.webp",
    fallback: ALERTS_FALLBACK,
  },
  {
    href: "/config",
    label: "Config",
    icon: "/images/config-icon.svg",
    fallback: CONFIG_FALLBACK,
  },
];

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className={styles.wrap}>
      <div className={`glassPanel ${styles.topBar}`}>
        <Link href="/" className={styles.brand}>
          <AssetImage
            src="/images/sprout-logo.webp"
            alt="VerdantOS logo"
            fallback={LOGO_FALLBACK}
            className={styles.logo}
            fallbackClassName={`${styles.logo} assetFallback`}
          />
          <div className={styles.brandMeta}>
            <span className="eyebrow">Vertical Farm Control</span>
            <strong className={styles.brandTitle}>VerdantOS</strong>
          </div>
        </Link>

        <div className={styles.actions}>
          <span className={styles.readinessBadge}>Offline shell ready</span>
          <InstallAppButton className={styles.installButton} />
        </div>
      </div>

      <nav className={styles.bottomDock}>
        {navItems.map((item) => {
          const isActive =
            item.href === "/" ? pathname === item.href : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navItem} ${isActive ? styles.active : ""}`}
            >
              <AssetImage
                src={item.icon}
                alt={`${item.label} icon`}
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
