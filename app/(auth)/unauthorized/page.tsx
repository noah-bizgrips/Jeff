import { AuthCard } from "@/components/auth/AuthForms";

export const dynamic = "force-dynamic";

export default function UnauthorizedPage() {
  return (
    <AuthCard>
      <h1>This workspace is private.</h1>
      <p>Jeff is a single-owner application. The account you signed in with is not the configured owner, so nothing here is available to it.</p>
      <form action="/auth/signout" method="post">
        <button className="button primary" type="submit">
          Sign out
        </button>
      </form>
      <p className="auth-note">If you are the owner and see this page, the server&apos;s OWNER_USER_ID / OWNER_EMAIL configuration does not match your account.</p>
    </AuthCard>
  );
}
