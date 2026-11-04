import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { unavailable } from "../errors.mjs";

/**
 * One IBKR Client Portal Gateway JVM per connection (contract section 7).
 *
 * - Slots come from IBKR_GATEWAY_PORTS. A slot is held by one connection until it is released
 *   (disconnect, expiry plus 30 minutes, or the JVM exiting).
 * - Each slot gets <runtime>/slot-<port>/conf.yaml rendered from the bundle's root/conf.yaml with
 *   listenPort = slot, listenSsl = false, ips.allow = 127.0.0.1, and without sslCert/sslPwd: the
 *   service never copies the bundle's keystore or its password.
 * - The gateway reads `--conf` as a CLASSPATH RESOURCE (ClassLoader.getSystemResourceAsStream), not
 *   as a file path, so an absolute path fails with "Stream closed". The slot folder therefore goes
 *   first on the classpath (ahead of <bundle>/root, whose own conf.yaml would otherwise win) and
 *   the JVM gets `--conf conf.yaml`.
 * - At most one JVM per connection: concurrent starts share one launch, and a start waits for a
 *   gateway of the same connection that is still stopping to exit before it launches another.
 * - A released port is handed out again only after its slot folder is removed.
 * - A restart is a session loss: the IBKR login lives inside the JVM.
 */

export const GATEWAY_JAR = path.join("dist", "ibgroup.web.core.iblink.router.clientportal.gw.jar");
export const GATEWAY_MAIN = "ibgroup.web.core.clientportal.gw.GatewayStart";

/**
 * Renders a slot's conf.yaml from the bundle template.
 * @param {string} template contents of <bundle>/root/conf.yaml
 * @param {number} port
 */
export function renderGatewayConf(template, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("bad port");
  const lines = template.replace(/\r\n/g, "\n").split("\n");
  /** @type {string[]} */
  const out = [];
  let sawPort = false;
  let sawSsl = false;
  let sawIps = false;
  /** indentation of a block being replaced; -1 when not inside one */
  let skipIndent = -1;
  const indentOf = (/** @type {string} */ l) => /^ */.exec(l)?.[0].length ?? 0;
  // Top-level keys in the IBKR template are indented by 4 spaces; follow whatever it uses.
  const topIndent = lines.filter((l) => /^\s*[A-Za-z]/.test(l)).reduce((m, l) => Math.min(m, indentOf(l)), Infinity);
  const pad = " ".repeat(Number.isFinite(topIndent) ? topIndent : 0);

  for (const line of lines) {
    if (skipIndent >= 0) {
      if (line.trim() === "" || indentOf(line) > skipIndent || /^\s*-/.test(line) && indentOf(line) >= skipIndent) continue;
      skipIndent = -1;
    }
    const key = /^(\s*)([A-Za-z0-9_.]+)\s*:/.exec(line);
    if (key && key[1].length === (Number.isFinite(topIndent) ? topIndent : 0)) {
      const name = key[2];
      if (name === "listenPort") {
        out.push(`${pad}listenPort: ${port}`);
        sawPort = true;
        continue;
      }
      if (name === "listenSsl") {
        out.push(`${pad}listenSsl: false`);
        sawSsl = true;
        continue;
      }
      if (name === "sslCert" || name === "sslPwd") continue; // never carried into the runtime folder
      if (name === "ips") {
        out.push(`${pad}ips:`, `${pad}  allow:`, `${pad}    - 127.0.0.1`, `${pad}  deny: []`);
        sawIps = true;
        skipIndent = key[1].length;
        continue;
      }
    }
    out.push(line);
  }
  if (!sawPort) out.push(`${pad}listenPort: ${port}`);
  if (!sawSsl) out.push(`${pad}listenSsl: false`);
  if (!sawIps) out.push(`${pad}ips:`, `${pad}  allow:`, `${pad}    - 127.0.0.1`, `${pad}  deny: []`);
  return out.join("\n").replace(/\n*$/, "\n");
}

/**
 * Variables a gateway JVM may inherit. Everything else in the service's environment (the Supabase
 * service-role key, BROKER_SERVICE_SECRET, BROKER_TOKEN_KEY) stays out of the third-party process:
 * it serves pages to browsers through the login host, and a bug in it must not hand over the
 * database, the ticket key or the key to every stored E*TRADE secret.
 */
