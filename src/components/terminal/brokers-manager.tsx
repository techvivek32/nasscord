"use client";

import * as React from "react";
import { toast } from "sonner";
import { CircleAlertIcon, LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon, UnplugIcon } from "lucide-react";
import { useDisconnectConnection, useRenewConnection } from "@/hooks/queries";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { AccountIncludeList } from "@/components/brokers/connect/account-switches";
import { ConnectBrokers } from "@/components/brokers/connect/connect-brokers";
import { EtradeConnectDialog, type EtradeResume } from "@/components/brokers/connect/etrade-dialog";
import { IbkrConnectDialog } from "@/components/brokers/connect/ibkr-dialog";
import { CONNECTION_TONE, connectionName, environmentLabel, sessionLine } from "@/components/brokers/connect/status";
import { EmptyState } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getBroker } from "@/lib/brokers";
import { fmtDate } from "@/lib/format";
import type { BrokerConnection } from "@/lib/types";
import { ConnectionsError } from "@/components/terminal/broker-health";
import { useAccountScope, useMinuteClock } from "@/components/terminal/hooks";
import { CardSkeleton } from "@/components/terminal/skeletons";

type Resume = { kind: "ibkr"; connectionId: string; round: number } | { kind: "etrade"; resume: EtradeResume; round: number } | null;

/**
 * /app/brokers: the workspace's real connections (status, detail, session, accounts with Included
 * switches, Reconnect, Disconnect) and the connect entry point for IBKR and E*TRADE.
 */
