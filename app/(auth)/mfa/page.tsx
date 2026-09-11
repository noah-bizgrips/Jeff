import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { MfaFlow } from "@/components/auth/AuthForms";

export const dynamic = "force-dynamic";

export default async function MfaPage() {
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status === "anonymous") redirect("/login");
  if (session.status === "unauthorized") redirect("/unauthorized");
  return <MfaFlow aal={session.aal} />;
}
