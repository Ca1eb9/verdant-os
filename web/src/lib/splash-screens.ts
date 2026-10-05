// Launch images for the home-screen app on iPhone and iPad. iOS only shows
// one whose size matches the screen exactly, so there's one per screen size
// (public/images/splash/). Rendered from this list: keep both in step.

/** [width, height] in CSS px (portrait), device pixel ratio, and whether it's an iPad */
const SCREENS: [number, number, number, boolean][] = [
  // iPhone
  [440, 956, 3, false], // 16 Pro Max, 17 Pro Max
  [430, 932, 3, false], // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [428, 926, 3, false], // 12 Pro Max, 13 Pro Max, 14 Plus
  [420, 912, 3, false], // Air
  [414, 896, 3, false], // XS Max, 11 Pro Max
  [414, 896, 2, false], // XR, 11
  [414, 736, 3, false], // 6 Plus to 8 Plus
  [402, 874, 3, false], // 16 Pro, 17, 17 Pro
  [393, 852, 3, false], // 14 Pro, 15, 15 Pro, 16
  [390, 844, 3, false], // 12, 12 Pro, 13, 13 Pro, 14, 16e
  [375, 812, 3, false], // X, XS, 11 Pro, 12 mini, 13 mini
  [375, 667, 2, false], // 6 to 8, SE (2nd and 3rd)
  [320, 568, 2, false], // SE (1st)
  // iPad
  [1032, 1376, 2, true], // Pro 13" (M4)
  [1024, 1366, 2, true], // Pro 12.9", Air 13"
  [834, 1210, 2, true], // Pro 11" (M4)
  [834, 1194, 2, true], // Pro 11"
  [834, 1112, 2, true], // Air (3rd), Pro 10.5"
  [820, 1180, 2, true], // Air 10.9" and 11", iPad (10th)
  [810, 1080, 2, true], // iPad (7th to 9th)
  [768, 1024, 2, true], // mini (5th), iPad 9.7"
  [744, 1133, 2, true], // mini (6th and 7th)
];

/** Phones open in portrait; iPads are held either way */
export const SPLASH_SCREENS = SCREENS.flatMap(([width, height, scale, ipad]) =>
  (ipad ? (["portrait", "landscape"] as const) : (["portrait"] as const)).map((orientation) => {
    const [w, h] = orientation === "portrait" ? [width * scale, height * scale] : [height * scale, width * scale];
    return {
      url: `/images/splash/splash-${w}x${h}.png`,
      media:
        `(device-width: ${width}px) and (device-height: ${height}px) ` +
        `and (-webkit-device-pixel-ratio: ${scale}) and (orientation: ${orientation})`,
    };
  }),
);
