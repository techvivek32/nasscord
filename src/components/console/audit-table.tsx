"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Download } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fmtDateTime } from "@/lib/format";
import type { AuditEvent } from "@/lib/types";
import { ResultBadge } from "./badges";

type ResultFilter = "all" | AuditEvent["result"];

const COLUMNS: ColumnDef<AuditEvent>[] = [
  { accessorKey: "at", header: "Time", cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground tabular">{fmtDateTime(row.original.at)}</span> },
  { accessorKey: "actor", header: "Actor", cell: ({ row }) => <span className={row.original.actor === "system" || row.original.actor === "anonymous" ? "text-muted-foreground" : "font-medium"}>{row.original.actor}</span> },
  { accessorKey: "action", header: "Action", cell: ({ row }) => <span className="font-mono text-xs">{row.original.action}</span> },
  { accessorKey: "target", header: "Target", cell: ({ row }) => <span className="block max-w-72 truncate">{row.original.target}</span> },
  { id: "ip", accessorFn: (a) => a.ip ?? "", header: "IP", cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.ip}</span> },
  { accessorKey: "result", header: "Result", cell: ({ row }) => <ResultBadge result={row.original.result} /> },
];

/** "tenant.application.approve" -> "tenant". */
const areaOf = (action: string) => action.split(".")[0] ?? action;

/**
 * One CSV cell. Targets carry text from anonymous forms (tenant applications), so a value that a
 * spreadsheet would read as a formula (=, +, -, @, tab, carriage return) is prefixed with a single
 * quote and stays text. Then the usual quoting applies.
 */
function csvCell(raw: string) {
  const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function downloadCsv(rows: AuditEvent[]) {
  const header = ["at", "actor", "action", "target", "ip", "result", "workspace_id"];
  const lines = rows.map((a) => [a.at, a.actor, a.action, a.target, a.ip ?? "", a.result, a.workspaceId ?? ""].map(csvCell).join(","));
  const blob = new Blob([[header.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nasscord-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Audit events read on the server, filtered here. `limit` is how many of the newest rows were loaded. */
export function AuditTable({ events, limit }: { events: AuditEvent[]; limit: number }) {
  const [actor, setActor] = React.useState("all");
  const [area, setArea] = React.useState("all");
  const [result, setResult] = React.useState<ResultFilter>("all");

  const actors = React.useMemo(() => [{ value: "all", label: "All actors" }, ...[...new Set(events.map((a) => a.actor))].sort().map((a) => ({ value: a, label: a }))], [events]);
  const areas = React.useMemo(() => [{ value: "all", label: "All actions" }, ...[...new Set(events.map((a) => areaOf(a.action)))].sort().map((a) => ({ value: a, label: `${a}.*` }))], [events]);
  const rows = React.useMemo(
    () => events.filter((a) => (actor === "all" || a.actor === actor) && (area === "all" || areaOf(a.action) === area) && (result === "all" || a.result === result)),
    [events, actor, area, result],
  );

  if (events.length === 0) return <EmptyState title="No audit events yet" description="Sign-ins, broker connections and console changes are recorded here as they happen." />;

  return (
    <div className="grid gap-2">
      <DataTable
        columns={COLUMNS}
        data={rows}
        searchPlaceholder="Search action, target, IP…"
        pageSize={15}
        emptyMessage="No events match these filters."
        toolbar={
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <Select items={actors} value={actor} onValueChange={(v) => v && setActor(v)}>
              <SelectTrigger aria-label="Filter by actor" className="w-56 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {actors.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select items={areas} value={area} onValueChange={(v) => v && setArea(v)}>
              <SelectTrigger aria-label="Filter by action" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {areas.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ToggleGroup
              variant="outline"
              spacing={0}
              value={[result]}
              onValueChange={(next) => {
                const v = next[0] as ResultFilter | undefined;
                if (v) setResult(v);
              }}
              aria-label="Filter by result"
            >
              {(["all", "ok", "denied", "error"] as ResultFilter[]).map((r) => (
                <ToggleGroupItem key={r} value={r} size="sm" className="px-3 capitalize data-pressed:bg-muted aria-pressed:bg-muted">
                  {r === "all" ? "All" : r === "ok" ? "OK" : r}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <span className="text-xs text-muted-foreground tabular">
              {rows.length} of {events.length}
            </span>
            <Button variant="outline" size="sm" className="ml-auto" disabled={rows.length === 0} onClick={() => downloadCsv(rows)}>
              <Download data-icon="inline-start" />
              Download CSV
            </Button>
          </div>
        }
      />
      {events.length >= limit ? <p className="text-xs text-muted-foreground">Showing the newest {limit.toLocaleString("en-US")} events. Older events stay in the audit_events table.</p> : null}
    </div>
  );
}
