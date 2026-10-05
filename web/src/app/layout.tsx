import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "@/app/globals.css";
import { Analytics } from "@vercel/analytics/next";
import { FarmProvider } from "@/components/farms/FarmContext";
import { PreferencesProvider } from "@/components/preferences/PreferencesProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PwaRegistrar } from "@/components/pwa/PwaRegistrar";
import { SPLASH_SCREENS } from "@/lib/splash-screens";

// applies the saved theme and sidebar state before first paint so neither flashes.
// Theme: saved choice, else the browser's preference, else dark.
const PREPAINT_SCRIPT = `(function(){var d=document.documentElement,p={};try{p=JSON.parse(localStorage.getItem("verdantos:preferences")||"{}")||{}}catch(e){}var t=p.theme==="light"||p.theme==="dark"?p.theme:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");d.dataset.theme=t;d.dataset.sidebar=p.sidebarCollapsed===true?"collapsed":"expanded"})()`;

// IBM Plex, stored in the repo (app/fonts, SIL Open Font License) so the app
// builds and runs on a farm network with no internet access
const plexSans = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
  fallback: ["Segoe UI", "Helvetica Neue", "Arial", "sans-serif"],
});

const plexMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
  fallback: ["ui-monospace", "Menlo", "monospace"],
});

export const metadata: Metadata = {
  title: {
    default: "VerdantOS Control Room",
    template: "%s | VerdantOS",
  },
  description:
    "Premium progressive web app for vertical farm monitoring, live sensor ingestion, and historical environmental analysis.",
  applicationName: "VerdantOS Control Room",
  manifest: "/manifest.webmanifest",
  icons: {
    // favicon.svg switches to its glowing dark version on a dark browser theme;
    // the PNG is the light-safe fallback for browsers without SVG favicons
    icon: [
      { url: "/images/favicon.svg", type: "image/svg+xml" },
      { url: "/images/favicon-48.png", sizes: "48x48", type: "image/png" },
    ],
    apple: [
      {
        url: "/images/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "VerdantOS",
    // the home-screen app's launch screen, one per iPhone and iPad screen size
    startupImage: SPLASH_SCREENS,
  },
  formatDetection: {
    telephone: false,
  },
  category: "technology",
  other: {
    "mobile-web-app-capable": "yes",
    "msapplication-TileColor": "#07131d",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#07131d" },
    { media: "(prefers-color-scheme: light)", color: "#eef2f6" },
  ],
  colorScheme: "dark light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark" className={`${plexSans.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREPAINT_SCRIPT }} />
      </head>
      <body>
        <PwaRegistrar />
        <PreferencesProvider>
          <FarmProvider>
            <AppShell>{children}</AppShell>
          </FarmProvider>
        </PreferencesProvider>
        <Analytics />
      </body>
    </html>
  );
}
