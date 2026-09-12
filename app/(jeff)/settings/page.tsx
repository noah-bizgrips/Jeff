import { createClient } from "@/lib/supabase/server";
import { resolveOwnerSession } from "@/lib/auth/session";
import { getSettings } from "@/lib/jeff/settings-store";
import { SettingsView } from "@/components/settings/SettingsView";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createClient();
  const session = await resolveOwnerSession(supabase);
  if (session.status !== "owner") return null;
  const settings = await getSettings(session.userId);
  // The VAPID public key is public by design (it identifies the push sender).
  return <SettingsView initial={settings} vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ""} />;
}
