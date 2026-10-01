"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Check, Copy, Download, KeyRound, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DEMO_NOW } from "@/lib/demo-clock";
import { fmtDate, timeAgo } from "@/lib/format";
import { copyText } from "./clipboard";
import { PROGRAM, useCurrentTenant } from "./current";
import { commissionFor } from "./program";
import { ControlRow, ErrorState, Field, FormSkeleton, KV, ToneBadge } from "./primitives";
import type { SettingsTab } from "./settings-tab";
import { fullKeyText, maskedKey, useTenantStore, type ApiKey, type Contacts, type NotificationKey } from "./store";

export function SettingsPage({ initialTab = "contacts" }: { initialTab?: SettingsTab }) {
  const { tenant, isLoading, isError } = useCurrentTenant();

  if (isError) return <ErrorState />;
  if (isLoading || !tenant) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <FormSkeleton fields={5} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Tabs defaultValue={initialTab} className="gap-4">
      <div className="overflow-x-auto">
        <TabsList aria-label="Settings sections">
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="api">API keys</TabsTrigger>
          <TabsTrigger value="legal">Legal</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="contacts">
        <ContactsTab />
      </TabsContent>
      <TabsContent value="notifications">
        <NotificationsTab />
      </TabsContent>
      <TabsContent value="api">
        <ApiKeysTab />
      </TabsContent>
      <TabsContent value="legal">
        <LegalTab tenantName={tenant.name} since={tenant.createdAt} commissionPct={commissionFor(tenant)} whiteLabel={tenant.whiteLabel} />
      </TabsContent>
    </Tabs>
  );
}

/* ---------------- Contacts ---------------- */

const contactsSchema = z.object({
  primaryName: z.string().trim().min(2, "Enter a name.").max(80, "Keep it under 80 characters."),
  primaryEmail: z.email("Enter a valid email."),
  billingEmail: z.email("Enter a valid email."),
  technicalEmail: z.email("Enter a valid email."),
  phone: z.string().trim().max(32, "Keep it under 32 characters.").optional().or(z.literal("")),
});
type ContactsValues = z.output<typeof contactsSchema>;

