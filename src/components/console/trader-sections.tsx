"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setWorkspacePlan, setWorkspaceStatus } from "@/lib/server/console-actions";
import { getPlan, PLANS, PLAN_LABEL } from "@/lib/plans";
import type { PlanId, Workspace, WorkspaceStatus } from "@/lib/types";
import { attempt, WORKSPACE_STATUS, WORKSPACE_STATUSES } from "./lib";

const PLAN_ITEMS = PLANS.map((p) => ({ value: p.id, label: p.name }));
const STATUS_ITEMS = WORKSPACE_STATUSES.map((s) => ({ value: s, label: WORKSPACE_STATUS[s].label }));

type Pending = { kind: "plan"; value: PlanId } | { kind: "status"; value: WorkspaceStatus } | null;

function seatText(limit: number | "unlimited") {
  return limit === "unlimited" ? "unlimited members" : `${limit} member${limit === 1 ? "" : "s"}`;
}

/**
 * Plan and status of one workspace. Picking a new value asks for confirmation, then saves through
 * the console server actions (which audit the change). The page re-renders with the stored value.
 */
export function WorkspaceControls({ workspace }: { workspace: Pick<Workspace, "id" | "name" | "plan" | "status" | "seats"> }) {
  const [pending, setPending] = React.useState<Pending>(null);
  const [saving, startSaving] = React.useTransition();
  const id = React.useId();

  function confirm() {
    if (!pending) return;
    const change = pending;
    startSaving(async () => {
      const r = await attempt(() => (change.kind === "plan" ? setWorkspacePlan(workspace.id, change.value) : setWorkspaceStatus(workspace.id, change.value)));
      if (r.ok) {
        toast.success(change.kind === "plan" ? `${workspace.name} is on ${PLAN_LABEL[change.value as PlanId]}` : `${workspace.name} is ${WORKSPACE_STATUS[change.value as WorkspaceStatus].label.toLowerCase()}`);
        setPending(null);
      } else {
        toast.error(r.error);
      }
    });
  }

  const nextPlan = pending?.kind === "plan" ? getPlan(pending.value) : null;
  const overSeats = nextPlan && nextPlan.limits.seats !== "unlimited" && workspace.seats > nextPlan.limits.seats;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-plan`}>Plan</Label>
        <Select items={PLAN_ITEMS} value={workspace.plan} onValueChange={(v) => v && v !== workspace.plan && setPending({ kind: "plan", value: v as PlanId })}>
          <SelectTrigger id={`${id}-plan`} className="w-full" disabled={saving}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLAN_ITEMS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Stored on the workspace and shown in the console. Plan limits are not enforced yet and billing is not connected.</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-status`}>Status</Label>
        <Select items={STATUS_ITEMS} value={workspace.status} onValueChange={(v) => v && v !== workspace.status && setPending({ kind: "status", value: v as WorkspaceStatus })}>
          <SelectTrigger id={`${id}-status`} className="w-full" disabled={saving}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_ITEMS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Stored on the workspace and shown across the console.</p>
      </div>

      <Dialog open={pending !== null} onOpenChange={(o) => !o && !saving && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === "plan" ? `Move ${workspace.name} to ${PLAN_LABEL[pending.value]}?` : pending ? `Mark ${workspace.name} as ${WORKSPACE_STATUS[pending.value].label.toLowerCase()}?` : ""}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === "plan" && nextPlan
                ? `The plan is stored on the workspace and written to the audit log. ${nextPlan.name} lists ${seatText(nextPlan.limits.seats)}, but plan limits are not enforced yet and billing is not connected, so nothing changes for the trader.`
                : "The new status is stored on the workspace and written to the audit log. The terminal does not act on it yet, so its members can still sign in."}
            </DialogDescription>
          </DialogHeader>
          {overSeats ? (
            <p className="text-sm text-warn-foreground">
              The workspace has {workspace.seats} members, more than {nextPlan?.name} lists. Nobody is removed.
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button variant={pending?.kind === "status" && pending.value === "suspended" ? "destructive" : "default"} disabled={saving} onClick={confirm}>
              {saving ? "Saving" : pending?.kind === "plan" ? "Change plan" : "Change status"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
