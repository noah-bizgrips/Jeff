import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { isTrustedOrigin } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isTrustedOrigin(req)) return NextResponse.json({ error: "untrusted_origin" }, { status: 403 });
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  await supabase.auth.signOut({ scope: "global" });
  if (session.status === "owner") await audit({ event: "logout", ownerId: session.userId, request: req });
  const url = new URL("/login", req.url);
  return NextResponse.redirect(url, { status: 303 });
}
