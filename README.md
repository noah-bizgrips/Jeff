# Jeff

Private BizGrips second-brain / operations command center.

## What this starter contains

- A real Next.js project structure that Vercel can import and build.
- The current Jeff Mission Control UI, including Financial Accounts / Plaid in the Connections experience.
- A simple backend health endpoint at `/api/health`.
- Security headers and a strict `.gitignore`.
- No real credentials and no live data connections.

## Important current limitation

The UI displayed at `/` is the current standalone Jeff prototype embedded from `public/jeff-command-center-plaid.html`. It intentionally uses sample data and does not yet implement Supabase authentication, OAuth callbacks, encrypted connector storage, Claude execution, or background synchronization.

Do not enter real credentials into the prototype UI.

## Next deployment stages

1. Import this repository into Vercel.
2. Add the Supabase public/server environment variables directly in Vercel.
3. Replace the prototype shell with owner-only Supabase authentication and mandatory MFA.
4. Add the protected credential broker.
5. Connect Google, Slack, Notion, HighLevel, Stripe, Plaid, Meta, GitHub, and n8n one at a time.
6. Enable Claude/Sandbox execution only after the access controls are verified.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Health check: `http://localhost:3000/api/health`
