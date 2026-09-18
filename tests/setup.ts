import { beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// Test-only values. These are NOT real credentials.
Object.assign(process.env, { NODE_ENV: "test" });
process.env.NEXT_PUBLIC_APP_URL = "https://gomez.test";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test_placeholder";
process.env.SUPABASE_SECRET_KEY = "sb_secret_test_placeholder";
process.env.OWNER_EMAIL = "noah@bizgrips.com";
process.env.OWNER_USER_ID = "11111111-1111-4111-8111-111111111111";
process.env.JEFF_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  process.env.OWNER_USER_ID = "11111111-1111-4111-8111-111111111111";
  process.env.OWNER_EMAIL = "noah@bizgrips.com";
});
