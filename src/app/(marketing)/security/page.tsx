import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SHELL_AREAS } from "@/lib/nav";
import { ROLES, ROLE_DESCRIPTION, ROLE_LABEL, areasForRole } from "@/lib/roles";
import { Container, Section, SectionHead } from "@/components/marketing/container";
import { CtaBand } from "@/components/marketing/cta-band";
import { SecurityControlDetails, SOFTWARE_DISCLAIMER } from "@/components/marketing/security-controls";

export const metadata: Metadata = {
  title: "Security",
  description: "How Nasscord isolates broker connections, verifies orders, handles data and secures accounts. Plain statements, no certification claims. Terms and privacy summaries.",
};

const PIPELINE = [
  { name: "Browser or mobile app", note: "Your session, 2FA, no broker credentials" },
  { name: "Nasscord web tier", note: "Workspace and brand resolution, auth, audit log" },
  { name: "Proxy", note: "Strips forwarding headers so browser and keepalive share one session" },
  { name: "Gateway process (per login)", note: "Holds the decrypted broker token in memory only" },
  { name: "Broker API", note: "Orders, positions, balances; custody stays here" },
];

const ISOLATION = [
  {
    title: "Dedicated gateway process per login",
    body: "Every login that connects Interactive Brokers gets its own Client Portal gateway process. Processes are pooled per workspace, never across workspaces, and a white-label tenant gets a pool of its own for its traders.",
  },
  {
    title: "Proxy keeps one session",
    body: "A reverse proxy in front of each gateway strips X-Forwarded-For and related headers. The browser and the keepalive worker therefore present as the same client and share one broker session instead of invalidating each other.",
  },
  {
    title: "Session init throttled",
    body: "The gateway's ssodh/init call is throttled to once per minute per session. Reconnect storms cannot hammer the broker, and a flapping network degrades to a visible Expiring state rather than repeated logins.",
  },
  {
    title: "Orders verified in the order book",
    body: "After an order is submitted and the broker's confirmation prompts are answered, the engine polls the live order list for the returned id and checks symbol, side, quantity and price before it reports success.",
  },
];

const STORE = [
  "Your name, email, hashed password and 2FA secret",
  "Encrypted broker refresh tokens and gateway session cookies, per workspace key",
  "Which accounts you connected, masked account numbers and their inclusion in the combined book",
  "Orders you placed through Nasscord, their verification results and fills",
  "Alert history and your settings",
  "An audit log of actions with actor, time, IP and result",
];

const NEVER = [
  "Broker passwords or second-factor codes",
  "Full account numbers (only the broker's masked form)",
  "Bank details, Social Security numbers or tax documents",
  "Card numbers (handled by the payment processor)",
  "Positions or balances from accounts you did not connect",
];

const ACCOUNT = [
  { title: "Two-factor authentication", body: "Time-based one-time codes on every account. A Desk workspace can require it for every seat. Recovery codes are shown once at setup." },
  { title: "Session expiry", body: "Web sessions expire after 12 hours of inactivity and are revoked when the password changes. Mobile sessions are bound to the device and revocable from Settings." },
  { title: "New device notices", body: "A sign-in from a device we have not seen sends an email with the time, approximate location and a one-click revoke link." },
  { title: "Roles", body: "Every login has exactly one of four roles, and the role decides which areas it can open. A tenant's login never opens the terminal, and only the super admin opens the console." },
];

