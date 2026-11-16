"use client";

import * as React from "react";
import { toast } from "sonner";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Nasscord's one callback URL for a broker (https://nasscord.com/api/broker/callback/<broker>), as the
 * broker service reports it, with a Copy button. The user enters it in their own developer app
 * exactly as shown: a broker compares it character by character.
 */
export function CallbackUrl({ url, label = "Callback URL", className }: { url: string; label?: string; className?: string }) {
  const id = React.useId();
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Callback URL copied", { description: "Paste it into your app's callback field exactly as it is." });
    } catch {
      toast.error("The callback URL was not copied", { description: "Your browser blocked the clipboard. Select the address and copy it by hand." });
    }
  };

  return (
    <div className={cn("grid gap-1.5", className)}>
      <span id={`${id}-label`} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 py-1.5 pr-1.5 pl-3">
        <code aria-labelledby={`${id}-label`} className="min-w-0 flex-1 self-center font-mono text-xs break-all select-all">
          {url}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={copy} aria-label={copied ? "Callback URL copied" : "Copy the callback URL"}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