export const GATEWAY_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "JAVA_HOME",
  // Windows needs these to start a JVM at all.
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "PATHEXT",
  "COMSPEC",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

/**
 * The environment for a gateway JVM: only GATEWAY_ENV_KEYS, copied from `env`.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string>}
 */
export function gatewayEnv(env = process.env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of GATEWAY_ENV_KEYS) {
    const v = env[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

/**
 * The java command line for one slot. Classpath entries are joined with path.delimiter
 * (":" on Linux, ";" on Windows).
 * @param {{ bundle: string, slotDir: string, xmx: string }} o
 */
export function buildJavaArgs({ bundle, slotDir, xmx }) {
  const classpath = [
    slotDir,
    path.join(bundle, "root"),
    path.join(bundle, GATEWAY_JAR),
    path.join(bundle, "build", "lib", "runtime", "*"),
  ].join(path.delimiter);
  return [
    "-server",
    `-Xmx${xmx}`,
    "-Dvertx.disableDnsResolver=true",
    "-Djava.net.preferIPv4Stack=true",
    "-Dvertx.logger-delegate-factory-class-name=io.vertx.core.logging.SLF4JLogDelegateFactory",
    "-Dnologback.statusListenerClass=ch.qos.logback.core.status.OnConsoleStatusListener",
    "-Dnolog4j.debug=true",
    "-Dnolog4j2.debug=true",
    "-cp",
    classpath,
    GATEWAY_MAIN,
    "--conf",
    "conf.yaml",
  ];
}

/**
 * True when nothing is listening on 127.0.0.1:port.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * Any HTTP answer from the gateway's root means it is listening.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function probeGateway(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", agent: false, timeout: 2_000 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) > 0);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * @typedef {{
 *   port: number,
 *   connectionId: string,
 *   dir: string,
 *   proc: import("node:child_process").ChildProcess | null,
 *   startedAt: number,
 *   ready: boolean,
 *   readyPromise: Promise<boolean>,
 *   launching: boolean,
 *   stopping: boolean,
 *   failed: boolean,
 *   released: boolean,
 *   exited: Promise<void>,
 *   onExited: () => void,
 *   expiredAt: number | null,
 *   output: string[],
 * }} Slot
 */

/**
 * @param {{
 *   bundle: string,
 *   runtime: string,
 *   ports: number[],
 *   javaBin?: string,
 *   xmx?: string,
 *   log: import("../log.mjs").Logger,
 *   spawn?: typeof nodeSpawn,
 *   probe?: (port: number) => Promise<boolean>,
 *   isPortFree?: (port: number) => Promise<boolean>,
 *   now?: () => number,
 *   readyTimeoutMs?: number,
 *   stopTimeoutMs?: number,
 *   pollMs?: number,
 * }} opts
 */
export function createGatewayManager(opts) {
  const {
    bundle,
    runtime,
    ports,
    javaBin = "java",
    xmx = "256m",
    log,
    spawn = nodeSpawn,
    probe = probeGateway,
    isPortFree = portIsFree,
    now = Date.now,
    readyTimeoutMs = 60_000,
    stopTimeoutMs = 8_000,
    pollMs = 500,
  } = opts;
  const portSet = new Set(ports);
  const events = new EventEmitter();
  /**
   * Every slot that holds a port, including one whose JVM has exited and whose folder is still
   * being removed (`released`).
   * @type {Map<number, Slot>}
   */
  const slots = new Map();
  /** connection id -> port of its current gateway (one at most) */
  /** @type {Map<string, number>} */
  const byConnection = new Map();
  /** connection id -> the start() in progress for it, so two starts never launch two JVMs */
  /** @type {Map<string, Promise<number>>} */
  const starting = new Map();
  /** ports found busy (an orphan JVM or another program): skipped for a while */
  /** @type {Map<number, number>} */
  const blocked = new Map();
  let closed = false;

  /** @param {number} port */
  const slotDir = (port) => path.join(runtime, `slot-${port}`);

  /** @param {string} connectionId */
  const slotOf = (connectionId) => {
    const port = byConnection.get(connectionId);
    return port === undefined ? undefined : slots.get(port);
  };

  /** @param {Slot} slot */
  const alive = (slot) => !!slot.proc && slot.proc.exitCode === null && slot.proc.signalCode === null;

  /**
   * Picks a free slot and reserves it synchronously, so two starts never race for one port.
   * @param {string} connectionId
   */
  function reserve(connectionId) {
    for (const port of ports) {
      if (slots.has(port)) continue;
      const until = blocked.get(port);
      if (until && until > now()) continue;
      let onExited = () => {};
      /** @type {Promise<void>} */
      const exited = new Promise((r) => {
        onExited = () => r(undefined);
      });
      /** @type {Slot} */
      const slot = {
        port,
        connectionId,
        dir: slotDir(port),
        proc: null,
        startedAt: now(),
        ready: false,
        readyPromise: Promise.resolve(false),
        launching: true,
        stopping: false,
        failed: false,
        released: false,
        exited,
        onExited,
        expiredAt: null,
        output: [],
      };
      slots.set(port, slot);
      byConnection.set(connectionId, port);
      return slot;
    }
    return null;
  }

  /** @param {Slot} slot */
  function unmap(slot) {
    slot.released = true;
    if (byConnection.get(slot.connectionId) === slot.port) byConnection.delete(slot.connectionId);
  }

  /**
   * The JVM is gone (or never started). The connection loses the slot at once; the port is only
   * handed out again once the slot folder is removed, so a new launch on the same port never has
   * its conf.yaml deleted under it.
   * @param {Slot} slot
   * @returns {Promise<void>}
   */
  function release(slot) {
    if (slot.released) return slot.exited;
    unmap(slot);
    // Gateway logs can name accounts; nothing of a released slot is kept.
    void fsp
      .rm(slot.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      .catch(() => {})
      .finally(() => {
        if (slots.get(slot.port) === slot) slots.delete(slot.port);
        slot.onExited();
      });
    return slot.exited;
  }

  /**
   * A slot that never touched the disk (its port was busy): given back at once.
   * @param {Slot} slot
   */
  function drop(slot) {
    unmap(slot);
    if (slots.get(slot.port) === slot) slots.delete(slot.port);
    slot.onExited();
  }

  /** @param {Slot} slot */
  function waitReady(slot) {
    const deadline = now() + readyTimeoutMs;
    return (async () => {
      while (now() < deadline) {
        if (slot.released || slot.stopping || !alive(slot)) return false;
        if (await probe(slot.port)) {
          slot.ready = true;
          return true;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      // Alive but never listening: start() replaces it instead of handing it out again.
      slot.failed = true;
      log.warn("gateway did not start listening in time", { port: slot.port, connectionId: slot.connectionId });
      return false;
    })();
  }

  /** @param {Slot} slot */
  async function launch(slot) {
    const template = await fsp.readFile(path.join(bundle, "root", "conf.yaml"), "utf8");
    await fsp.rm(slot.dir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(slot.dir, { recursive: true });
    await fsp.writeFile(path.join(slot.dir, "conf.yaml"), renderGatewayConf(template, slot.port), { mode: 0o600 });

    // Stopped (shutdown, a release) while the folder was being written: never spawn for it.
    if (slot.stopping || slot.released || closed) throw new Error("the slot was stopped before the gateway started");
    const args = buildJavaArgs({ bundle, slotDir: slot.dir, xmx });
    const proc = spawn(javaBin, args, {
      cwd: slot.dir, // the gateway writes logs/ relative to its working folder
      env: gatewayEnv(), // never the service's secrets
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    });
    slot.proc = proc;
    slot.startedAt = now();
    /** @param {Buffer} chunk */
    const keep = (chunk) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        slot.output.push(line.slice(0, 300));
        if (slot.output.length > 40) slot.output.shift();
      }
    };
    proc.stdout?.on("data", keep);
    proc.stderr?.on("data", keep);

    let launched = false;
    // Registered before any await so a JVM that dies at once is still seen.
    proc.once("exit", (code, signal) => {
      const expected = slot.stopping || !launched;
      void release(slot);
      if (!launched) return; // start() reports the failure itself
      log[expected ? "info" : "warn"]("gateway exited", { port: slot.port, connectionId: slot.connectionId, code, signal, expected });
      // `port` says WHICH gateway of the connection exited: an old one being replaced says
      // nothing about the one the connection runs on now.
      events.emit("exit", { connectionId: slot.connectionId, port: slot.port, code, signal, expected });
    });

    // "spawn" or "error" (java missing, not executable) decides whether the launch worked.
    await new Promise((resolve, reject) => {
      proc.once("spawn", resolve);
      proc.once("error", reject);
    });
    launched = true;
    proc.on("error", (err) => {
      log.error("gateway process error", { port: slot.port, connectionId: slot.connectionId, error: err });
    });
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error("the gateway exited right after it started");
    }
    try {
      await fsp.writeFile(path.join(slot.dir, "gateway.pid"), String(proc.pid ?? ""), { mode: 0o600 });
    } catch {
      /* best effort */
    }

    slot.readyPromise = waitReady(slot);
    return slot;
  }

  /**
   * Stops a slot's JVM. Resolves once it has exited and the slot is released. Safe to call twice.
   * @param {Slot} slot
   * @returns {Promise<void>}
   */
  function kill(slot) {
    if (slot.released || slot.stopping) return slot.exited;
    slot.stopping = true;
    const proc = slot.proc;
    // Still launching: launch() sees `stopping` before it spawns and startNow() releases the slot.
    if (!proc && slot.launching) return slot.exited;
    if (!proc || !alive(slot)) return release(slot);
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, stopTimeoutMs);
    void slot.exited.then(() => clearTimeout(timer));
    try {
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      return release(slot);
    }
    // the exit handler releases the slot and removes the folder
    return slot.exited;
  }

  /**
   * @param {string} connectionId
   * @returns {Promise<number>}
   */
  async function startNow(connectionId) {
    // One JVM per connection. A gateway still being stopped (a slot release, a restart) exits
    // first; one that died or never started listening is replaced; a healthy one is reused.
    const current = slotOf(connectionId);
    if (current) {
      if (!current.stopping && alive(current) && !current.failed) {
        current.expiredAt = null; // wanted again: no longer a release candidate
        return current.port;
      }
      await kill(current);
    }
    if (closed) throw unavailable("The broker service is restarting. Try again in a minute.", "shutting_down");
    for (let attempt = 0; attempt < ports.length; attempt++) {
      const slot = reserve(connectionId);
      if (!slot) break;
      if (!(await isPortFree(slot.port))) {
        // Something else (an orphaned JVM from a crash, another program) holds the port.
        log.warn("gateway port busy, skipping it for 10 minutes", { port: slot.port });
        blocked.set(slot.port, now() + 10 * 60_000);
        drop(slot);
        continue;
      }
      try {
        await launch(slot);
      } catch (e) {
        slot.launching = false;
        const stopped = slot.stopping || closed;
        await release(slot);
        if (stopped) {
          log.info("gateway stopped before it started", { port: slot.port, connectionId });
          throw unavailable("The IBKR login was stopped before it started. Press Reconnect to try again.", "gateway_stopped");
        }
        log.error("gateway launch failed", { port: slot.port, error: e });
        throw unavailable("IBKR connections are not available on this server right now.", "gateway_launch");
      }
      slot.launching = false;
      log.info("gateway started", { port: slot.port, connectionId, pid: slot.proc?.pid });
      return slot.port;
    }
    throw unavailable("Every IBKR login slot on this server is in use. Try again in a few minutes.", "no_slots");
  }

  /**
   * Starts (or reuses) the gateway of a connection. Returns its port without waiting for it to
   * listen; use whenReady() for that. Concurrent calls for one connection share one launch.
   * @param {string} connectionId
   * @returns {Promise<number>}
   */
  function start(connectionId) {
    const inflight = starting.get(connectionId);
    if (inflight) return inflight;
    const p = startNow(connectionId).finally(() => {
      if (starting.get(connectionId) === p) starting.delete(connectionId);
    });
    starting.set(connectionId, p);
    return p;
  }

  /**
   * Stops every gateway of the connection (after a start in progress for it) and releases the
   * slots.
   * @param {string} connectionId
   */
  async function stop(connectionId) {
    const inflight = starting.get(connectionId);
    if (inflight) await inflight.catch(() => {});
    const own = [...slots.values()].filter((s) => s.connectionId === connectionId && !s.released);
    if (!own.length) return;
    log.info("stopping gateway", { ports: own.map((s) => s.port), connectionId });
    await Promise.all(own.map((s) => kill(s)));
  }

  return {
    events,
    ports,

    /** @param {number} port */
    isSlotPort: (port) => portSet.has(port),

    bundleAvailable() {
      return (
        existsSync(path.join(bundle, "root", "conf.yaml")) &&
        existsSync(path.join(bundle, GATEWAY_JAR)) &&
        existsSync(path.join(bundle, "build", "lib", "runtime"))
      );
    },

    /** @param {string} connectionId */
    portFor: (connectionId) => byConnection.get(connectionId) ?? null,

    /** @param {string} connectionId */
    isReady(connectionId) {
      return !!slotOf(connectionId)?.ready;
    },

    /**
     * Resolves true once the gateway answers HTTP (or false if it died or timed out).
     * @param {string} connectionId
     */
    async whenReady(connectionId) {
      const inflight = starting.get(connectionId);
      if (inflight) {
        try {
          await inflight;
        } catch {
          return false;
        }
      }
      const slot = slotOf(connectionId);
      if (!slot) return false;
      return slot.ready || slot.readyPromise;
    },

    start,
    stop,

    /**
     * Stops one slot, and only while it still belongs to `connectionId` when that is given. The
     * scheduler releases by port, so it never stops a different gateway than the one it checked.
     * @param {number} port
     * @param {string} [connectionId]
     */
    async stopSlot(port, connectionId) {
      const slot = slots.get(port);
      if (!slot || slot.released) return;
      if (connectionId !== undefined && slot.connectionId !== connectionId) return;
      log.info("stopping gateway", { port, connectionId: slot.connectionId });
      await kill(slot);
    },

    /**
     * Stop and start again. The IBKR login inside the old JVM is gone: callers treat this as a
     * session loss and ask the user to log in again.
     * @param {string} connectionId
     */
    async restart(connectionId) {
      await stop(connectionId);
      return start(connectionId);
    },

    /** Shutdown: no new launches, every JVM stopped. */
    async stopAll() {
      closed = true;
      await Promise.allSettled([...starting.values()]);
      await Promise.all([...slots.values()].map((s) => kill(s)));
    },

    /** Synchronous last resort on process exit. */
    killAllSync() {
      for (const s of slots.values()) {
        try {
          s.proc?.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
    },

    /**
     * Remembers when the connection behind a slot stopped being usable (for "expiry plus 30 minutes").
     * @param {string} connectionId
     * @param {number | null} at
     */
    markExpired(connectionId, at) {
      const slot = slotOf(connectionId);
      if (slot) slot.expiredAt = at === null ? null : slot.expiredAt ?? at;
    },

    /** Slots with a live or launching gateway (a released slot whose folder is being removed is left out). */
    list() {
      return [...slots.values()]
        .filter((s) => !s.released)
        .map((s) => ({
          port: s.port,
          connectionId: s.connectionId,
          pid: s.proc?.pid ?? null,
          startedAt: s.startedAt,
          ready: s.ready,
          stopping: s.stopping,
          expiredAt: s.expiredAt,
        }));
    },

    /** @param {string} connectionId last lines the JVM printed (diagnostics) */
    output(connectionId) {
      return [...(slotOf(connectionId)?.output ?? [])];
    },

    stats() {
      const running = [...slots.values()].filter((s) => !s.released).length;
      return { running, slotsFree: Math.max(0, ports.length - slots.size), total: ports.length };
    },

    /**
     * Boot clean-up: removes slot folders left by a previous run and, on Linux, stops gateway JVMs
     * a crashed run left behind (only when /proc confirms the pid is a GatewayStart process).
     */
    async cleanupRuntime() {
      await fsp.mkdir(runtime, { recursive: true });
      const entries = await fsp.readdir(runtime, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory() || !/^slot-\d+$/.test(e.name)) continue;
        const dir = path.join(runtime, e.name);
        const pidFile = path.join(dir, "gateway.pid");
        if (process.platform === "linux" && existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, "utf8").trim());
          try {
            const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
            if (pid > 1 && cmd.includes(GATEWAY_MAIN) && cmd.includes(dir)) {
              process.kill(pid, "SIGKILL");
              log.warn("stopped an orphaned gateway", { pid, slot: e.name });
            }
          } catch {
            /* not running */
          }
        }
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

/** @typedef {ReturnType<typeof createGatewayManager>} GatewayManager */
