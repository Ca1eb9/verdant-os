import type { ReactNode } from "react";

// The app's icons, drawn inline in the theme's accent colours so they switch
// with the theme: the light theme's accents are deeper, and stay legible on
// white. public/images/dashboard-icon.svg and history-icon.svg are static
// dark-theme copies for the PWA manifest's shortcuts, which can't follow the theme.

const CYAN = "var(--cyan)";
const TEAL = "var(--teal)";
const LIME = "var(--lime)";
const AMBER = "var(--amber)";

const ICONS = {
  dashboard: {
    viewBox: "0 0 64 64",
    body: (
      <>
        <rect x="14" y="14" width="15" height="15" rx="4" fill={CYAN} />
        <rect x="35" y="14" width="15" height="15" rx="4" fill={TEAL} />
        <rect x="14" y="35" width="15" height="15" rx="4" fill={LIME} />
        <rect x="35" y="35" width="15" height="15" rx="4" fill={CYAN} fillOpacity="0.75" />
      </>
    ),
  },
  farm: {
    viewBox: "0 0 64 64",
    body: (
      <>
        <rect x="12" y="22" width="40" height="4" rx="2" fill={CYAN} fillOpacity="0.75" />
        <rect x="12" y="40" width="40" height="4" rx="2" fill={CYAN} fillOpacity="0.75" />
        <rect x="17" y="31" width="16" height="6" rx="2" fill={AMBER} />
        <circle cx="20" cy="38.5" r="2" fill={LIME} />
        <circle cx="30" cy="38.5" r="2" fill={LIME} />
        <path d="M38 18V14M44 18V12M50 18V15" stroke={TEAL} strokeWidth="3" strokeLinecap="round" />
      </>
    ),
  },
  history: {
    viewBox: "0 0 64 64",
    body: (
      <>
        <path d="M16 44L27 33L35 39L48 22" stroke={CYAN} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="16" cy="44" r="3" fill={TEAL} />
        <circle cx="27" cy="33" r="3" fill={TEAL} />
        <circle cx="35" cy="39" r="3" fill={LIME} />
        <circle cx="48" cy="22" r="3" fill={CYAN} />
      </>
    ),
  },
  settings: {
    viewBox: "0 0 64 64",
    body: (
      <>
        <path d="M16 22H37M51 22H48.5M16 42H21M35 42H48" stroke={CYAN} strokeWidth="4" strokeLinecap="round" />
        <circle cx="44" cy="22" r="5" stroke={TEAL} strokeWidth="4" />
        <circle cx="28" cy="42" r="5" stroke={LIME} strokeWidth="4" />
      </>
    ),
  },
  air: {
    viewBox: "0 0 96 96",
    body: (
      <>
        <path
          d="M24 39C27.2 33.4 32.6 30.6 40.2 30.6C47.8 30.6 54.2 34.2 59.4 41.4C64.6 48.6 70.4 52.2 76.8 52.2"
          stroke={CYAN}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M19 54C22.6 48.4 28.2 45.6 35.8 45.6C43.4 45.6 49.2 48.6 53.2 54.6C57.2 60.6 63 63.6 70.6 63.6"
          stroke={TEAL}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <circle cx="69" cy="28" r="8" fill={LIME} />
      </>
    ),
  },
  water: {
    viewBox: "0 0 96 96",
    body: (
      <>
        <path
          d="M48 18C35.333 32 29 43.333 29 52C29 63.0457 37.9543 72 49 72C60.0457 72 69 63.0457 69 52C69 42.6667 62 31.3333 48 18Z"
          fill={TEAL}
        />
        <path
          d="M38 56C42 60 46.6667 62 52 62C57.3333 62 62 60 66 56"
          stroke="#07131D"
          strokeOpacity="0.45"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <circle cx="67" cy="27" r="7" fill={CYAN} />
      </>
    ),
  },
  light: {
    viewBox: "0 0 96 96",
    body: (
      <>
        <circle cx="48" cy="47" r="16" fill={LIME} />
        <path d="M48 17V27M48 67V77M18 47H28M68 47H78" stroke={CYAN} strokeWidth="6" strokeLinecap="round" />
        <path d="M26 25L33 32M63 62L70 69M70 25L63 32M33 62L26 69" stroke={TEAL} strokeWidth="6" strokeLinecap="round" />
      </>
    ),
  },
} satisfies Record<string, { viewBox: string; body: ReactNode }>;

export type AppIconName = keyof typeof ICONS;

/** Decorative: the label beside it names it */
export function AppIcon({ name, className }: { name: AppIconName; className?: string }) {
  const { viewBox, body } = ICONS[name];
  return (
    <svg viewBox={viewBox} fill="none" className={className} aria-hidden="true">
      {body}
    </svg>
  );
}
