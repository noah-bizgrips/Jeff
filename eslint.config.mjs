import nextConfig from "eslint-config-next";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextConfig,
  ...nextTs,
  {
    ignores: [".next/**", "node_modules/**", "public/**", "coverage/**", "supabase/.temp/**", "docs/**"],
  },
  {
    rules: {
      // Secrets never belong in console output; log through lib/security/log instead.
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
];

export default config;