export function BrokersManager() {
  const scope = useAccountScope();
  const now = useMinuteClock();
  const renew = useRenewConnection();
  const [renewingId, setRenewingId] = React.useState<string | null>(null);
  const [resume, setResume] = React.useState<Resume>(null);
  const [disconnecting, setDisconnecting] = React.useState<BrokerConnection | null>(null);

  // One renew at a time: every card shares this mutation, and a second call would drop the first one's callbacks.
  const reconnect = (c: BrokerConnection) => {
    if (renew.isPending) return;
    setRenewingId(c.id);
    renew.mutate(c.id, {
      onSuccess: (res) => {
        if (res.needsLogin && c.brokerId === "ibkr") {
          // The dialog opens the app's login route, which mints a fresh one-time link.
          setResume({ kind: "ibkr", connectionId: c.id, round: Date.now() });
        } else if (res.authorizeUrl && c.brokerId === "etrade") {
          setResume({ kind: "etrade", resume: { connectionId: c.id, authorizeUrl: res.authorizeUrl }, round: Date.now() });
        } else {
          toast.success(c.brokerId === "ibkr" ? "IBKR is still logged in" : `${connectionName(c)} session renewed`, {
            description: c.brokerId === "ibkr" ? "The gateway session is open, so there is nothing to renew." : "E*TRADE renewed the session for today.",
          });
        }
      },
      onError: (err) => toast.error(`${connectionName(c)} was not reconnected`, { description: err.message }),
      onSettled: () => setRenewingId(null),
    });
  };

  return (
    <>
      <section className="grid gap-3" aria-labelledby="brokers-connected">
        <h2 id="brokers-connected" className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Connected
        </h2>
        {scope.isLoading ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <CardSkeleton lines={4} />
            <CardSkeleton lines={4} />
          </div>
        ) : scope.error && scope.connections.length === 0 ? (
          <ConnectionsError scope={scope} />
        ) : scope.connections.length === 0 ? (
          <EmptyState title="No brokers connected" description="Connect IBKR or E*TRADE below. Nasscord reads balances, positions, orders and executions; it never moves money or places orders in this release." />
        ) : (
          <>
            {scope.portfolioError ? (
              <Alert>
                <CircleAlertIcon />
                <AlertTitle>Balances could not be read</AlertTitle>
                <AlertDescription>{scope.portfolioError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="grid gap-4 lg:grid-cols-2">
              {scope.connections.map((c) => (
                <ConnectionCard
                  key={c.id}
                  connection={c}
                  line={now ? sessionLine(c, now) : null}
                  renewing={renewingId === c.id}
                  renewBusy={renew.isPending}
                  onReconnect={() => reconnect(c)}
                  onDisconnect={() => setDisconnecting(c)}
                />
              ))}
            </div>
          </>
        )}
      </section>

      <section className="grid gap-3" aria-labelledby="brokers-add">
        <h2 id="brokers-add" className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Add a broker
        </h2>
        <ConnectBrokers layout="grid" />
      </section>

      {resume?.kind === "ibkr" ? <IbkrConnectDialog key={`ibkr-${resume.round}`} open resumeConnectionId={resume.connectionId} onOpenChange={(o) => !o && setResume(null)} /> : null}
      {resume?.kind === "etrade" ? <EtradeConnectDialog key={`etrade-${resume.round}`} open resume={resume.resume} onOpenChange={(o) => !o && setResume(null)} /> : null}

      <DisconnectDialog connection={disconnecting} onClose={() => setDisconnecting(null)} />
    </>
  );
}

function ConnectionCard({
  connection: c,
  line,
  renewing,
  renewBusy,
  onReconnect,
  onDisconnect,
}: {
  connection: BrokerConnection;
  line: string | null;
  renewing: boolean;
  renewBusy: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const b = getBroker(c.brokerId);
  const tone = CONNECTION_TONE[c.status];
  const live = c.status === "connected" || c.status === "expiring";
  const warn = c.status === "expiring" || (live && !!c.statusDetail);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <BrokerMark id={c.brokerId} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{b.name}</CardTitle>
              <Badge variant="outline">{environmentLabel(c.brokerId, c.environment)}</Badge>
              <StatusDot tone={tone.tone} label={<span className="text-xs">{tone.label}</span>} pulse={c.status === "pending"} />
            </div>
            <CardDescription>
              {line ?? "No session yet"}
              {c.connectedAt ? ` · added ${fmtDate(c.connectedAt)}` : ""}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      {c.statusDetail ? (
        <CardContent>
          <p className={warn || !live ? "flex items-start gap-2 text-sm text-warn-foreground" : "text-sm text-muted-foreground"}>
            {warn || !live ? <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : null}
            {c.statusDetail}
          </p>
        </CardContent>
      ) : null}
      <CardContent>
        <AccountIncludeList
          accounts={c.accounts}
          brokerShort={b.short}
          emptyText={c.status === "pending" ? `Accounts appear here once you finish the ${b.short} login.` : `${b.short} listed no accounts for this connection.`}
        />
      </CardContent>
      <CardContent className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="secondary">Read only</Badge>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={renewing || renewBusy} onClick={onReconnect}>
            {renewing ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
            {renewing ? "Reconnecting" : c.status === "pending" ? "Continue login" : "Reconnect"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDisconnect}>
            <UnplugIcon />
            Disconnect
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DisconnectDialog({ connection, onClose }: { connection: BrokerConnection | null; onClose: () => void }) {
  const disconnect = useDisconnectConnection();
  const [shown, setShown] = React.useState<BrokerConnection | null>(connection);
  // Keep the last connection on screen while the dialog animates closed.
  if (connection && connection !== shown) setShown(connection);
  const c = connection ?? shown;
  const name = c ? connectionName(c) : "";

  // Every way out clears the last attempt, so its error never shows up for the next connection.
  const close = () => {
    if (disconnect.isPending) return;
    disconnect.reset();
    onClose();
  };

  const confirm = () => {
    if (!c) return;
    disconnect.mutate(c.id, {
      onSuccess: () => {
        toast.success(`${name} disconnected`, { description: "Its accounts are no longer shown and its stored credentials were deleted." });
        disconnect.reset();
        onClose();
      },
    });
  };

  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect {name}?</DialogTitle>
          <DialogDescription>
            {c?.brokerId === "ibkr"
              ? "Nasscord logs out of the IBKR gateway and stops it, and removes this connection's accounts from your totals. Your IBKR account itself does not change."
              : "Nasscord revokes the E*TRADE token, deletes the stored consumer key and secret, and removes this connection's accounts from your totals. Your E*TRADE account itself does not change."}{" "}
            To read it again later, connect it again.
          </DialogDescription>
        </DialogHeader>
        {disconnect.isError ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>{disconnect.error.message}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={disconnect.isPending} onClick={close}>
            Keep connected
          </Button>
          <Button variant="destructive" disabled={disconnect.isPending} onClick={confirm}>
            {disconnect.isPending ? <LoaderCircleIcon className="animate-spin" /> : <UnplugIcon />}
            {disconnect.isPending ? "Disconnecting" : "Disconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
