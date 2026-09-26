export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Emoji shown if the icon image fails to load */
  fallback: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "/images/dashboard-icon.svg", fallback: "🧭" },
  { href: "/farm", label: "Farm", icon: "/images/farm-icon.svg", fallback: "🤖" },
  { href: "/history", label: "History", icon: "/images/history-icon.svg", fallback: "📈" },
  { href: "/alerts", label: "Alerts", icon: "/images/alert-danger.webp", fallback: "⚠️" },
  { href: "/config", label: "Config", icon: "/images/config-icon.svg", fallback: "🔧" },
  { href: "/settings", label: "Settings", icon: "/images/settings-icon.svg", fallback: "⚙️" },
];

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
