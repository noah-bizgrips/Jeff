import type { MetadataRoute } from "next";

/** Web app manifest so Jeff installs as a standalone home-screen app (required for iOS push). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Jeff",
    short_name: "Jeff",
    description: "Private BizGrips second brain and operations command center.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#050505",
    theme_color: "#050505",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