function ContactsTab() {
  const contacts = useTenantStore((s) => s.contacts);
  const setContacts = useTenantStore((s) => s.setContacts);
  const ids = { name: React.useId(), primary: React.useId(), billing: React.useId(), tech: React.useId(), phone: React.useId() };
  const form = useForm<ContactsValues>({ resolver: zodResolver(contactsSchema), defaultValues: contacts });
  const { errors, isSubmitting, isDirty } = form.formState;

  async function onSubmit(v: ContactsValues) {
    await new Promise((r) => setTimeout(r, 400));
    const next: Contacts = { ...v, phone: v.phone ?? "" };
    setContacts(next);
    form.reset(next);
    toast.success("Contacts saved", { description: "Payout notices go to billing; incident notices go to the technical contact." });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contacts</CardTitle>
        <CardDescription>Who we write to about payouts, invoices and platform incidents.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4 sm:grid-cols-2">
          <Field id={ids.name} label="Primary contact" error={errors.primaryName?.message}>
            <Input id={ids.name} autoComplete="name" aria-invalid={!!errors.primaryName} {...form.register("primaryName")} />
          </Field>
          <Field id={ids.primary} label="Primary email" error={errors.primaryEmail?.message}>
            <Input id={ids.primary} type="email" autoComplete="email" aria-invalid={!!errors.primaryEmail} {...form.register("primaryEmail")} />
          </Field>
          <Field id={ids.billing} label="Billing email" hint="Receives invoices and payout notices." error={errors.billingEmail?.message}>
            <Input id={ids.billing} type="email" autoComplete="off" aria-invalid={!!errors.billingEmail} {...form.register("billingEmail")} />
          </Field>
          <Field id={ids.tech} label="Technical contact" hint="Receives incident and DNS notices." error={errors.technicalEmail?.message}>
            <Input id={ids.tech} type="email" autoComplete="off" aria-invalid={!!errors.technicalEmail} {...form.register("technicalEmail")} />
          </Field>
          <Field id={ids.phone} label="Phone (optional)" error={errors.phone?.message}>
            <Input id={ids.phone} type="tel" autoComplete="tel" aria-invalid={!!errors.phone} {...form.register("phone")} />
          </Field>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={isSubmitting || !isDirty}>
              {isSubmitting ? "Saving" : "Save contacts"}
            </Button>
            <Button type="button" variant="ghost" disabled={!isDirty} onClick={() => form.reset()}>
              Discard
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ---------------- Notifications ---------------- */

const NOTIFICATIONS: Array<{ key: NotificationKey; label: string; help: string }> = [
  { key: "payoutSent", label: "Payout sent", help: "The day an ACH transfer leaves, with the statement attached." },
  { key: "newConversion", label: "New paid conversion", help: "A referred trader picks a paid plan." },
  { key: "traderPastDue", label: "Trader past due", help: "One of your trader workspaces misses an invoice." },
  { key: "domainChanges", label: "Domain and certificate changes", help: "DNS verification results and certificate renewals." },
  { key: "weeklyDigest", label: "Weekly digest", help: "Clicks, signups and conversions every Monday morning." },
];

function NotificationsTab() {
  const prefs = useTenantStore((s) => s.notifications);
  const setNotification = useTenantStore((s) => s.setNotification);
  const ids = React.useId();
  const enabled = Object.values(prefs).filter(Boolean).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Emails go to the primary contact. {enabled} of {NOTIFICATIONS.length} enabled.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border">
          {NOTIFICATIONS.map((n) => (
            <ControlRow key={n.key} id={`${ids}-${n.key}`} label={n.label} help={n.help}>
              <Switch
                id={`${ids}-${n.key}`}
                checked={prefs[n.key]}
                aria-describedby={`${ids}-${n.key}-help`}
                onCheckedChange={(on) => {
                  setNotification(n.key, on);
                  toast.success(`${n.label} ${on ? "on" : "off"}`);
                }}
              />
            </ControlRow>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ---------------- API keys ---------------- */

function ApiKeysTab() {
  const keys = useTenantStore((s) => s.apiKeys);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>Read-only reporting keys for your data warehouse and SSO provisioning. Rotate a key any time; the old one keeps working for 24 hours.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                    <KeyRound className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {k.label}
                      <ToneBadge tone={k.scope === "trade" ? "warn" : "neutral"}>{k.scope === "trade" ? "Trade" : "Read-only"}</ToneBadge>
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{maskedKey(k)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    Created {fmtDate(k.createdAt)}
                    {k.lastUsedAt ? ` · used ${timeAgo(k.lastUsedAt, DEMO_NOW)}` : " · never used"}
                  </span>
                  <RotateKeyDialog apiKey={k} />
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function RotateKeyDialog({ apiKey }: { apiKey: ApiKey }) {
  const rotateKey = useTenantStore((s) => s.rotateKey);
  const [open, setOpen] = React.useState(false);
  const [revealed, setRevealed] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  function onOpenChange(o: boolean) {
    setOpen(o);
    if (!o) {
      setRevealed(null);
      setCopied(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <RefreshCw data-icon="inline-start" />
        Rotate
      </DialogTrigger>
      <DialogContent>
        {revealed ? (
          <>
            <DialogHeader>
              <DialogTitle>New key for {apiKey.label}</DialogTitle>
              <DialogDescription>Copy it now. For security we show the full key only once; the previous key stops working in 24 hours.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-input bg-muted/40 px-2.5 py-1.5 font-mono text-xs">{revealed}</code>
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy new key"
                onClick={async () => {
                  const ok = await copyText(revealed);
                  if (ok) {
                    setCopied(true);
                    toast.success("Key copied");
                  } else toast.error("Could not copy automatically", { description: "Select the key and copy it by hand." });
                }}
              >
                {copied ? <Check className="text-gain-foreground" /> : <Copy />}
              </Button>
            </div>
            <DialogFooter>
              <DialogClose render={<Button />}>Done</DialogClose>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Rotate {apiKey.label}?</DialogTitle>
              <DialogDescription>
                A new key is issued immediately. <span className="font-mono">{maskedKey(apiKey)}</span> keeps working for 24 hours so you can switch integrations without downtime.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button
                onClick={() => {
                  const next = rotateKey(apiKey.id);
                  setRevealed(fullKeyText(next));
                  toast.success(`${apiKey.label} rotated`, { description: "The old key expires in 24 hours." });
                }}
              >
                Rotate key
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Legal ---------------- */

function LegalTab({ tenantName, since, commissionPct, whiteLabel }: { tenantName: string; since: string; commissionPct: number; whiteLabel: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const noteId = React.useId();

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Agreement summary</CardTitle>
          <CardDescription>Plain-language summary of the Nasscord Tenant Agreement between Nasscord, Inc. and {tenantName}. The signed PDF governs.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <KV
            items={[
              { label: "Agreement", value: "Nasscord Tenant Agreement v2.3" },
              { label: "White-label", value: whiteLabel ? "Granted by Nasscord" : "Not included, ask Nasscord to turn it on" },
              { label: "Effective date", value: fmtDate(since) },
              { label: "Term", value: "12 months, renews automatically" },
              { label: "Commission", value: `${commissionPct}% of your traders' subscription revenue, lifetime` },
              ...(whiteLabel ? [{ label: "Platform fee", value: `$${PROGRAM.platformFee}/mo plus $${PROGRAM.perSeat} per active seat` }] : []),
              { label: "Payout terms", value: `${PROGRAM.payoutDay}th of the month, ACH, $${PROGRAM.minimumPayout} minimum` },
              { label: "Termination", value: "Either party, 30 days written notice" },
              { label: "Governing law", value: "Delaware" },
            ]}
          />
          <ul className="grid gap-1.5 text-sm text-muted-foreground">
            <li>Nasscord holds the broker connections, order engine and infrastructure. You may not present Nasscord as a broker or as investment advice.</li>
            <li>Commission is earned once a referred trader has paid; refunds and chargebacks are netted against the next payout.</li>
            <li>{whiteLabel ? "You own your brand and your customer relationships; Nasscord processes trader data on your behalf under the DPA." : "Attribution runs from first visit to paid plan within a 90-day window and follows the trader across devices."}</li>
            <li>Marketing claims about TradeScope performance must use the published backtest figures without alteration.</li>
          </ul>
        </CardContent>
      </Card>
      <Card className="self-start">
        <CardHeader>
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Button variant="outline" className="justify-start" onClick={() => toast.success("Downloading Tenant Agreement v2.3", { description: "Signed PDF, 14 pages." })}>
            <Download data-icon="inline-start" />
            Tenant Agreement (PDF)
          </Button>
          <Button variant="outline" className="justify-start" onClick={() => toast.success("Downloading Data Processing Addendum", { description: "Signed PDF, 6 pages." })}>
            <Download data-icon="inline-start" />
            Data Processing Addendum
          </Button>
          <Dialog
            open={open}
            onOpenChange={(o) => {
              setOpen(o);
              if (!o) setNote("");
            }}
          >
            <DialogTrigger render={<Button variant="ghost" className="justify-start" />}>Request an amendment</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Request an amendment</DialogTitle>
                <DialogDescription>Describe the change you need. Nasscord replies to your primary contact within two business days.</DialogDescription>
              </DialogHeader>
              <Field id={noteId} label="What should change?">
                <Textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Example: extend the notice period to 60 days for the white-label term." rows={4} />
              </Field>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                <Button
                  disabled={note.trim().length < 10}
                  onClick={() => {
                    setOpen(false);
                    setNote("");
                    toast.success("Amendment request sent", { description: "Reference AMD-2026-0142. We will reply to your primary contact." });
                  }}
                >
                  Send request
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  );
}
