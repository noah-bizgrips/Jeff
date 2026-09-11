# Jeff security rules

This repository must never contain production credentials.

Do not commit:
- `.env` files
- Supabase secret/service-role keys
- Anthropic API keys
- OAuth client secrets or access/refresh tokens
- Stripe restricted keys or webhook signing secrets
- Plaid secrets or Item access tokens
- Meta app secrets
- GitHub private keys
- n8n API keys
- passwords, MFA seeds, QR codes, or recovery codes

The current UI is a sample-data prototype. A connection is not considered live until the production backend authenticates it and passes a non-destructive verification test.
