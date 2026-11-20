import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BrokerRegistryTable,
  BrokerRequestsTable,
  CallbackUrlList,
  ConnectOptionsTable,
  GatewaySlotsTable,
  type BrokerRow,
  type ConnectOptionRow,
} from "@/components/console/brokers-page";
import { readServiceReport, ServiceFacts } from "@/components/console/service-status";
import { getBrokerServiceStatus, getConnectOptionsForConsole, listBrokerConnectionsAll, listBrokerRequests } from "@/lib/server/console";
import { connectSpecs, environmentLabel, findSpec, METHOD_LABEL } from "@/lib/broker-connect";
import { BROKERS } from "@/lib/brokers";
import { gateKey, REACH_RANK, reachOf } from "@/lib/console-brokers";
import type { BrokerId } from "@/lib/types";

export const metadata: Metadata = { title: "Brokers · Console" };

const KNOWN = new Set<string>(BROKERS.map((b) => b.id));
const NAME = new Map<BrokerId, string>(BROKERS.map((b) => [b.id, b.name]));

export default async function BrokersAdminPage() {
  const [connections, service, requests, connect] = await Promise.all([listBrokerConnectionsAll(), getBrokerServiceStatus(), listBrokerRequests(), getConnectOptionsForConsole()]);
  const checkedAt = new Date().toISOString();
  const report = readServiceReport(service);
  const options = connect.options.filter((o) => KNOWN.has(o.brokerId));

  const rows: BrokerRow[] = BROKERS.map((b) => {
    const mine = connections.filter((c) => c.brokerId === b.id);
    const by = (s: string) => mine.filter((c) => c.status === s).length;
    const ways = [...new Set(connectSpecs(b.id).map((s) => METHOD_LABEL[s.method]))].join(" · ");
    return {
      id: b.id,
      name: b.name,
      ways: ways || "No integration yet",
      reach: reachOf(
        options.filter((o) => o.brokerId === b.id),
        connect.reachable,
      ),
      total: mine.length,
      connected: by("connected"),
      expiring: by("expiring"),
      pending: by("pending"),
      failing: by("expired") + by("error"),
      disconnected: by("disconnected"),
      accounts: mine.reduce((n, c) => n + c.accounts.length, 0),
    };
  }).sort((a, b) => REACH_RANK[a.reach] - REACH_RANK[b.reach] || b.total - a.total);

  const optionRows: ConnectOptionRow[] = options
    .map((o) => {
      const spec = findSpec(o.brokerId, o.method, o.client);
      const whose = o.client === "user" ? " (the user's own app)" : o.client === "platform" ? " (Nasscord's client)" : "";
      return {
        key: `${o.brokerId}:${o.method}:${o.client ?? "-"}`,
        brokerId: o.brokerId,
        brokerName: NAME.get(o.brokerId) ?? o.brokerId,
        way: spec?.title ?? METHOD_LABEL[o.method] ?? o.method,
        method: `${METHOD_LABEL[o.method] ?? o.method}${whose}`,
        gateKey: gateKey(o.method, o.client),
        audience: o.audience,
        available: o.available,
        reasonCode: o.reasonCode,
        reason: o.reason,
        environments: o.environments.map((e) => environmentLabel(o.brokerId, e, o.method)),
      };
    })
    .sort((a, b) => Number(b.available) - Number(a.available) || a.brokerName.localeCompare(b.brokerName));

  // One callback URL per OAuth broker plus SnapTrade's, as the service builds them from OAUTH_CALLBACK_BASE.
  const callbacks = new Map<string, Set<string>>();
  for (const o of options) {
    if (!o.callbackUrl) continue;
    const names = callbacks.get(o.callbackUrl) ?? new Set<string>();
    names.add(o.method === "snaptrade" ? "SnapTrade" : (NAME.get(o.brokerId) ?? o.brokerId));
    callbacks.set(o.callbackUrl, names);
  }
  const callbackItems = [...callbacks].map(([url, names]) => ({ url, label: [...names].join(", ") })).sort((a, b) => a.label.localeCompare(b.label));
  const everyone = rows.filter((r) => r.reach === "everyone").map((r) => r.name);

  return (
    <>
      <PageHeader
        title="Brokers"
        description={
          connect.reachable
            ? `The brokers in the registry, who may connect each one on this server right now, and the connections stored for each. ${everyone.length ? `Open to everyone today: ${everyone.join(", ")}.` : "No broker is open to everyone yet."} Order entry works for IBKR, E*TRADE and Alpaca (API key) in the workspaces where you switch it on; every other broker is read only.`
            : "The brokers in the registry and the connections stored for each. Who may connect each one is shown once the broker service answers."
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Registry</CardTitle>
          <CardDescription>
            Open to comes from the broker service (GET /v1/options) and is what the public pages show. Connection counts come from the database, for every broker.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BrokerRegistryTable rows={rows} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ways to connect</CardTitle>
          <CardDescription>
            Every way of connecting as the broker service offers it to you. Change who may use one with BROKER_AUDIENCE in the broker service&apos;s environment, then
            restart the service; the app needs no redeploy. A way also needs its adapter, its settings and, for broker sign-ins and SnapTrade, OAUTH_CALLBACK_BASE
            (docs/SETUP.md).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!connect.reachable && connect.error ? <p className="text-sm text-muted-foreground">{connect.error}</p> : null}
          <ConnectOptionsTable rows={optionRows} />
        </CardContent>
      </Card>

      {connect.reachable ? (
        <Card>
          <CardHeader>
            <CardTitle>Callback URLs</CardTitle>
            <CardDescription>
              Register these exactly with each broker and with SnapTrade. They come from OAUTH_CALLBACK_BASE and must never change: a new address means every Schwab app
              and TradeStation key is approved again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {connect.callbackBase ? (
              <CallbackUrlList items={callbackItems} />
            ) : (
              <p className="text-sm text-warn-foreground">OAUTH_CALLBACK_BASE is not set on the broker service, so no broker sign-in or SnapTrade connection can start.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Broker service</CardTitle>
            <CardDescription>Its own report from /health and /v1/health.</CardDescription>
          </CardHeader>
          <CardContent>
            <ServiceFacts status={service} checkedAt={checkedAt} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>IBKR gateways</CardTitle>
            <CardDescription>One gateway process per IBKR connection, as the broker service lists them.</CardDescription>
          </CardHeader>
          <CardContent>
            {service.reachable && service.detail ? (
              <GatewaySlotsTable slots={report.slots} />
            ) : (
              <p className="text-sm text-muted-foreground">{service.reachable ? "The broker service did not return its gateway list." : "Gateways are listed once the broker service answers."}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Broker requests</CardTitle>
          <CardDescription>Traders asking for a broker that does not connect yet.</CardDescription>
        </CardHeader>
        <CardContent>
          <BrokerRequestsTable requests={requests} />
        </CardContent>
      </Card>
    </>
  );
}
