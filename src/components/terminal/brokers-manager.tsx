"use client";

import * as React from "react";
import { toast } from "sonner";
import { CircleAlertIcon, KeyRoundIcon, LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon, UnplugIcon } from "lucide-react";
import { useBrokerOptions, useDisconnectConnection, useRenewConnection } from "@/hooks/queries";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { AccountIncludeList } from "@/components/brokers/connect/account-switches";
import { AggregatorDialog } from "@/components/brokers/connect/aggregator-dialog";
import { ApiKeyDialog } from "@/components/brokers/connect/api-key-dialog";
import { ConnectBrokers, useConnectableNames } from "@/components/brokers/connect/connect-brokers";
import { EtradeConnectDialog, type EtradeResume } from "@/components/brokers/connect/etrade-dialog";
import { IbkrConnectDialog } from "@/components/brokers/connect/ibkr-dialog";
import { OAuthDialog } from "@/components/brokers/connect/oauth-dialog";
import { announceConnected, safeOpenUrl } from "@/components/brokers/connect/redirect-wait";
import { CONNECTION_TONE, connectionFlow, connectionName, connectionSpec, environmentLabel, isLiveStatus, sessionLine } from "@/components/brokers/connect/status";
import { EmptyState } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RenewResult } from "@/lib/api";
import { findSpec } from "@/lib/broker-connect";
import { getBroker } from "@/lib/brokers";
import { fmtDate } from "@/lib/format";
import type { BrokerConnection, BrokerId, RenewNext } from "@/lib/types";
import { ConnectionsError } from "@/components/terminal/broker-health";
import { useAccountScope, useMinuteClock } from "@/components/terminal/hooks";
import { CardSkeleton } from "@/components/terminal/skeletons";
import { RequestOrderEntryButton, useOrderEntry } from "@/components/terminal/order-entry";

type Resume =
  | { kind: "ibkr"; connectionId: string; round: number }
  | { kind: "etrade"; resume: EtradeResume; round: number }
  | { kind: "api_key"; connection: BrokerConnection; round: number }
  | { kind: "redirect"; connection: BrokerConnection; openUrl: string; round: number }
  | null;

/**
 * What Reconnect asks for next (POST /api/broker/connections/[id]/renew answers `next`; IBKR and
 * E*TRADE also keep `needsLogin` and `authorizeUrl`). No step: the session works as it is.
 */
function readNext(res: RenewResult, brokerId: BrokerId): RenewNext | null {
  if (res.next) return res.next;
  if (res.needsLogin && brokerId === "ibkr") return { kind: "gateway_login" };
  if (res.authorizeUrl && brokerId === "etrade") return { kind: "oauth1_verifier", authorizeUrl: res.authorizeUrl };
  return null;
}

const subscribeNothing = () => () => {};
const readConnectedParam = () => new URLSearchParams(window.location.search).get("connected");

/** `?connected=<id>`: where the OAuth and SnapTrade finish routes land after a login. */
function useConnectedParam(): string | null {
  return React.useSyncExternalStore(subscribeNothing, readConnectedParam, () => null);
}

/**
 * /app/brokers: the workspace's real connections (status, detail, session, accounts with Included
 * switches, Reconnect, Disconnect) and the connect entry point for every broker the broker service
 * offers this user (ConnectBrokers). Reconnect acts on what the service answers: a new IBKR login, a
 * new E*TRADE code, a new key, or a new login on the broker's page.
 */
