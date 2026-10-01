import { Check } from "lucide-react";
import { TRADING_BROKERS } from "@/lib/brokers";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { reveal } from "@/components/marketing/motion";
import { ClockUp } from "@/components/marketing/reveal";
import { cn } from "@/lib/utils";

/*
 * "One signup. Four systems. About two minutes." as two pieces:
 *  1. the first two minutes as a timeline on a dot-grid card: a track that fills as it scrolls in, three milestones
 *     that light up in turn, and a setup clock counting to 2:00;
 *  2. the four systems Nasscord runs for you, as a status board, each with what you no longer have to do.
 * Server component; the clock is the only client piece. Motion waits for the reveal and stops under reduced motion.
 */

const STEPS = [
  { at: "0:00", title: "Create your account", body: "Email, a password and 2FA. Starter is free and needs no card." },
  { at: "0:45", title: "Connect your brokers", body: "Each broker opens its own sign-in page and hands Nasscord a scoped token. You pick the accounts that count." },
  { at: "2:00", title: "Trade from one screen", body: "Alerts, verified orders and every position across every account, in one terminal." },
];

const SYSTEMS = [
  { name: "Broker gateway", now: "Started for you, one session per login, kept alive.", was: "Install and log in to a local gateway", meta: "per login" },
  { name: "Proxy", now: "Keeps the browser and the keepalive on one broker session.", was: "Configure a reverse proxy", meta: "per session" },
  { name: "Terminal", now: "The web terminal you trade from, on desktop and on your phone.", was: "Host and update a trading screen", meta: "web + phone" },
  {
    name: "Alert engine",
    now: `TradeScope scans ${ENGINE_DEFAULTS.universeSize} symbols on ${ENGINE_DEFAULTS.timeframe} bars and delivers to the terminal, push and email.`,
    was: "Run a scanner on your own machine",
    meta: `${ENGINE_DEFAULTS.universeSize} symbols · ${ENGINE_DEFAULTS.timeframe}`,
  },
];

export function PlatformSetup({ brokerCount, accountCount }: { brokerCount: number; accountCount: number }) {
  const shown = TRADING_BROKERS.slice(0, 3);
  return (
    <div className="grid gap-16">
      {/* 1. the first two minutes */}
      <div className="group/tl dotgrid rounded-[1.75rem] border border-border bg-card p-6 shadow-[0_30px_80px_-50px_color-mix(in_oklab,var(--primary)_55%,transparent)] sm:p-10" {...reveal(0, "scale")}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-1">
            <span className="site-label">Your first two minutes</span>
            <span className="font-mono text-xs text-muted-foreground">Typical setup, from signup to first alert</span>
          </div>
          <div className="sm:text-right">
            <span className="site-caption block text-muted-foreground">Setup time</span>
            <ClockUp seconds={120} className="text-5xl leading-none tracking-[-0.03em] tabular" />
          </div>
        </div>

        <ol className="relative mt-10 grid gap-10 md:grid-cols-3 md:gap-8">
          {/* track: vertical on phones, horizontal from md up; fills once the card is on screen */}
          <span aria-hidden="true" className="absolute top-5 bottom-5 left-5 w-px bg-border md:top-5 md:right-[calc(100%/6)] md:bottom-auto md:left-[calc(100%/6)] md:h-px md:w-auto">
            <span className="absolute inset-0 origin-top scale-y-0 bg-primary transition-transform delay-300 duration-[1800ms] ease-out group-data-[shown]/tl:scale-y-100 md:origin-left md:scale-x-0 md:scale-y-100 md:group-data-[shown]/tl:scale-x-100" />
          </span>
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative grid content-start grid-cols-[2.5rem_1fr] gap-4 md:grid-cols-1 md:justify-items-center md:text-center">
              <span
                aria-hidden="true"
                className="relative z-10 grid size-10 place-items-center rounded-full border border-border bg-card font-mono text-sm text-muted-foreground transition-colors duration-500 group-data-[shown]/tl:border-primary group-data-[shown]/tl:bg-primary group-data-[shown]/tl:text-primary-foreground"
                style={{ transitionDelay: `${400 + i * 650}ms` }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="grid gap-2 md:justify-items-center">
                <span className="font-mono text-xs text-site-accent-ink tabular">{s.at}</span>
                <h3 className="text-3xl leading-tight">{s.title}</h3>
                <p className="max-w-[20rem] text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                <div className="pt-2">
                  {i === 0 ? (
                    <ul className="flex flex-wrap gap-1.5 md:justify-center">
                      {["Email", "Password", "2FA"].map((c, k) => (
                        <li key={c} className="inline-flex items-center gap-1.5 border border-border bg-background px-2 py-1 font-mono text-[0.7rem]" {...reveal(500 + k * 120)}>
                          <Check aria-hidden="true" className="size-3 text-site-accent" />
                          {c}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {i === 1 ? (
                    <div className="flex items-center gap-2.5 md:justify-center">
                      {shown.map((b, k) => (
                        <span key={b.id} className="relative" {...reveal(900 + k * 140, "scale")}>
                          <BrokerMark id={b.id} size="md" className="rounded-[9px]" />
                          <span aria-hidden="true" className="absolute -right-1.5 -bottom-1.5 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground ring-2 ring-card">
                            <Check className="size-2.5" />
                          </span>
                        </span>
                      ))}
                      <span className="ml-1 font-mono text-[0.7rem] text-muted-foreground">+{TRADING_BROKERS.length - shown.length} more</span>
                    </div>
                  ) : null}
                  {i === 2 ? (
                    <span className="inline-flex items-center gap-2 border border-border bg-background px-2.5 py-1 font-mono text-[0.7rem]" {...reveal(1500)}>
                      <span className="relative flex size-2">
                        <span className="absolute inset-0 animate-ping rounded-full bg-gain opacity-60" />
                        <span className="relative size-2 rounded-full bg-gain" />
                      </span>
                      Session live · {brokerCount} brokers · {accountCount} accounts
                    </span>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* 2. the four systems, run for you */}
      <div className="grid gap-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3" {...reveal()}>
          <h3 className="site-label font-sans">Four systems, run for you</h3>
          <span className="site-caption text-muted-foreground">Started · monitored · restarted by Nasscord</span>
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
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs text-site-accent-ink">SYS/{String(i + 1).padStart(2, "0")}</span>
                <span className="inline-flex items-center gap-1.5 font-mono text-[0.7rem] text-muted-foreground">
                  <span className="relative flex size-1.5">
                    <span className="absolute inset-0 animate-ping rounded-full bg-gain opacity-60" style={{ animationDelay: `${i * 400}ms` }} />
                    <span className="relative size-1.5 rounded-full bg-gain" />
                  </span>
                  Running
                </span>
              </div>
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