export default function SecurityPage() {
  return (
    <>
      <Section className="pt-12 sm:pt-20">
        <Container className="grid gap-6">
          <SectionHead
            as="h1"
            eyebrow="Security"
            title="Built like infrastructure."
            lede="This page describes how the system behaves. It makes no certification claims; it states controls you can check against the terminal."
            className="mb-0 sm:mb-0"
          />
          <p className="max-w-2xl text-sm font-medium">{SOFTWARE_DISCLAIMER}</p>
        </Container>
      </Section>

      <Section className="bg-card/40">
        <Container className="grid gap-8">
          <SectionHead eyebrow="Controls" title="Eight controls, in detail." className="mb-0 sm:mb-0" />
          <SecurityControlDetails />
        </Container>
      </Section>

      <Section id="isolation">
        <Container className="grid gap-10">
          <SectionHead eyebrow="Architecture" title="How the broker connection is isolated." lede="The path an order takes, and the four properties that hold along it." className="mb-0 sm:mb-0" />
          <ol className="grid gap-2 sm:grid-cols-5 sm:gap-0" aria-label="Request path">
            {PIPELINE.map((step, i) => (
              <li key={step.name} className="flex items-stretch gap-2 sm:contents">
                <div className="grid flex-1 content-start gap-1 rounded-lg border border-border bg-card p-3">
                  <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">Step {i + 1}</span>
                  <span className="text-sm font-semibold">{step.name}</span>
                  <span className="text-xs leading-relaxed text-muted-foreground">{step.note}</span>
                </div>
                {i < PIPELINE.length - 1 ? (
                  <span aria-hidden="true" className="hidden items-center px-1 text-muted-foreground sm:flex">
                    <ArrowRight className="size-4" />
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="grid gap-4 md:grid-cols-2">
            {ISOLATION.map((item) => (
              <Card key={item.title} className="gap-3">
                <CardHeader>
                  <CardTitle className="text-base font-semibold">{item.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-relaxed text-muted-foreground">{item.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </Container>
      </Section>

      <Section id="data" className="bg-card/40">
        <Container className="grid gap-8">
          <SectionHead eyebrow="Data handling" title="What we store, and what we never store." className="mb-0 sm:mb-0" />
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="gap-4">
              <CardHeader>
                <CardTitle className="text-base font-semibold">What we store</CardTitle>
                <CardDescription>Encrypted at rest, in a US region, with per-workspace keys for broker material.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-2 text-sm text-muted-foreground">
                  {STORE.map((s) => (
                    <li key={s} className="flex gap-2">
                      <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                      {s}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
            <Card className="gap-4">
              <CardHeader>
                <CardTitle className="text-base font-semibold">What we never store</CardTitle>
                <CardDescription>If it is not on this list and not on the left, we do not have it.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-2 text-sm text-muted-foreground">
                  {NEVER.map((s) => (
                    <li key={s} className="flex gap-2">
                      <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                      {s}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Deleting your account removes broker tokens immediately and the rest of your data within 30 days. Order and audit records required for
            regulatory retention are kept in an isolated archive for the period the rules require and nothing longer.
          </p>
        </Container>
      </Section>

      <Section id="account">
        <Container className="grid gap-8">
          <SectionHead eyebrow="Account security" title="Your Nasscord account." className="mb-0 sm:mb-0" />
          <dl className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
            {ACCOUNT.map((a) => (
              <div key={a.title} className="grid gap-1">
                <dt className="text-sm font-semibold">{a.title}</dt>
                <dd className="text-sm leading-relaxed text-muted-foreground">{a.body}</dd>
              </div>
            ))}
          </dl>
          <div id="roles" className="grid gap-4 border-t border-border pt-8">
            <h3 className="text-base font-semibold">The four roles</h3>
            <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              {ROLES.map((role) => (
                <div key={role} className="grid gap-1">
                  <dt className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
                    {ROLE_LABEL[role]}
                    <span className="text-xs font-normal text-muted-foreground">Opens {areasForRole(role).map((a) => SHELL_AREAS[a].title.toLowerCase()).join(", ")}</span>
                  </dt>
                  <dd className="text-sm leading-relaxed text-muted-foreground">{ROLE_DESCRIPTION[role]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Container>
      </Section>

      <Section id="disclosure" className="bg-card/40">
        <Container className="grid gap-4">
          <SectionHead eyebrow="Responsible disclosure" title="Found something?" className="mb-0 sm:mb-0" />
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Email <span className="font-mono text-foreground">security@nasscord.com</span> with steps to reproduce. We acknowledge within two business days, keep you
            updated while we fix it and credit you if you want to be credited. Please do not test against accounts you do not own, and give us a reasonable
            window before publishing.
          </p>
        </Container>
      </Section>

      <Section id="legal">
        <Container className="grid gap-8">
          <SectionHead eyebrow="Legal" title="Terms and privacy, summarized." lede="Summaries for orientation only. The full documents are shown at signup and available on request." className="mb-0 sm:mb-0" />
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="gap-4">
              <CardHeader>
                <CardTitle className="text-base font-semibold">Terms of service</CardTitle>
                <CardDescription>Summary</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-2 text-sm leading-relaxed text-muted-foreground">
                  <li>Nasscord is software. It is not a broker-dealer or investment adviser and does not hold your assets or execute trades on its own behalf.</li>
                  <li>Alerts are information, not recommendations. You decide what to trade and you carry the risk of every order you place.</li>
                  <li>Subscriptions bill monthly or yearly in USD and can be cancelled at any time; the plan stays active until the period ends.</li>
                  <li>You may not use the service to violate a broker&apos;s terms, to trade on behalf of others without authority, or to attack the platform.</li>
                  <li>Either party can end the agreement; we give 30 days notice for material changes to these terms.</li>
                </ul>
              </CardContent>
            </Card>
            <Card className="gap-4">
              <CardHeader>
                <CardTitle className="text-base font-semibold">Privacy policy</CardTitle>
                <CardDescription>Summary</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-2 text-sm leading-relaxed text-muted-foreground">
                  <li>We collect what the data handling section above lists, and only to run the service, bill you and keep the audit log.</li>
                  <li>We do not sell personal data and do not share broker data with anyone except the broker it came from and the aggregator you authorized.</li>
                  <li>Payment processing, email delivery and error monitoring use vendors under data processing agreements.</li>
                  <li>You can export or delete your data from Settings. Deletion removes broker tokens immediately.</li>
                  <li>White-label tenants are controllers of their traders&apos; data; Nasscord processes it on their instructions.</li>
                </ul>
              </CardContent>
            </Card>
          </div>
        </Container>
      </Section>

      <CtaBand title="Read the controls, then connect a broker." lede="Everything on this page is visible in the terminal: the audit log, the verification step, the connection status." />
    </>
  );
}
