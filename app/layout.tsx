import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./theme-black.css";
import "./theme-black-pages.css";

export const metadata: Metadata = {
  title: "Jeff — Private Mission Control",
  description: "Jeff, the private BizGrips second brain and operations command center.",
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-180.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
  // Installed as a standalone app on iOS: required for Web Push on iPhone.
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Jeff" },
};

export const viewport: Viewport = {
  themeColor: "#090f1c",
  colorScheme: "dark",
  viewportFit: "cover", // lets env(safe-area-inset-*) work in the iOS home-screen app
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
