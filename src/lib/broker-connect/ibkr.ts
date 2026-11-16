import type { ConnectSpec } from "@/lib/types";

/** Interactive Brokers: a Client Portal gateway per connection, logged in on IBKR's own page. */
export const IBKR_CONNECT: ConnectSpec[] = [
  {
    flow: "gateway_login",
    method: "ibkr_gateway",
    title: "Log in on IBKR's own page",
    summary: "Log in on IBKR's own page, with its second factor. Live or paper. A session lasts about a day.",
    environments: [
      { value: "production", label: "Live", hint: "Your real IBKR account, with your usual username." },
      { value: "paper", label: "Paper", hint: "Your IBKR paper account, with its paper username." },
    ],
    prerequisites: ["An IBKR account. For Paper, the username of your IBKR paper account."],
    steps: [
      "Choose Live or Paper.",
      "Nasscord starts a login session for this connection and opens the IBKR login in a new tab.",
      "Check the Nasscord workspace that page names, then log in on IBKR's own page with your username, password and second factor.",
      "Come back here. Nasscord notices the login by itself and lists your accounts.",
    ],
    warning: "IBKR allows one session per username. If you also use TWS or the IBKR mobile app, close it or use a second IBKR username for Nasscord.",
    disclosure:
      "Nasscord reads your accounts, balances, positions, orders and executions, and places no orders in this release. It never sees your IBKR password: you log in on IBKR's own page, and the session lives in a gateway Nasscord runs for this connection alone.",
    sessionNote: "IBKR ends the session about once a day. Reconnect opens the IBKR login again.",
    disconnectNote: "Disconnect stops the IBKR session Nasscord runs for this connection and removes its accounts from Nasscord.",
    unavailableReason: "IBKR connections are not set up on this server yet.",
  },
];
