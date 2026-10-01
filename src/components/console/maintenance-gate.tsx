"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useConsoleStore } from "./store";
import { MAINTENANCE_EXEMPT, MAINTENANCE_WINDOW, MAINTENANCE_WINDOW_INLINE } from "./lib";

/**
 * Maintenance gate switch. Turning it on asks for confirmation first because it
 * blocks traders during regular hours; turning it off is immediate.
 */
export function MaintenanceSwitch({ id, size = "default", className }: { id: string; size?: "sm" | "default"; className?: string }) {
  const on = useConsoleStore((s) => s.maintenanceOn);
  const setMaintenance = useConsoleStore((s) => s.setMaintenance);
  const [confirm, setConfirm] = React.useState(false);

  return (
    <>
      <Switch
        id={id}
        size={size}
        checked={on}
        aria-label="Maintenance gate"
        className={className}
        onCheckedChange={(next) => {
          if (next) setConfirm(true);
          else {
            setMaintenance(false);
            toast.success("Maintenance gate off. Terminals render normally again.");
          }
        }}
      />
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Turn on the maintenance gate?</DialogTitle>
            <DialogDescription>
              Trader terminals show a maintenance page instead of positions and orders while the gate is on during regular market hours.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Active window</dt>
              <dd className="font-medium">{MAINTENANCE_WINDOW}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Who is blocked</dt>
              <dd className="text-right font-medium">Every tenant login, including white-label domains</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Exempt</dt>
              <dd className="font-mono text-xs">{MAINTENANCE_EXEMPT.join(", ")}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">Pre-market, after-hours and weekends are not affected. Working orders at the brokers keep working; only the terminal UI is gated.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setMaintenance(true);
                setConfirm(false);
                toast.warning("Maintenance gate on", { description: `Terminals are gated ${MAINTENANCE_WINDOW_INLINE}.` });
              }}
            >
              Turn on
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function MaintenanceRow({ className }: { className?: string }) {
  const on = useConsoleStore((s) => s.maintenanceOn);
  return (
    <div data-tour="maintenance" className={cn("flex items-center justify-between gap-2 rounded-lg px-2 py-1.5", className)}>
      <label htmlFor="sidebar-maintenance" className="grid cursor-pointer gap-0 group-data-[collapsible=icon]:hidden">
        <span className="text-xs font-medium">Maintenance gate</span>
        <span className={cn("text-[11px]", on ? "text-warn-foreground" : "text-muted-foreground")}>{on ? MAINTENANCE_WINDOW : "Off"}</span>
      </label>
      <MaintenanceSwitch id="sidebar-maintenance" size="sm" />
    </div>
  );
}
