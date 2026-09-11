import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./lib/security/headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Never bundle the Node SDKs into edge/client output.
  serverExternalPackages: ["@anthropic-ai/sdk", "stripe", "plaid"],
  async headers() {
    const headers = STATIC_SECURITY_HEADERS.filter(
      // HSTS only makes sense over HTTPS; Vercel serves production over HTTPS.
      (h) => h.key !== "Strict-Transport-Security" || process.env.NODE_ENV === "production",
    );
    return [{ source: "/:path*", headers }];
  },
};

export default nextConfig;
