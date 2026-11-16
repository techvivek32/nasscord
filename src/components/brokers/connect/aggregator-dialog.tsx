"use client";

import * as React from "react";
import { toast } from "sonner";
import { LoaderCircleIcon } from "lucide-react";
import { useStartAggregator } from "@/hooks/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { getBroker } from "@/lib/brokers";
import type { BrokerId, ConnectEnvironmentOption, ConnectSpec } from "@/lib/types";
import { ConnectedAccounts, RedirectWait, type RedirectWaitResult } from "@/components/brokers/connect/redirect-wait";
import { ConnectDialogHeader, ErrorAlert, OwnerOnlyNote, SpecDisclosure, SpecPrerequisites, SpecSteps } from "@/components/brokers/connect/spec-parts";
import { connectionName } from "@/components/brokers/connect/status";

/** Where to pick up: Reconnect answered next.kind "redirect" with the hop link for this connection. */
export interface AggregatorResume {
  connectionId: string;
  openUrl: string;
}

type Stage = { kind: "intro" } | { kind: "wait"; connectionId: string; openUrl: string } | { kind: "done"; result: RedirectWaitResult };

/**
 * The aggregator_portal flow (docs/real-backend.md section 8): a broker Nasscord reads through
 * SnapTrade's hosted portal. The dialog says plainly that SnapTrade is a data intermediary, that the
 * connection is read only and how fresh the data is, then opens SnapTrade's page (with the broker
 * already chosen and a read-only connection type, set by the broker service) through the canonical
 * hop in a new tab, and waits for the login (RedirectWait). With `resume` (Reconnect) it starts at the
 * wait step for that connection.
 */
export function AggregatorDialog({
  brokerId,
  spec,
  environments,
  ownerOnly = false,
  resume,
  onRestartResume,
  restartingResume = false,
  open,
  onOpenChange,
}: {
  brokerId: BrokerId;
  spec: ConnectSpec;
  environments: ConnectEnvironmentOption[];
  ownerOnly?: boolean;
  resume?: AggregatorResume;
  onRestartResume?: () => void;
  restartingResume?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const broker = getBroker(brokerId);
  const start = useStartAggregator();
  const [stage, setStage] = React.useState<Stage>(resume ? { kind: "wait", ...resume } : { kind: "intro" });
  const view: Stage = resume && stage.kind !== "done" ? { kind: "wait", ...resume } : stage;
  const busy = start.isPending;
  const environment = environments[0]?.value;

  const begin = () => {
    if (busy || !environment) return;
    start.mutate({ brokerId, environment }, { onSuccess: (res) => setStage({ kind: "wait", connectionId: res.connectionId, openUrl: res.openUrl }) });
  };

  const onConnected = React.useCallback(
    (result: RedirectWaitResult) => {
      setStage({ kind: "done", result });
      const n = result.connection.accounts.length;
      toast.success(`${connectionName(result.connection)} ${resume ? "reconnected" : "connected"} through SnapTrade`, {
        description: result.merged ? "This login was already connected, so Nasscord updated that connection." : `${n} ${n === 1 ? "account" : "accounts"} found.`,
      });
    },
    [resume],
  );

  const restart = () => {
    if (resume) {
      onRestartResume?.();
      return;
    }
    start.reset();
    setStage({ kind: "intro" });
  };

  const title = view.kind === "done" ? `${connectionName(view.result.connection)} connected` : resume ? `Reconnect ${broker.short}` : `Connect ${broker.name}`;
  const description =
    view.kind === "done"
      ? "Choose which accounts count toward your totals. You can change this later under Brokers."
      : view.kind === "wait"
        ? `Log in on ${broker.short}'s own page through SnapTrade in the new tab. This window notices the login by itself.`
        : spec.summary;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!busy}>
        <ConnectDialogHeader brokerId={brokerId} title={title} description={description} via="snaptrade" />

        {view.kind === "done" ? (
          <ConnectedAccounts connection={view.result.connection} merged={view.result.merged} />
        ) : view.kind === "wait" ? (
          <RedirectWait
            key={view.openUrl}
            brokerId={brokerId}
            connectionId={view.connectionId}
            openUrl={view.openUrl}
            via="snaptrade"
            reconnect={!!resume}
            onConnected={onConnected}
            onRestart={!resume || onRestartResume ? restart : undefined}
            restarting={restartingResume}
          />
        ) : (
          <div className="grid gap-4">
            {ownerOnly ? <OwnerOnlyNote /> : null}
            <SpecDisclosure text={spec.disclosure} note={spec.sessionNote} />
            <SpecPrerequisites items={spec.prerequisites} />
            <SpecSteps steps={spec.steps} />
            <ErrorAlert error={start.error} />
          </div>
        )}

        <DialogFooter>
          {view.kind === "done" ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : view.kind === "wait" ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={begin} disabled={busy || !environment}>
                {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
                {busy ? "Preparing SnapTrade's page" : "Continue"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
