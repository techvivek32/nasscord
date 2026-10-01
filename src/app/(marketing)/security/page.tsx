import type { Metadata } from "next";
import { ArrowRight, Mail } from "lucide-react";
import { SHELL_AREAS } from "@/lib/nav";
import { ROLES, ROLE_DESCRIPTION, ROLE_LABEL, areasForRole } from "@/lib/roles";
import { Container, PageHero, PaperCard, Section, SectionHead } from "@/components/marketing/container";
import { CtaBand } from "@/components/marketing/cta-band";
import { reveal } from "@/components/marketing/motion";
import { RequestPath } from "@/components/marketing/page-visuals";
import { SecurityControlDetails, SOFTWARE_DISCLAIMER } from "@/components/marketing/security-controls";

export const metadata: Metadata = {
  title: "Security",
  description: "How Nasscord isolates broker connections, verifies orders, handles data and secures accounts. Plain statements, no certification claims. Terms and privacy summaries.",
};

const PIPELINE = [
  { name: "Browser, desktop or phone", note: "Your session, 2FA, no broker credentials" },
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
  { title: "Session expiry", body: "Sessions expire after 12 hours of inactivity and are revoked when the password changes. Every signed-in device is listed in Settings, where you can sign it out, or sign out everywhere at once." },
  { title: "New device notices", body: "A sign-in from a device we have not seen sends an email with the time, approximate location and a one-click revoke link." },
  { title: "Roles", body: "Every login has exactly one of four roles, and the role decides which areas it can open. A tenant's login never opens the terminal, and only the super admin opens the console." },
];

