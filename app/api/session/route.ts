import { json } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { effectiveMode } from "@/lib/mode";

export const dynamic = "force-dynamic";

/** Minimal session descriptor for the UI. Never includes tokens. */
export async function GET() {
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status !== "owner") return json({ status: session.status }, { status: 401 });
  return json({ status: "owner", email: session.email, aal: session.aal, mode: await effectiveMode() });
}
