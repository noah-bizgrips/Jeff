import { Suspense } from "react";
import { MemoriesView } from "@/components/jeff/views";

export default function MemoriesPage() {
  return (
    <Suspense>
      <MemoriesView />
    </Suspense>
  );
}
