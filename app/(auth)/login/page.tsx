import { LoginForm } from "@/components/auth/AuthForms";
import { ownerIdentity } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return <LoginForm ownerEmail={ownerIdentity().email} />;
}
