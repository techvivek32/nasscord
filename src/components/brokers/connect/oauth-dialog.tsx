"use client";

import * as React from "react";
import { toast } from "sonner";
import { LoaderCircleIcon } from "lucide-react";
import { useStartOAuth } from "@/hooks/queries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { StartOAuthInput } from "@/lib/api";
import { getBroker } from "@/lib/brokers";
import type { BrokerId, ConnectEnvironmentOption, ConnectionEnvironment, ConnectOption, ConnectSpec } from "@/lib/types";
import { useForgetSecretRequest } from "@/components/brokers/connect/api-key-dialog";
import { CallbackUrl } from "@/components/brokers/connect/callback-url";
import { EnvironmentChoice } from "@/components/brokers/connect/environment-choice";
import { ConnectedAccounts, RedirectWait, type RedirectWaitResult } from "@/components/brokers/connect/redirect-wait";
import { ConnectDialogHeader, ErrorAlert, OwnerOnlyNote, SpecDisclosure, SpecPrerequisites, SpecSteps } from "@/components/brokers/connect/spec-parts";
import { connectionName } from "@/components/brokers/connect/status";

/** Where to pick up: Reconnect answered next.kind "redirect" with the hop link for this connection. */
export interface OAuthResume {
  connectionId: string;
  openUrl: string;
}

const PRINTABLE = /^[\x21-\x7e]+$/;

type Stage = { kind: "form" } | { kind: "wait"; connectionId: string; openUrl: string } | { kind: "done"; result: RedirectWaitResult };

/**
 * The OAuth flows (docs/real-backend.md section 8).
 * - oauth2_user_app: the user's own app (a Schwab Individual app, a TradeStation key). Step 1 shows
 *   Nasscord's callback URL with a Copy button and the broker's checklist; step 2 takes the app key
 *   and secret, which go once to the broker service and leave the page (the input at once, react-query's
 *   copy of the request once it settles).
 * - oauth2_platform: Nasscord's own client. The scopes, the prerequisites, and a consent the user
 *   accepts before leaving Nasscord when the broker requires one (Tradier).
 * Both then open the login in a new tab through the canonical hop and wait for it (RedirectWait).
 * With `resume` (Reconnect) it starts at the wait step for that connection, reusing the stored app.
 */
