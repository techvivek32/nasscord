"use client";

import * as React from "react";
import { toast } from "sonner";
import { FlaskConicalIcon, RadioIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TONE_BADGE } from "@/components/status-dot";
import { cn } from "@/lib/utils";
import { usePaperMode } from "@/components/terminal/hooks";
import { useTerminalStore } from "@/components/terminal/store";

/** Header pill. Reflects the store; the switch lives in the sidebar footer. */
export function PaperLiveBadge({ className }: { className?: string }) {
  const { paperMode, hydrated } = usePaperMode();
  if (!hydrated) return <Skeleton className={cn("h-5 w-14 rounded-4xl", className)} />;
  return (
    <Badge variant="secondary" data-tour="paper-live" className={cn("gap-1", paperMode ? TONE_BADGE.warn : TONE_BADGE.good, className)} title={paperMode ? "Orders route to paper accounts only" : "Orders route to your live broker accounts"}>
      {paperMode ? <FlaskConicalIcon /> : <RadioIcon />}
      {paperMode ? "Paper" : "Live"}
    </Badge>
  );
}

/** Switch with a confirmation when leaving paper mode. Used in the sidebar footer. */
export function PaperModeSwitch({ id = "paper-mode", compact = false }: { id?: string; compact?: boolean }) {
  const { paperMode, hydrated } = usePaperMode();
  const setPaperMode = useTerminalStore((s) => s.setPaperMode);
  const [confirmLive, setConfirmLive] = React.useState(false);

  const onChange = (next: boolean) => {
    if (!next) {
      setConfirmLive(true);
      return;
    }
    setPaperMode(true);
    toast("Paper mode on", { description: "New orders route to your paper account. Live positions stay visible." });
  };

  const goLive = () => {
    setPaperMode(false);
    setConfirmLive(false);
    toast.success("Live trading on", { description: "Orders now go to the broker account you pick on the ticket." });
  };

  return (
    <>
      <div data-tour="paper-mode" className={cn("flex items-center justify-between gap-2 rounded-lg px-2 py-1.5", compact && "px-0")}>
        <Label htmlFor={id} className="cursor-pointer text-sm font-medium group-data-[collapsible=icon]:hidden">
          <FlaskConicalIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Paper mode
        </Label>
        {hydrated ? <Switch id={id} checked={paperMode} onCheckedChange={onChange} aria-label="Paper mode" /> : <Skeleton className="h-[18px] w-8 rounded-full" />}
      </div>
      <Dialog open={confirmLive} onOpenChange={setConfirmLive}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch to live trading?</DialogTitle>
            <DialogDescription>
              Orders you place from the ticket will be sent to the real broker account selected on it and can fill with real money. Brackets and risk sizing stay on.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLive(false)}>
              Stay on paper
            </Button>
            <Button onClick={goLive}>
              <RadioIcon />
              Go live
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
