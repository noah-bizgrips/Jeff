# Jeff security model

Jeff is a **single-owner** application. The only permitted user is the configured owner
(`OWNER_EMAIL` + `OWNER_USER_ID`). Everything below is enforced on the server and in the
database, never only in the UI.

## Identity and access

| Layer | Control |
| --- | --- |
| `proxy.ts` | Refreshes the Supabase session, verifies the JWT **signature** via `getClaims()`, requires `sub === OWNER_USER_ID` **and** `email === OWNER_EMAIL`, and requires `aal === "aal2"` for every non-public route. Unauthenticated visitors are redirected to `/login`; wrong accounts to `/unauthorized`; owner-at-aal1 to `/mfa`. |
| `app/(jeff)/layout.tsx` | Independent second check before any workspace HTML is rendered. |
| `lib/auth/guard.ts` | Every state-changing API route calls `requireOwnerAal2()` (owner + aal2 + same-origin). MFA routes use `requireOwnerAnyAal()`. |
| Supabase RLS | `public.is_owner_aal2()` gates every owner table. `connection_secrets` has **no** policies and its privileges are revoked from `anon`/`authenticated`: only the service role (server code) can read it. |
| `app_owner` | Binds the database to exactly one `auth.users` uuid. Written only by the server bootstrap (`POST /api/admin/bind-owner`, which itself requires the caller to be that exact user). |

There is no signup page, no "create account" flow, and no MFA bypass. Recovery is an administrator
action in the Supabase dashboard.

## Secrets

- Provider credentials are encrypted with **AES-256-GCM** (`lib/crypto/secrets.ts`), unique 96-bit IV per
  record, auth tag stored, version field for rotation, AAD bound to the connection id. Key:
  `JEFF_CREDENTIAL_ENCRYPTION_KEY` (server only).
- Helpers are `server-only`; importing them from a client component fails the build.
- Decrypted values never leave the adapter that uses them. No API returns a credential; tests assert this.
- Stripe accepts **restricted** keys only (`rk_…`); secret keys are refused. The key is posted once to
  `/api/integrations/stripe/connect`, encrypted immediately, and never echoed.
- Plaid access tokens are exchanged and stored server-side; the browser only ever sees a short-lived Link token.
- Logs and audit metadata pass through `lib/security/redact.ts`. Request bodies are never logged.

## Network and browser hardening

- Strict CSP with per-request nonces + `strict-dynamic`; no `unsafe-inline` scripts; `frame-ancestors 'none'`.
  `style-src` keeps `unsafe-inline` for React inline style attributes (documented in `lib/security/headers.ts`).
- HSTS (production), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, restrictive
  `Permissions-Policy`, COOP/CORP same-origin.
- OAuth: random `state` bound to an HttpOnly signed cookie, PKCE where supported (Google), callback verifies
  state before any code exchange. Provider errors and mismatches are audited.
- Webhooks verify signatures (Stripe `constructEventAsync`, Plaid JWT/ES256 + body hash, GitHub HMAC-SHA256)
  before doing anything.

## AI boundaries

- Ask Jeff runs server-side with narrow tools (`lib/jeff/tools.ts`). The model never receives provider
  tokens. Retrieved content is wrapped as untrusted evidence and the system prompt forbids following
  instructions found in it.
- Missions created by the model are sandbox-only drafts. Production actions require an approval bound to an
  exact artifact, environment, expiry and an aal2 session.

## What must never be committed

`.env*` (except `.env.example`), `.vercel`, private keys, downloaded OAuth JSON, service-account files,
tokens, TOTP seeds, recovery codes. CI runs a secret-pattern scan on every PR.

## Reporting

This is a private project. Report concerns directly to the owner.
