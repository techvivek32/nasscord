/**
 * The adapter interface every broker implements (docs/real-backend.md, "Adapters"). JSDoc only.
 *
 * A broker package exports one factory from src/<broker>/index.mjs, typed as AdapterFactory (below):
 *
 *   export function createAdapter(deps) { return { descriptor, ...methods } }
 *
 * Until the package lands its index.mjs says `export const createAdapter = null`: the registry
 * skips it and GET /v1/options answers that method as not built.
 *
 * Rules every adapter follows:
 * - Read only. Every broker call goes through deps.http (createBrokerHttp) with an allowlist of the
 *   read endpoints plus the token endpoints; anything else throws before the network. A test per
 *   adapter proves the allowlist.
 * - Never log a query string, token, key, code or response body. Log ids and statuses only.
 * - Sandbox (sample data) only when !config.production. Paper only for the user's own paper account.
 * - Secrets live in broker_secrets (deps.oauth2.loadSecret / saveSecret, or deps.secretBox), sealed
 *   with the connection id as AAD.
 * - `accountId` in every read answer is broker_accounts.id, never the broker's own number.
 *
 * @typedef {import("./db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("./db.mjs").AccountRow} AccountRow
 * @typedef {import("./db.mjs").AccountRowInput} AccountRowInput
 * @typedef {import("./db.mjs").ConnectionMethod} ConnectionMethod
 * @typedef {import("./db.mjs").Environment} Environment
 * @typedef {import("./mapping.mjs").BrokerId} BrokerId
 * @typedef {import("./mapping.mjs").AccountSummary} AccountSummary
 * @typedef {import("./mapping.mjs").Position} Position
 * @typedef {import("./mapping.mjs").Order} Order
 * @typedef {import("./mapping.mjs").Execution} Execution
 * @typedef {import("./jwt.mjs").ServiceClaims} Claims
 * @typedef {import("./oauth2.mjs").OAuthProfile} OAuthProfile
 * @typedef {import("./oauth2.mjs").OAuthSecret} OAuthSecret
 * @typedef {import("./oauth2.mjs").TokenSet} TokenSet
 * @typedef {import("./http.mjs").BrokerHttp} BrokerHttp
 * @typedef {import("./http.mjs").BrokerHttpOptions} BrokerHttpOptions
 *
 * @typedef {"gateway_login" | "oauth1_verifier" | "api_key" | "oauth2_user_app" | "oauth2_platform" | "aggregator_portal"} ConnectFlow
 * @typedef {"user" | "platform"} OAuthClientKind
 *
 * What renew tells the app to do next (the app's renew route answers it to the browser):
 * - gateway_login: open /api/broker/ibkr/login/[id] (IBKR)
 * - oauth1_verifier: open authorizeUrl and paste the new code (E*TRADE)
 * - api_key: open the key dialog in replace-key mode (Alpaca, Tradier token)
 * - redirect: open the canonical hop for a new broker login (OAuth, SnapTrade); the app builds the URL
 * @typedef {{ kind: "gateway_login" } | { kind: "oauth1_verifier", authorizeUrl: string } | { kind: "api_key" } | { kind: "redirect" }} RenewNext
 *
 * @typedef {{
 *   method: ConnectionMethod,
 *   brokers: BrokerId[],
 *   name: string,
 *   environments: Environment[],
 *   readTtlMs: { portfolio: number, orders: number, executions: number },
 *   lazyAccounts?: boolean,
 *   sweepEveryMs?: number | null,
 *   clients?: OAuthClientKind[],
 * }} AdapterDescriptor
 * - method: the broker_connections.method this adapter serves (one adapter per method).
 * - brokers: the broker ids it connects (several only for SnapTrade).
 * - name: the broker's name in sentences ("Alpaca", "Schwab").
 * - environments: every environment the method can offer. "sandbox" is dropped in production by the
 *   registry; environmentsFor(config) narrows it further at runtime.
 * - readTtlMs: how long a read answer is reused (the cache key is per connection and accounts).
 * - lazyAccounts: reads call syncAccounts first when the connection has no accounts stored yet.
 *   Whatever it says, a connection whose account list failed right after connecting ("it loads
 *   on the next refresh") gets its list loaded by the next read.
 * - sweepEveryMs: the scheduler calls refresh() on every active connection this often (and sweep()).
 * - clients: OAuth methods only: "user" (the user's own app) and/or "platform" (Nasscord's client).
 *
 * @typedef {{
 *   config: import("./config.mjs").Config,
 *   store: import("./db.mjs").Store,
 *   secretBox: import("./secrets.mjs").SecretBox,
 *   limiter: import("./limits.mjs").Limiter,
 *   cache: import("./cache.mjs").CoalescingCache,
 *   locks: import("./locks.mjs").Locks,
 *   oauth2: import("./oauth2.mjs").OAuth2Engine,
 *   log: import("./log.mjs").Logger,
 *   now: () => number,
 *   fetch: typeof fetch,
 *   urls: Readonly<Record<string, string>>,
 *   http: (opts: Omit<BrokerHttpOptions, "limiter" | "fetch">) => BrokerHttp,
 * }} AdapterDeps
 * - urls: BROKER_URL_OVERRIDES[<broker id or method>] (local fakes, refused in production) merged
 *   over nothing: the adapter applies them over its own default hosts.
 * - http: createBrokerHttp with the shared limiter and fetch already bound.
 *
 * One factory per broker folder. It may serve several methods (Tradier: tradier_token and
 * tradier_oauth) by returning one adapter per method.
 * @typedef {(deps: AdapterDeps) => BrokerAdapter | BrokerAdapter[]} AdapterFactory
 *
 * api_key flow. The adapter checks the key with the broker (a read call) and answers what to store;
 * flows.mjs writes the rows, reuses a connection of the same login (external_ref) and audits.
 * @typedef {{ environment: Environment | null, keyId: string | null, secret: string }} KeyInput
 * @typedef {{
 *   environment: Environment,
 *   externalRef: string,
 *   secret: Record<string, unknown>,
 *   accounts: Array<Omit<AccountRowInput, "connection_id" | "workspace_id">>,
 *   scope?: string | null,
 *   sessionExpiresAt?: string | null,
 * }} KeyResult
 *
 * OAuth flows. After the code exchange (canonical host) identify() names the login; after the
 * claim (the user's own host) listAccounts() loads the accounts.
 * @typedef {{ externalRef?: string | null, scope?: string | null, extra?: Record<string, unknown> }} Identity
 *
 * Aggregator flow (SnapTrade).
 * @typedef {{ connection: ConnectionRow, brokerId: BrokerId, redirectUrl: string, reconnect: string | null }} PortalRequest
 * @typedef {{ externalRef: string, dataAsOf?: string | null }} AggregatorIdentity
 *
 * @typedef {{ connectionId: string, message: string }} PartialError
 *
 * @typedef {{
 *   descriptor: AdapterDescriptor,
 *   portfolio?: (c: ConnectionRow, a: AccountRow[]) => Promise<{ accounts: AccountSummary[], positions: Position[], errors?: PartialError[] }>,
 *   balances?: (c: ConnectionRow, a: AccountRow[]) => Promise<{ accounts: AccountSummary[], errors?: PartialError[] }>,
 *   positions?: (c: ConnectionRow, a: AccountRow[]) => Promise<Position[]>,
 *   orders: (c: ConnectionRow, a: AccountRow[]) => Promise<Order[]>,
 *   executions: (c: ConnectionRow, a: AccountRow[]) => Promise<Execution[]>,
 *   listAccounts?: (c: ConnectionRow) => Promise<Array<Omit<AccountRowInput, "connection_id" | "workspace_id">>>,
 *   syncAccounts?: (c: ConnectionRow) => Promise<unknown>,
 *   accountsPending?: (c: ConnectionRow) => boolean,
 *   refresh?: (c: ConnectionRow) => Promise<"ok" | "expired" | "skipped">,
 *   renew?: (c: ConnectionRow, ctx: { returnOrigin: string | null, bindingHash: string | null }) => Promise<{ connection: ConnectionRow, next?: RenewNext, loginUrl?: string }>,
 *   revoke?: (c: ConnectionRow) => Promise<void>,
 *   forget?: (id: string) => void,
 *   environmentsFor?: (config: import("./config.mjs").Config) => Environment[],
 *   configured?: (client: OAuthClientKind | null) => string | null,
 *   checkClient?: (input: { clientId: string, clientSecret?: string }) => void,
 *   connectKey?: (ctx: { claims: Claims, existing: ConnectionRow | null }, input: KeyInput) => Promise<KeyResult>,
 *   oauthProfile?: (environment: Environment, client: OAuthClientKind) => OAuthProfile,
 *   identify?: (c: ConnectionRow, tokens: TokenSet, secret: OAuthSecret) => Promise<Identity>,
 *   portalUrl?: (req: PortalRequest) => Promise<string>,
 *   aggregatorComplete?: (c: ConnectionRow, input: { authorizationId: string, startedAt?: number | null }) => Promise<AggregatorIdentity>,
 *   aggregatorRefused?: (c: ConnectionRow, input: { authorizationId: string, startedAt?: number | null }) => Promise<void>,
 *   webhook?: (req: { headers: Record<string, string | string[] | undefined>, rawBody: Buffer }) => Promise<{ status: number, body?: unknown }>,
 *   sweep?: () => Promise<void>,
 * }} BrokerAdapter
 * Reads: implement portfolio (one combined call), or balances + positions (run in parallel).
 * - refresh: lazily before reads is the adapter's own business; the scheduler calls it every
 *   sweepEveryMs. "expired" means the adapter marked the connection expired.
 * - renew: optional. Without it flows.mjs renews generically: refresh() first, then api_key or a new
 *   redirect login by the flow.
 * - revoke: broker-side clean-up on Disconnect (best effort; never TradeStation's /oauth/revoke).
 * - configured: why a client is not usable on this server (a sentence for the owner), or null.
 * - checkClient: oauth2_user_app only; flows.startOAuth calls it with the pasted app key and secret
 *   before any row is written, and it throws an HttpError (400) with a sentence when the key cannot
 *   be used (TradeStation's legacy keys).
 * - connectKey: api_key flow; `existing` is the connection being re-keyed (replace-key mode) or null.
 * - oauthProfile: OAuth flows; identify: after the code exchange, and it MUST answer an externalRef
 *   (the one-login index and the duplicate merge depend on it): the broker's account or customer id,
 *   or loginRef() from oauth2.mjs (the id_token sub, else sha256 of the App Key and the sorted
 *   account hashes: Schwab). tokens.raw is the broker's whole token answer (Webull's identity_id).
 *   On a Reconnect the login must be the one the connection holds (an "h:" loginRef may change with
 *   the account list), or the callback answers 409 other_account.
 * - portalUrl / aggregatorComplete: aggregator flow; aggregatorComplete MUST answer a non-empty
 *   externalRef too (the SnapTrade authorization id), and takes only an authorization the aggregator
 *   made since `startedAt` (epoch ms, when this login started) unless it is the one the connection
 *   holds (a Reconnect). aggregatorRefused (optional): the canonical callback refused the login
 *   (binding, window, status); delete the authorization its portal made when no connection holds it.
 * - webhook: POST /hooks/<method or broker id>, no service JWT; verify the broker's signature.
 */
export {};
