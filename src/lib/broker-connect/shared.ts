import type { BrokerId, ConnectEnvironmentOption, ConnectSpec } from "@/lib/types";

/*
 * Pieces the per-broker connect specs share. Pure data: safe for client and server code.
 */

/** The label of a broker's sample-data environment, wherever it appears (developers only). */
export const SANDBOX_LABEL = "Sandbox · sample data";

/** "Live" for a broker's real accounts. */
export function liveEnvironment(name: string, hint?: string): ConnectEnvironmentOption {
  return { value: "production", label: "Live", hint: hint ?? `Your real ${name} account.` };
}

/** A broker's sample-data environment. The broker service refuses it in production. */
export function sandboxEnvironment(what: string): ConnectEnvironmentOption {
  return { value: "sandbox", label: SANDBOX_LABEL, hint: `${what}, for developers only. Never offered in production.` };
}

/**
 * The SnapTrade spec of a broker Nasscord reads through SnapTrade's hosted portal (Fidelity,
 * Robinhood, Public, Moomoo, and Webull, Schwab and tastytrade until they approve Nasscord).
 * Read only: SnapTrade's connection is opened with connectionType=read and the broker preselected.
 */
export function snaptradeSpec(brokerId: BrokerId, name: string, opts: { agreement?: string; unavailableReason?: string; extraNote?: string } = {}): ConnectSpec {
  return {
    flow: "aggregator_portal",
    method: "snaptrade",
    via: "snaptrade",
    title: `Connect ${name} through SnapTrade`,
    summary: `Log in on ${name}'s own page through SnapTrade, a data intermediary. Read only.`,
    environments: [liveEnvironment(name, `Your real ${name} accounts.`)],
    prerequisites: [`A ${name} account you can log in to.`],
    steps: [
      `Press Continue. SnapTrade's connection page opens in a new tab with ${name} already chosen.`,
      `Accept SnapTrade's terms and ${opts.agreement ?? `${name}'s access agreement`}.`,
      `Log in on ${name}'s own page, pass its second factor and choose the accounts to share.`,
      "SnapTrade sends you back to Nasscord, and your accounts appear here.",
    ],
    disclosure: `Nasscord reads ${name} through SnapTrade, a data intermediary. You log in on ${name}'s own page, so Nasscord never sees your password. Read only: Nasscord places no orders.${opts.extraNote ? ` ${opts.extraNote}` : ""}`,
    sessionNote: `Balances and positions refresh on SnapTrade's schedule, not live, and trade history arrives a day late. The card shows when the data was last updated. If ${name} ends the access, Reconnect opens SnapTrade's page again.`,
    disconnectNote: `Disconnect removes the connection at SnapTrade and deletes its accounts from Nasscord. You can also remove the access in ${name}'s own settings.`,
    unavailableReason: opts.unavailableReason ?? `Not available yet: Nasscord is waiting for SnapTrade to approve it for ${name}.`,
  };
}
