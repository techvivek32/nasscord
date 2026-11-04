"use client";

import * as React from "react";
import { toast } from "sonner";
import { CircleAlertIcon, ExternalLinkIcon, LoaderCircleIcon, MoonIcon } from "lucide-react";
import { useConnection, useStartEtrade, useVerifyEtrade } from "@/hooks/queries";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BrokerConnection } from "@/lib/types";
import { AccountIncludeList } from "@/components/brokers/connect/account-switches";
import { EnvironmentChoice } from "@/components/brokers/connect/environment-choice";

type Environment = "production" | "sandbox";

/** Where to pick up: after a Reconnect that needs a new verification code. */
export interface EtradeResume {
  connectionId: string;
  authorizeUrl: string;
}

const ENVIRONMENTS = [
  { value: "production" as const, label: "Production", hint: "Your real E*TRADE account." },
  { value: "sandbox" as const, label: "Sandbox", hint: "E*TRADE's test environment, with a sandbox key." },
];

/** The authorize page comes from the broker service; only an https link is offered to open. */
function safeHttps(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Connect E*TRADE with the user's own consumer key (docs/real-backend.md section 8):
 * key and secret, then E*TRADE's authorize page in a new tab, then the verification code, then the
 * accounts E*TRADE returned with their Included switches. With `resume` (Reconnect after midnight
 * Eastern) it starts at the authorize step of that connection.
 */
export function EtradeConnectDialog({ open, onOpenChange, resume }: { open: boolean; onOpenChange: (open: boolean) => void; resume?: EtradeResume }) {
  const start = useStartEtrade();
  const verify = useVerifyEtrade();
  const [environment, setEnvironment] = React.useState<Environment>("production");
  const [consumerKey, setConsumerKey] = React.useState("");
  const [consumerSecret, setConsumerSecret] = React.useState("");
  const [verifier, setVerifier] = React.useState("");
  const [pendingAuth, setPendingAuth] = React.useState<EtradeResume | null>(resume ?? null);
  const [opened, setOpened] = React.useState(false);
  const [verified, setVerified] = React.useState<BrokerConnection | null>(null);
  const id = React.useId();

  // After the code: the connection as the service reports it now (accounts and their Included state).
  const fresh = useConnection(verified?.id);
  const connection = fresh.data ?? verified;

  const busy = start.isPending || verify.isPending;
  const authorizeUrl = pendingAuth ? safeHttps(pendingAuth.authorizeUrl) : null;
  const keyError = consumerKey.trim().length > 0 && consumerKey.trim().length < 8 ? "That consumer key looks too short." : null;
  const canStart = consumerKey.trim().length >= 8 && consumerSecret.trim().length >= 8 && !busy;
  const canVerify = /^[A-Za-z0-9]{4,32}$/.test(verifier.trim()) && !busy;

  const submitKeys = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canStart) return;
    start.mutate(
      { environment, consumerKey: consumerKey.trim(), consumerSecret: consumerSecret.trim() },
      {
        onSuccess: (res) => {
          // The secret is with the broker service now (stored encrypted); it does not stay in this page.
          setConsumerSecret("");
          setOpened(false);
          setVerifier("");
          setPendingAuth(res);
        },
      },
    );
  };

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingAuth || !canVerify) return;
    verify.mutate(
      { connectionId: pendingAuth.connectionId, verifier: verifier.trim() },
      {
        onSuccess: (conn) => {
          setVerified(conn);
          toast.success(resume ? "E*TRADE reconnected" : "E*TRADE connected", { description: `${conn.accounts.length} ${conn.accounts.length === 1 ? "account" : "accounts"} found.` });
        },
      },
    );
  };

  const restart = () => {
    start.reset();
    verify.reset();
    setPendingAuth(null);
    setVerifier("");
    setOpened(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <BrokerMark id="etrade" size="md" />
            <div className="grid gap-1">
              <DialogTitle>{connection ? "E*TRADE connected" : resume ? "Reconnect E*TRADE" : "Connect E*TRADE"}</DialogTitle>
              <DialogDescription>
                {connection
                  ? "Choose which accounts count toward your totals. You can change this later under Brokers."
                  : pendingAuth
                    ? "Approve Nasscord on E*TRADE, then paste the verification code it shows."
                    : "Nasscord reads your E*TRADE balances, positions and orders with a consumer key you create yourself."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {connection ? (
          <div className="grid gap-3">
            {connection.statusDetail ? <p className="text-sm text-muted-foreground">{connection.statusDetail}</p> : null}
            <AccountIncludeList accounts={connection.accounts} brokerShort="E*TRADE" emptyText="E*TRADE listed no accounts for this key yet. They appear under Brokers as soon as E*TRADE returns them." />
          </div>
        ) : pendingAuth ? (
          <form id={`${id}-code`} onSubmit={submitCode} className="grid gap-4" noValidate>
            <ol className="grid gap-3 text-sm">
              <li className="grid gap-2">
                <span>
                  <span className="font-medium">1.</span> Open E*TRADE, sign in and approve Nasscord. It opens in a new tab.
                </span>
                {authorizeUrl ? (
                  <Button variant="outline" className="justify-self-start" render={<a href={authorizeUrl} target="_blank" rel="noopener noreferrer" />} onClick={() => setOpened(true)}>
                    Open E*TRADE
                    <ExternalLinkIcon data-icon="inline-end" />
                  </Button>
                ) : (
                  <p className="text-sm text-destructive">The broker service sent an authorize link that cannot be opened. Start again.</p>
                )}
              </li>
              <li className="grid gap-1.5">
                <Label htmlFor={`${id}-verifier`}>
                  <span className="font-medium">2.</span> Verification code
                </Label>
                <Input
                  id={`${id}-verifier`}
                  value={verifier}
                  onChange={(e) => setVerifier(e.target.value.replace(/\s+/g, ""))}
                  placeholder="The code E*TRADE showed"
                  className="font-mono tabular sm:max-w-xs"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={32}
                  aria-describedby={`${id}-verifier-hint`}
                  aria-invalid={verify.isError ? true : undefined}
                />
                <p id={`${id}-verifier-hint`} className="text-xs text-muted-foreground">
                  {opened ? "Paste it here within 5 minutes; after that E*TRADE needs a new approval." : "E*TRADE shows the code after you approve. It works for 5 minutes."}
                </p>
              </li>
            </ol>
            {verify.isError ? (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertDescription>{verify.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </form>
        ) : (
          <form id={`${id}-keys`} onSubmit={submitKeys} className="grid gap-4" noValidate>
            <EnvironmentChoice name={`${id}-env`} label="E*TRADE environment" value={environment} onChange={setEnvironment} options={ENVIRONMENTS} disabled={busy} />
            <div className="grid gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Create your consumer key first</p>
              <ol className="grid list-decimal gap-1 pl-4">
                <li>
                  Sign in at{" "}
                  <a href="https://developer.etrade.com" target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                    developer.etrade.com
                  </a>{" "}
                  with your own E*TRADE login.
                </li>
                <li>Request an individual consumer key for {environment === "sandbox" ? "Sandbox" : "Production"}.</li>
                <li>Paste the consumer key and secret below.</li>
              </ol>
              <p>An individual key only works with the E*TRADE account of the person who created it, so use a key from your own login.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-key`}>Consumer key</Label>
              <Input
                id={`${id}-key`}
                value={consumerKey}
                onChange={(e) => setConsumerKey(e.target.value)}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
                aria-invalid={keyError ? true : undefined}
                aria-describedby={keyError ? `${id}-key-err` : undefined}
              />
              {keyError ? (
                <p id={`${id}-key-err`} className="text-xs text-destructive">
                  {keyError}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-secret`}>Consumer secret</Label>
              <Input id={`${id}-secret`} type="password" value={consumerSecret} onChange={(e) => setConsumerSecret(e.target.value)} className="font-mono" autoComplete="off" spellCheck={false} maxLength={200} />
              <p className="text-xs text-muted-foreground">Sent once to Nasscord&apos;s broker service and stored there encrypted. It is never shown again.</p>
            </div>
            {start.isError ? (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertDescription>{start.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </form>
        )}

        {!connection ? (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <MoonIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            E*TRADE ends every session at midnight Eastern, so you reconnect once a day with a new verification code. Your key stays stored, so reconnecting takes one approval.
          </p>
        ) : null}

        <DialogFooter>
          {connection ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : pendingAuth ? (
            <>
              {!resume ? (
                <Button variant="outline" disabled={busy} onClick={restart}>
                  Start again
                </Button>
              ) : (
                <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
              )}
              <Button type="submit" form={`${id}-code`} disabled={!canVerify}>
                {verify.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
                {verify.isPending ? "Checking the code" : "Verify code"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" form={`${id}-keys`} disabled={!canStart}>
                {start.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
                {start.isPending ? "Contacting E*TRADE" : "Continue"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
