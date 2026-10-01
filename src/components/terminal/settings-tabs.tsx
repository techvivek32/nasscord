"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { type PathValue, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CreditCardIcon, LaptopIcon, ShieldCheckIcon, SmartphoneIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TONE_BADGE } from "@/components/status-dot";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { fmtMoney } from "@/lib/format";
import { getPlan } from "@/lib/plans";
import type { PlanId } from "@/lib/types";
import { usePaperMode } from "@/components/terminal/hooks";
import { useTerminalStore } from "@/components/terminal/store";

export interface SettingsProps {
  user: { name: string; email: string };
  tenant: { name: string; plan: PlanId; timezone: string; features: { options: boolean; extendedHours: boolean; paperDefault: boolean } };
}

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "Europe/London", label: "London" },
  { value: "Asia/Kolkata", label: "India (Kolkata)" },
];
const TZ_ITEMS = TIMEZONES.map((t) => ({ value: t.value, label: t.label }));

type Tab = "profile" | "notifications" | "risk" | "security" | "billing";

export function SettingsTabs({ user, tenant }: SettingsProps) {
  const [tab, setTab] = React.useState<Tab>("profile");
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
        <ProfileForm user={user} timezone={tenant.timezone} />
      </TabsContent>
      <TabsContent value="notifications">
        <NotificationsForm email={user.email} />
      </TabsContent>
      <TabsContent value="risk">
        <RiskForm features={tenant.features} />
      </TabsContent>
      <TabsContent value="security">
        <SecurityPanel email={user.email} />
      </TabsContent>
      <TabsContent value="billing">
        <BillingPanel plan={tenant.plan} tenantName={tenant.name} />
      </TabsContent>
    </Tabs>
  );
}

/* ---------------- Profile ---------------- */

const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter your name."),
  email: z.email("Enter a valid email address."),
  timezone: z.string().min(1, "Pick a timezone."),
});
type ProfileValues = z.infer<typeof profileSchema>;

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

function ProfileForm({ user, timezone }: { user: SettingsProps["user"]; timezone: string }) {
  const form = useForm<ProfileValues>({ resolver: zodResolver(profileSchema), defaultValues: { name: user.name, email: user.email, timezone } });
  const { register, handleSubmit, formState, setValue, control, reset } = form;
  const tz = useWatch({ control, name: "timezone" });
  const id = React.useId();

  const onSubmit = (values: ProfileValues) => {
    toast.success("Profile saved", { description: `${values.name} · ${values.email} · ${TIMEZONES.find((t) => t.value === values.timezone)?.label ?? values.timezone}` });
    reset(values);
  };

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Your name appears in the team audit log; alert times are shown in your timezone.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>Full name</Label>
            <Input id={`${id}-name`} {...register("name")} aria-invalid={!!formState.errors.name} aria-describedby={`${id}-name-err`} autoComplete="name" />
            <FieldError id={`${id}-name-err`} message={formState.errors.name?.message} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-email`}>Email</Label>
            <Input id={`${id}-email`} type="email" {...register("email")} aria-invalid={!!formState.errors.email} aria-describedby={`${id}-email-err`} autoComplete="email" />
            <FieldError id={`${id}-email-err`} message={formState.errors.email?.message} />
            <p className="text-xs text-muted-foreground">Changing your email sends a confirmation link to both addresses.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-tz`}>Timezone</Label>
            <Select items={TZ_ITEMS} value={tz} onValueChange={(v) => v && setValue("timezone", String(v), { shouldDirty: true })}>
              <SelectTrigger id={`${id}-tz`} className="w-full sm:max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Trading-day boundaries always follow US Eastern time regardless of this setting.</p>
          </div>
        </CardContent>
        <CardContent className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="outline" disabled={!formState.isDirty} onClick={() => reset()}>
            Discard
          </Button>
          <Button type="submit" disabled={!formState.isDirty}>
            Save profile
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}

/* ---------------- Notifications ---------------- */

const notifySchema = z.object({
  emailAlerts: z.boolean(),
  push: z.boolean(),
  sms: z.boolean(),
  fills: z.boolean(),
  sessionExpiry: z.boolean(),
  digest: z.enum(["off", "daily", "weekly"]),
  phone: z.string().trim(),
}).refine((v) => !v.sms || /^\+?[0-9 ()-]{10,}$/.test(v.phone), { path: ["phone"], message: "Enter a phone number to receive SMS alerts." });
type NotifyValues = z.infer<typeof notifySchema>;

