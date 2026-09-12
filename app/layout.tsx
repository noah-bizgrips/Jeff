import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jeff — Private Mission Control",
  description: "Jeff, the private BizGrips second brain and operations command center.",
  robots: { index: false, follow: false },
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 64 64%27%3E%3Crect width=%2764%27 height=%2764%27 rx=%2716%27 fill=%27%230f203b%27/%3E%3Ctext x=%2732%27 y=%2748%27 font-family=%27Arial,sans-serif%27 font-size=%2744%27 font-weight=%27700%27 text-anchor=%27middle%27 fill=%27%2380bdff%27%3EJ%3C/text%3E%3C/svg%3E",
  },
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
