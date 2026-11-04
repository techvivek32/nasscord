import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BookOpenIcon, KeyRoundIcon, WalletIcon } from "lucide-react";
import { AuthHeader } from "@/app/(auth)/auth-header";
import { NotConfigured } from "@/app/(auth)/not-configured";
import { LoginForm } from "@/app/(auth)/login/login-form";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { getAuthUser, getSession } from "@/lib/auth";
import { CONNECTABLE_BROKERS } from "@/lib/brokers";
import { homeForRole } from "@/lib/roles";
import { isSupabaseConfigured, safeNextPath } from "@/lib/supabase/env";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Nasscord terminal.",
};

const VALUE_LINES = [
  {
    icon: WalletIcon,
    title: "Your accounts, one book",
    body: "Positions, balances, orders and executions from Interactive Brokers and E*TRADE, read straight from the broker.",
  },
  {
    icon: KeyRoundIcon,
    title: "Your broker login stays with the broker",
    body: "You sign in to IBKR on IBKR's own page. E*TRADE uses a key you create and can revoke. Nasscord never sees a broker password.",
  },
  {
    icon: BookOpenIcon,
    title: "Read-only to start",
    body: "This release reads your accounts. Placing orders from Nasscord comes in a later release.",
  },
];

const ERRORS: Record<string, string> = {
  link: "That link has expired or was already used. Sign in, or sign up again to get a new one.",
  "reset-link": "That reset link has expired or was already used. Request a new one below.",
  config: "Supabase is not configured on this deployment.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; view?: string }> }) {
  const { next, error, view } = await searchParams;
  const safeNext = safeNextPath(next) ?? undefined;
  const configured = isSupabaseConfigured();

  if (configured) {
    // Already signed in: go where they were headed, or finish signup.
    const user = await getAuthUser();
    if (user) {
      const session = await getSession();
      redirect(session ? (safeNext ?? homeForRole(session.role)) : "/signup");
    }
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <AuthHeader prompt="New to Nasscord?" linkLabel="Create your workspace" href="/signup" />
      <main className="flex flex-1 items-start px-4 py-8 sm:px-6 lg:items-center lg:px-10 lg:py-12">
        <div className="mx-auto grid w-full max-w-5xl gap-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-center lg:gap-16">
          {configured ? (
            <LoginForm
              next={safeNext}
              notice={error ? (ERRORS[error] ?? null) : null}
              initialView={view === "reset" || error === "reset-link" ? "reset" : "credentials"}
            />
          ) : (
            <NotConfigured title="Sign in" />
          )}

          <aside className="hidden lg:block" aria-label="About Nasscord">
            <div className="grid gap-8 border-l border-border pl-10">
              <div className="grid gap-3">
                <span className="text-xs font-semibold tracking-wide text-primary uppercase">The cord</span>
                <h2 className="text-3xl font-semibold tracking-tight">One cord to every broker.</h2>
                <p className="max-w-md text-base leading-relaxed text-muted-foreground">
                  Nasscord sits between you and your brokers: one login, every account in one place. Your money and your broker passwords never leave the broker.
                </p>
              </div>
              <ul className="grid gap-5">
                {VALUE_LINES.map((v) => (
                  <li key={v.title} className="flex gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-primary">
                      <v.icon className="size-4" aria-hidden="true" />
                    </span>
                    <div className="grid gap-0.5">
                      <span className="text-sm font-semibold">{v.title}</span>
                      <span className="text-sm leading-relaxed text-muted-foreground">{v.body}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="grid gap-2">
                <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Connect today</span>
                <div className="flex flex-wrap items-center gap-3">
                  {CONNECTABLE_BROKERS.map((b) => (
                    <span key={b.id} className="inline-flex items-center gap-1.5 text-sm">
                      <BrokerMark id={b.id} size="sm" />
                      {b.name}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
