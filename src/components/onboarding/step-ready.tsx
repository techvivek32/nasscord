"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ArrowRightIcon, CircleCheckIcon, LoaderCircleIcon, UserPlusIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { completeSignup, inviteTeammate } from "@/lib/auth-actions";
import { getBroker } from "@/lib/brokers";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { fmtMoney } from "@/lib/format";
import { getPlan } from "@/lib/plans";
import { FALLBACK_SETUP_MS, MAX_REPORTED_SETUP_MS, formatElapsed } from "@/components/onboarding/data";
import { inviteSchema, type InviteValues } from "@/components/onboarding/schemas";
import { FieldError, StepShell, useFocusOnMount } from "@/components/onboarding/step-shell";
import { riskDollars, selectDefaultAccount, useSignupStore } from "@/components/onboarding/store";

/** Step 5: confirmation, summary, launch. */
export function StepReady({ partnerName, partnerActive }: { partnerName: string; partnerActive: boolean }) {
  const router = useRouter();
  const account = useSignupStore((s) => s.account);
  const workspace = useSignupStore((s) => s.workspace);
  const connections = useSignupStore((s) => s.connections);
  const prefs = useSignupStore((s) => s.prefs);
  const startedAt = useSignupStore((s) => s.startedAt);
  const completedAt = useSignupStore((s) => s.completedAt);
  const navigated = useSignupStore((s) => s.navigated);
  const markLaunched = useSignupStore((s) => s.markLaunched);

  const [launching, setLaunching] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);

  useFocusOnMount("signup-open-terminal", navigated);

  const plan = getPlan(workspace.plan);
  const defaultAccount = selectDefaultAccount({ connections, prefs });
  const accountCount = connections.reduce((n, c) => n + c.accounts.length, 0);

  const elapsed = startedAt && completedAt && completedAt > startedAt ? completedAt - startedAt : null;
  const setupMs = elapsed !== null && elapsed <= MAX_REPORTED_SETUP_MS ? elapsed : FALLBACK_SETUP_MS;

  const planLine = partnerActive
    ? `${plan.name} · billed by ${partnerName}`
    : plan.monthly === 0
      ? `${plan.name} · $0`
      : plan.id === "pro"
        ? `${plan.name} · 14-day trial, then $${plan.monthly}/mo`
        : `${plan.name} · $${plan.monthly}/mo`;

  const openTerminal = () => {
    setLaunching(true);
    React.startTransition(async () => {
      try {
        await completeSignup({ name: account.fullName || "New trader", email: account.email, tenantSlug: workspace.slug });
        markLaunched();
        router.push("/app");
      } catch {
        setLaunching(false);
        toast.error("Could not open the terminal", { description: "Try again in a moment." });
      }
    });
  };

  return (
    <StepShell step={5} title="Your terminal is ready" description={`Setup took ${formatElapsed(setupMs)}. Here is what you set up.`}>
      <div className="flex items-start gap-3 rounded-xl bg-gain-soft px-4 py-3 text-gain-foreground">
        <CircleCheckIcon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="grid gap-0.5 text-sm">
          <span className="font-semibold">Workspace created</span>
          <span className="font-mono text-xs break-all">{workspace.slug}.nasscord.com</span>
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Row label="Workspace URL">
          <span className="font-mono text-xs break-all">{workspace.slug}.nasscord.com</span>
        </Row>
        <Row label="Plan">{planLine}</Row>
        <Row label="Brokers">
          {connections.length ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {connections.map((c) => (
                <span key={c.brokerId} className="inline-flex items-center gap-1">
                  <BrokerMark id={c.brokerId} size="sm" />
                  <span className="text-xs">{getBroker(c.brokerId).short}</span>
                </span>
              ))}
              <span className="text-xs text-muted-foreground tabular">
                · {accountCount} {accountCount === 1 ? "account" : "accounts"}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">None yet. Add one from Settings.</span>
          )}
        </Row>
        <Row label="Default account">
          {defaultAccount ? (
            <span>
              {getBroker(defaultAccount.brokerId).short} {defaultAccount.label} <span className="font-mono text-xs text-muted-foreground tabular">{defaultAccount.masked}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Not set</span>
          )}
        </Row>
        <Row label="Risk per trade">
          <span className="tabular">
            {prefs.riskPct}%{defaultAccount ? ` · ${fmtMoney(riskDollars(defaultAccount.netLiq, prefs.riskPct))} per trade` : ""}
          </span>
        </Row>
        <Row label="Mode">{prefs.paperMode ? "Paper trading until you switch to live" : "Live trading"}</Row>
      </dl>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
          <DialogTrigger render={<Button type="button" variant="outline" size="lg" />}>
            <UserPlusIcon />
            Invite a teammate
          </DialogTrigger>
          <DialogContent>
            <InviteForm tenantSlug={workspace.slug} invitedBy={account.email} seatLimit={plan.limits.seats} onDone={() => setInviteOpen(false)} />
          </DialogContent>
        </Dialog>
        <Button id="signup-open-terminal" type="button" size="lg" onClick={openTerminal} disabled={launching}>
          {launching ? <LoaderCircleIcon className="animate-spin" /> : null}
          {launching ? "Opening" : "Open your terminal"}
          {!launching ? <ArrowRightIcon data-icon="inline-end" /> : null}
        </Button>
      </div>

      <div className="grid gap-2 border-t border-border pt-4">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">What happens next</p>
        <ul className="grid gap-1.5 text-sm text-muted-foreground">
          <li className="flex gap-2">
            <span aria-hidden="true">1.</span>
            Your first alerts arrive after the next {ENGINE_DEFAULTS.timeframe.replace("m", "-minute")} scan during market hours. TradeScope watches {ENGINE_DEFAULTS.universeSize} symbols and only surfaces scores of {ENGINE_DEFAULTS.minScore} or higher.
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true">2.</span>
            Broker tokens refresh automatically. Interactive Brokers asks for its own second factor once a day.
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true">3.</span>
            Add brokers, teammates and notification channels any time from Settings.
          </li>
        </ul>
      </div>
    </StepShell>
  );
}

