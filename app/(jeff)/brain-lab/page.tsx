import { notFound } from "next/navigation";
import { BrainLab } from "@/components/brain/BrainLab";

export const dynamic = "force-dynamic";

/**
 * Dev harness for the brain visualization (spec §34). Hidden in production
 * unless JEFF_BRAIN_LAB=1; still behind the owner+aal2 (jeff) layout.
 */
export default function BrainLabPage() {
  if (process.env.NODE_ENV === "production" && process.env.JEFF_BRAIN_LAB !== "1") notFound();
  return <BrainLab />;
}
