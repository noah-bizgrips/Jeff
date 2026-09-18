import { Suspense } from "react";
import { SearchView } from "@/components/gomez/views";

export default function SearchPage() {
  return (
    <Suspense>
      <SearchView />
    </Suspense>
  );
}
