"use client";

import * as React from "react";
import { CircleAlertIcon, ExternalLinkIcon, LoaderCircleIcon, RotateCcwIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { qk, useConnection } from "@/hooks/queries";
import { useWorkspaceId } from "@/components/workspace-scope";
import { ApiError } from "@/lib/api";
import { getBroker } from "@/lib/brokers";
import type { BrokerConnection, BrokerId, ConnectionStatus } from "@/lib/types";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { AccountIncludeList } from "@/components/brokers/connect/account-switches";
import { CONNECTION_TONE, isLiveStatus } from "@/components/brokers/connect/status";

/*
 * The shared wait step of every flow that leaves Nasscord for the broker's own page (OAuth with the
 * user's app or Nasscord's client, and SnapTrade's portal; docs/real-backend.md section 8):
 *
 * 1. The dialog opens `openUrl` (the canonical hop on nasscord.com) in a new tab. When the user started
 *    on another host (a workspace subdomain, a tenant domain), the hop first shows which workspace the
 *    login joins; then it sends the browser to the broker.
 * 2. The broker returns to the canonical callback, which hands an opaque ticket to the user's own host;
 *    its finish route claims the login and lands on /app/brokers?connected=<id>.
 * 3. That page announces the id on a BroadcastChannel as soon as it loads, and this dialog (still open
 *    in the first tab) polls GET /api/broker/connections/[id] every 3 s, so it notices the login
 *    either way.
 *
 * A 404 for the id it started means the connection is gone: either the login was merged into a
 * connection the workspace already had (the finish page announces that one's id) or the broker
 * refused it (the callback page in the other tab says why). The announcement can trail the 404 by a
 * few seconds, so the dialog keeps checking for GONE_GRACE_MS before it calls the login ended.
 *
 * Only answers fetched after the dialog opened count: a cached one can predate the start or the renew.
 */

const POLL_MS = 3_000;
const GONE_GRACE_MS = 15_000;

/** Same-origin tabs tell each other which connection a finished login landed on. */
export const CONNECT_CHANNEL = "nasscord:broker-connected";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tells the other tabs of this site that a login finished on `connectionId` (/app/brokers?connected=). */
export function announceConnected(connectionId: string) {
  if (typeof BroadcastChannel === "undefined" || !UUID.test(connectionId)) return;
  try {
    const channel = new BroadcastChannel(CONNECT_CHANNEL);
    channel.postMessage({ connected: connectionId });
    channel.close();
  } catch {
    // A browser without BroadcastChannel in this context: the waiting dialog's poll still notices the login.
  }
}

/** Connection ids other tabs announced since this component mounted. */
export function useConnectedSignal(): string[] {
  const [ids, setIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CONNECT_CHANNEL);
    channel.onmessage = (e: MessageEvent) => {
      const id = (e.data as { connected?: unknown } | null)?.connected;
      if (typeof id === "string" && UUID.test(id)) setIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    };
    return () => channel.close();
  }, []);
  return ids;
}

/**
 * The hop, authorize or portal link from the app's routes. Only https is opened, plus plain http on
 * localhost for local development (the broker service refuses an http callback base in production).
 */
export function safeOpenUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return u.toString();
    const local = u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname === "127.0.0.1";
    if (u.protocol === "http:" && local) return u.toString();
    return null;
  } catch {
    return null;
  }
}

const FAILED: ReadonlySet<ConnectionStatus> = new Set(["expired", "error", "disconnected"]);

export interface RedirectWaitResult {
  connection: BrokerConnection;
  /** The login was already connected in this workspace, so it landed on that connection. */
  merged: boolean;
}

/**
 * "Open <Broker> login" plus the wait for the login to come back. Calls `onConnected` once, with the
 * connection the login landed on. `reconnect`: the connection already existed and may still be live,
 * so success is the finish page's announcement, or the status turning live from not live. A live
 * status alone is not, and neither is the session end moving: the broker service moves that on an
 * ordinary background token refresh too.
 */
