/**
 * Preloaded with `node --import` by process-exit.test.mjs. Waits until the service answers
 * /health, then either throws an uncaught exception or delivers SIGTERM to its own handlers
 * (process.emit works the same on Windows, where a real SIGTERM cannot be caught).
 */
const port = Number(process.env.API_PORT);
const mode = process.env.TEST_EXIT_MODE;
const deadline = Date.now() + 20_000;

const timer = setInterval(() => {
  fetch(`http://127.0.0.1:${port}/health`).then(
    (r) => {
      if (!r.ok) return;
      clearInterval(timer);
      if (mode === "sigterm") process.emit("SIGTERM", "SIGTERM");
      else
        setImmediate(() => {
          throw new Error("test crash after start");
        });
    },
    () => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        process.exit(99);
      }
    },
  );
}, 100);
