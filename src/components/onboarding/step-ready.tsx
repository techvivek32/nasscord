"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, CircleCheckIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_DOMAIN } from "@/lib/branding";
import { ROLE_LABEL, terminalHomeForRole } from "@/lib/roles";
import { MAX_REPORTED_SETUP_MS, formatElapsed } from "@/components/onboarding/data";
import { StepShell, useFocusOnMount } from "@/components/onboarding/step-shell";
import { useSignupStore } from "@/components/onboarding/store";

/** Step 5: what was set up, then "Open your terminal" (Positions for traders, terminalHomeForRole). */
export function StepReady({ tenantName }: { tenantName: string | null }) {
  const router = useRouter();
  const workspace = useSignupStore((s) => s.workspace);
  const created = useSignupStore((s) => s.created);
  const prefs = useSignupStore((s) => s.prefs);
  const startedAt = useSignupStore((s) => s.startedAt);
  const completedAt = useSignupStore((s) => s.completedAt);
  const navigated = useSignupStore((s) => s.navigated);
  const markLaunched = useSignupStore((s) => s.markLaunched);
  const [launching, setLaunching] = React.useState(false);

  useFocusOnMount("signup-open-terminal", navigated);

  const slug = created?.slug ?? workspace.slug;
  const role = created?.role ?? "trader";
  const elapsed = startedAt && completedAt && completedAt > startedAt ? completedAt - startedAt : null;
  const showElapsed = elapsed !== null && elapsed <= MAX_REPORTED_SETUP_MS;

  const openTerminal = () => {
    setLaunching(true);
    markLaunched();
    router.push(terminalHomeForRole(role));
  };

  return (
    <StepShell step={5} title="Your terminal is ready" description={showElapsed ? `Setup took ${formatElapsed(elapsed)}. Here is what you set up.` : "Here is what you set up."}>
      <div className="flex items-start gap-3 rounded-xl bg-gain-soft px-4 py-3 text-gain-foreground">
        <CircleCheckIcon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="grid gap-0.5 text-sm">
          <span className="font-semibold">Workspace created</span>
          <span className="font-mono text-xs break-all">
            {slug}.{APP_DOMAIN}
          </span>
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Row label="Workspace">{workspace.name}</Row>
        <Row label="Your role">
          {role === "tenant_user" && tenantName ? `${ROLE_LABEL.tenant_user} through ${tenantName}` : ROLE_LABEL[role]}
        </Row>
        <Row label="Brokers">
          <span className="text-muted-foreground">Connect from the Brokers page</span>
        </Row>
        <Row label="Risk per trade">
          <span className="tabular">{prefs.riskPct}%</span>
        </Row>
        <Row label="Mode">{prefs.paperMode ? "Paper until you switch to live" : "Live"}</Row>
      </dl>

      <div className="flex justify-end">
        <Button id="signup-open-terminal" type="button" size="lg" onClick={openTerminal} disabled={launching}>
          {launching ? <LoaderCircleIcon className="animate-spin" /> : null}
          {launching ? "Opening" : "Open your terminal"}
          {!launching ? <ArrowRightIcon data-icon="inline-end" /> : null}
        </Button>
      </div>

      <div className="grid gap-2 border-t border-border pt-4">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">What happens next</p>
        <ol className="grid gap-1.5 text-sm text-muted-foreground">
          <li className="flex gap-2">
            <span aria-hidden="true">1.</span>
            Connect a broker from the Brokers page in the terminal. It lists the brokers you can connect today.
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true">2.</span>
            Some brokers ask you to log in again every day or every few days. The Brokers page shows when each session ends and has a Reconnect button.
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true">3.</span>
            Nasscord reads your accounts: balances, positions, orders and executions. Placing orders from Nasscord is switched on per workspace, for IBKR, E*TRADE and Alpaca (API key).
          </li>
        </ol>
      </div>
    </StepShell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{children}</dd>
    </div>
  );
}
