import "server-only";
import { cookies } from "next/headers";
import { appMode } from "@/lib/env";

/** Effective workspace mode: explicit cookie switch, else JEFF_MODE env (default demo). */
export async function effectiveMode(): Promise<"demo" | "live"> {
  const store = await cookies();
  const c = store.get("gomez_mode")?.value;
  if (c === "demo" || c === "live") return c;
  return appMode();
}