export function RedirectWait({
  brokerId,
  connectionId,
  openUrl,
  via,
  reconnect = false,
  onConnected,
  onRestart,
  restarting = false,
}: {
  brokerId: BrokerId;
  connectionId: string;
  openUrl: string | null | undefined;
  via?: "snaptrade";
  reconnect?: boolean;
  onConnected: (result: RedirectWaitResult) => void;
  /** Start a new login (a fresh link) after this one failed or ran out. */
  onRestart?: () => void;
  restarting?: boolean;
}) {
  const broker = getBroker(brokerId);
  const href = safeOpenUrl(openUrl);
  const [opened, setOpened] = React.useState(false);
  const heard = useConnectedSignal();

  // Poll until the login settles. The decision uses the last answer, so the poll stops one render later.
  const [stopped, setStopped] = React.useState(false);
  const peek = useConnection(connectionId, { pollMs: stopped ? undefined : POLL_MS });
  // A cached answer can predate the start or the renew (an old "Session ended", an old live status),
  // so nothing is decided before this dialog's own first answer.
  const fresh = peek.isFetchedAfterMount;
  const c = fresh ? peek.data : undefined;
  const gone = fresh && peek.error instanceof ApiError && peek.error.status === 404;

  // The first answer after the start (or the renew): a Reconnect succeeds when a status that was not
  // live turns live. The renew leaves a working session live, so that case waits for the finish page.
  const [startStatus, setStartStatus] = React.useState<ConnectionStatus | null>(null);
  if (c && !startStatus) setStartStatus(c.status);
  // An ended status only means this login failed once the wait has seen the connection waiting or live.
  const [armed, setArmed] = React.useState(false);
  if (c && !FAILED.has(c.status) && !armed) setArmed(true);

  const heardThis = heard.includes(connectionId);
  const live = isLiveStatus(c?.status);
  const cameLive = !!startStatus && !isLiveStatus(startStatus);
  const succeeded = !gone && live && (!reconnect || heardThis || cameLive);
  const failed = !gone && !!c && FAILED.has(c.status) && armed;

  // Gone after the login: the finish page names the connection it merged into. Its announcement can
  // come a few seconds after the 404, so keep checking for a while before calling the login ended.
  const mergedId = gone ? (heard.find((id) => id !== connectionId) ?? null) : null;
  const merged = useConnection(mergedId);
  const mergedLive = !!merged.data && isLiveStatus(merged.data.status);
  const [graceOver, setGraceOver] = React.useState(false);
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  React.useEffect(() => {
    if (!gone || mergedId) return;
    // The connection list (under this dialog) shows where the login landed sooner than its own refresh.
    if (workspaceId) void queryClient.invalidateQueries({ queryKey: qk.connections(workspaceId) });
    const t = window.setTimeout(() => setGraceOver(true), GONE_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [gone, mergedId, queryClient, workspaceId]);

  const settled = succeeded || failed || (gone && (!!mergedId || graceOver));
  if (settled !== stopped) setStopped(settled);

  const mergedData = merged.data;
  const result = React.useMemo<RedirectWaitResult | null>(
    () => (succeeded && c ? { connection: c, merged: false } : mergedLive && mergedData ? { connection: mergedData, merged: true } : null),
    [succeeded, c, mergedLive, mergedData],
  );
  const reported = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!result || reported.current === result.connection.id) return;
    reported.current = result.connection.id;
    onConnected(result);
  }, [result, onConnected]);

  const ended = (failed || (gone && !mergedId && graceOver)) && !result;
  const label = opened ? `Open the ${broker.short} login again` : `Open the ${broker.short} login`;

  return (
    <div className="grid gap-4">
      <ol className="grid gap-3 text-sm">
        <li className="grid gap-2">
          <span>
            <span className="font-medium">1.</span> Open the {broker.short} login in a new tab. If Nasscord asks, check the workspace the login joins and press Continue. The link works for 10 minutes.
          </span>
          {href && !ended && !restarting ? (
            <Button
              className="justify-self-start"
              variant={opened ? "outline" : "default"}
              render={<a href={href} target="_blank" rel="noopener noreferrer" />}
              onClick={() => setOpened(true)}
            >
              {label}
              <ExternalLinkIcon data-icon="inline-end" />
            </Button>
          ) : (
            // An anchor cannot be disabled; with no safe link, or after the login ended, there is nothing to open.
            <Button className="justify-self-start" variant="outline" disabled>
              {label}
              <ExternalLinkIcon data-icon="inline-end" />
            </Button>
          )}
          {!href ? <p className="text-xs text-destructive">Nasscord received a login link it will not open. Close this window and start again.</p> : null}
        </li>
        <li>
          <span className="font-medium">2.</span>{" "}
          {via === "snaptrade"
            ? `Accept SnapTrade's terms, log in on ${broker.short}'s own page and choose the accounts to share.`
            : `Sign in on ${broker.short}'s own page and approve Nasscord. Nasscord never sees your password.`}
        </li>
        <li>
          <span className="font-medium">3.</span> {broker.short} sends you back to Nasscord in that tab. This window notices it by itself.
        </li>
      </ol>

      <div className="grid gap-1 rounded-lg border border-border px-3 py-2.5" aria-live="polite">
        {ended ? (
          <span className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {failed && c?.statusDetail
              ? c.statusDetail
              : gone
                ? `This login is no longer waiting. If ${broker.short} sent you back to Nasscord, the connection is listed under Brokers. If the other tab showed an error, start again.`
                : `The ${broker.short} login did not finish. Start again.`}
          </span>
        ) : peek.isError && !gone ? (
          <span className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {peek.error.message}
          </span>
        ) : gone && !result ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
            Checking where the login landed
          </span>
        ) : !c ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
            Checking the connection
          </span>
        ) : (
          <>
            <StatusDot
              tone={reconnect && live && !succeeded ? "brand" : CONNECTION_TONE[c.status].tone}
              pulse={!succeeded}
              label={<span className="text-sm">{reconnect && live && !succeeded ? "Waiting for the new login" : CONNECTION_TONE[c.status].label}</span>}
            />
            <p className="text-xs text-muted-foreground">
              {reconnect && live && !succeeded
                ? `Your current ${broker.short} session keeps working until the new login replaces it.`
                : (c.statusDetail ?? (opened ? `Waiting for ${broker.short} to send you back.` : "Open the login to continue."))}
            </p>
          </>
        )}
      </div>

      {ended && onRestart ? (
        <Button variant="outline" className="justify-self-start" disabled={restarting} onClick={onRestart}>
          {restarting ? <LoaderCircleIcon className="animate-spin" /> : <RotateCcwIcon />}
          {restarting ? "Starting a new login" : "Start again"}
        </Button>
      ) : null}
    </div>
  );
}

/** After a connect: the connection's accounts with their Included switches, kept fresh. */
export function ConnectedAccounts({ connection, merged = false }: { connection: BrokerConnection; merged?: boolean }) {
  const fresh = useConnection(connection.id);
  const c = fresh.data ?? connection;
  const short = getBroker(c.brokerId).short;
  return (
    <div className="grid gap-3">
      {merged ? <p className="text-sm text-muted-foreground">This {short} login was already connected in this workspace, so Nasscord updated that connection and kept its Included choices.</p> : null}
      {c.statusDetail ? <p className="text-sm text-muted-foreground">{c.statusDetail}</p> : null}
      <AccountIncludeList
        accounts={c.accounts}
        brokerShort={short}
        emptyText={`${short} listed no accounts for this login yet. They appear under Brokers as soon as ${short} returns them.`}
      />
    </div>
  );
}
