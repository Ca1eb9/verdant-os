import type { Metadata, Viewport } from "next";
import "@/app/globals.css";
import { Analytics } from "@vercel/analytics/next";
import { FarmProvider } from "@/components/farms/FarmContext";
import { AppShell } from "@/components/layout/AppShell";
import { PwaRegistrar } from "@/components/pwa/PwaRegistrar";

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
    icon: [
      { url: "/images/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/images/icon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/images/app-icon.svg", type: "image/svg+xml" },
    ],
    apple: [
      {
        url: "/images/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
    other: [
      {
        rel: "mask-icon",
        url: "/images/mask-icon.svg",
        color: "#6ff7c3",
      },
      {
        rel: "apple-touch-startup-image",
        url: "/images/splash-screen.png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "VerdantOS",
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
    { media: "(prefers-color-scheme: light)", color: "#07131d" },
  ],
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <PwaRegistrar />
        <FarmProvider>
          <AppShell>{children}</AppShell>
        </FarmProvider>
        <Analytics />
      </body>
    </html>
  );
}
