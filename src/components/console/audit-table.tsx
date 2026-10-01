"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAudit } from "@/hooks/queries";
import { fmtDateTime } from "@/lib/format";
import type { AuditEvent } from "@/lib/types";
import { ResultBadge } from "./badges";
import { TableSkeleton } from "./primitives";

type ResultFilter = "all" | AuditEvent["result"];

const COLUMNS: ColumnDef<AuditEvent>[] = [
  { accessorKey: "at", header: "Time", cell: ({ row }) => <span className="text-muted-foreground tabular">{fmtDateTime(row.original.at)}</span> },
  { accessorKey: "actor", header: "Actor", cell: ({ row }) => <span className={row.original.actor === "system" ? "text-muted-foreground" : "font-medium"}>{row.original.actor}</span> },
  { accessorKey: "action", header: "Action", cell: ({ row }) => <span className="font-mono text-xs">{row.original.action}</span> },
  { accessorKey: "target", header: "Target", cell: ({ row }) => <span className="max-w-72 truncate">{row.original.target}</span> },
  { accessorKey: "ip", header: "IP", cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.ip}</span> },
  { accessorKey: "result", header: "Result", cell: ({ row }) => <ResultBadge result={row.original.result} /> },
];

export function AuditTable() {
  const audit = useAudit();
  const [actor, setActor] = React.useState("all");
  const [result, setResult] = React.useState<ResultFilter>("all");

  const actors = React.useMemo(() => {
    const set = new Set((audit.data ?? []).map((a) => a.actor));
    return [{ value: "all", label: "All actors" }, ...Array.from(set).sort().map((a) => ({ value: a, label: a }))];
  }, [audit.data]);

  const rows = React.useMemo(() => (audit.data ?? []).filter((a) => (actor === "all" || a.actor === actor) && (result === "all" || a.result === result)), [audit.data, actor, result]);

  if (audit.isLoading) return <TableSkeleton rows={10} cols={6} />;
  if (audit.isError) return <EmptyState title="Audit log unavailable" action={<Button variant="outline" size="sm" onClick={() => audit.refetch()}>Retry</Button>} />;
  if ((audit.data ?? []).length === 0) return <EmptyState title="No audit events" description="Super admin, tenant, trader and system actions will appear here." />;

  return (
    <DataTable
      columns={COLUMNS}
      data={rows}
      searchPlaceholder="Search action, target, IP…"
      pageSize={12}
      emptyMessage="No events match these filters."
      toolbar={
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <Select items={actors} value={actor} onValueChange={(v) => v && setActor(v)}>
            <SelectTrigger aria-label="Filter by actor" className="w-56">
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
            {rows.length} of {audit.data?.length ?? 0}
          </span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => toast.success("Export started", { description: `${rows.length} events · CSV lands in your inbox within a minute.` })}>
            <Download data-icon="inline-start" />
            Export CSV
          </Button>
        </div>
      }
    />
  );
}
