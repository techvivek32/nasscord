"use client";

import * as React from "react";
import { toast } from "sonner";
import { LoaderCircleIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnectKey } from "@/hooks/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConnectKeyInput } from "@/lib/api";
import { getBroker } from "@/lib/brokers";
import type { BrokerConnection, BrokerId, ConnectEnvironmentOption, ConnectField, ConnectionEnvironment, ConnectSpec } from "@/lib/types";
import { EnvironmentChoice } from "@/components/brokers/connect/environment-choice";
import { ConnectedAccounts } from "@/components/brokers/connect/redirect-wait";
import { ConnectDialogHeader, ErrorAlert, OwnerOnlyNote, SpecDisclosure, SpecPrerequisites, SpecSteps, SpecWarning } from "@/components/brokers/connect/spec-parts";
import { connectionName } from "@/components/brokers/connect/status";

/** Reconnect after the broker stopped accepting the key: a new key for the same account and connection. */
export interface ApiKeyReplace {
  connectionId: string;
}

const PRINTABLE = /^[\x21-\x7e]+$/;

/**
 * A key with its own key ID (Alpaca) tells the broker service which account type it is, so the
 * dialog does not ask. A single token (Tradier) does not, so the user picks Live or Paper.
 */
function asksEnvironment(spec: ConnectSpec, environments: ConnectEnvironmentOption[]): boolean {
  return environments.length > 1 && !spec.fields?.some((f) => f.name === "keyId");
}

function fieldError(field: ConnectField, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!PRINTABLE.test(v)) return `Paste the ${field.label} exactly as the broker shows it, without spaces.`;
  if (field.name === "keyId" && v.length < 4) return `That ${field.label} looks too short.`;
  if (field.name === "secret" && v.length < 8) return `That ${field.label} looks too short.`;
  return null;
}

/**
 * Forgets a settled request that carried a secret. react-query keeps a mutation's variables in the
 * observer's result and in its mutation cache (for gcTime after the dialog closes), so a dialog copies
 * what it still needs (the error sentence) into its own state, then calls this from the request's
 * onSettled: the observer is reset and the mutation leaves the cache at once.
 */
export function useForgetSecretRequest() {
  const client = useQueryClient();
  return React.useCallback(
    (reset: () => void, sent: unknown) => {
      reset();
      const cache = client.getMutationCache();
      for (const m of cache.findAll({ predicate: (x) => x.state.variables === sent })) cache.remove(m);
    },
    [client],
  );
}

/**
 * The api_key flow (docs/real-backend.md section 8): the user's own Alpaca key and secret, or the
 * platform owner's own Tradier token. No redirect: the key goes once to POST /api/broker/key/connect,
 * the broker service checks it with a read call, stores it encrypted and answers the connection.
 * The secret leaves the input as soon as it is sent, and react-query's copy of the request once it
 * settles (useForgetSecretRequest). With `replace` (Reconnect after a 401)
 * the key replaces the stored one of that connection, and a key of another account is refused.
 */
