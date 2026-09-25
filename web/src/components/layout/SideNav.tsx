"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive, NAV_ITEMS } from "@/components/layout/nav-items";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import { AssetImage } from "@/components/ui/AssetImage";
import styles from "@/components/layout/SideNav.module.css";

/** Desktop navigation (980px and up); collapses to an icon rail */
export function SideNav() {
  const pathname = usePathname();
  const { prefs, setPref } = usePreferences();
  const collapsed = prefs.sidebarCollapsed;

  return (
    <aside className={styles.side} aria-label="Main navigation">
      <Link href="/" className={styles.brand} title="VerdantOS">
        <AssetImage
          src="/images/sprout-logo.webp"
          alt="VerdantOS logo"
          fallback={"🌿"}
          className={styles.logo}
          fallbackClassName={`${styles.logo} assetFallback`}
        />
        <span className={styles.brandText}>
          <span className={styles.brandEyebrow}>Vertical Farm Control</span>
          <strong className={styles.brandTitle}>VerdantOS</strong>
        </span>
      </Link>

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

      <button
        type="button"
        className={styles.toggle}
        onClick={() => setPref("sidebarCollapsed", !collapsed)}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <svg className={styles.chevron} viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className={styles.label}>Collapse</span>
      </button>
    </aside>
  );
}
