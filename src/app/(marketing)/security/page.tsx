import type { Metadata } from "next";
import { ArrowRight, Mail } from "lucide-react";
import { SHELL_AREAS } from "@/lib/nav";
import { ROLES, ROLE_LABEL, areasForRole } from "@/lib/roles";
import type { Role } from "@/lib/types";
import { Container, PageHero, PaperCard, Section, SectionHead } from "@/components/marketing/container";
import { CtaBand } from "@/components/marketing/cta-band";
import { reveal } from "@/components/marketing/motion";
import { RequestPath } from "@/components/marketing/page-visuals";
import { SECURITY_CONTROLS, SecurityControlDetails, SOFTWARE_DISCLAIMER } from "@/components/marketing/security-controls";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How Nasscord isolates broker connections, stores credentials and secures accounts in this read-only release. Plain statements, no certification claims. Terms and privacy summaries.",
};

const PIPELINE = [
  { name: "Your browser", note: "Your Nasscord sign-in. No broker credentials." },
  { name: "Nasscord app", note: "Checks your session and workspace on every request. Holds no broker secrets." },
  { name: "Broker service", note: "A separate server: the encryption key and every call to IBKR and E*TRADE" },
  { name: "Gateway or broker API", note: "Your IBKR gateway on localhost, or E*TRADE's API" },
  { name: "Your broker", note: "Accounts, balances, positions, orders; custody stays here" },
];

const ISOLATION = [
  {
    title: "Dedicated gateway process per connection",
    body: "Every Interactive Brokers connection gets its own Client Portal gateway process on its own port, reachable only from the broker service's own machine. Two connections never share a gateway, and a gateway never serves another workspace.",
  },
  {
    title: "A login host that passes only the login",
    body: "The IBKR login opens on a separate login host. A one-time ticket, valid for 2 minutes, opens a page that names the Nasscord workspace the login joins. After you continue, the host forwards IBKR's login pages and nothing else; every other gateway path is refused.",
  },
  {
    title: "Forwarding headers stripped",
    body: "The login host removes X-Forwarded-For, X-Real-IP and X-Forwarded-Host, rewrites cookies to host-only and opens a fresh loopback connection for every request, so the browser and the keepalive share one IBKR session.",
  },
  {
    title: "Signed calls, scoped to your workspace",
    body: "The app calls the broker service with a token signed for your workspace that lives 60 seconds. The service checks every connection id against it before use, so another workspace's connection answers as not found.",
  },
];

const STORE = [
  "Your name, email and role; your password is held as a hash by the sign-in provider (Supabase Auth)",
  "Your workspace, its plan and your settings",
  "For tenants: the tenant's name, referral code and branding",
  "Your broker connections: broker, environment, status and when the session ends",
  "Your broker accounts as the broker labels them, with the masked account number shown on screen and whether each one counts in your book",
  "The broker's account identifier (your IBKR account number, or E*TRADE's account key), which Nasscord needs to read the account. Screens only ever show the masked number",
  "For E*TRADE: your consumer key and secret, and the request or access token, encrypted with AES-256-GCM",
  "An audit log of sign-in, connection, tenant and console actions with who and when, and the IP address for the actions the app records itself (sign-in, settings, account choices, console changes)",
  "What you send through the public forms: tenant applications (name, company, email, expected traders, notes) and broker requests (broker name, email)",
];

const NEVER = [
  "Broker passwords or second-factor codes",
  "Positions, balances, orders or executions: they are read from the broker when you open a page and kept in memory for a few seconds",
  "Bank details, Social Security numbers or tax documents",
  "Card numbers: billing is not switched on in this release",
];

const ACCOUNT = [
  {
    title: "Email and password",
    body: "You sign in with your email and a password. Your address is confirmed by email first. A password needs at least 8 characters and two of: upper and lower case letters, a number, a symbol.",
  },
  { title: "Password reset", body: "A reset link goes to your confirmed address. It works once and expires after an hour." },
  {
    title: "Two-factor sign-in",
    body: "Not in this release: signing in to Nasscord has no second factor yet. Your broker's own second factor still protects the IBKR and E*TRADE logins.",
  },
  {
    title: "Roles",
    body: "Every login has exactly one of four roles, and the role decides which areas it can open. A tenant's login never opens the terminal, and only the super admin opens the console.",
  },
];

