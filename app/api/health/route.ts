import { NextResponse } from "next/server";
import { hasEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Public liveness probe. Reports configuration PRESENCE only, never values. */
export async function GET() {
  return NextResponse.json(
    {
      app: "Jeff",
      status: "ok",
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      config: {
        supabase: hasEnv("NEXT_PUBLIC_SUPABASE_URL") && hasEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") && hasEnv("SUPABASE_SECRET_KEY"),
        owner: hasEnv("OWNER_USER_ID"),
        encryption: hasEnv("JEFF_CREDENTIAL_ENCRYPTION_KEY"),
        anthropic: hasEnv("ANTHROPIC_API_KEY"),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
