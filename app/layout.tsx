import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jeff — Private Mission Control",
  description: "Jeff, the private BizGrips second brain and operations command center.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#090f1c",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
