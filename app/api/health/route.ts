import { NextResponse } from "next/server";
import { hasEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Public liveness probe. Reports configuration PRESENCE only, never values. */
async function serverKeyWorks(): Promise<boolean> {
  if (!hasEnv("SUPABASE_SECRET_KEY")) return false;
  try {
    const { error } = await createAdminClient().from("app_owner").select("id", { head: true, count: "exact" });
    return !error;
  } catch {
    return false;
  }
}

export async function GET() {
  const supabaseServer = await serverKeyWorks();
  return NextResponse.json(
    {
      app: "Jeff",
      status: "ok",
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      config: {
        supabase: hasEnv("NEXT_PUBLIC_SUPABASE_URL") && hasEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") && hasEnv("SUPABASE_SECRET_KEY"),
        supabaseServerKeyValid: supabaseServer,
        owner: hasEnv("OWNER_USER_ID"),
        encryption: hasEnv("JEFF_CREDENTIAL_ENCRYPTION_KEY"),
        anthropic: hasEnv("ANTHROPIC_API_KEY"),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
