import { StatusDot } from "@/components/status-dot";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { BrokerServiceStatus } from "@/lib/server/console";
import type { ActionResult } from "@/lib/signup";
import { fmtDateTime, fmtNum } from "@/lib/format";
import { CONNECTION_STATUS } from "./lib";
import { KV } from "./primitives";
import { readServiceReport, ServiceFacts } from "./service-status";

/** DB status words the broker service counts by, mapped to the labels the console uses. */
const DB_STATUS_LABEL: Record<string, string> = {
  active: CONNECTION_STATUS.connected.label,
  pending: CONNECTION_STATUS.pending.label,
  expired: CONNECTION_STATUS.expired.label,
  error: CONNECTION_STATUS.error.label,
  disconnected: CONNECTION_STATUS.disconnected.label,
};

/** The two things this app depends on at run time: the database and the broker service. Checked when the page loads. */
export function HealthPage({ database, service, checkedAt }: { database: ActionResult<{ ms: number }>; service: BrokerServiceStatus; checkedAt: string }) {
  const report = readServiceReport(service);
  const brokers = Object.entries(report.connections);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Database</CardTitle>
          <CardDescription>Supabase Postgres, read with the service role.</CardDescription>
        </CardHeader>
        <CardContent>
          <KV
            items={[
              { label: "Status", value: database.ok ? <StatusDot tone="good" label="Answering" /> : <StatusDot tone="bad" label="Not answering" /> },
              database.ok ? { label: "Round trip", value: `${fmtNum(database.ms)} ms` } : { label: "Reason", value: <span className="font-normal text-muted-foreground">{database.error}</span> },
              { label: "Checked", value: <span className="font-normal text-muted-foreground">{fmtDateTime(checkedAt)}</span> },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Broker service</CardTitle>
          <CardDescription>Holds the IBKR gateways and the E*TRADE tokens. Traders cannot see balances, positions or orders while it is down.</CardDescription>
        </CardHeader>
        <CardContent>
          <ServiceFacts status={service} checkedAt={checkedAt} />
        </CardContent>
      </Card>

      {brokers.length ? (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Connections the service counts</CardTitle>
            <CardDescription>By broker and stored status, as the broker service reads them.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {brokers.map(([broker, counts]) => (
              <div key={broker} className="grid gap-1">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{broker === "ibkr" ? "IBKR" : broker === "etrade" ? "E*TRADE" : broker}</h3>
                {Object.keys(counts).length ? (
                  <KV items={Object.entries(counts).map(([s, n]) => ({ label: DB_STATUS_LABEL[s] ?? s, value: fmtNum(n) }))} />
                ) : (
                  <p className="text-sm text-muted-foreground">No connections.</p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