function InviteForm({ tenantSlug, invitedBy, seatLimit, onDone }: { tenantSlug: string; invitedBy: string; seatLimit: number | "unlimited"; onDone: () => void }) {
  const [pending, setPending] = React.useState(false);
  const { register, handleSubmit, formState, setError } = useForm<InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: { email: "" } });

  const submit = (values: InviteValues) => {
    setPending(true);
    React.startTransition(async () => {
      const res = await inviteTeammate({ email: values.email, tenantSlug, invitedBy });
      setPending(false);
      if (!res.ok) {
        setError("email", { message: res.error });
        return;
      }
      toast.success(`Invite sent to ${res.email}`, { description: "They get a join link that expires in 7 days." });
      onDone();
    });
  };

  return (
    <form noValidate onSubmit={handleSubmit(submit)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Invite a teammate</DialogTitle>
        <DialogDescription>
          {seatLimit === 1
            ? "Your plan includes 1 seat. Invites beyond it prompt an upgrade to Desk."
            : seatLimit === "unlimited"
              ? "Seats are unlimited on your plan."
              : `Your plan includes ${seatLimit} seats.`}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="signup-invite-email">Teammate email</Label>
        <Input
          id="signup-invite-email"
          type="email"
          autoComplete="off"
          placeholder="teammate@yourfirm.com"
          aria-invalid={!!formState.errors.email}
          aria-describedby={formState.errors.email ? "signup-invite-email-error" : undefined}
          {...register("email")}
        />
        <FieldError id="signup-invite-email-error" message={formState.errors.email?.message} />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
          Send invite
        </Button>
      </DialogFooter>
    </form>
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
