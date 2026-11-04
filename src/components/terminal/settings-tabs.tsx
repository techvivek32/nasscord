"use client";

import * as React from "react";
import { toast } from "sonner";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { LoaderCircleIcon, MailIcon } from "lucide-react";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { saveUserSettings } from "@/lib/auth-actions";
import { sendMyPasswordReset } from "@/lib/server/terminal-actions-extra";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { fmtMoney } from "@/lib/format";
import type { SettingsValues } from "@/lib/signup";

/** The saved trading defaults this page edits (user_settings), without the default account. */
export type EditableSettings = Omit<SettingsValues, "defaultAccountId">;

export interface SettingsProps {
  user: { name: string; email: string };
  workspace: { name: string; planLabel: string; timezone: string };
  settings: EditableSettings;
}

type Tab = "profile" | "notifications" | "risk" | "security" | "billing";

/**
 * /app/settings. Profile shows who is signed in; Notifications and Risk save to user_settings through
 * saveUserSettings; Security sends a password reset email; Billing has no source yet.
 */
export function SettingsTabs({ user, workspace, settings }: SettingsProps) {
  const [tab, setTab] = React.useState<Tab>("profile");
  // The last saved values: both forms send the whole row, so each starts from what the other saved.
  const [saved, setSaved] = React.useState<EditableSettings>(settings);
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-4">
      <div className="overflow-x-auto">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="risk">Risk</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="profile">
        <ProfilePanel user={user} workspace={workspace} />
      </TabsContent>
      <TabsContent value="notifications">
        <NotificationsForm email={user.email} saved={saved} onSaved={setSaved} />
      </TabsContent>
      <TabsContent value="risk">
        <RiskForm saved={saved} onSaved={setSaved} />
      </TabsContent>
      <TabsContent value="security">
        <SecurityPanel email={user.email} />
      </TabsContent>
      <TabsContent value="billing">
        <EmptyState className="max-w-2xl" title="Billing is not connected yet" description={`Your workspace is on the ${workspace.planLabel} plan. Invoices, payment methods and plan changes appear here once billing is connected.`} />
      </TabsContent>
    </Tabs>
  );
}

/** Saves the whole settings row; resolves to the saved values, or null after showing why it failed. */
async function save(next: EditableSettings, what: string): Promise<EditableSettings | null> {
  const res = await saveUserSettings(next).catch(() => ({ ok: false as const, error: "We could not reach Nasscord. Check your connection and try again." }));
  if (!res.ok) {
    toast.error(`${what} not saved`, { description: res.error });
    return null;
  }
  toast.success(`${what} saved`);
  return next;
}

/* ---------------- Profile ---------------- */

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="grid gap-0.5 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{k}</dt>
      <dd className={mono ? "font-mono text-sm break-all" : "text-sm break-words"}>{v}</dd>
    </div>
  );
}

function ProfilePanel({ user, workspace }: { user: SettingsProps["user"]; workspace: SettingsProps["workspace"] }) {
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Who is signed in, and the workspace this terminal belongs to.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          <Row k="Name" v={user.name || "Not set"} />
          <Row k="Email" v={user.email} />
          <Row k="Workspace" v={workspace.name} />
          <Row k="Timezone" v={workspace.timezone} mono />
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">Your name and email come from your sign-up and cannot be changed here yet. Trading days always follow US Eastern time.</p>
      </CardContent>
    </Card>
  );
}

/* ---------------- shared ---------------- */

