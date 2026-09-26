"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive, NAV_ITEMS } from "@/components/layout/nav-items";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { AssetImage } from "@/components/ui/AssetImage";
import styles from "@/components/layout/SideNav.module.css";

function Arrow({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        d={direction === "left" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Desktop navigation (980px and up); collapses to an icon rail */
export function SideNav() {
  const pathname = usePathname();
  const { setPref } = usePreferences();

  return (
    <aside className={styles.side} aria-label="Main navigation">
      <div className={styles.header}>
        <Link href="/" className={styles.brand} title="VerdantOS">
          <AssetImage
            src="/images/sprout-logo.webp"
            alt="VerdantOS logo"
            fallback={"\uD83C\uDF3F"}
            className={styles.logo}
            fallbackClassName={`${styles.logo} assetFallback`}
          />
          <strong className={styles.brandText}>VerdantOS</strong>
        </Link>

        <button
          type="button"
          className={`${styles.iconButton} ${styles.collapse}`}
          onClick={() => setPref("sidebarCollapsed", true)}
          aria-label="Collapse sidebar"
          aria-expanded="true"
          title="Collapse sidebar"
        >
          <Arrow direction="left" />
        </button>

        {/* collapsed: the logo turns into an expand arrow on hover or focus */}
        <button
          type="button"
          className={styles.expand}
          onClick={() => setPref("sidebarCollapsed", false)}
          aria-label="Expand sidebar"
          aria-expanded="false"
          title="Expand sidebar"
        >
          <AssetImage
            src="/images/sprout-logo.webp"
            alt=""
            fallback={"\uD83C\uDF3F"}
            className={`${styles.logo} ${styles.expandLogo}`}
            fallbackClassName={`${styles.logo} ${styles.expandLogo} assetFallback`}
          />
          <span className={styles.expandArrow}>
            <Arrow direction="right" />
          </span>
        </button>
      </div>

      <nav className={styles.nav}>
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.item} ${active ? styles.active : ""}`}
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              title={item.label}
            >
              <AssetImage
                src={item.icon}
                alt=""
                fallback={item.fallback}
                className={styles.icon}
                fallbackClassName={`${styles.icon} assetFallback`}
              />
              <span className={styles.label}>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