export function ApiKeyDialog({
  brokerId,
  spec,
  environments,
  ownerOnly = false,
  replace,
  open,
  onOpenChange,
}: {
  brokerId: BrokerId;
  spec: ConnectSpec;
  /** The environments the broker service offers, in the spec's words. */
  environments: ConnectEnvironmentOption[];
  ownerOnly?: boolean;
  replace?: ApiKeyReplace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const broker = getBroker(brokerId);
  const connect = useConnectKey();
  const forget = useForgetSecretRequest();
  const id = React.useId();
  const fields = spec.fields ?? [];
  const [values, setValues] = React.useState<Record<string, string>>({});
  const askEnv = !replace && asksEnvironment(spec, environments);
  const [environment, setEnvironment] = React.useState<ConnectionEnvironment>(environments[0]?.value ?? "production");
  const [done, setDone] = React.useState<BrokerConnection | null>(null);
  // The last failure's sentence, kept here because the request itself is forgotten once it settles.
  const [error, setError] = React.useState<string | null>(null);

  const busy = connect.isPending;
  const errors = fields.map((f) => fieldError(f, values[f.name] ?? ""));
  const complete = fields.every((f, i) => (values[f.name] ?? "").trim().length > 0 && !errors[i]);
  const canSubmit = complete && !busy && fields.length > 0;

  const set = (name: string, value: string) => setValues((prev) => ({ ...prev, [name]: value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const keyId = values.keyId?.trim();
    const input: ConnectKeyInput = {
      brokerId,
      // A key environment is the user's own Live or Paper account; sample data is never keyed in.
      ...(askEnv && (environment === "production" || environment === "paper") ? { environment } : {}),
      ...(keyId ? { keyId } : {}),
      secret: (values.secret ?? "").trim(),
      ...(replace ? { connectionId: replace.connectionId } : {}),
    };
    setError(null);
    connect.mutate(input, {
      onSuccess: (conn) => {
        setDone(conn);
        const n = conn.accounts.length;
        toast.success(`${connectionName(conn)} ${replace ? "reconnected" : "connected"}`, { description: `${n} ${n === 1 ? "account" : "accounts"} found.` });
      },
      onError: (err) => setError(err.message),
      onSettled: () => forget(connect.reset, input),
    });
    // The secret is with the broker service now (stored encrypted); it does not stay in this page.
    setValues((prev) => ({ ...prev, secret: "" }));
  };

  const title = done ? `${connectionName(done)} connected` : replace ? `Paste the new ${broker.short} key` : `Connect ${broker.name}`;
  const description = done
    ? "Choose which accounts count toward your totals. You can change this later under Brokers."
    : replace
      ? `${broker.short} no longer accepts the stored key. Paste a new key of the same account; a key of another account is refused.`
      : spec.summary;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!busy}>
        <ConnectDialogHeader brokerId={brokerId} title={title} description={description} />

        {done ? (
          <ConnectedAccounts connection={done} />
        ) : (
          <form id={`${id}-form`} onSubmit={submit} className="grid gap-4" noValidate autoComplete="off">
            {ownerOnly ? <OwnerOnlyNote /> : null}
            {!replace ? <SpecPrerequisites items={spec.prerequisites} /> : null}
            <SpecWarning text={spec.warning} />
            <SpecSteps steps={spec.steps} docsUrl={spec.docsUrl} title={replace ? "Get a new key" : "Get your key"} />
            {askEnv ? (
              <EnvironmentChoice name={`${id}-env`} label={`${broker.short} account type`} value={environment} onChange={setEnvironment} options={environments} disabled={busy} />
            ) : null}
            {fields.map((f, i) => {
              const inputId = `${id}-${f.name}`;
              const err = errors[i];
              const hint = f.secret ? "Sent once to Nasscord's broker service and stored there encrypted. It is never shown again." : f.hint;
              return (
                <div key={f.name} className="grid gap-1.5">
                  <Label htmlFor={inputId}>{f.label}</Label>
                  <Input
                    id={inputId}
                    name={`${spec.method}-${f.name}`}
                    type={f.secret ? "password" : "text"}
                    value={values[f.name] ?? ""}
                    onChange={(e) => set(f.name, e.target.value)}
                    className="font-mono"
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={512}
                    data-1p-ignore=""
                    data-lpignore="true"
                    disabled={busy}
                    aria-invalid={err ? true : undefined}
                    aria-describedby={err || hint ? `${inputId}-hint` : undefined}
                  />
                  {err ? (
                    <p id={`${inputId}-hint`} className="text-xs text-destructive">
                      {err}
                    </p>
                  ) : hint ? (
                    <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
                      {hint}
                    </p>
                  ) : null}
                </div>
              );
            })}
            <SpecDisclosure text={spec.disclosure} note={spec.sessionNote} />
            <ErrorAlert message={error ?? undefined} />
          </form>
        )}

        <DialogFooter>
          {done ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" form={`${id}-form`} disabled={!canSubmit}>
                {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
                {busy ? `Checking with ${broker.short}` : replace ? "Replace key" : "Connect"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