export function BrokersManager() {
  const scope = useAccountScope();
  const now = useMinuteClock();
  const renew = useRenewConnection();
  const names = useConnectableNames();
  const [renewingId, setRenewingId] = React.useState<string | null>(null);
  const [resume, setResume] = React.useState<Resume>(null);
  const [disconnecting, setDisconnecting] = React.useState<BrokerConnection | null>(null);

  // One renew at a time: every card shares this mutation, and a second call would drop the first one's callbacks.
  // `again`: Start again inside an open Reconnect dialog, which keeps that dialog and swaps its link.
  const reconnect = (c: BrokerConnection, again = false) => {
    if (renew.isPending) return;
    setRenewingId(c.id);
    renew.mutate(c.id, {
      onSuccess: (res) => {
        const next = readNext(res, c.brokerId);
        const round = Date.now();
        switch (next?.kind) {
          case "gateway_login":
            // The dialog opens the app's login route, which mints a fresh one-time link.
            setResume({ kind: "ibkr", connectionId: c.id, round });
            return;
          case "oauth1_verifier":
            setResume({ kind: "etrade", resume: { connectionId: c.id, authorizeUrl: next.authorizeUrl }, round });
            return;
          case "api_key":
            setResume({ kind: "api_key", connection: c, round });
            return;
          case "redirect": {
            const openUrl = safeOpenUrl(next.url);
            if (!openUrl) {
              toast.error(`${connectionName(c)} was not reconnected`, { description: "Nasscord did not receive a login link it can open. Try again in a moment." });
              return;
            }
            setResume((prev) => (again && prev?.kind === "redirect" && prev.connection.id === c.id ? { ...prev, openUrl } : { kind: "redirect", connection: c, openUrl, round }));
            return;
          }
          default:
            toast.success(c.brokerId === "ibkr" ? "IBKR is still logged in" : c.brokerId === "etrade" ? `${connectionName(c)} session renewed` : `${connectionName(c)} is working`, {
              description:
                c.brokerId === "ibkr"
                  ? "The gateway session is open, so there is nothing to renew."
                  : c.brokerId === "etrade"
                    ? "E*TRADE renewed the session for today."
                    : `${getBroker(c.brokerId).short} accepted the stored access, so there is nothing to renew.`,
            });
        }
      },
      onError: (err) => toast.error(`${connectionName(c)} was not reconnected`, { description: err.message }),
      onSettled: () => setRenewingId(null),
    });
  };

  // A finished OAuth or SnapTrade login lands here with ?connected=<id>. Tell the tab that started it
  // at once (its dialog is waiting, and after a merge its own id is already gone), then, once the
  // list is in, say so, point at the card and drop the parameter so a reload does not repeat it.
  const connectedId = useConnectedParam();
  const told = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!connectedId || told.current === connectedId) return;
    told.current = connectedId;
    announceConnected(connectedId);
  }, [connectedId]);
  const announced = React.useRef(false);
  React.useEffect(() => {
    if (!connectedId || announced.current || scope.isLoading) return;
    announced.current = true;
    const c = scope.connections.find((x) => x.id === connectedId);
    const n = c?.accounts.length ?? 0;
    toast.success(c ? `${connectionName(c)} connected` : "Broker connected", {
      description: c ? `${n} ${n === 1 ? "account" : "accounts"} found. Choose which ones count toward your totals.` : "The connection is listed under Connected.",
    });
    const el = document.getElementById(`connection-${connectedId}`);
    if (el) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      el.setAttribute("data-highlight", "true");
      window.setTimeout(() => el.removeAttribute("data-highlight"), 4_000);
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("connected");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [connectedId, scope.isLoading, scope.connections]);

  const closeResume = (o: boolean) => {
    if (!o) setResume(null);
  };

  return (
    <>
      <section className="grid gap-3" aria-labelledby="brokers-connected">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="brokers-connected" className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Connected
          </h2>
          <RequestOrderEntryButton />
        </div>
        {scope.isLoading ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <CardSkeleton lines={4} />
            <CardSkeleton lines={4} />
          </div>
        ) : scope.error && scope.connections.length === 0 ? (
          <ConnectionsError scope={scope} />
        ) : scope.connections.length === 0 ? (
          <EmptyState
            title="No brokers connected"
            description={`Connect ${names ?? "a broker"} below. Nasscord reads balances, positions, orders and executions and never moves money. It places an order only when order entry is on for your workspace and you confirm the order.`}
          />
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

      {resume?.kind === "ibkr" ? <IbkrConnectDialog key={`ibkr-${resume.round}`} open resumeConnectionId={resume.connectionId} onOpenChange={closeResume} /> : null}
      {resume?.kind === "etrade" ? <EtradeConnectDialog key={`etrade-${resume.round}`} open resume={resume.resume} onOpenChange={closeResume} /> : null}
      {resume?.kind === "api_key" ? <ReplaceKeyDialog key={`key-${resume.round}`} connection={resume.connection} onOpenChange={closeResume} /> : null}
      {resume?.kind === "redirect" ? (
        <RedirectResumeDialog
          key={`redirect-${resume.round}`}
          connection={resume.connection}
          openUrl={resume.openUrl}
          restarting={renewingId === resume.connection.id}
          onRestart={() => reconnect(resume.connection, true)}
          onOpenChange={closeResume}
        />
      ) : null}

      <DisconnectDialog connection={disconnecting} onClose={() => setDisconnecting(null)} />
    </>
  );
}

/** Reconnect of a key connection whose key the broker stopped accepting: paste a new key of the same account. */
function ReplaceKeyDialog({ connection: c, onOpenChange }: { connection: BrokerConnection; onOpenChange: (open: boolean) => void }) {
  const spec = findSpec(c.brokerId, c.method);
  if (!spec) return null;
  return <ApiKeyDialog open onOpenChange={onOpenChange} brokerId={c.brokerId} spec={spec} environments={spec.environments} replace={{ connectionId: c.id }} />;
}

/** Reconnect of an OAuth or SnapTrade connection: a new login on the broker's page through the hop. */
function RedirectResumeDialog({
  connection: c,
  openUrl,
  restarting,
  onRestart,
  onOpenChange,
}: {
  connection: BrokerConnection;
  openUrl: string;
  restarting: boolean;
  onRestart: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const options = useBrokerOptions();
  // Both of a method's OAuth specs wait the same way; the spec only picks the dialog (OAuth or SnapTrade).
  const spec = connectionSpec(c, options.data) ?? findSpec(c.brokerId, c.method);
  if (!spec) return null;
  const resume = { connectionId: c.id, openUrl };
  if (spec.flow === "aggregator_portal") {
    return (
      <AggregatorDialog
        open
        onOpenChange={onOpenChange}
        brokerId={c.brokerId}
        spec={spec}
        environments={spec.environments}
        resume={resume}
        onRestartResume={onRestart}
        restartingResume={restarting}
      />
    );
  }
  return (
    <OAuthDialog open onOpenChange={onOpenChange} brokerId={c.brokerId} spec={spec} environments={spec.environments} resume={resume} onRestartResume={onRestart} restartingResume={restarting} />
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
  const oe = useOrderEntry();
  const ordersOn = oe.state === "on" && !!oe.caps?.connections[c.id];
  const blocked = oe.state === "on" ? oe.caps?.blocked[c.id] : undefined;
  const tone = CONNECTION_TONE[c.status];
  const live = isLiveStatus(c.status);
  const warn = c.status === "expiring" || (live && !!c.statusDetail);
  const keyFlow = connectionFlow(c) === "api_key";
  const label = renewing ? "Reconnecting" : c.status === "pending" ? "Continue login" : keyFlow && !live ? "Paste new key" : "Reconnect";
  return (
    <Card id={`connection-${c.id}`} className="scroll-mt-20 transition-shadow data-[highlight=true]:ring-2 data-[highlight=true]:ring-primary">
      <CardHeader>
        <div className="flex items-start gap-3">
          <BrokerMark id={c.brokerId} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{b.name}</CardTitle>
              <Badge variant="outline">{environmentLabel(c.brokerId, c.environment, c.method)}</Badge>
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
      {blocked ? (
        <CardContent>
          <p className="text-xs text-muted-foreground">{blocked}</p>
        </CardContent>
      ) : null}
      <CardContent className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="secondary">{ordersOn ? "Orders on" : "Read only"}</Badge>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={renewing || renewBusy} onClick={onReconnect}>
            {renewing ? <LoaderCircleIcon className="animate-spin" /> : keyFlow && !live ? <KeyRoundIcon /> : <RefreshCwIcon />}
            {label}
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
  const options = useBrokerOptions();
  const [shown, setShown] = React.useState<BrokerConnection | null>(connection);
  // Keep the last connection on screen while the dialog animates closed.
  if (connection && connection !== shown) setShown(connection);
  const c = connection ?? shown;
  const name = c ? connectionName(c) : "";
  const short = c ? getBroker(c.brokerId).short : "";
  // The spec of the client this connection used (a Schwab or TradeStation app of the user's own, or
  // Nasscord's); when that cannot be told, the neutral note.
  const note = c ? (connectionSpec(c, options.data)?.disconnectNote ?? "Disconnect deletes what Nasscord stored for this connection and removes its accounts from Nasscord.") : "";

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
            {note} Your {short} account itself does not change. To read it again later, connect it again.
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
