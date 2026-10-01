"use client";

import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { fmtDate } from "@/lib/format";
import { ControlRow, SectionTitle } from "./primitives";
import { PLATFORM_DOMAIN } from "./lib";

const SESSION_ITEMS = [
  { value: "8h", label: "8 hours" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  scope: string;
  createdAt: string;
  lastUsedAt?: string;
}

const INITIAL_KEYS: ApiKey[] = [
  { id: "key_live", label: "Production", prefix: "nsk_live_4f8a", scope: "alerts:read orders:write positions:read", createdAt: "2026-03-01T00:00:00Z", lastUsedAt: "2026-09-30T18:51:00Z" },
  { id: "key_partner", label: "Partner embed (Fintech Lab)", prefix: "nsk_live_9c21", scope: "alerts:read positions:read", createdAt: "2026-05-19T00:00:00Z", lastUsedAt: "2026-09-30T17:02:00Z" },
  { id: "key_test", label: "Sandbox", prefix: "nsk_test_77d0", scope: "all (paper only)", createdAt: "2026-06-10T00:00:00Z" },
];

const TEMPLATES = [
  { id: "otp", name: "Sign-in code", subject: "Your {{brand}} sign-in code", updatedAt: "2026-08-12T00:00:00Z" },
  { id: "alert", name: "TradeScope alert", subject: "{{symbol}} setup · score {{score}}", updatedAt: "2026-09-02T00:00:00Z" },
  { id: "invoice", name: "Invoice issued", subject: "Invoice {{number}} from {{brand}}", updatedAt: "2026-07-21T00:00:00Z" },
  { id: "invite", name: "Workspace invitation", subject: "{{inviter}} invited you to {{tenant}}", updatedAt: "2026-06-30T00:00:00Z" },
  { id: "suspend", name: "Workspace suspended", subject: "Action needed on your {{brand}} account", updatedAt: "2026-05-14T00:00:00Z" },
];

export function SettingsPage() {
  return (
    <Tabs defaultValue="general" className="gap-4">
      <TabsList variant="line" className="w-full justify-start overflow-x-auto">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="branding">Branding defaults</TabsTrigger>
        <TabsTrigger value="security">Security</TabsTrigger>
        <TabsTrigger value="api">API keys</TabsTrigger>
        <TabsTrigger value="email">Email</TabsTrigger>
      </TabsList>
      <TabsContent value="general">
        <GeneralTab />
      </TabsContent>
      <TabsContent value="branding">
        <BrandingTab />
      </TabsContent>
      <TabsContent value="security">
        <SecurityTab />
      </TabsContent>
      <TabsContent value="api">
        <ApiKeysTab />
      </TabsContent>
      <TabsContent value="email">
        <EmailTab />
      </TabsContent>
    </Tabs>
  );
}

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

function GeneralTab() {
  const [name, setName] = React.useState("Nasscord");
  const [domain, setDomain] = React.useState(PLATFORM_DOMAIN);
  const [support, setSupport] = React.useState("support@nasscord.com");
  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Platform identity used wherever a tenant has no white-label override.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-xl gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            toast.success("General settings saved");
          }}
        >
          <Field id="set-name" label="Platform name">
            <Input id="set-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field id="set-domain" label="Apex domain" help="Tenant workspaces live on subdomains; white-label tenants CNAME to edge.">
            <Input id="set-domain" value={domain} className="font-mono" onChange={(e) => setDomain(e.target.value)} />
          </Field>
          <Field id="set-support" label="Support email" help="Shown in the terminal footer and in transactional emails.">
            <Input id="set-support" type="email" value={support} onChange={(e) => setSupport(e.target.value)} />
          </Field>
          <div>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function BrandingTab() {
  const [tagline, setTagline] = React.useState("One terminal for every broker.");
  const [footer, setFooter] = React.useState("Nasscord is a software platform, not a broker-dealer. Orders execute at your broker under your agreement with them.");
  const [darkDefault, setDarkDefault] = React.useState(true);
  const [showBrokerMarks, setShowBrokerMarks] = React.useState(true);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Branding defaults</CardTitle>
        <CardDescription>Applied to every tenant without its own white-label settings. Accent colors come from the design tokens and are overridden per tenant.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-xl gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            toast.success("Branding defaults saved", { description: "Tenants without overrides pick this up on next load." });
          }}
        >
          <Field id="brand-tagline" label="Tagline">
            <Input id="brand-tagline" value={tagline} onChange={(e) => setTagline(e.target.value)} />
          </Field>
          <Field id="brand-footer" label="Regulatory footer" help="Appears under every terminal page and in alert emails.">
            <Textarea id="brand-footer" rows={3} value={footer} onChange={(e) => setFooter(e.target.value)} />
          </Field>
          <div className="divide-y divide-border border-t">
            <ControlRow id="brand-dark" label="Dark theme by default" help="New seats start in dark mode; they can switch any time.">
              <Switch id="brand-dark" checked={darkDefault} onCheckedChange={setDarkDefault} />
            </ControlRow>
            <ControlRow id="brand-marks" label="Show broker monograms" help="Broker tiles next to accounts and positions. Some white-label partners prefer text only.">
              <Switch id="brand-marks" checked={showBrokerMarks} onCheckedChange={setShowBrokerMarks} />
            </ControlRow>
          </div>
          <div>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SecurityTab() {
  const [require2fa, setRequire2fa] = React.useState(true);
  const [session, setSession] = React.useState("24h");
  const [ipAllow, setIpAllow] = React.useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Security</CardTitle>
        <CardDescription>Applies to operator accounts on this console. Tenant security is set per workspace.</CardDescription>
      </CardHeader>
      <CardContent className="grid max-w-xl gap-4">
        <div className="divide-y divide-border">
          <ControlRow id="sec-2fa" label="Require 2FA for all operators" help="Operators without an authenticator are prompted to enroll at next sign-in.">
            <Switch
              id="sec-2fa"
              checked={require2fa}
              onCheckedChange={(on) => {
                setRequire2fa(on);
                toast.success(on ? "2FA required for operators" : "2FA no longer required", { description: on ? "1 operator will be prompted to enroll." : "Not recommended for production." });
              }}
            />
          </ControlRow>
          <ControlRow id="sec-ip" label="Restrict console to office IPs" help="Allowlist 73.0.0.0/8 and the VPN egress. Everyone else sees a 403.">
            <Switch
              id="sec-ip"
              checked={ipAllow}
              onCheckedChange={(on) => {
                setIpAllow(on);
                toast.success(on ? "IP allowlist enabled" : "IP allowlist disabled");
              }}
            />
          </ControlRow>
        </div>
        <Field id="sec-session" label="Session lifetime" help="Idle operator sessions expire after this period.">
          <Select
            items={SESSION_ITEMS}
            value={session}
            onValueChange={(v) => {
              if (!v) return;
              setSession(v);
              toast.success(`Session lifetime set to ${SESSION_ITEMS.find((s) => s.value === v)?.label}`);
            }}
          >
            <SelectTrigger id="sec-session" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SESSION_ITEMS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}

