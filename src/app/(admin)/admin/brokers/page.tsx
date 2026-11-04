import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BrokerRegistryTable, BrokerRequestsTable, GatewaySlotsTable, type BrokerRow } from "@/components/console/brokers-page";
import { readServiceReport, ServiceFacts } from "@/components/console/service-status";
import { getBrokerServiceStatus, listBrokerConnectionsAll, listBrokerRequests } from "@/lib/server/console";
import { BROKERS, isConnectable } from "@/lib/brokers";

export const metadata: Metadata = { title: "Brokers · Console" };

const METHOD: Partial<Record<BrokerRow["id"], string>> = {
  ibkr: "Client Portal Gateway, one per login",
  etrade: "OAuth 1.0a with the trader's own key",
};

export default async function BrokersAdminPage() {
  const [connections, service, requests] = await Promise.all([listBrokerConnectionsAll(), getBrokerServiceStatus(), listBrokerRequests()]);
  const checkedAt = new Date().toISOString();
  const report = readServiceReport(service);

  const rows: BrokerRow[] = BROKERS.map((b) => {
    const mine = connections.filter((c) => c.brokerId === b.id);
    const by = (s: string) => mine.filter((c) => c.status === s).length;
    return {
      id: b.id,
      name: b.name,
      blurb: b.blurb,
      connectable: isConnectable(b.id),
      method: METHOD[b.id] ?? "No integration yet",
      total: mine.length,
      connected: by("connected"),
      expiring: by("expiring"),
      pending: by("pending"),
      failing: by("expired") + by("error"),
      disconnected: by("disconnected"),
      accounts: mine.reduce((n, c) => n + c.accounts.length, 0),
    };
  }).sort((a, b) => Number(b.connectable) - Number(a.connectable));

  return (
    <>
      <PageHeader title="Brokers" description="The brokers in the registry, the connections stored for each, and the broker service that holds the sessions. Only IBKR and E*TRADE connect today, read-only." />

      <Card>
        <CardHeader>
          <CardTitle>Registry</CardTitle>
          <CardDescription>Connection counts come from the database. Every other broker shows &ldquo;Not available yet&rdquo; in the connect flows.</CardDescription>
        </CardHeader>
        <CardContent>
          <BrokerRegistryTable rows={rows} />
        </CardContent>
      </Card>

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
