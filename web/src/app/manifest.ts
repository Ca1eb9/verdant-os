import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "VerdantOS",
    short_name: "VerdantOS",
    description:
      "Installable control and monitoring dashboard for modern vertical farm operations.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#07131d",
    theme_color: "#07131d",
    icons: [
      {
        src: "/images/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/images/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/images/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/images/app-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
    // ?v=2: browsers that saved the original dark-tiled icons under the old year-long
    // cache keep them until the URL changes. Bump it when redrawing either icon.
    shortcuts: [
      {
        name: "Dashboard",
        short_name: "Dashboard",
        url: "/",
        icons: [{ src: "/images/dashboard-icon.svg?v=2", sizes: "any" }],
      },
      {
        name: "History",
        short_name: "History",
        url: "/history",
        icons: [{ src: "/images/history-icon.svg?v=2", sizes: "any" }],
      },
      {
        name: "Alerts",
        short_name: "Alerts",
        url: "/alerts",
        icons: [{ src: "/images/alert-danger.webp", sizes: "any" }],
      },
    ],
    categories: ["business", "productivity", "utilities"],
    lang: "en-US",
  };
}
