import type { AppIconName } from "@/components/ui/AppIcon";

/** An app icon (drawn in the theme's colours), or an image that suits both themes */
export type NavItem = { href: string; label: string } & (
  | { icon: AppIconName }
  | {
      image: string;
      /** Emoji shown if the image fails to load */
      fallback: string;
    }
);

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/farm", label: "Farm", icon: "farm" },
  { href: "/history", label: "History", icon: "history" },
  { href: "/alerts", label: "Alerts", image: "/images/alert-danger.webp", fallback: "⚠️" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

/** The Backup nav page: only where useBackupNav() says so */
const BACKUP_NAV_ITEM: NavItem = { href: "/backup-nav", label: "Backup", icon: "backupNav" };

/** The pages to show, with Backup nav after Farm when it's on */
export function navItems(backupNav: boolean) {
  if (!backupNav) return NAV_ITEMS;
  const farm = NAV_ITEMS.findIndex((item) => item.href === "/farm");
  return [...NAV_ITEMS.slice(0, farm + 1), BACKUP_NAV_ITEM, ...NAV_ITEMS.slice(farm + 1)];
}

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
