"use client";

import { ArrowLeftIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getBroker } from "@/lib/brokers";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { fmtMoney } from "@/lib/format";
import { RISK_OPTIONS, type RiskPct } from "@/components/onboarding/data";
import type { PreferencesValues } from "@/components/onboarding/schemas";
import { FieldHint, StepShell, useFocusOnMount } from "@/components/onboarding/step-shell";
import { riskDollars, selectAllAccounts, selectDefaultAccount, useSignupStore } from "@/components/onboarding/store";

type SwitchKey = Exclude<keyof PreferencesValues, "defaultAccountId" | "riskPct">;

const SWITCHES: ReadonlyArray<{ key: SwitchKey; label: string; help: string }> = [
  { key: "emailAlerts", label: "Email alerts", help: "Every new TradeScope alert and every fill, to the address on your account." },
  { key: "push", label: "Push notifications", help: "Mobile and desktop push for alerts, fills and stop moves." },
  { key: "sms", label: "SMS", help: "Text messages for fills and rejected orders only. Carrier rates apply." },
  { key: "extendedHours", label: "Extended hours", help: "Limit orders only outside 09:30 to 16:00 ET. Brackets wait for the regular session." },
  { key: "paperMode", label: "Start in paper mode", help: "Orders route to a simulated book until you switch the terminal to live. Recommended for the first week." },
];

/** Step 4: default account, risk per trade and notification switches. */
export function StepPreferences() {
  const connections = useSignupStore((s) => s.connections);
  const prefs = useSignupStore((s) => s.prefs);
  const navigated = useSignupStore((s) => s.navigated);
  const setPrefs = useSignupStore((s) => s.setPrefs);
  const finishPreferences = useSignupStore((s) => s.finishPreferences);
  const back = useSignupStore((s) => s.back);
  const goTo = useSignupStore((s) => s.goTo);

  const accounts = selectAllAccounts({ connections });
  const defaultAccount = selectDefaultAccount({ connections, prefs });

  const items = accounts.map((a) => ({ value: a.id, label: `${getBroker(a.brokerId).short} ${a.label} ${a.masked}` }));
  const setSwitch = (key: SwitchKey, checked: boolean) => setPrefs({ [key]: checked } as Partial<PreferencesValues>);

  useFocusOnMount(accounts.length ? "signup-default-account" : "signup-risk-0.5", navigated);

  const atRisk = defaultAccount ? riskDollars(defaultAccount.netLiq, prefs.riskPct) : null;

  return (
    <StepShell
      step={4}
      title="Trading preferences"
      description="These become the defaults in the order ticket and the alert feed. Everything here is editable in Settings."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={back}>
            <ArrowLeftIcon />
            Back
          </Button>
          <Button type="button" size="lg" onClick={finishPreferences}>
            Finish setup
          </Button>
        </>
      }
    >
      <div className="grid gap-2">
        <Label htmlFor="signup-default-account">Default trading account</Label>
        {accounts.length === 0 ? (
          <EmptyState
            title="No accounts connected yet"
            description="Connect a broker to pick a default account. You can also do this later; the terminal starts in paper mode."
            action={
              <Button type="button" variant="outline" size="sm" onClick={() => goTo(3)}>
                Connect a broker
              </Button>
            }
          />
        ) : (
          <>
            <Select items={items} value={prefs.defaultAccountId} onValueChange={(v) => v && setPrefs({ defaultAccountId: v })}>
              <SelectTrigger id="signup-default-account" className="w-full sm:max-w-md" aria-describedby="signup-default-account-hint">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="flex items-center gap-2">
                      <BrokerMark id={a.brokerId} size="xs" />
                      <span>
                        {getBroker(a.brokerId).short} {a.label}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground tabular">{a.masked}</span>
                      <span className="font-mono text-xs tabular">{fmtMoney(a.netLiq)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldHint id="signup-default-account-hint">New orders start in this account. Alerts still size against whichever account you pick in the ticket.</FieldHint>
          </>
        )}
      </div>

      <div className="grid gap-2">
        <Label id="signup-risk-label">Risk per trade</Label>
        <ToggleGroup
          variant="outline"
          spacing={0}
          value={[String(prefs.riskPct)]}
          onValueChange={(next) => {
            const v = Number(next[0]);
            if (RISK_OPTIONS.includes(v as RiskPct)) setPrefs({ riskPct: v as RiskPct });
          }}
          aria-labelledby="signup-risk-label"
          aria-describedby="signup-risk-hint"
        >
          {RISK_OPTIONS.map((r) => (
            <ToggleGroupItem key={r} id={`signup-risk-${r}`} value={String(r)} className="px-4 tabular data-pressed:bg-muted aria-pressed:bg-muted">
              {r}%
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldHint id="signup-risk-hint">
          {defaultAccount && atRisk !== null ? (
            <>
              {prefs.riskPct}% of {fmtMoney(defaultAccount.netLiq)} in {getBroker(defaultAccount.brokerId).short} {defaultAccount.label} puts{" "}
              <span className="font-medium text-foreground tabular">{fmtMoney(atRisk)}</span> at risk per trade. Position size is worked back from the stop at {ENGINE_DEFAULTS.atrStopMultiple}x ATR, capped at 95% of cash.
            </>
          ) : (
            <>Position size is worked back from the stop at {ENGINE_DEFAULTS.atrStopMultiple}x ATR so a stop-out costs this share of net liquidation. Connect an account to see the dollar amount.</>
          )}
        </FieldHint>
      </div>

      <ul className="divide-y divide-border rounded-xl border border-border" aria-label="Notifications and modes">
        {SWITCHES.map((row) => {
          const id = `signup-pref-${row.key}`;
          return (
            <li key={row.key} className="flex items-start justify-between gap-4 px-3 py-3">
              <div className="grid gap-0.5">
                <Label htmlFor={id} className="cursor-pointer">
                  {row.label}
                </Label>
                <p id={`${id}-help`} className="text-xs text-muted-foreground">
                  {row.help}
                </p>
              </div>
              <Switch id={id} checked={prefs[row.key]} onCheckedChange={(checked) => setSwitch(row.key, checked)} aria-describedby={`${id}-help`} className="mt-0.5" />
            </li>
          );
        })}
      </ul>
    </StepShell>
  );
}
