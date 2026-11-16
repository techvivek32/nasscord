import { cache } from "react";
import { unstable_cache } from "next/cache";
import { BROKERS } from "@/lib/brokers";
import { connectSpecs, optionFor } from "@/lib/broker-connect";
import { getOptions, isBrokerServiceConfigured, type ServiceActor } from "@/lib/server/broker-service";
import type { Broker, BrokerOptions, BrokerStatus, ConnectOption, ConnectSpec } from "@/lib/types";

/*
 * What the public pages say about each broker, taken from the broker service's own answer
 * (GET /v1/options, asked as an ordinary trader) instead of a fixed label. A page then never says
 * "Connect today" while a broker is gated to the owner, not built, not set up, or waiting for
 * SnapTrade. Server only.
 *
 * The answer is kept 5 minutes, and a page that reads it re-renders on the same clock. When the
 * service cannot be asked (not configured, down, slow), the static release status in
 * src/lib/brokers.ts is used: it lists only what connects for everyone. After such a failure the
 * service is not asked again for a minute, so a service that hangs costs one slow render a minute
 * (at most PUBLIC_OPTIONS_TIMEOUT_MS), not every render of a dynamic page such as /login.
 *
 * Inside that minute no cached read runs, so nothing gives the page a revalidate time: the
 * (marketing) layout sets `revalidate = 300` itself, and a page rendered on the fallback (a build
 * while the service is down or still the old one) is rendered again within 5 minutes.
 */

if (typeof window !== "undefined") throw new Error("src/lib/server/broker-availability.ts is server only.");

/**
 * The caller the public pages ask for: an ordinary trader with no user and no workspace. The
 * service's /v1/options reads only the role, so this sees exactly what every trader sees.
 */
const PUBLIC_ACTOR: ServiceActor = { userId: "00000000-0000-0000-0000-000000000000", workspaceId: null, role: "trader" };
/** How long a page waits for the service's answer before it shows the static release status. */
export const PUBLIC_OPTIONS_TIMEOUT_MS = 3_000;
/** After a failed ask, the service is not asked again for this long: the pages show the static status. */
export const PUBLIC_RETRY_AFTER_MS = 60_000;
/** Seconds the service's answer is reused by the public pages. */
const REVALIDATE_S = 300;
/**
 * Until when (epoch ms) the service is not asked. Module state: the app is one Node process, and a
 * failure is never written to the cross-request cache (readOptions throws), so it is remembered here.
 */
let retryAt = 0;

/** A broker as the public pages show it: the registry entry with its status for everyone right now. */
export interface PublicBroker extends Broker {
  /** The ways a trader can connect it now, the preferred first. Empty while it does not connect. */
  open: ConnectSpec[];
  /** Connects today only through SnapTrade. */
  viaSnapTrade: boolean;
  /** The user's own paper account connects today. */
  paperToday: boolean;
  /** Why it does not connect yet, as a sentence. Null when it connects. */
  waiting: string | null;
}

export interface PublicAvailability {
  /** "service": the broker service answered. "registry": it could not be asked, so the static release status is shown. */
  source: "service" | "registry";
  /** Every broker in registry order, with `status` for everyone right now. */
  brokers: PublicBroker[];
  /** Brokers that connect today (status live or sync), registry order. */
  today: PublicBroker[];
  /** Brokers that connect today directly (status live). */
  direct: PublicBroker[];
  /** Brokers that connect today only through SnapTrade (status sync). */
  sync: PublicBroker[];
  /** Brokers that do not connect yet (status soon). */
  soon: PublicBroker[];
}

/* ---------------------------------------------------------------- reading the service */

