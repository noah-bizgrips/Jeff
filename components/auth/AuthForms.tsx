"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/gomez/icons";

export function AuthCard({ children, step }: { children: React.ReactNode; step?: 1 | 2 }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand" aria-label="Gomez">
          <span className="brand-symbol">
            <Icon name="brain" />
          </span>
          <span>
            Gomez<span className="brand-period">.</span>
          </span>
        </div>
        {step ? (
          <div className="auth-steps" aria-hidden="true">
            <span className="done" />
            <span className={step === 2 ? "done" : ""} />
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function LoginForm({ ownerEmail }: { ownerEmail: string }) {
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState(ownerEmail);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; next?: string; error?: string } | null;
      setPassword("");
      if (!res.ok || !data?.ok) {
        setError(data?.error === "not_owner" ? "This account is not permitted to use Gomez." : "Sign-in failed. Check your email and password.");
        return;
      }
      router.push(data.next ?? "/");
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard step={1}>
      <h1>Welcome back, Noah.</h1>
      <p>Step 1 of 2 · Owner account and password. A password alone never unlocks Gomez.</p>
      {error ? (
        <div className="auth-error" role="alert">
          {error}
        </div>
      ) : null}
      <form onSubmit={onSubmit}>
        <label className="field">
          Permitted email
          <input type="email" name="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          Password
          <input type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : <Icon name="lock" />}
          Continue to authenticator
        </button>
      </form>
      <p className="auth-note">Single-owner workspace. There is no signup, no password-only access, and no MFA bypass. Recovery goes through the Supabase administrator.</p>
    </AuthCard>
  );
}

interface Factor {
  id: string;
  name: string | null;
  status: string;
}

export function MfaFlow({ aal }: { aal: "aal1" | "aal2" }) {
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [enroll, setEnroll] = useState<{ factorId: string; qrCode: string; uri: string } | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const verified = (factors ?? []).filter((f) => f.status === "verified");

  async function startEnroll() {
    setBusy(true);
    setError(null);
    try {
      // Clean up abandoned, unverified factors first (requires aal2; ignore failures at aal1).
      for (const f of (factors ?? []).filter((x) => x.status !== "verified")) {
        await fetch("/api/auth/mfa/unenroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ factorId: f.id }) }).catch(() => null);
      }
      const res = await fetch("/api/auth/mfa/enroll", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { factorId?: string; qrCode?: string; uri?: string; error?: string } | null;
      if (!res.ok || !data?.factorId) return setError(`Could not start enrollment (${data?.error ?? res.status}).`);
      setEnroll({ factorId: data.factorId, qrCode: data.qrCode ?? "", uri: data.uri ?? "" });
      const ch = await fetch("/api/auth/mfa/challenge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ factorId: data.factorId }) });
      const chd = (await ch.json().catch(() => null)) as { challengeId?: string } | null;
      setChallengeId(chd?.challengeId ?? null);
      setFactorId(data.factorId);
      setTimeout(() => codeRef.current?.focus(), 50);
    } finally {
      setBusy(false);
    }
  }

  async function startChallenge(fid: string) {
    setBusy(true);
    setError(null);
    try {
      const ch = await fetch("/api/auth/mfa/challenge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ factorId: fid }) });
      const chd = (await ch.json().catch(() => null)) as { challengeId?: string; error?: string } | null;
      if (!ch.ok || !chd?.challengeId) return setError(`Could not start a challenge (${chd?.error ?? ch.status}).`);
      setChallengeId(chd.challengeId);
      setFactorId(fid);
      setTimeout(() => codeRef.current?.focus(), 50);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    fetch("/api/auth/mfa/factors")
      .then((r) => r.json())
      .then((d: { factors?: Factor[] }) => {
        const list = d.factors ?? [];
        setFactors(list);
        // Auto-start a challenge when the owner already has a verified factor.
        const first = list.find((f) => f.status === "verified");
        if (first && aal !== "aal2") void startChallenge(first.id);
      })
      .catch(() => setError("Could not load your authenticator settings."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!factorId || !challengeId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factorId, challengeId, code, enrolling: !!enroll }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      setCode("");
      if (!res.ok || !data?.ok) {
        setError("That code did not verify. Codes rotate every 30 seconds — try the current one.");
        // A failed challenge is consumed; start a fresh one.
        if (!enroll) await startChallenge(factorId);
        else {
          const ch = await fetch("/api/auth/mfa/challenge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ factorId }) });
          const chd = (await ch.json().catch(() => null)) as { challengeId?: string } | null;
          setChallengeId(chd?.challengeId ?? null);
        }
        return;
      }
      router.push("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (factors === null) {
    return (
      <AuthCard step={2}>
        <h1>Authenticator</h1>
        <p>Loading your security settings…</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard step={2}>
      <h1>{enroll ? "Set up your authenticator." : aal === "aal2" ? "Authenticator settings" : "One more step."}</h1>
      <p>
        {enroll
          ? "Scan the QR code with your authenticator app (1Password, Google Authenticator, Authy…), then enter the 6-digit code."
          : verified.length
            ? "Step 2 of 2 · Enter the 6-digit code from your authenticator app."
            : "No authenticator is enrolled yet. Gomez requires one before the workspace opens."}
      </p>
      {error ? (
        <div className="auth-error" role="alert">
          {error}
        </div>
      ) : null}

      {enroll ? (
        <>
          <div className="qr-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URL from Supabase, never optimized/proxied */}
            {enroll.qrCode ? <img src={enroll.qrCode} alt="TOTP enrollment QR code" /> : null}
          </div>
          <p className="auth-note">
            Can&apos;t scan?{" "}
            <button type="button" className="text-button" onClick={() => setShowSecret((v) => !v)}>
              {showSecret ? "Hide setup key" : "Show setup key"}
            </button>
          </p>
          {showSecret ? <div className="code-hint">{enroll.uri}</div> : null}
        </>
      ) : null}

      {!enroll && !verified.length ? (
        <button className="button primary" type="button" disabled={busy} onClick={startEnroll}>
          {busy ? <span className="spinner" /> : <Icon name="lock" />}
          Enroll an authenticator
        </button>
      ) : null}

      {(enroll || (verified.length && aal !== "aal2")) && challengeId ? (
        <form onSubmit={verify}>
          <label className="field">
            6-digit code
            <input
              ref={codeRef}
              className="otp-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
            />
          </label>
          <button className="button primary" type="submit" disabled={busy || code.length !== 6}>
            {busy ? <span className="spinner" /> : <Icon name="check" />}
            {enroll ? "Verify and finish enrollment" : "Verify"}
          </button>
        </form>
      ) : null}

      {aal === "aal2" && !enroll ? (
        <>
          <div className="audit-list" style={{ marginTop: 12 }}>
            {verified.map((f) => (
              <div className="audit-row" key={f.id}>
                <Icon name="lock" />
                <div>
                  <strong>{f.name ?? "Authenticator"}</strong>
                  <p>Verified TOTP factor</p>
                </div>
                <span className="pill ok">Active</span>
              </div>
            ))}
          </div>
          <button className="button secondary" type="button" disabled={busy} onClick={startEnroll} style={{ marginTop: 12 }}>
            <Icon name="plus" />
            Add another authenticator
          </button>
          <p className="auth-note">
            <Link href="/">Back to Gomez</Link>
          </p>
        </>
      ) : null}

      <form action="/auth/signout" method="post" style={{ marginTop: 16 }}>
        <button className="text-button" type="submit">
          Sign out
        </button>
      </form>
    </AuthCard>
  );
}
