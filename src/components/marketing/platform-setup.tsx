import { Check } from "lucide-react";
import { CONNECTABLE_BROKERS } from "@/lib/brokers";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

/*
 * "One signup. Every account on one screen." as two pieces:
 *  1. getting started as a timeline on a dot-grid card: a track that fills as it scrolls in and three milestones that
 *     light up in turn. No clock: how long it takes depends on the broker (an E*TRADE key is made on E*TRADE's site);
 *  2. the systems Nasscord runs for you, each with what you no longer have to do yourself.
 * Server component. Motion waits for the reveal and stops under reduced motion.
 */

const STEPS = [
  { title: "Create your account", body: "Email and a password. Confirm your address from the email we send, then name your workspace. Starter is free and needs no card." },
  {
    title: "Connect a broker",
    body: "Interactive Brokers: log in on IBKR's own page. E*TRADE: paste your own developer key, approve on E*TRADE and paste back the code. Then pick the accounts that count.",
  },
  { title: "See it in one place", body: "Accounts, balances, positions, orders and executions from every connection, read-only, in one terminal." },
];

const STEP_CHIPS = [["Email", "Password", "Confirm link"], null, ["Accounts", "Positions", "Orders", "Executions"]] as const;

const SYSTEMS = [
  {
    name: "Broker gateway",
    now: "An IBKR Client Portal gateway for each connection, started for you and checked about once a minute to keep the session alive.",
    was: "Install and log in to a gateway on your own machine",
    meta: "per IBKR connection",
  },
  {
    name: "Login host",
    now: "Opens IBKR's own login page for your gateway and passes through the login pages only.",
    was: "Configure a reverse proxy",
    meta: "per IBKR login",
  },
  {
    name: "Broker service",
    now: "Holds the key that encrypts your E*TRADE tokens and makes every call to IBKR and E*TRADE.",
    was: "Keep API keys and tokens in files",
    meta: "AES-256-GCM",
  },
  {
    name: "Terminal",
    now: "The web terminal: every account, position, order and execution across your connections. Read-only in this release.",
    was: "Host and update a trading screen",
    meta: "in the browser",
  },
];

export function PlatformSetup() {
  return (
    <div className="grid gap-16">
      {/* 1. getting started */}
      <div className="group/tl dotgrid rounded-[1.75rem] border border-border bg-card p-6 shadow-[0_30px_80px_-50px_color-mix(in_oklab,var(--primary)_55%,transparent)] sm:p-10" {...reveal(0, "scale")}>
        <div className="grid gap-1">
          <span className="site-label">Getting started</span>
          <span className="font-mono text-xs text-muted-foreground">From signup to your first account on screen</span>
        </div>

        <ol className="relative mt-10 grid gap-10 md:grid-cols-3 md:gap-8">
          {/* track: vertical on phones, horizontal from md up; fills once the card is on screen */}
          <span aria-hidden="true" className="absolute top-5 bottom-5 left-5 w-px bg-border md:top-5 md:right-[calc(100%/6)] md:bottom-auto md:left-[calc(100%/6)] md:h-px md:w-auto">
            <span className="absolute inset-0 origin-top scale-y-0 bg-primary transition-transform delay-300 duration-[1800ms] ease-out group-data-[shown]/tl:scale-y-100 md:origin-left md:scale-x-0 md:scale-y-100 md:group-data-[shown]/tl:scale-x-100" />
          </span>
          {STEPS.map((s, i) => {
            const chips = STEP_CHIPS[i];
            return (
              <li key={s.title} className="relative grid content-start grid-cols-[2.5rem_1fr] gap-4 md:grid-cols-1 md:justify-items-center md:text-center">
                <span
                  aria-hidden="true"
                  className="relative z-10 grid size-10 place-items-center rounded-full border border-border bg-card font-mono text-sm text-muted-foreground transition-colors duration-500 group-data-[shown]/tl:border-primary group-data-[shown]/tl:bg-primary group-data-[shown]/tl:text-primary-foreground"
                  style={{ transitionDelay: `${400 + i * 650}ms` }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="grid gap-2 md:justify-items-center">
                  <span className="font-mono text-xs text-site-accent-ink tabular">Step {String(i + 1).padStart(2, "0")}</span>
                  <h3 className="text-3xl leading-tight">{s.title}</h3>
                  <p className="max-w-[20rem] text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                  <div className="pt-2">
                    {chips ? (
                      <ul className="flex flex-wrap gap-1.5 md:justify-center">
                        {chips.map((c, k) => (
                          <li key={c} className="inline-flex items-center gap-1.5 border border-border bg-background px-2 py-1 font-mono text-[0.7rem]" {...reveal(500 + i * 400 + k * 120)}>
                            <Check aria-hidden="true" className="size-3 text-site-accent" />
                            {c}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="flex items-center gap-2.5 md:justify-center">
                        {CONNECTABLE_BROKERS.map((b, k) => (
                          <span key={b.id} className="inline-flex items-center gap-2" {...reveal(900 + k * 140, "scale")}>
                            <BrokerMark id={b.id} size="md" className="rounded-[9px]" />
                            <span className="font-mono text-[0.7rem] text-muted-foreground">{b.short}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {/* 2. the systems, run for you */}
      <div className="grid gap-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3" {...reveal()}>
          <h3 className="site-label font-sans">What Nasscord runs for you</h3>
          <span className="site-caption text-muted-foreground">Started and kept running by Nasscord</span>
        </div>
        <ul className="grid border-t border-foreground sm:grid-cols-2 lg:grid-cols-4">
          {SYSTEMS.map((s, i) => (
            <li
              key={s.name}
              className={cn(
                "group/sys flex flex-col gap-4 border-b border-border py-6 transition-colors duration-300 hover:bg-site-band/60 sm:px-6",
                // two columns from sm, four from lg: rule and pad every column but the first
                i % 2 === 0 ? "sm:pl-0" : "sm:border-l",
                i >= 1 && "lg:border-l",
                i === 2 && "lg:pl-6",
              )}
              {...reveal(i * 90)}
            >
              <span className="font-mono text-xs text-site-accent-ink">SYS/{String(i + 1).padStart(2, "0")}</span>
              <h4 className="font-serif text-3xl leading-tight">{s.name}</h4>
              <p className="text-sm leading-relaxed">{s.now}</p>
              <div className="mt-auto grid gap-1 border-t border-border pt-3">
                <span className="font-mono text-[0.7rem] text-muted-foreground">{s.meta}</span>
                <span className="text-xs text-muted-foreground">
                  <span className="mr-2 font-mono text-[0.65rem] tracking-wide uppercase">Before</span>
                  <del className="decoration-site-accent/60">{s.was}</del>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