export function OAuthDialog({
  brokerId,
  spec,
  option,
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
  option?: ConnectOption;
  environments: ConnectEnvironmentOption[];
  ownerOnly?: boolean;
  resume?: OAuthResume;
  /** Reconnect: ask for a fresh hop link after this one failed (renews again). */
  onRestartResume?: () => void;
  restartingResume?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const broker = getBroker(brokerId);
  const start = useStartOAuth();
  const forget = useForgetSecretRequest();
  const id = React.useId();
  const userApp = spec.flow === "oauth2_user_app";
  const [stage, setStage] = React.useState<Stage>(resume ? { kind: "wait", ...resume } : { kind: "form" });
  // A Reconnect waits on the link its parent holds (a new one after Start again).
  const view: Stage = resume && stage.kind !== "done" ? { kind: "wait", ...resume } : stage;
  const [environment, setEnvironment] = React.useState<ConnectionEnvironment>(environments[0]?.value ?? "production");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [accepted, setAccepted] = React.useState(false);
  // The last failure's sentence, kept here because the request itself is forgotten once it settles.
  const [error, setError] = React.useState<string | null>(null);

  const busy = start.isPending;
  const callbackUrl = option?.callbackUrl ?? null;
  const idField = spec.fields?.find((f) => f.name === "clientId");
  const secretField = spec.fields?.find((f) => f.name === "clientSecret");
  const idValue = clientId.trim();
  const secretValue = clientSecret.trim();
  const idError = idValue && (!PRINTABLE.test(idValue) || idValue.length < 4) ? `Paste the ${idField?.label ?? "client ID"} exactly as ${broker.short} shows it.` : null;
  const secretError = secretValue && (!PRINTABLE.test(secretValue) || secretValue.length < 4) ? `Paste the ${secretField?.label ?? "secret"} exactly as ${broker.short} shows it.` : null;
  const credentialsReady = !userApp || (!!idValue && !!secretValue && !idError && !secretError);
  const canStart = !busy && credentialsReady && (!spec.consent || accepted) && (!userApp || !!callbackUrl);

  const begin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canStart) return;
    const input: StartOAuthInput = {
      brokerId,
      method: spec.method,
      ...(spec.client ? { client: spec.client } : {}),
      environment,
      ...(userApp ? { clientId: idValue, clientSecret: secretValue } : {}),
    };
    setError(null);
    start.mutate(input, {
      onSuccess: (res) => setStage({ kind: "wait", connectionId: res.connectionId, openUrl: res.openUrl }),
      onError: (err) => setError(err.message),
      onSettled: () => forget(start.reset, input),
    });
    // The secret is with the broker service now (stored encrypted); it does not stay in this page.
    setClientSecret("");
  };

  const onConnected = React.useCallback(
    (result: RedirectWaitResult) => {
      setStage({ kind: "done", result });
      const n = result.connection.accounts.length;
      toast.success(`${connectionName(result.connection)} ${resume ? "reconnected" : "connected"}`, {
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
    setError(null);
    setStage({ kind: "form" });
  };

  const title = view.kind === "done" ? `${connectionName(view.result.connection)} connected` : resume ? `Reconnect ${broker.short}` : spec.title;
  const description =
    view.kind === "done"
      ? "Choose which accounts count toward your totals. You can change this later under Brokers."
      : view.kind === "wait"
        ? `Sign in on ${broker.short}'s own page in the new tab. This window notices the login by itself.`
        : spec.summary;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!busy}>
        <ConnectDialogHeader brokerId={brokerId} title={title} description={description} />

        {view.kind === "done" ? (
          <ConnectedAccounts connection={view.result.connection} merged={view.result.merged} />
        ) : view.kind === "wait" ? (
          <RedirectWait
            // A new link (Start again on a Reconnect) starts a new wait.
            key={view.openUrl}
            brokerId={brokerId}
            connectionId={view.connectionId}
            openUrl={view.openUrl}
            reconnect={!!resume}
            onConnected={onConnected}
            onRestart={!resume || onRestartResume ? restart : undefined}
            restarting={restartingResume}
          />
        ) : (
          <form id={`${id}-form`} onSubmit={begin} className="grid gap-4" noValidate autoComplete="off">
            {ownerOnly ? <OwnerOnlyNote /> : null}
            <SpecPrerequisites items={spec.prerequisites} />

            {userApp ? (
              <section className="grid gap-3" aria-labelledby={`${id}-app`}>
                <h3 id={`${id}-app`} className="text-sm font-medium">
                  1. Create your app
                </h3>
                {callbackUrl ? (
                  <CallbackUrl url={callbackUrl} label="Nasscord's callback URL" />
                ) : (
                  <ErrorAlert message="This server has no callback URL set, so a login could not return to Nasscord. The platform owner sets OAUTH_CALLBACK_BASE on the broker service." />
                )}
                <SpecSteps steps={spec.steps} docsUrl={spec.docsUrl} title="Checklist" />
              </section>
            ) : (
              <>
                {spec.scopes ? (
                  <p className="text-sm">
                    <span className="font-medium">Nasscord asks for:</span> <span className="text-muted-foreground">{spec.scopes}</span>
                  </p>
                ) : null}
                <SpecSteps steps={spec.steps} docsUrl={spec.docsUrl} />
              </>
            )}

            {environments.length > 1 ? (
              <EnvironmentChoice name={`${id}-env`} label={`${broker.short} account type`} value={environment} onChange={setEnvironment} options={environments} disabled={busy} />
            ) : null}

            {userApp ? (
              <section className="grid gap-3" aria-labelledby={`${id}-keys`}>
                <h3 id={`${id}-keys`} className="text-sm font-medium">
                  2. Paste your app&apos;s credentials
                </h3>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-client`}>{idField?.label ?? "Client ID"}</Label>
                  <Input
                    id={`${id}-client`}
                    name={`${spec.method}-client-id`}
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    className="font-mono"
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={256}
                    data-1p-ignore=""
                    data-lpignore="true"
                    disabled={busy}
                    aria-invalid={idError ? true : undefined}
                    aria-describedby={idError ? `${id}-client-err` : undefined}
                  />
                  {idError ? (
                    <p id={`${id}-client-err`} className="text-xs text-destructive">
                      {idError}
                    </p>
                  ) : null}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-secret`}>{secretField?.label ?? "Secret"}</Label>
                  <Input
                    id={`${id}-secret`}
                    name={`${spec.method}-client-secret`}
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    className="font-mono"
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={512}
                    data-1p-ignore=""
                    data-lpignore="true"
                    disabled={busy}
                    aria-invalid={secretError ? true : undefined}
                    aria-describedby={`${id}-secret-hint`}
                  />
                  <p id={`${id}-secret-hint`} className={secretError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                    {secretError ?? "Sent once to Nasscord's broker service and stored there encrypted. It is never shown again."}
                  </p>
                </div>
              </section>
            ) : null}

            {spec.consent ? (
              <div className="grid gap-2 rounded-lg border border-border px-3 py-2.5">
                <p className="text-xs text-muted-foreground">{spec.consent}</p>
                <Label htmlFor={`${id}-consent`} className="flex cursor-pointer items-start gap-2 font-normal">
                  <Checkbox id={`${id}-consent`} checked={accepted} onCheckedChange={(v) => setAccepted(v === true)} disabled={busy} className="mt-0.5" />
                  <span className="text-sm">I accept and want to continue to {broker.short}.</span>
                </Label>
              </div>
            ) : null}

            <SpecDisclosure text={spec.disclosure} note={spec.sessionNote} />
            <ErrorAlert message={error ?? undefined} />
          </form>
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
              <Button type="submit" form={`${id}-form`} disabled={!canStart}>
                {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
                {busy ? `Preparing the ${broker.short} login` : "Continue"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
