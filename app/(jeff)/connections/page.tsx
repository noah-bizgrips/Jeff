import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { PROVIDERS } from "@/lib/integrations/registry";
import { hasEnv } from "@/lib/env";
import { ConnectionsView, type CatalogEntry, type ServiceRequestItem } from "@/components/connections/ConnectionsView";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const supabase = await createClient();
  const catalog: CatalogEntry[] = PROVIDERS.map((p) => ({ ...p, configured: p.requiredEnv.every(hasEnv), missingEnv: p.requiredEnv.filter((n) => !hasEnv(n)) }));
  const { data } = await supabase.from("service_requests").select("id, service_name, desired_capability, access_intent, status, classification_notes, matched_provider, created_at").order("created_at", { ascending: false }).limit(50);
  return (
    <Suspense>
      <ConnectionsView catalog={catalog} requests={(data ?? []) as ServiceRequestItem[]} />
    </Suspense>
  );
}
