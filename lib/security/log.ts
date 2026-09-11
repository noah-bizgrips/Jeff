import { redact } from "./redact";

type Level = "info" | "warn" | "error";

/**
 * Structured, redacted logger. Everything passing through here is scrubbed.
 * Do not log request bodies, headers, or provider responses wholesale.
 */
function emit(level: Level, event: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...(meta ? redact(meta) : {}) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (process.env.NODE_ENV !== "test") console.warn(line);
}

export const log = {
  info: (event: string, meta?: Record<string, unknown>) => emit("info", event, meta),
  warn: (event: string, meta?: Record<string, unknown>) => emit("warn", event, meta),
  error: (event: string, meta?: Record<string, unknown>) => emit("error", event, meta),
};

/** Produces a safe, redacted message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}
