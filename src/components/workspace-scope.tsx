"use client";

import * as React from "react";
import type { Role } from "@/lib/types";

/**
 * Who and which workspace the client-side data belongs to. The terminal layout (a server component)
 * provides it from the session; the hooks in src/hooks/queries.ts put the workspace id into every
 * query key, so cached data can never be shown to the wrong workspace.
 */
export interface WorkspaceScope {
  workspaceId: string;
  userId: string;
  role: Role;
}

const WorkspaceScopeContext = React.createContext<WorkspaceScope | null>(null);

export function WorkspaceScopeProvider({ value, children }: { value: WorkspaceScope; children: React.ReactNode }) {
  const memo = React.useMemo(() => value, [value.workspaceId, value.userId, value.role]); // eslint-disable-line react-hooks/exhaustive-deps
  return <WorkspaceScopeContext.Provider value={memo}>{children}</WorkspaceScopeContext.Provider>;
}

/** The scope, or null outside the terminal (queries that need it stay idle). */
export function useWorkspaceScope(): WorkspaceScope | null {
  return React.useContext(WorkspaceScopeContext);
}

export function useWorkspaceId(): string | null {
  return React.useContext(WorkspaceScopeContext)?.workspaceId ?? null;
}