function ApiKeysTab() {
  const [keys, setKeys] = React.useState<ApiKey[]>(INITIAL_KEYS);
  const [pending, setPending] = React.useState<ApiKey | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>Keys are shown once at creation. Rotating a key invalidates the old one after a 15-minute grace period.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="grid min-w-0 gap-0.5">
                <span className="text-sm font-medium">{k.label}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {k.prefix}
                  {"•".repeat(20)}
                </span>
                <span className="text-xs text-muted-foreground">
                  Scope {k.scope} · created {fmtDate(k.createdAt)}
                  {k.lastUsedAt ? ` · last used ${fmtDate(k.lastUsedAt)}` : " · never used"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {k.prefix.startsWith("nsk_test") ? <Badge variant="outline">Sandbox</Badge> : <Badge variant="secondary" className="bg-brand-soft text-primary">Live</Badge>}
                <Button variant="outline" size="sm" onClick={() => setPending(k)}>
                  Rotate
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-3 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => toast("Key creation is done from the embedded partner's record", { description: "Partners > partner > API access." })}>
            Create key
          </Button>
        </div>
      </CardContent>

      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate {pending?.label}?</DialogTitle>
            <DialogDescription>A new key is issued now. The current key ({pending?.prefix}…) keeps working for 15 minutes so integrations can swap without downtime.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!pending) return;
                const suffix = Math.random().toString(16).slice(2, 6);
                const prefix = pending.prefix.replace(/[0-9a-f]{4}$/, suffix);
                setKeys((ks) => ks.map((k) => (k.id === pending.id ? { ...k, prefix, createdAt: new Date().toISOString(), lastUsedAt: undefined } : k)));
                setPending(null);
                toast.success(`${pending.label} rotated`, { description: `New key ${prefix}… copied to clipboard. Old key expires in 15 minutes.` });
              }}
            >
              Rotate key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function EmailTab() {
  const [sender, setSender] = React.useState("Nasscord <alerts@mail.nasscord.com>");
  const [reply, setReply] = React.useState("support@nasscord.com");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>Transactional sender and templates. White-label tenants substitute their own brand and sender domain.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <form
          className="grid max-w-xl gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            toast.success("Sender settings saved", { description: "SPF and DKIM verified for mail.nasscord.com." });
          }}
        >
          <Field id="mail-sender" label="Sender" help="Must be on a verified sending domain.">
            <Input id="mail-sender" value={sender} onChange={(e) => setSender(e.target.value)} />
          </Field>
          <Field id="mail-reply" label="Reply-to">
            <Input id="mail-reply" type="email" value={reply} onChange={(e) => setReply(e.target.value)} />
          </Field>
          <div>
            <Button type="submit">Save</Button>
          </div>
        </form>
        <div className="grid gap-2">
          <SectionTitle>Templates</SectionTitle>
          <ul className="divide-y divide-border">
            {TEMPLATES.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="grid min-w-0 gap-0.5">
                  <span className="text-sm font-medium">{t.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{t.subject}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Updated {fmtDate(t.updatedAt)}</span>
                  <Button variant="outline" size="sm" onClick={() => toast(`Test ${t.name.toLowerCase()} sent to ops@nasscord.com`)}>
                    Send test
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => toast("Template editor opens in the mail service", { description: `${t.id}.mjml · last deploy ${fmtDate(t.updatedAt)}` })}>
                    Edit
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