function SwitchRow({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <Label htmlFor={id} className="grid cursor-pointer gap-0.5 font-normal">
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/* ---------------- Notifications ---------------- */

const notifySchema = z.object({ emailAlerts: z.boolean(), pushAlerts: z.boolean(), smsAlerts: z.boolean() });
type NotifyValues = z.infer<typeof notifySchema>;

function NotificationsForm({ email, saved, onSaved }: { email: string; saved: EditableSettings; onSaved: (s: EditableSettings) => void }) {
  const defaults: NotifyValues = { emailAlerts: saved.emailAlerts, pushAlerts: saved.pushAlerts, smsAlerts: saved.smsAlerts };
  const form = useForm<NotifyValues>({ resolver: zodResolver(notifySchema), defaultValues: defaults });
  const { handleSubmit, formState, setValue, control, reset } = form;
  const v = { ...defaults, ...useWatch({ control }) };
  const id = React.useId();

  const onSubmit = async (values: NotifyValues) => {
    const next = await save({ ...saved, ...values }, "Notification preferences");
    if (next) {
      onSaved(next);
      reset(values);
    }
  };

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Where TradeScope alerts reach you. TradeScope is not connected to this workspace yet, so nothing is sent until it is; your choice is saved for then.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <CardContent className="divide-y divide-border">
          <SwitchRow id={`${id}-email`} label="Email" hint={`Alerts to ${email}`} checked={v.emailAlerts} onChange={(c) => setValue("emailAlerts", c, { shouldDirty: true })} disabled={formState.isSubmitting} />
          <SwitchRow id={`${id}-push`} label="Push notifications" hint="Notifications in your browser" checked={v.pushAlerts} onChange={(c) => setValue("pushAlerts", c, { shouldDirty: true })} disabled={formState.isSubmitting} />
          <SwitchRow id={`${id}-sms`} label="SMS" hint="Text messages. Nasscord does not ask for a mobile number yet" checked={v.smsAlerts} onChange={(c) => setValue("smsAlerts", c, { shouldDirty: true })} disabled={formState.isSubmitting} />
        </CardContent>
        <CardContent className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="outline" disabled={!formState.isDirty || formState.isSubmitting} onClick={() => reset()}>
            Discard
          </Button>
          <Button type="submit" disabled={!formState.isDirty || formState.isSubmitting}>
            {formState.isSubmitting ? <LoaderCircleIcon className="animate-spin" /> : null}
            Save preferences
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}

/* ---------------- Risk ---------------- */

const riskSchema = z.object({
  riskPct: z.number({ error: "Enter a number." }).gt(0, "Risk must be above 0%.").max(5, "Risk is at most 5% per trade."),
  extendedHours: z.boolean(),
  paperMode: z.boolean(),
});
type RiskValues = z.infer<typeof riskSchema>;

function RiskForm({ saved, onSaved }: { saved: EditableSettings; onSaved: (s: EditableSettings) => void }) {
  const defaults: RiskValues = { riskPct: saved.riskPct, extendedHours: saved.extendedHours, paperMode: saved.paperMode };
  const form = useForm<RiskValues>({ resolver: zodResolver(riskSchema), defaultValues: defaults });
  const { register, handleSubmit, formState, setValue, control, reset } = form;
  const v = { ...defaults, ...useWatch({ control }) };
  const id = React.useId();
  const example = Number.isFinite(v.riskPct) && v.riskPct > 0 ? fmtMoney(100_000 * (v.riskPct / 100), { digits: 0 }) : null;

  const onSubmit = async (values: RiskValues) => {
    const next = await save({ ...saved, ...values }, "Risk settings");
    if (next) {
      onSaved(next);
      reset(values);
    }
  };

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Risk</CardTitle>
        <CardDescription>
          The order ticket sizes every trade so a stop-out costs this share of the account&apos;s net liquidation. The engine&apos;s stop sits at {ENGINE_DEFAULTS.atrStopMultiple} x ATR and its target at {ENGINE_DEFAULTS.rewardToRisk} R.
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5 sm:max-w-48">
            <Label htmlFor={`${id}-risk`}>Risk per trade</Label>
            <div className="relative">
              <Input id={`${id}-risk`} type="number" step={0.1} min={0.1} max={5} className="pr-8 font-mono tabular" {...register("riskPct", { valueAsNumber: true })} aria-invalid={!!formState.errors.riskPct} aria-describedby={`${id}-risk-hint`} />
              <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">%</span>
            </div>
            <p id={`${id}-risk-hint`} className={formState.errors.riskPct ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {formState.errors.riskPct?.message ?? (example ? `On a $100,000 account a full stop-out costs ${example}.` : "Between 0.1% and 5%.")}
            </p>
          </div>
          <div className="divide-y divide-border">
            <SwitchRow id={`${id}-ext`} label="Extended hours" hint="Size and route orders outside 09:30 to 16:00 ET once order entry is on" checked={v.extendedHours} onChange={(c) => setValue("extendedHours", c, { shouldDirty: true })} disabled={formState.isSubmitting} />
            <SwitchRow id={`${id}-paper`} label="Start in paper mode" hint="Send orders to a paper account by default once order entry is on" checked={v.paperMode} onChange={(c) => setValue("paperMode", c, { shouldDirty: true })} disabled={formState.isSubmitting} />
          </div>
          <p className="text-xs text-muted-foreground">Order entry is switched off in this release, so the two switches are saved for later and change nothing today.</p>
        </CardContent>
        <CardContent className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="outline" disabled={!formState.isDirty || formState.isSubmitting} onClick={() => reset()}>
            Discard
          </Button>
          <Button type="submit" disabled={!formState.isDirty || formState.isSubmitting}>
            {formState.isSubmitting ? <LoaderCircleIcon className="animate-spin" /> : null}
            Save risk settings
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}

/* ---------------- Security ---------------- */

function SecurityPanel({ email }: { email: string }) {
  const [pending, startTransition] = React.useTransition();
  const [sentAt, setSentAt] = React.useState<string | null>(null);

  const send = () =>
    startTransition(async () => {
      const res = await sendMyPasswordReset().catch(() => ({ ok: false as const, error: "We could not reach Nasscord. Check your connection and try again." }));
      if (!res.ok) {
        toast.error("Reset email not sent", { description: res.error });
        return;
      }
      setSentAt(res.email);
      toast.success("Reset email sent", { description: `Open the link sent to ${res.email} to choose a new password.` });
    });

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Change your password with a link sent to your email. The link works once and expires after an hour.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{sentAt ? `Sent to ${sentAt}. Check your inbox and spam folder.` : `The link goes to ${email}.`}</p>
        <Button variant="outline" onClick={send} disabled={pending}>
          {pending ? <LoaderCircleIcon className="animate-spin" /> : <MailIcon />}
          {sentAt ? "Send again" : "Send reset link"}
        </Button>
      </CardContent>
    </Card>
  );
}
