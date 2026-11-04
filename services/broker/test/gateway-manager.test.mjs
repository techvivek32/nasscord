import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { HttpError } from "../src/errors.mjs";
import { buildJavaArgs, createGatewayManager, GATEWAY_MAIN, gatewayEnv, renderGatewayConf } from "../src/ibkr/gateway-manager.mjs";
import { silentLogger } from "../src/log.mjs";

// The shape of the bundle's root/conf.yaml, with a made-up keystore password.
const TEMPLATE = `    ip2loc: "US"
    proxyRemoteSsl: true
    proxyRemoteHost: "https://api.ibkr.com"
    listenPort: 5000
    listenSsl: true
    ccp: false
    svcEnvironment: "v1"
    sslCert: "vertx.jks"
    sslPwd: "test-only-password"
    authDelay: 3000
    portalBaseURL: ""
    serverOptions:
        blockedThreadCheckInterval: 1000000
        eventLoopPoolSize: 20
    cors:
        origin.allowed: "*"
        allowCredentials: false
    webApps:
        - name: "demo"
          index: "index.html"
    ips:
      allow:
        - 192.*
        - 131.216.*
        - 127.0.0.1
      deny:
        - 212.90.324.10
`;

const tmp = mkdtempSync(path.join(os.tmpdir(), "nasscord-gw-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeBundle() {
  const bundle = path.join(tmp, `bundle-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(bundle, "root"), { recursive: true });
  mkdirSync(path.join(bundle, "dist"), { recursive: true });
  mkdirSync(path.join(bundle, "build", "lib", "runtime"), { recursive: true });
  writeFileSync(path.join(bundle, "root", "conf.yaml"), TEMPLATE);
  writeFileSync(path.join(bundle, "dist", "ibgroup.web.core.iblink.router.clientportal.gw.jar"), "");
  return bundle;
}

/**
 * A ChildProcess stand-in: emits "spawn" right away, exits when killed (after `exitDelayMs`, like
 * a JVM that takes a while to shut down).
 * @param {{ exitDelayMs?: number }} [o]
 */
function fakeSpawner(o = {}) {
  /** @type {any[]} */
  const procs = [];
  let pid = 1000;
  /** @param {string} cmd @param {string[]} args @param {any} opts */
  const spawn = (cmd, args, opts) => {
    const p = /** @type {any} */ (new EventEmitter());
    p.pid = ++pid;
    p.cmd = cmd;
    p.args = args;
    p.opts = opts;
    p.exitCode = null;
    p.signalCode = null;
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.killing = false;
    p.kill = (/** @type {string} */ sig) => {
      if (p.exitCode !== null || p.signalCode !== null || p.killing) return false;
      p.killing = true;
      const done = () => {
        p.signalCode = sig;
        p.emit("exit", null, sig);
      };
      if (o.exitDelayMs) setTimeout(done, o.exitDelayMs);
      else setImmediate(done);
      return true;
    };
    p.crash = () => {
      p.exitCode = 1;
      p.emit("exit", 1, null);
    };
    procs.push(p);
    setImmediate(() => p.emit("spawn"));
    return p;
  };
  return { spawn, procs };
}

test("renderGatewayConf: slot port, plain HTTP, loopback only, no keystore settings", () => {
  const out = renderGatewayConf(TEMPLATE, 7203);
  assert.match(out, /^ {4}listenPort: 7203$/m);
  assert.match(out, /^ {4}listenSsl: false$/m);
  assert.doesNotMatch(out, /sslPwd|sslCert|test-only-password|vertx\.jks/);
  assert.doesNotMatch(out, /192\.\*|131\.216/);
  assert.match(out, / {4}ips:\n {6}allow:\n {8}- 127\.0\.0\.1\n {6}deny: \[\]\n/);
  // everything else is kept as it was
  assert.match(out, /proxyRemoteHost: "https:\/\/api\.ibkr\.com"/);
  assert.match(out, / {8}- name: "demo"\n {10}index: "index\.html"/);
  assert.match(out, / {8}origin\.allowed: "\*"/);
  assert.equal((out.match(/listenPort/g) ?? []).length, 1);
});

test("renderGatewayConf adds missing keys", () => {
  const out = renderGatewayConf('proxyRemoteHost: "https://api.ibkr.com"\n', 7210);
  assert.match(out, /^listenPort: 7210$/m);
  assert.match(out, /^listenSsl: false$/m);
  assert.match(out, /^ips:\n {2}allow:\n {4}- 127\.0\.0\.1$/m);
});

test("buildJavaArgs: slot folder first on the classpath, joined with path.delimiter, --conf conf.yaml", () => {
  const args = buildJavaArgs({ bundle: "/opt/gw", slotDir: "/var/run/slot-7200", xmx: "256m" });
  const cp = args[args.indexOf("-cp") + 1].split(path.delimiter);
  assert.deepEqual(cp, [
    "/var/run/slot-7200",
    path.join("/opt/gw", "root"),
    path.join("/opt/gw", "dist", "ibgroup.web.core.iblink.router.clientportal.gw.jar"),
    path.join("/opt/gw", "build", "lib", "runtime", "*"),
  ]);
  assert.ok(args.includes("-Xmx256m"));
  assert.deepEqual(args.slice(-3), [GATEWAY_MAIN, "--conf", "conf.yaml"]);
});

test("slots: allocation, reuse, exhaustion, release on stop and on exit", async () => {
  const bundle = fakeBundle();
  const runtime = path.join(tmp, "runtime-a");
  const { spawn, procs } = fakeSpawner();
  const m = createGatewayManager({
    bundle,
    runtime,
    ports: [7200, 7201],
    javaBin: "java-test",
    log: silentLogger,
    spawn: /** @type {any} */ (spawn),
    probe: async () => true,
    isPortFree: async () => true,
    pollMs: 5,
  });
  assert.equal(m.bundleAvailable(), true);
  assert.deepEqual(m.stats(), { running: 0, slotsFree: 2, total: 2 });

  const p1 = await m.start("conn-1");
  assert.equal(p1, 7200);
  assert.equal(await m.start("conn-1"), 7200, "same connection reuses its slot");
  const p2 = await m.start("conn-2");
  assert.equal(p2, 7201);
  await assert.rejects(m.start("conn-3"), (e) => e instanceof HttpError && e.status === 503 && e.code === "no_slots");
  assert.equal(await m.whenReady("conn-1"), true);
  assert.equal(m.isReady("conn-1"), true);

  // what was spawned
  const first = procs[0];
  assert.equal(first.cmd, "java-test");
  assert.equal(first.opts.cwd, path.join(runtime, "slot-7200"));
  const conf = readFileSync(path.join(runtime, "slot-7200", "conf.yaml"), "utf8");
  assert.match(conf, /listenPort: 7200/);
  assert.doesNotMatch(conf, /sslPwd/);
  assert.ok(!existsSync(path.join(runtime, "slot-7200", "vertx.jks")));

  // stop releases the slot and removes the folder before it resolves
  /** @type {any[]} */
  const exits = [];
  m.events.on("exit", (e) => exits.push(e));
  await m.stop("conn-1");
  assert.equal(m.portFor("conn-1"), null);
  assert.equal(exits[0].expected, true);
  assert.equal(exits[0].port, 7200, "the exit says which gateway it was");
  assert.ok(!existsSync(path.join(runtime, "slot-7200")));
  assert.equal(await m.start("conn-3"), 7200, "freed slot is handed out again");

  // a crash releases the slot and is reported as unexpected
  procs[1].crash();
  assert.equal(m.portFor("conn-2"), null);
  assert.equal(exits[1].expected, false);
  assert.equal(exits[1].connectionId, "conn-2");

  await m.stopAll();
  assert.equal(m.stats().running, 0);
});

test("a busy port is skipped; a missing java is a 503 and frees the slot", async () => {
  const bundle = fakeBundle();
  const { spawn } = fakeSpawner();
  const m = createGatewayManager({
    bundle,
    runtime: path.join(tmp, "runtime-b"),
    ports: [7220, 7221],
    log: silentLogger,
    spawn: /** @type {any} */ (spawn),
    probe: async () => true,
    isPortFree: async (port) => port !== 7220,
  });
  assert.equal(await m.start("c1"), 7221);
  await m.stopAll();

  const failing = createGatewayManager({
    bundle,
    runtime: path.join(tmp, "runtime-c"),
    ports: [7230],
    log: silentLogger,
    spawn: /** @type {any} */ (() => {
      const p = /** @type {any} */ (new EventEmitter());
      p.exitCode = null;
      p.signalCode = null;
      setImmediate(() => p.emit("error", Object.assign(new Error("spawn java ENOENT"), { code: "ENOENT" })));
      return p;
    }),
    probe: async () => true,
    isPortFree: async () => true,
  });
  await assert.rejects(failing.start("c2"), (e) => e instanceof HttpError && e.status === 503 && e.code === "gateway_launch");
  assert.equal(failing.stats().running, 0);
});

test("restart is stop + start (the caller treats it as a session loss)", async () => {
  const { spawn, procs } = fakeSpawner();
  const m = createGatewayManager({
    bundle: fakeBundle(),
    runtime: path.join(tmp, "runtime-d"),
    ports: [7240],
    log: silentLogger,
    spawn: /** @type {any} */ (spawn),
    probe: async () => true,
    isPortFree: async () => true,
  });
  await m.start("c");
  await m.restart("c");
  assert.equal(procs.length, 2);
  assert.notEqual(procs[0].signalCode, null);
  assert.equal(m.portFor("c"), 7240);
  m.markExpired("c", 123);
  assert.equal(m.list()[0].expiredAt, 123);
  m.markExpired("c", null);
  assert.equal(m.list()[0].expiredAt, null);
  await m.stopAll();
});

test("two starts at once share one launch; a start waits for a stopping gateway of the connection", async () => {
  const { spawn, procs } = fakeSpawner({ exitDelayMs: 80 });
  const runtime = path.join(tmp, "runtime-e");
  const m = createGatewayManager({
    bundle: fakeBundle(),
    runtime,
    ports: [7260, 7261, 7262],
    log: silentLogger,
    spawn: /** @type {any} */ (spawn),
    probe: async () => true,
    isPortFree: async () => true,
    pollMs: 5,
  });
  // Connect and Reconnect pressed together (or a renew racing a start): one JVM.
  const ports = await Promise.all([m.start("x"), m.start("x"), m.start("x")]);
  assert.deepEqual(ports, [7260, 7260, 7260]);
  assert.equal(procs.length, 1);
  assert.equal(m.stats().running, 1);

  // The scheduler releases the slot by port while the user presses Reconnect.
  /** @type {any[]} */
  const exits = [];
  m.events.on("exit", (e) => exits.push(e));
  const releasing = m.stopSlot(7260, "x");
  const again = m.start("x");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(procs.length, 1, "nothing is launched while the old JVM is still stopping");
  const port = await again;
  await releasing;
  assert.equal(procs.length, 2);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].port, 7260);
  assert.equal(m.stats().running, 1, "one gateway for the connection, none orphaned");
  assert.equal(m.portFor("x"), port);
  assert.ok(existsSync(path.join(runtime, `slot-${port}`, "conf.yaml")), "the old slot's clean-up never deletes the new conf.yaml");

  // stopSlot only stops the slot it names, for the connection it names
  await m.stopSlot(port, "someone-else");
  await m.stopSlot(7299);
  assert.equal(m.stats().running, 1);

  // a stop right after a start waits for the launch, then stops it
  const starting = m.start("y");
  await m.stop("y");
  await starting;
  assert.equal(m.portFor("y"), null);
  assert.equal(m.list().some((s) => s.connectionId === "y"), false);

  await m.stop("x");
  assert.equal(m.stats().running, 0);
  assert.ok(procs.every((p) => p.signalCode !== null), "every JVM exited");
  await m.stopAll();
  await assert.rejects(m.start("z"), (e) => e instanceof HttpError && e.code === "shutting_down");
});

test("a gateway that never starts listening is replaced on the next start", async () => {
  const { spawn, procs } = fakeSpawner();
  let listening = false;
  const m = createGatewayManager({
    bundle: fakeBundle(),
    runtime: path.join(tmp, "runtime-f"),
    ports: [7270, 7271],
    log: silentLogger,
    spawn: /** @type {any} */ (spawn),
    probe: async () => listening,
    isPortFree: async () => true,
    readyTimeoutMs: 40,
    pollMs: 5,
  });
  await m.start("c");
  assert.equal(await m.whenReady("c"), false);
  listening = true;
  await m.start("c");
  assert.equal(procs.length, 2, "a new JVM");
  assert.notEqual(procs[0].signalCode, null, "the stuck one was stopped");
  assert.equal(await m.whenReady("c"), true);
  assert.equal(m.stats().running, 1);
  await m.stopAll();
});

test("a gateway JVM gets no secret from the service's environment", () => {
  const env = gatewayEnv({
    PATH: "/usr/bin",
    HOME: "/opt/nasscord-broker",
    JAVA_HOME: "/usr/lib/jvm/java-17",
    SUPABASE_SERVICE_ROLE_KEY: "srk",
    BROKER_SERVICE_SECRET: "secret",
    BROKER_TOKEN_KEY: "key",
    BROKER_TOKEN_KEYS_PREVIOUS: "1:old",
    SUPABASE_URL: "https://x.supabase.co",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/opt/nasscord-broker", JAVA_HOME: "/usr/lib/jvm/java-17" });
});