function isOption(o: unknown): o is ConnectOption {
  if (!o || typeof o !== "object") return false;
  const x = o as Record<string, unknown>;
  return (
    typeof x.brokerId === "string" &&
    typeof x.method === "string" &&
    (x.client === null || x.client === "user" || x.client === "platform") &&
    typeof x.available === "boolean" &&
    typeof x.audience === "string" &&
    Array.isArray(x.environments)
  );
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The broker service did not answer in time.")), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The service's options for an ordinary trader, kept REVALIDATE_S seconds. Throws when the service
 * cannot be asked, so a failure is never kept: the next render asks again.
 */
const readOptions = unstable_cache(
  async (): Promise<BrokerOptions> => {
    if (!isBrokerServiceConfigured()) throw new Error("The broker service is not configured.");
    const raw = (await withTimeout(getOptions(PUBLIC_ACTOR), PUBLIC_OPTIONS_TIMEOUT_MS)) as unknown;
    const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const options = Array.isArray(r.options) ? r.options.filter(isOption) : [];
    if (options.length === 0) throw new Error("The broker service sent no connect options.");
    return { callbackBase: typeof r.callbackBase === "string" ? r.callbackBase : null, options };
  },
  ["public-broker-availability", "v1"],
  { revalidate: REVALIDATE_S, tags: ["broker-availability"] },
);

/* ---------------------------------------------------------------- shaping */

const NOT_YET = /^Not available yet:\s*/;

/** Why a broker does not connect yet: the reason of its preferred way, in a sentence. */
function waitingFor(b: Broker, specs: ConnectSpec[]): string {
  const reason = specs[0]?.unavailableReason ?? "";
  if (NOT_YET.test(reason)) {
    const rest = reason.replace(NOT_YET, "");
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return `Nasscord cannot connect ${b.name} right now.`;
}

/** The registry blurb while the status is the static one; otherwise a line from the way it connects. */
function blurbFor(b: Broker, status: BrokerStatus, open: ConnectSpec[], waiting: string | null): string {
  if (status === b.status) return b.blurb;
  if (status === "soon") return `Not available yet. ${waiting ?? ""}`.trim();
  const summary = open[0]?.summary ?? "";
  return /read only|read-only/i.test(summary) ? summary : `${summary} Read-only in this release.`.trim();
}

function group(brokers: PublicBroker[], source: PublicAvailability["source"]): PublicAvailability {
  return {
    source,
    brokers,
    today: brokers.filter((b) => b.status !== "soon"),
    direct: brokers.filter((b) => b.status === "live" || b.status === "beta"),
    sync: brokers.filter((b) => b.status === "sync"),
    soon: brokers.filter((b) => b.status === "soon"),
  };
}

/** Status for everyone from the service's answer: direct ways first, then SnapTrade. */
export function availabilityFromOptions(options: BrokerOptions): PublicAvailability {
  const brokers = BROKERS.map((b): PublicBroker => {
    const specs = connectSpecs(b.id);
    const openPairs = specs
      .map((spec) => ({ spec, option: optionFor(options, b.id, spec) }))
      .filter((x) => x.option?.available === true && x.option.audience === "all" && x.option.environments.some((e) => e !== "sandbox"));
    const direct = openPairs.filter((x) => x.spec.via !== "snaptrade");
    const status: BrokerStatus = direct.length ? "live" : openPairs.length ? "sync" : "soon";
    const open = (direct.length ? direct : openPairs).map((x) => x.spec);
    const waiting = status === "soon" ? waitingFor(b, specs) : null;
    return {
      ...b,
      status,
      blurb: blurbFor(b, status, open, waiting),
      open,
      viaSnapTrade: status === "sync",
      paperToday: openPairs.some((x) => x.option?.environments.includes("paper")),
      waiting,
    };
  });
  return group(brokers, "service");
}

/** The static release status of src/lib/brokers.ts, for when the service cannot be asked. */
export function availabilityFromRegistry(): PublicAvailability {
  const brokers = BROKERS.map((b): PublicBroker => {
    const specs = connectSpecs(b.id);
    const today = b.status !== "soon";
    const open = today ? specs.filter((s) => (b.status === "sync" ? s.via === "snaptrade" : s.via !== "snaptrade")).slice(0, 1) : [];
    return {
      ...b,
      open,
      viaSnapTrade: b.status === "sync",
      paperToday: today && b.capabilities.paper,
      waiting: today ? null : waitingFor(b, specs),
    };
  });
  return group(brokers, "registry");
}

/**
 * Every broker with its status for everyone right now. Never throws. Deduplicated per request, and
 * the service's answer is reused for 5 minutes across requests. A failure shows the static status
 * and keeps the service unasked for PUBLIC_RETRY_AFTER_MS.
 */
export const publicBrokers = cache(async (): Promise<PublicAvailability> => {
  if (Date.now() < retryAt) return availabilityFromRegistry();
  try {
    return availabilityFromOptions(await readOptions());
  } catch {
    retryAt = Date.now() + PUBLIC_RETRY_AFTER_MS;
    return availabilityFromRegistry();
  }
});

/* ---------------------------------------------------------------- copy helpers */

/** "A", "A and B", "A, B and C". */
export function andList(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "A", "A or B", "A, B or C". */
export function orList(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/**
 * Broker names for a sentence: every name while there are at most `max`, otherwise the first ones
 * and how many more ("Fidelity, Robinhood and 3 more").
 */
export function brokerNames(brokers: Broker[], opts: { max?: number; short?: boolean; joiner?: "and" | "or" } = {}): string {
  const { max = 4, short = false, joiner = "and" } = opts;
  const names = brokers.map((b) => (short ? b.short : b.name));
  const list = joiner === "or" ? orList : andList;
  if (names.length <= max) return list(names);
  const shown = names.slice(0, Math.max(1, max - 1));
  return `${shown.join(", ")} and ${names.length - shown.length} more`;
}

/** How a broker connects today, in a few words for "<Broker>: ...". */
export function connectHow(b: PublicBroker): string {
  switch (b.open[0]?.flow) {
    case "gateway_login":
      return `log in on ${b.short}'s own page`;
    case "oauth1_verifier":
      return `paste your own developer key, approve on ${b.short} and paste back the code`;
    case "api_key":
      return `paste an API key of your own ${b.short} account`;
    case "oauth2_user_app":
      return `use your own ${b.short} developer app and sign in on ${b.short}'s page`;
    case "oauth2_platform":
      return `sign in on ${b.short}'s own page`;
    case "aggregator_portal":
      return `log in on ${b.short}'s own page through SnapTrade`;
    default:
      return "not available yet";
  }
}
