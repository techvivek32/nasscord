"use client";

import * as React from "react";
import { toast } from "sonner";
import { ArrowLeftIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { saveUserSettings } from "@/lib/auth-actions";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { RISK_OPTIONS, type RiskPct } from "@/components/onboarding/data";
import type { PreferencesValues } from "@/components/onboarding/schemas";
import { FieldHint, StepShell, useFocusOnMount } from "@/components/onboarding/step-shell";
import { useSignupStore } from "@/components/onboarding/store";

type SwitchKey = Exclude<keyof PreferencesValues, "riskPct">;

const SWITCHES: ReadonlyArray<{ key: SwitchKey; label: string; help: string }> = [
  { key: "emailAlerts", label: "Email alerts", help: "To the address on your account. Saved for later: Nasscord sends no alerts in this release." },
  { key: "pushAlerts", label: "Push notifications", help: "In your browser. Saved for later: nothing is sent in this release." },
  { key: "smsAlerts", label: "SMS", help: "Text messages. Saved for later: Nasscord does not ask for a mobile number or send texts yet." },
  { key: "extendedHours", label: "Extended hours", help: "When order entry opens: allow limit orders outside 09:30 to 16:00 ET." },
  { key: "paperMode", label: "Start in paper mode", help: "When order entry opens: orders go to paper accounts until you switch the terminal to live." },
];

/** Step 4: risk per trade and notification switches, saved to user_settings. */
export function StepPreferences() {
  const prefs = useSignupStore((s) => s.prefs);
  const navigated = useSignupStore((s) => s.navigated);
  const setPrefs = useSignupStore((s) => s.setPrefs);
  const finishPreferences = useSignupStore((s) => s.finishPreferences);
  const back = useSignupStore((s) => s.back);
  const [saving, setSaving] = React.useState(false);

  useFocusOnMount("signup-risk-0.5", navigated);

  const setSwitch = (key: SwitchKey, checked: boolean) => setPrefs({ [key]: checked } as Partial<PreferencesValues>);

  const finish = () => {
    setSaving(true);
    React.startTransition(async () => {
      const res = await saveUserSettings({
        riskPct: prefs.riskPct,
        paperMode: prefs.paperMode,
        extendedHours: prefs.extendedHours,
        emailAlerts: prefs.emailAlerts,
        pushAlerts: prefs.pushAlerts,
        smsAlerts: prefs.smsAlerts,
      });
      setSaving(false);
      if (!res.ok) {
        toast.error("Could not save your preferences", { description: res.error });
        return;
      }
      finishPreferences();
    });
  };

  return (
    <StepShell
      step={4}
      title="Trading preferences"
      description="Defaults for your account. Everything here is editable in Settings."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={back} disabled={saving}>
            <ArrowLeftIcon />
            Back
          </Button>
          <Button type="button" size="lg" onClick={finish} disabled={saving}>
            {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
            {saving ? "Saving" : "Finish setup"}
          </Button>
        </>
      }
    >
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
          Share of net liquidation a stop-out may cost. Position size is worked back from the stop at {ENGINE_DEFAULTS.atrStopMultiple}x ATR, capped at 95% of cash.
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
