import { SHELL_NAVS, type ShellNavId } from "@/lib/nav";

/* ------------------------------------------------------------------
   Intro tours, one per signed-in area. A tour runs once on the first
   visit and again from the help button in the header.
   The sidebar steps are built from lib/nav, so a page added to the
   sidebar shows up in the tour with its description.
   ------------------------------------------------------------------ */

export interface TourStep {
  title: string;
  body: string;
  /** CSS selectors tried in order; the first one visible on screen is spotlighted. None visible: the card is centred. */
  targets?: string[];
  /** Drop the step when no target is on screen (controls that depend on the role, the page or the screen width). */
  optional?: boolean;
  /** What each item in the highlighted group is for. */
  items?: Array<{ label: string; text: string }>;
}

/** On phones the sidebar is closed, so sidebar steps point at the button that opens it. */
const SIDEBAR_TRIGGER = '[data-slot="sidebar-trigger"]';

const INTRO: Record<ShellNavId, TourStep> = {
  terminal: {
    title: "Welcome to the terminal",
    body: "This is where you trade. Alerts come in, you place orders with a stop and a target attached, and every account at every broker shows up as one book. The tour takes about a minute. Anything marked Demo data is a sample.",
  },
  console: {
    title: "Welcome to the console",
    body: "You run the platform from here: traders, tenants, white-label, brokers, billing and system health. Traders and tenants never see this area. The tour takes about a minute.",
  },
  tenant: {
    title: "Welcome to the tenant portal",
    body: "Track the traders you bring, the commission you earn and, once white-label is on, the branded workspaces you run. The tour takes under a minute.",
  },
};

/** Title and lead-in for each sidebar group, by position in SHELL_NAVS. */
const GROUPS: Record<ShellNavId, Array<{ title: string; body: string }>> = {
  terminal: [
    { title: "Trade", body: "The pages you use while the market is open." },
    { title: "Research", body: "Find setups and review what you did." },
    { title: "Account", body: "Your broker connections and preferences." },
  ],
  console: [
    { title: "Overview", body: "Start here. The health of the whole business on one page." },
    { title: "Customers", body: "Who uses the platform: traders, the tenants who bring them, and every login." },
    { title: "White-label", body: "Give a tenant their own brand and domain on the terminal. Only you can turn it on." },
    { title: "Platform", body: "What the platform offers and what it earns." },
    { title: "Operations", body: "Keeping it running, and the record of every change." },
  ],
  tenant: [
    { title: "Overview", body: "Start here. Your program on one page." },
    { title: "Program", body: "The traders you bring and the commission you earn." },
    { title: "White-label", body: "Your brand on the terminal, once Nasscord turns white-label on for you." },
    { title: "Account", body: "Contacts, keys and your agreement." },
  ],
};

const AREA_SWITCHER: TourStep = {
  title: "Switch area",
  body: "Your account can open more than one area. Move between the console, the terminal and the tenant portal from this menu.",
  targets: ['[data-tour="area-switcher"]'],
  optional: true,
};

/** Controls specific to one area, shown after the sidebar steps. */
const EXTRA: Record<ShellNavId, TourStep[]> = {
  terminal: [
    {
      title: "Account scope",
      body: "Choose All accounts or a single account. Every page, every total and the order ticket follow this choice.",
      targets: ['[data-tour="account-scope"]'],
      optional: true,
    },
    {
      title: "Live or paper",
      body: "Live sends orders to your real broker accounts. Paper mode sends them to a practice account. Leaving paper mode asks you to confirm first.",
      targets: ['[data-tour="paper-mode"]', '[data-tour="paper-live"]'],
      optional: true,
    },
    {
      title: "Order ticket",
      body: "Pick an account, a symbol and a price. The quantity is sized so that a stop-out costs 1% of the account, and the stop and target go out with the order as a bracket.",
      targets: ["#order-ticket"],
      optional: true,
    },
  ],
  console: [
    {
      title: "Search",
      body: "Find any trader workspace or user and jump straight to it. Keyboard shortcut: Ctrl K, or Cmd K on a Mac.",
      targets: ['[data-tour="console-search"]'],
      optional: true,
    },
    {
      title: "Maintenance gate",
      body: "One switch that shows traders a maintenance page during market hours while you work on the fleet. It asks before it turns on.",
      targets: ['[data-tour="maintenance"]'],
      optional: true,
    },
  ],
  tenant: [],
};

const USER_MENU: TourStep = {
  title: "Your account",
  body: "Settings and Sign out are in this menu.",
  targets: ['[data-tour="user-menu"]'],
  optional: true,
};

const REPLAY: TourStep = {
  title: "Replay this tour",
  body: "Open the tour again from this button whenever you need it.",
  targets: ['[data-tour="tour-button"]'],
  optional: true,
};

export function tourFor(id: ShellNavId): TourStep[] {
  const groups = SHELL_NAVS[id].map<TourStep>((group, i) => ({
    title: GROUPS[id][i]?.title ?? group.label ?? "Pages",
    body: GROUPS[id][i]?.body ?? "",
    targets: [`[data-tour="nav-group-${i}"]`, SIDEBAR_TRIGGER],
    items: group.items.map((it) => ({ label: it.title, text: it.description })),
  }));
  return [INTRO[id], AREA_SWITCHER, ...groups, ...EXTRA[id], USER_MENU, REPLAY];
}
