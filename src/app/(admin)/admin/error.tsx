"use client";

import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";

/** A console page whose server read failed (database down, Supabase not configured). The layout stays. */
export default function ConsoleError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <EmptyState
      title="This page could not load"
      description={`The database did not answer the read this page needs. Try again in a moment.${error.digest ? ` Reference ${error.digest}.` : ""}`}
      action={
        <Button variant="outline" size="sm" onClick={() => retry()}>
          Try again
        </Button>
      }
    />
  );
}
