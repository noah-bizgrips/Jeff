/**
 * Pure claim → session mapping. No I/O, so it is usable in proxy.ts and tests.
 */
export type ClaimSession =
  | { status: "anonymous" }
  | { status: "unauthorized" }
  | { status: "owner"; aal: "aal1" | "aal2" };

export function resolveOwnerSessionFromClaims(
  claims: Record<string, unknown> | null,
  owner: { email: string; userId: string },
): ClaimSession {
  if (!claims) return { status: "anonymous" };
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!sub) return { status: "anonymous" };
  if (!owner.userId || sub !== owner.userId || !email || email !== owner.email) return { status: "unauthorized" };
  return { status: "owner", aal: claims.aal === "aal2" ? "aal2" : "aal1" };
}
