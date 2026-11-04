"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyText } from "./clipboard";

/** A read-only value with a copy button. The value is copied for real; the toast only reports what happened. */
export function CopyField({ id, label, value, mono = true }: { id: string; label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  async function onCopy() {
    const ok = await copyText(value);
    if (ok) {
      setCopied(true);
      toast.success(`${label} copied`);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("Could not copy automatically", { description: "Select the text and copy it by hand." });
    }
  }

  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input id={id} value={value} readOnly onFocus={(e) => e.currentTarget.select()} className={mono ? "font-mono text-xs" : undefined} />
        <Button type="button" variant="outline" size="icon" aria-label={`Copy ${label.toLowerCase()}`} onClick={onCopy}>
          {copied ? <Check className="text-gain-foreground" /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}
