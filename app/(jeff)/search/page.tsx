import { Suspense } from "react";
import { SearchView } from "@/components/jeff/views";

export default function SearchPage() {
  return (
    <Suspense>
      <SearchView />
    </Suspense>
  );
}
