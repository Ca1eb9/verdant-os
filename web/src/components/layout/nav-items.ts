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

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