function SwitchRow({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <Label htmlFor={id} className="grid cursor-pointer gap-0.5 font-normal">
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

const NOTIFY_DEFAULTS: NotifyValues = { emailAlerts: true, push: true, sms: false, fills: true, sessionExpiry: true, digest: "daily", phone: "" };

function NotificationsForm({ email }: { email: string }) {
  const form = useForm<NotifyValues>({ resolver: zodResolver(notifySchema), defaultValues: NOTIFY_DEFAULTS });
  const { register, handleSubmit, formState, setValue, control, reset } = form;
  const watched = useWatch({ control });
  const v: NotifyValues = { ...NOTIFY_DEFAULTS, ...watched };
  const id = React.useId();
  const set = <K extends keyof NotifyValues>(k: K, val: NotifyValues[K]) => setValue(k, val as unknown as PathValue<NotifyValues, K>, { shouldDirty: true });

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Alerts go out the moment the scanner publishes them. Fills and session warnings come from the broker connection.</CardDescription>
      </CardHeader>
      <form
        onSubmit={handleSubmit((values) => {
          toast.success("Notification preferences saved", { description: [values.emailAlerts && "email", values.push && "push", values.sms && "SMS"].filter(Boolean).join(", ") || "All channels off" });
          reset(values);
        })}
        noValidate
      >
        <CardContent className="divide-y">
          <SwitchRow id={`${id}-email`} label="Email alerts" hint={`New TradeScope alerts to ${email}`} checked={v.emailAlerts} onChange={(c) => set("emailAlerts", c)} />
          <SwitchRow id={`${id}-push`} label="Push notifications" hint="Mobile app and desktop" checked={v.push} onChange={(c) => set("push", c)} />
          <SwitchRow id={`${id}-sms`} label="SMS" hint="Score 100+ alerts and stop-outs only" checked={v.sms} onChange={(c) => set("sms", c)} />
          {v.sms ? (
            <div className="grid gap-1.5 py-3">
              <Label htmlFor={`${id}-phone`}>Mobile number</Label>
              <Input id={`${id}-phone`} type="tel" placeholder="+1 555 010 4477" className="sm:max-w-xs" {...register("phone")} aria-invalid={!!formState.errors.phone} aria-describedby={`${id}-phone-err`} />
              <FieldError id={`${id}-phone-err`} message={formState.errors.phone?.message} />
            </div>
          ) : null}
          <SwitchRow id={`${id}-fills`} label="Fills and cancels" hint="One notification per verified order event" checked={v.fills} onChange={(c) => set("fills", c)} />
          <SwitchRow id={`${id}-sess`} label="Broker session expiry" hint="30 minutes before an IBKR gateway session or OAuth token lapses" checked={v.sessionExpiry} onChange={(c) => set("sessionExpiry", c)} />
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="grid gap-0.5">
              <span className="text-sm font-medium">Performance digest</span>
              <span className="text-xs text-muted-foreground">Realised P&L, win rate and open risk</span>
            </div>
            <ToggleGroup value={[v.digest]} onValueChange={(g) => g[0] && set("digest", g[0] as NotifyValues["digest"])} variant="outline" size="sm" spacing={0} aria-label="Digest frequency">
              <ToggleGroupItem value="off">Off</ToggleGroupItem>
              <ToggleGroupItem value="daily">Daily</ToggleGroupItem>
              <ToggleGroupItem value="weekly">Weekly</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </CardContent>
        <CardContent className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="outline" disabled={!formState.isDirty} onClick={() => reset()}>
            Discard
          </Button>
          <Button type="submit" disabled={!formState.isDirty}>
            Save preferences
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}

/* ---------------- Risk ---------------- */

const riskSchema = z.object({
  riskPct: z.number({ error: "Enter a number." }).min(0.1, "At least 0.1%.").max(3, "Keep risk per trade at 3% or below."),
  maxOpen: z.number({ error: "Enter a number." }).int("Whole positions only.").min(1, "At least 1.").max(10, "At most 10."),
  dailyLossStop: z.number({ error: "Enter a number." }).min(0, "Cannot be negative.").max(20, "20% or less."),
  trailToBreakeven: z.boolean(),
  extendedHours: z.boolean(),
  confirmLive: z.boolean(),
});
type RiskValues = z.infer<typeof riskSchema>;

function RiskForm({ features }: { features: SettingsProps["tenant"]["features"] }) {
  const { paperMode } = usePaperMode();
  const setPaperMode = useTerminalStore((s) => s.setPaperMode);
  const defaults = React.useMemo<RiskValues>(
    () => ({ riskPct: 1, maxOpen: ENGINE_DEFAULTS.maxOpen, dailyLossStop: 3, trailToBreakeven: ENGINE_DEFAULTS.trailToBreakeven, extendedHours: features.extendedHours, confirmLive: true }),
    [features.extendedHours],
  );
  const form = useForm<RiskValues>({ resolver: zodResolver(riskSchema), defaultValues: defaults });
  const { register, handleSubmit, formState, setValue, control, reset } = form;
  const watched = useWatch({ control });
  const v: RiskValues = { ...defaults, ...watched };
  const id = React.useId();
  const set = <K extends keyof RiskValues>(k: K, val: RiskValues[K]) => setValue(k, val as unknown as PathValue<RiskValues, K>, { shouldDirty: true });

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Risk</CardTitle>
        <CardDescription>Applied to every ticket. The engine stop is fixed at {ENGINE_DEFAULTS.atrStopMultiple} x ATR and the target at {ENGINE_DEFAULTS.rewardToRisk} R; these settings control how much you put behind each one.</CardDescription>
      </CardHeader>
      <form
        onSubmit={handleSubmit((values) => {
          toast.success("Risk settings saved", { description: `${values.riskPct}% per trade · max ${values.maxOpen} open · daily loss stop ${values.dailyLossStop}%` });
          reset(values);
        })}
        noValidate
      >
        <CardContent className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-risk`}>Risk per trade</Label>
              <div className="relative">
                <Input id={`${id}-risk`} type="number" step={0.1} min={0.1} max={3} className="font-mono tabular pr-8" {...register("riskPct", { valueAsNumber: true })} aria-invalid={!!formState.errors.riskPct} aria-describedby={`${id}-risk-err`} />
                <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">%</span>
              </div>
              <FieldError id={`${id}-risk-err`} message={formState.errors.riskPct?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-max`}>Max open positions</Label>
              <Input id={`${id}-max`} type="number" step={1} min={1} max={10} className="font-mono tabular" {...register("maxOpen", { valueAsNumber: true })} aria-invalid={!!formState.errors.maxOpen} aria-describedby={`${id}-max-err`} />
              <FieldError id={`${id}-max-err`} message={formState.errors.maxOpen?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-dls`}>Daily loss stop</Label>
              <div className="relative">
                <Input id={`${id}-dls`} type="number" step={0.5} min={0} max={20} className="font-mono tabular pr-8" {...register("dailyLossStop", { valueAsNumber: true })} aria-invalid={!!formState.errors.dailyLossStop} aria-describedby={`${id}-dls-err`} />
                <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">%</span>
              </div>
              <FieldError id={`${id}-dls-err`} message={formState.errors.dailyLossStop?.message} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">At 1% on a $100,000 account, a full stop-out costs $1,000. Quantity is capped so the position never exceeds 95% of cash.</p>
          <div className="divide-y">
            <SwitchRow id={`${id}-be`} label="Trail stop to breakeven" hint="Move the stop to entry once price reaches half the target" checked={v.trailToBreakeven} onChange={(c) => set("trailToBreakeven", c)} />
            <SwitchRow id={`${id}-ext`} label="Extended hours" hint={features.extendedHours ? "Limit orders 04:00 to 09:30 and 16:00 to 20:00 ET" : "Not enabled on your workspace plan"} checked={v.extendedHours && features.extendedHours} onChange={(c) => features.extendedHours && set("extendedHours", c)} />
            <SwitchRow id={`${id}-confirm`} label="Confirm before leaving paper mode" hint="Ask every time the paper switch is turned off" checked={v.confirmLive} onChange={(c) => set("confirmLive", c)} />
            <SwitchRow id={`${id}-paper`} label="Paper mode now" hint={paperMode ? "Tickets route to paper accounts" : "Tickets route to live accounts"} checked={paperMode} onChange={(c) => { setPaperMode(c); toast(c ? "Paper mode on" : "Live trading on"); }} />
          </div>
        </CardContent>
        <CardContent className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="outline" disabled={!formState.isDirty} onClick={() => reset()}>
            Discard
          </Button>
          <Button type="submit" disabled={!formState.isDirty}>
            Save risk settings
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}

/* ---------------- Security ---------------- */

const SESSIONS = [
  { id: "s1", device: "MacBook Pro · Chrome", where: "Jersey City, NJ", when: "Active now", current: true, icon: LaptopIcon },
  { id: "s2", device: "iPhone · Nasscord app", where: "Jersey City, NJ", when: "2 h ago", current: false, icon: SmartphoneIcon },
  { id: "s3", device: "Windows · Edge", where: "New York, NY", when: "Sep 27, 2026", current: false, icon: LaptopIcon },
];

function SecurityPanel({ email }: { email: string }) {
  const [sessions, setSessions] = React.useState(SESSIONS);
  const [confirmAll, setConfirmAll] = React.useState(false);
  return (
    <div className="grid max-w-2xl gap-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Two-factor authentication</CardTitle>
              <CardDescription>Required for every sign-in and before the first live order of the day.</CardDescription>
            </div>
            <Badge variant="secondary" className={TONE_BADGE.good}>
              <ShieldCheckIcon />
              Enabled
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="grid gap-0.5">
            <span>Authenticator app</span>
            <span className="text-xs text-muted-foreground">Backup codes: 8 of 10 unused</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => toast("Backup codes sent", { description: `A one-time link to view new codes was emailed to ${email}.` })}>
              New backup codes
            </Button>
            <Button variant="outline" size="sm" onClick={() => toast("Re-enrolment started", { description: "Scan the QR code in your authenticator app to replace the current device." })}>
              Change device
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Sessions</CardTitle>
              <CardDescription>Devices signed in to this workspace.</CardDescription>
            </div>
            <Button variant="destructive" size="sm" onClick={() => setConfirmAll(true)}>
              Sign out everywhere
            </Button>
          </div>
        </CardHeader>
        <CardContent className="divide-y">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-3 py-2.5">
              <s.icon className="size-4 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {s.device}
                  {s.current ? <span className="ml-2 text-xs font-normal text-primary">This device</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {s.where} · {s.when}
                </p>
              </div>
              {!s.current ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSessions((prev) => prev.filter((x) => x.id !== s.id));
                    toast.success(`Signed out ${s.device}`);
                  }}
                >
                  Sign out
                </Button>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign out of every device?</DialogTitle>
            <DialogDescription>All other sessions end immediately and broker tokens are kept, so orders and brackets stay working. You stay signed in here.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAll(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setSessions((prev) => prev.filter((s) => s.current));
                setConfirmAll(false);
                toast.success("Signed out everywhere else", { description: "Other devices will be asked to sign in again." });
              }}
            >
              Sign out everywhere
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------------- Billing ---------------- */

function BillingPanel({ plan: planId, tenantName }: { plan: PlanId; tenantName: string }) {
  const plan = getPlan(planId);
  const price = plan.monthly === null ? "Custom" : `${fmtMoney(plan.monthly, { digits: 0 })}/mo`;
  return (
    <div className="grid max-w-2xl gap-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>
                {plan.name} · {price}
              </CardTitle>
              <CardDescription>
                {tenantName} · {plan.tagline}
                {plan.monthly !== null && plan.monthly > 0 ? ` · next invoice Oct 30, 2026 for ${fmtMoney(plan.monthly, { digits: 0 })}` : ""}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" render={<Link href="/pricing" />}>
              Manage plan
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {plan.features.map((f) => (
            <p key={f} className="text-muted-foreground">
              {f}
            </p>
          ))}
          {plan.yearly !== null && plan.monthly !== null && plan.yearly < plan.monthly ? <p className="mt-2 text-xs text-muted-foreground">Switch to yearly billing for {fmtMoney(plan.yearly, { digits: 0 })}/mo, billed once a year.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment method</CardTitle>
          <CardDescription>Charged on the 30th of each month.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-sm">
            <span className="grid size-9 place-items-center rounded-lg bg-muted">
              <CreditCardIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <p className="font-medium">
                Visa ending <span className="font-mono">4417</span>
              </p>
              <p className="text-xs text-muted-foreground">Expires 08/2029</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => toast("Card update", { description: "A secure card form from the payment provider opens here." })}>
            Update card
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent className="divide-y text-sm">
          {[
            { id: "INV-2026-0927", date: "Sep 12, 2026", amount: plan.monthly ?? 0, status: "Paid" },
            { id: "INV-2026-0812", date: "Aug 12, 2026", amount: plan.monthly ?? 0, status: "Paid" },
            { id: "INV-2026-0712", date: "Jul 12, 2026", amount: plan.monthly ?? 0, status: "Paid" },
          ].map((inv) => (
            <div key={inv.id} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p className="font-mono text-xs">{inv.id}</p>
                <p className="text-xs text-muted-foreground">{inv.date}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono tabular">{fmtMoney(inv.amount)}</span>
                <Badge variant="secondary" className={TONE_BADGE.good}>
                  {inv.status}
                </Badge>
                <Button variant="ghost" size="sm" onClick={() => toast(`Downloading ${inv.id}.pdf`)}>
                  PDF
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