export default function SecurityPage() {
  return (
    <>
      <PageHero
        eyebrow="Security"
        title={
          <>
            Built like <em>infrastructure</em>.
          </>
        }
        lede="This page describes how the system behaves. It makes no certification claims; it states controls you can check against the terminal."
        aside={<RequestPath steps={PIPELINE} />}
      >
        <p className="max-w-xl border-l-2 border-site-accent py-1 pl-4 font-medium">{SOFTWARE_DISCLAIMER}</p>
      </PageHero>

      <Section>
        <Container className="grid gap-12">
          <SectionHead index={1} eyebrow="Controls" title={<>Eight controls, in <em>detail</em>.</>} className="mb-0 sm:mb-0" />
          <SecurityControlDetails />
        </Container>
      </Section>

      <Section id="isolation" tone="band">
        <Container className="grid gap-14">
          <SectionHead index={2} eyebrow="Architecture" title={<>How the broker connection is <em>isolated</em>.</>} lede="The path an order takes, and the four properties that hold along it." className="mb-0 sm:mb-0" />
          <ol className="grid border-t border-foreground sm:grid-cols-5" aria-label="Request path">
            {PIPELINE.map((step, i) => (
              <li key={step.name} className="group/pipe relative grid content-start gap-2 border-b border-border py-5 transition-colors hover:bg-site-raised sm:border-b-0 sm:border-l sm:px-4 sm:first:border-l-0 sm:first:pl-0" {...reveal(i * 90)}>
                <span className="flex items-center justify-between font-mono text-xs text-site-accent-ink">
                  Step {String(i + 1).padStart(2, "0")}
                  {i < PIPELINE.length - 1 ? <ArrowRight aria-hidden="true" className="hidden size-3.5 text-foreground transition-transform group-hover/pipe:translate-x-1 sm:block" /> : null}
                </span>
                <span className="font-serif text-2xl leading-tight">{step.name}</span>
                <span className="text-sm leading-relaxed text-muted-foreground">{step.note}</span>
              </li>
            ))}
          </ol>
          <div className="grid border-t border-foreground md:grid-cols-2">
            {ISOLATION.map((item, i) => (
              <div key={item.title} className={`grid gap-2 border-b border-border py-6 ${i % 2 === 1 ? "md:border-l md:pl-8" : "md:pr-8"}`} {...reveal((i % 2) * 100)}>
                <h3 className="text-3xl leading-tight">{item.title}</h3>
                <p className="leading-relaxed text-muted-foreground">{item.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <Section id="data">
        <Container className="grid gap-12">
          <SectionHead index={3} eyebrow="Data handling" title={<>What we store, and what we <em>never</em> store.</>} className="mb-0 sm:mb-0" />
          <div className="grid gap-6 md:grid-cols-2">
            <PaperCard className="p-6 sm:p-8" {...reveal(0, "scale")}>
              <h3 className="text-3xl">What we store</h3>
              <p className="mt-2 text-sm text-muted-foreground">Encrypted at rest, in a US region, with per-workspace keys for broker material.</p>
              <ul className="mt-5 border-t border-foreground">
                {STORE.map((s) => (
                  <li key={s} className="flex gap-3 border-b border-border py-3 text-sm">
                    <span aria-hidden="true" className="mt-[0.45rem] size-1.5 shrink-0 bg-site-accent" />
                    {s}
                  </li>
                ))}
              </ul>
            </PaperCard>
            <PaperCard className="p-6 sm:p-8" {...reveal(100, "scale")}>
              <h3 className="text-3xl">
                What we <em className="italic">never</em> store
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">If it is not on this list and not on the left, we do not have it.</p>
              <ul className="mt-5 border-t border-foreground">
                {NEVER.map((s) => (
                  <li key={s} className="flex gap-3 border-b border-border py-3 text-sm">
                    <span aria-hidden="true" className="mt-[0.45rem] size-1.5 shrink-0 bg-site-accent" />
                    {s}
                  </li>
                ))}
              </ul>
            </PaperCard>
          </div>
          <p className="max-w-2xl leading-relaxed text-muted-foreground">
            Deleting your account removes broker tokens immediately and the rest of your data within 30 days. Order and audit records required for
            regulatory retention are kept in an isolated archive for the period the rules require and nothing longer.
          </p>
        </Container>
      </Section>

      <Section id="account" tone="band">
        <Container className="grid gap-12">
          <SectionHead index={4} eyebrow="Account security" title={<>Your Nasscord <em>account</em>.</>} className="mb-0 sm:mb-0" />
          <dl className="grid border-t border-foreground sm:grid-cols-2">
            {ACCOUNT.map((a, i) => (
              <div key={a.title} className={`grid gap-2 border-b border-border py-6 ${i % 2 === 1 ? "sm:border-l sm:pl-8" : "sm:pr-8"}`} {...reveal((i % 2) * 100)}>
                <dt className="text-2xl font-serif">{a.title}</dt>
                <dd className="leading-relaxed text-muted-foreground">{a.body}</dd>
              </div>
            ))}
          </dl>
          <div id="roles" className="grid scroll-mt-24 gap-6">
            <h3 className="site-label" {...reveal()}>
              The four roles
            </h3>
            <dl className="grid border-t border-foreground sm:grid-cols-2 lg:grid-cols-4">
              {ROLES.map((role, i) => (
                <div key={role} className="grid content-start gap-2 border-b border-border py-6 lg:border-b-0 lg:border-l lg:px-5 lg:first:border-l-0 lg:first:pl-0" {...reveal(i * 80)}>
                  <dt className="grid gap-1">
                    <span className="font-mono text-xs text-site-accent-ink">R/{String(i + 1).padStart(2, "0")}</span>
                    <span className="font-serif text-3xl">{ROLE_LABEL[role]}</span>
                    <span className="font-mono text-[0.7rem] text-muted-foreground">Opens {areasForRole(role).map((a) => SHELL_AREAS[a].title.toLowerCase()).join(", ")}</span>
                  </dt>
                  <dd className="text-sm leading-relaxed text-muted-foreground">{ROLE_DESCRIPTION[role]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Container>
      </Section>

      <Section id="disclosure">
        <Container className="grid gap-12 lg:grid-cols-[minmax(0,24rem)_1fr] lg:gap-20">
          <SectionHead index={5} eyebrow="Responsible disclosure" title={<>Found <em>something</em>?</>} className="mb-0 sm:mb-0" />
          <div className="grid content-start gap-5 border-t border-foreground pt-6" {...reveal(100)}>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Email <span className="font-mono text-foreground">security@nasscord.com</span> with steps to reproduce. We acknowledge within two business days, keep you
              updated while we fix it and credit you if you want to be credited. Please do not test against accounts you do not own, and give us a reasonable
              window before publishing.
            </p>
            <span className="site-caption inline-flex w-fit items-center gap-2 border border-foreground px-3 py-1.5">
              <Mail aria-hidden="true" className="size-3.5" />
              Acknowledged within two business days
            </span>
          </div>
        </Container>
      </Section>

      <Section id="legal" tone="band">
        <Container className="grid gap-12">
          <SectionHead index={6} eyebrow="Legal" title={<>Terms and privacy, <em>summarized</em>.</>} lede="Summaries for orientation only. The full documents are available on request." className="mb-0 sm:mb-0" />
          <div className="grid gap-6 md:grid-cols-2">
            <PaperCard className="p-6 sm:p-8" {...reveal(0, "scale")}>
              <h3 className="text-3xl">Terms of service</h3>
              <p className="site-caption mt-2 text-muted-foreground">Summary</p>
              <ul className="mt-5 grid gap-3 border-t border-foreground pt-4 text-sm leading-relaxed text-muted-foreground">
                <li>Nasscord is software. It is not a broker-dealer or investment adviser and does not hold your assets or execute trades on its own behalf.</li>
                <li>Alerts are information, not recommendations. You decide what to trade and you carry the risk of every order you place.</li>
                <li>Subscriptions bill monthly or yearly in USD and can be cancelled at any time; the plan stays active until the period ends.</li>
                <li>You may not use the service to violate a broker&apos;s terms, to trade on behalf of others without authority, or to attack the platform.</li>
                <li>Either party can end the agreement; we give 30 days notice for material changes to these terms.</li>
              </ul>
            </PaperCard>
            <PaperCard className="p-6 sm:p-8" {...reveal(100, "scale")}>
              <h3 className="text-3xl">Privacy policy</h3>
              <p className="site-caption mt-2 text-muted-foreground">Summary</p>
              <ul className="mt-5 grid gap-3 border-t border-foreground pt-4 text-sm leading-relaxed text-muted-foreground">
                <li>We collect what the data handling section above lists, and only to run the service, bill you and keep the audit log.</li>
                <li>We do not sell personal data and do not share broker data with anyone except the broker it came from and the aggregator you authorized.</li>
                <li>Payment processing, email delivery and error monitoring use vendors under data processing agreements.</li>
                <li>You can export or delete your data from Settings. Deletion removes broker tokens immediately.</li>
                <li>White-label tenants are controllers of their traders&apos; data; Nasscord processes it on their instructions.</li>
              </ul>
            </PaperCard>
          </div>
        </Container>
      </Section>

      <CtaBand title={<>Read the controls, then connect a <em>broker</em>.</>} lede="Much of this page you can watch happen in the terminal: the verification step on every order, the status of every broker session, and every order and fill." />
    </>
  );
}
