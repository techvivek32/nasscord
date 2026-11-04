/**
 * One-line JSON logger. Meta keys that could hold a secret are replaced with "[redacted]"
 * before anything is written, so a careless `log.info("x", { consumerSecret })` cannot leak.
 */

const LEVELS = /** @type {const} */ ({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/** @typedef {keyof typeof LEVELS} LogLevel */
/**
 * @typedef {{
 *   debug: (msg: string, meta?: Record<string, unknown>) => void,
 *   info: (msg: string, meta?: Record<string, unknown>) => void,
 *   warn: (msg: string, meta?: Record<string, unknown>) => void,
 *   error: (msg: string, meta?: Record<string, unknown>) => void,
 *   child: (base: Record<string, unknown>) => Logger,
 * }} Logger
 */

const SECRET_KEY = /secret|token|password|passwd|authorization|cookie|verifier|signature|apikey|api_key|^key$|private/i;

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: /** @type {any} */ (value).code };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

/**
 * @param {{ level?: string, write?: (line: string) => void, base?: Record<string, unknown> }} [opts]
 * @returns {Logger}
 */
export function createLogger(opts = {}) {
  const levelName = /** @type {LogLevel} */ (opts.level && opts.level in LEVELS ? opts.level : "info");
  const min = LEVELS[levelName];
  const write = opts.write ?? ((line) => process.stdout.write(line + "\n"));
  const base = opts.base ?? {};

  /** @param {LogLevel} level */
  const at = (level) => (/** @type {string} */ msg, /** @type {Record<string, unknown>} */ meta = {}) => {
    if (LEVELS[level] < min) return;
    const entry = { t: new Date().toISOString(), level, msg, ...base, .../** @type {object} */ (redact(meta)) };
    try {
      write(JSON.stringify(entry));
    } catch {
      write(JSON.stringify({ t: entry.t, level, msg }));
    }
  };

  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (more) => createLogger({ level: levelName, write, base: { ...base, ...more } }),
  };
}

/** A logger that writes nothing (tests). */
export const silentLogger = createLogger({ level: "silent" });
