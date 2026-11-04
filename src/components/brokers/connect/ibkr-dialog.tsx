"use client";

import * as React from "react";
import { toast } from "sonner";
import { CircleAlertIcon, ExternalLinkIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useConnection, useRenewConnection, useStartIbkr } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { StatusDot } from "@/components/status-dot";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccountIncludeList } from "@/components/brokers/connect/account-switches";
import { EnvironmentChoice } from "@/components/brokers/connect/environment-choice";
import { CONNECTION_TONE } from "@/components/brokers/connect/status";

type Environment = "production" | "paper";

const ENVIRONMENTS = [
  { value: "production" as const, label: "Live", hint: "Your real IBKR account, with your usual username." },
  { value: "paper" as const, label: "Paper", hint: "Your IBKR paper account, with its paper username." },
];

const POLL_MS = 3_000;

/** The app route that checks the session and the workspace, then sends the browser to a fresh one-time IBKR login. */
export function ibkrLoginHref(connectionId: string) {
  return `/api/broker/ibkr/login/${encodeURIComponent(connectionId)}`;
}

/**
 * Connect IBKR through a Client Portal gateway (docs/real-backend.md section 7): choose Live or
 * Paper, start the gateway, open the login on IBKR's own page in a new tab, and watch the connection
 * until IBKR reports the login; then the accounts with their Included switches. The login opens
 * through ibkrLoginHref, never through the link the broker service returned. With
 * `resumeConnectionId` (Reconnect) it starts at the login step of that connection.
 */
export function IbkrConnectDialog({ open, onOpenChange, resumeConnectionId }: { open: boolean; onOpenChange: (open: boolean) => void; resumeConnectionId?: string }) {
  const start = useStartIbkr();
  const renew = useRenewConnection();
  const [environment, setEnvironment] = React.useState<Environment>("production");
  const [connectionId, setConnectionId] = React.useState<string | null>(resumeConnectionId ?? null);
  const [opened, setOpened] = React.useState(false);
  const id = React.useId();

  // Poll while the login is open; stop once IBKR reported it, or the login ended. The decision uses the
  // last answer, so the poll stops one render after the status settles.
  const [settled, setSettled] = React.useState(false);
  const peek = useConnection(connectionId, { pollMs: connectionId && !settled ? POLL_MS : undefined });
  const connection = peek.data;
  const live = connection?.status === "connected" || connection?.status === "expiring";
  const failed = connection?.status === "expired" || connection?.status === "error" || connection?.status === "disconnected";
  // A passing error (the service restarting) keeps polling; a connection that is gone does not.
  const gone = peek.error instanceof ApiError && peek.error.status === 404;
  const done = live || failed || gone;
  if (done !== settled) setSettled(done);

  const announced = React.useRef(false);
  React.useEffect(() => {
    if (live && !announced.current) {
      announced.current = true;
      toast.success("IBKR connected", { description: `${connection?.accounts.length ?? 0} ${connection?.accounts.length === 1 ? "account" : "accounts"} found.` });
    }
  }, [live, connection?.accounts.length]);

  const busy = start.isPending || renew.isPending;
  const competing = live && !!connection?.statusDetail;

  const begin = () =>
    start.mutate(
      { environment },
      {
        // The login itself opens through the app route, which checks the session and mints a one-time link.
        onSuccess: (res) => {
          setOpened(false);
          setConnectionId(res.connectionId);
        },
      },
    );

  const retry = () => {
    if (!connectionId) return;
    renew.mutate(connectionId, { onSuccess: () => setOpened(false) });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <BrokerMark id="ibkr" size="md" />
            <div className="grid gap-1">
              <DialogTitle>{live ? "IBKR connected" : resumeConnectionId ? "Reconnect IBKR" : "Connect Interactive Brokers"}</DialogTitle>
              <DialogDescription>
                {live
                  ? "Choose which accounts count toward your totals. You can change this later under Brokers."
                  : connectionId
                    ? "Log in on IBKR's own page in the new tab. This dialog notices the login by itself."
                    : "Nasscord reads your IBKR balances, positions, orders and executions through a gateway session you log in to."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {live && connection ? (
          <div className="grid gap-3">
            {competing ? (
              <Alert>
                <TriangleAlertIcon />
                <AlertTitle>Another IBKR session is open</AlertTitle>
                <AlertDescription>{connection.statusDetail}</AlertDescription>
              </Alert>
            ) : null}
            <AccountIncludeList accounts={connection.accounts} brokerShort="IBKR" emptyText="IBKR listed no accounts for this login yet. They appear under Brokers as soon as IBKR returns them." />
          </div>
        ) : connectionId ? (
          <div className="grid gap-4">
            <ol className="grid gap-3 text-sm">
              <li className="grid gap-2">
                <span>
                  <span className="font-medium">1.</span> Open the IBKR login in a new tab. It first asks you to confirm that the login joins your Nasscord workspace.
                </span>
                {busy || failed ? (
                  // An anchor cannot be disabled; while a new login starts, or after this one ended, there is nothing to open.
                  <Button className="justify-self-start" variant="outline" disabled>
                    Open the IBKR login
                    <ExternalLinkIcon data-icon="inline-end" />
                  </Button>
                ) : (
                  <Button
                    className="justify-self-start"
                    variant={opened ? "outline" : "default"}
                    render={<a href={ibkrLoginHref(connectionId)} target="_blank" rel="noopener noreferrer" />}
                    onClick={() => setOpened(true)}
                  >
                    {opened ? "Open the IBKR login again" : "Open the IBKR login"}
                    <ExternalLinkIcon data-icon="inline-end" />
                  </Button>
                )}
              </li>
              <li>
                <span className="font-medium">2.</span> Log in with your IBKR username, password and second factor. Nasscord never sees them.
              </li>
            </ol>

            <div className="grid gap-1 rounded-lg border border-border px-3 py-2.5" aria-live="polite">
              {peek.isError ? (
                <span className="flex items-start gap-2 text-sm text-destructive">
                  <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {peek.error.message}
                </span>
              ) : !connection ? (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
                  Checking the connection
                </span>
              ) : (
                <>
                  <StatusDot tone={CONNECTION_TONE[connection.status].tone} pulse={connection.status === "pending"} label={<span className="text-sm">{CONNECTION_TONE[connection.status].label}</span>} />
                  {connection.statusDetail ? <p className="text-xs text-muted-foreground">{connection.statusDetail}</p> : null}
                </>
              )}
            </div>

            {renew.isError ? (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertDescription>{renew.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-4">
            <EnvironmentChoice name={`${id}-env`} label="IBKR environment" value={environment} onChange={setEnvironment} options={ENVIRONMENTS} disabled={busy} />
            <div className="grid gap-1.5 rounded-lg bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
              <p>
                Nasscord starts an IBKR gateway for you and you log in on IBKR&apos;s own page, with its second factor. A session lasts about a day; then you log in again.
              </p>
              <p>
                IBKR allows one session per username: logging in to TWS, the IBKR mobile app or the website with the same username ends this one. A second IBKR username for Nasscord avoids that.
              </p>
            </div>
            {start.isError ? (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertDescription>{start.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {live ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : connectionId ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {failed ? (
                <Button disabled={busy} onClick={retry}>
                  {renew.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
                  {renew.isPending ? "Starting a new login" : "Start a new login"}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={begin} disabled={busy}>
                {start.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
                {start.isPending ? "Starting the gateway" : "Continue"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
