# Gomez

Private BizGrips second brain and operations command center. Single owner, MFA-only, server-enforced.

Production: https://jeff.bizgrips.com

## Stack

Next.js 16 (App Router, Proxy), React 19, TypeScript, Supabase (Postgres + Auth + RLS, `@supabase/ssr`),
Vercel, Anthropic SDK (Claude Opus 5), Stripe, Plaid, Zod, Vitest.

## Layout

```
app/
  (auth)/login, mfa, unauthorized     public auth screens
  (gomez)/                             protected workspace (Mission control, Missions, Insights, Approvals,
                                      Search, Memories, Saved answers, Connections, Security)
  api/                                route handlers (auth/mfa, oauth, integrations, plaid, webhooks, gomez/chat, ...)
components/  gomez | brain | assistant | connections | mission-control | security | auth
lib/         auth | supabase | crypto | integrations | audit | security | gomez
supabase/migrations/                  versioned SQL (schema + RLS)
docs/prototype/                       the original standalone HTML prototype (reference only, not served)
tests/                                Vitest security/unit tests
```

## Local development

```bash
cp .env.example .env.local        # fill in values privately; never commit
npm install
npm run key:generate              # → paste into JEFF_CREDENTIAL_ENCRYPTION_KEY
npm run dev
```

Verify everything: `npm run verify` (typecheck + lint + tests + build).

## Database

Migrations live in `supabase/migrations`. Apply with the Supabase CLI after linking:

```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npm run db:push:dry               # review
npm run db:push
```

Then bind the owner once (after creating the owner user in Supabase Auth and setting `OWNER_USER_ID`):
sign in to Gomez and `POST /api/admin/bind-owner`, or locally `npm run owner:bind`.

## Modes

- **Demo** — sample data only, clearly labelled, never mixed into analysis.
- **Live** — synced records from connected sources only. Toggle in the header (owner only).

See `SECURITY.md` for the security model and `SETUP_STATUS.md` for rollout status.
