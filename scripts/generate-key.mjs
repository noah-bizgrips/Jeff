#!/usr/bin/env node
// Prints ONE freshly generated base64 key for JEFF_CREDENTIAL_ENCRYPTION_KEY.
// Paste it straight into Vercel (Sensitive) or .env.local — do not share it in chat.
import { randomBytes } from "node:crypto";
process.stdout.write(randomBytes(32).toString("base64") + "\n");
