import { useId } from "react";
import styles from "@/components/brand/VerdantMark.module.css";

// The VerdantOS mark: a glass grow tower, its grow lights on, with a sprout on
// top. Its colours follow the app theme (light-safe edges in light mode).
// public/images/app-icon.svg and favicon.svg are static copies of this drawing.

/** Centre of each shelf's top face, bottom to top */
const SHELVES = [344, 262, 180];
const SHELF_DEPTH = 26;
const GREENS = ["#B8FF5C", "#4ADE80", "#2DD4BF"];
const LEAF_LEFT = "M253 142C220 142 192 121 186 85C222 82 249 106 253 142Z";
const LEAF_RIGHT = "M259 129C266 92 295 69 335 71C331 109 301 130 259 129Z";

/** "lights": the grow lights pulse in turn. "grow": lights switch on, then the sprout grows (loading). */
export type MarkAnimation = "lights" | "grow" | "none";

export function VerdantMark({ animation = "lights", className }: { animation?: MarkAnimation; className?: string }) {
  // useId's colons aren't safe inside url(#…)
  const id = useId().replace(/:/g, "");
  const green = `url(#${id}-green)`;

  return (
    <svg
      viewBox="26 26 460 460"
      className={`${styles.mark} ${animation === "none" ? "" : styles[animation]} ${className ?? ""}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${id}-green`} x1="140" y1="100" x2="372" y2="420" gradientUnits="userSpaceOnUse">
          {GREENS.map((color, i) => (
            <stop key={color} offset={i / (GREENS.length - 1)} stopColor={color} />
          ))}
        </linearGradient>
        <linearGradient id={`${id}-sprout`} x1="0" y1="0" x2="1" y2="1">
          <stop className={styles.sproutFrom} />
          <stop offset="1" className={styles.sproutTo} />
        </linearGradient>
        <filter id={`${id}-glow`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="20" />
        </filter>
        <filter id={`${id}-soft`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>

      <g transform="translate(256 256) scale(1.1) translate(-256 -233)">
        <path d="M256 124L372 180V370L256 426L140 370V180Z" fill={green} filter={`url(#${id}-glow)`} className={styles.halo} />

        {SHELVES.map((cy, i) => (
          <g key={cy}>
            <path d={`M140 ${cy}L256 ${cy + 56}V${cy + 56 + SHELF_DEPTH}L140 ${cy + SHELF_DEPTH}Z`} className={styles.sideLeft} />
            <path d={`M372 ${cy}L256 ${cy + 56}V${cy + 56 + SHELF_DEPTH}L372 ${cy + SHELF_DEPTH}Z`} className={styles.sideRight} />
            <path d={`M256 ${cy - 56}L372 ${cy}L256 ${cy + 56}L140 ${cy}Z`} fill={green} className={styles.glass} />
            {/* the shelves above the bottom one carry a grow light along their underside */}
            {i > 0 ? (
              <g className={`${styles.light} ${styles[`light${i}`]}`}>
                <path
                  d={`M140 ${cy + SHELF_DEPTH}L256 ${cy + 56 + SHELF_DEPTH}L372 ${cy + SHELF_DEPTH}`}
                  stroke={GREENS[0]}
                  strokeWidth="12"
                  fill="none"
                  strokeLinejoin="round"
                  filter={`url(#${id}-soft)`}
                />
                <path
                  d={`M146 ${cy + SHELF_DEPTH}L256 ${cy + 53 + SHELF_DEPTH}L366 ${cy + SHELF_DEPTH}`}
                  stroke="#F4FFD6"
                  strokeWidth="3"
                  fill="none"
                  strokeLinejoin="round"
                />
              </g>
            ) : null}
          </g>
        ))}

        {/* the sprout's own origin is its base, so it grows up out of the tower */}
        <g transform="translate(256 182)">
          <g className={styles.sprout}>
            <g transform="scale(1.32) translate(-256 -184)">
              <g filter={`url(#${id}-glow)`} opacity="0.9" fill={GREENS[0]}>
                <path d={LEAF_LEFT} />
                <path d={LEAF_RIGHT} />
              </g>
              <path d="M256 186V128" strokeWidth="13" strokeLinecap="round" className={styles.stem} />
              <path d={LEAF_LEFT} fill={`url(#${id}-sprout)`} />
              <path d={LEAF_RIGHT} fill={`url(#${id}-sprout)`} />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