/** What each role does in this release. Written here so the public page matches the read-only product. */
const ROLE_TODAY: Record<Role, string> = {
  superadmin: "Owns the platform. Runs the console, creates tenants, grants white-label and has a terminal of their own.",
  tenant: "A distributor. Sees its code, its link and the traders who joined with them, and its branding once white-label is granted.",
  trader: "Signed up directly. Connects brokers and sees them in the terminal.",
  tenant_user: "Joined with a tenant's code. Uses the terminal, in the tenant's brand when white-label is on.",
};

const COUNT_WORD = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

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
        lede="This page describes how the system behaves in this release, which is read-only. It makes no certification claims; it states controls you can check against the terminal."
        aside={<RequestPath steps={PIPELINE} />}
      >
        <p className="max-w-xl border-l-2 border-site-accent py-1 pl-4 font-medium">{SOFTWARE_DISCLAIMER}</p>
      </PageHero>

      <Section>
        <Container className="grid gap-12">
          <SectionHead index={1} eyebrow="Controls" title={<>{COUNT_WORD[SECURITY_CONTROLS.length] ?? SECURITY_CONTROLS.length} controls, in <em>detail</em>.</>} className="mb-0 sm:mb-0" />
          <SecurityControlDetails />
        </Container>
      </Section>

      <Section id="isolation" tone="band">
        <Container className="grid gap-14">
          <SectionHead index={2} eyebrow="Architecture" title={<>How the broker connection is <em>isolated</em>.</>} lede="The path a request takes, and the four properties that hold along it." className="mb-0 sm:mb-0" />
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
              <p className="mt-2 text-sm text-muted-foreground">In the Nasscord database. Broker secrets are encrypted by the broker service before they are written.</p>
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
              <p className="mt-2 text-sm text-muted-foreground">None of this is written to the Nasscord database.</p>
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
            Disconnecting a broker revokes its E*TRADE token or stops its IBKR gateway at once. Because positions, orders and executions are never
            written to the database, there is no trading history of yours to keep once a connection is gone.
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
                  <dd className="text-sm leading-relaxed text-muted-foreground">{ROLE_TODAY[role]}</dd>
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
                <li>Nothing Nasscord shows is a recommendation. You decide what to trade and you carry the risk of every order you place at your broker.</li>
                <li>Billing is not switched on in this release. Once it is, subscriptions bill monthly or yearly in USD and can be cancelled at any time.</li>
                <li>You may not use the service to violate a broker&apos;s terms, to trade on behalf of others without authority, or to attack the platform.</li>
                <li>Either party can end the agreement; we give 30 days notice for material changes to these terms.</li>
              </ul>
            </PaperCard>
            <PaperCard className="p-6 sm:p-8" {...reveal(100, "scale")}>
              <h3 className="text-3xl">Privacy policy</h3>
              <p className="site-caption mt-2 text-muted-foreground">Summary</p>
              <ul className="mt-5 grid gap-3 border-t border-foreground pt-4 text-sm leading-relaxed text-muted-foreground">
                <li>We collect what the data handling section above lists, plus the sign-in records Supabase Auth keeps, and use it only to run the service, answer what you sent us and keep the audit log.</li>
                <li>We do not sell personal data and do not share broker data with anyone except the broker it came from.</li>
                <li>Sign-in and the database run on Supabase, and sign-in emails go through an email provider.</li>
                <li>Disconnecting a broker in the terminal ends Nasscord&apos;s access to it at once.</li>
                <li>White-label tenants are controllers of their traders&apos; data; Nasscord processes it on their instructions.</li>
              </ul>
            </PaperCard>
          </div>
        </Container>
      </Section>

      <CtaBand title={<>Read the controls, then connect a <em>broker</em>.</>} lede="Some of this you can check yourself in the terminal: the status of every broker connection, when its session ends, and which accounts count in your book." />
    </>
  );
}
