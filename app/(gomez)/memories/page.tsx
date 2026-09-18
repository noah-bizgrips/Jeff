import { Suspense } from "react";
import { MemoriesView } from "@/components/gomez/views";

export default function MemoriesPage() {
  return (
    <Suspense>
      <MemoriesView />
    </Suspense>
  );
}
