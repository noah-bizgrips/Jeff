import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { hasEnv } from "@/lib/env";
import { listConnections } from "@/lib/integrations/store";
import { SecurityView, type SecurityFacts } from "@/components/security/SecurityView";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status !== "owner") return null;
  const [factors, owner, audit, connections] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.from("app_owner").select("user_id").eq("id", 1).maybeSingle(),
    supabase.from("audit_events").select("id, event, provider, actor, created_at, metadata").order("created_at", { ascending: false }).limit(25),
    listConnections(session.userId).catch(() => []),
  ]);
  const facts: SecurityFacts = {
    ownerEmail: session.email,
    aal: session.aal,
    factors: (factors.data?.totp ?? []).map((f) => ({ id: f.id, name: f.friendly_name ?? null, status: f.status })),
    encryptionConfigured: hasEnv("JEFF_CREDENTIAL_ENCRYPTION_KEY"),
    ownerBound: !!owner.data?.user_id,
    anthropicConfigured: hasEnv("ANTHROPIC_API_KEY"),
    connectionsCount: connections.length,
    audit: (audit.data ?? []).map((a) => ({ id: a.id, event: a.event, provider: a.provider, actor: a.actor, createdAt: a.created_at, metadata: a.metadata ?? {} })),
  };
  return <SecurityView facts={facts} />;
}
