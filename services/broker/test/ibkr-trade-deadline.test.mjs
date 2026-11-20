import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createGatewayHttp, GatewayHttpError } from "../src/ibkr/gateway-http.mjs";

/**
 * gateway-http's order door (trade) measures the caller's deadline again after the rate limiter's
 * wait (design 1.10: no step starts after the deadline). A fake gateway on 127.0.0.1 counts what
 * reaches it; no real gateway or broker is called.
 */

async function fakeGateway() {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ order_id: "1", order_status: "Submitted" }]));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return { port, hits: () => hits, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

test("trade: a limiter wait that eats the deadline sends nothing (not_sent); with time left it sends once", async () => {
  const gw0 = await fakeGateway();
  let clock = 1_000_000;
  const now = () => clock;
  // A limiter that waits 4 s (a back-off after a 429): the service clock moves on.
  const limiter = /** @type {any} */ ({ ibkr: async () => void (clock += 4_000) });
  const gw = createGatewayHttp({ isSlotPort: (p) => p === gw0.port, limiter, now });
  try {
    const deadline = clock + 6_000;
    const reply = "/iserver/reply/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    // 6 s left before the wait, 2 s after it: below the order POST's 5 s minimum.
    await assert.rejects(
      gw.trade("c1", gw0.port, "POST", "/iserver/account/DU123/orders", { orders: [] }, { timeoutMs: 20_000, notAfter: deadline, minLeftMs: 5_000 }),
      (e) => e instanceof GatewayHttpError && e.code === "not_sent" && /no time left/.test(e.message),
    );
    assert.equal(gw0.hits(), 0, "nothing reached the gateway");

    // Past the deadline after the wait: a reply is not sent either.
    await assert.rejects(
      gw.trade("c1", gw0.port, "POST", reply, { confirmed: true }, { timeoutMs: 20_000, notAfter: deadline, minLeftMs: 2_000 }),
      (e) => e instanceof GatewayHttpError && e.code === "not_sent",
    );
    assert.equal(gw0.hits(), 0);

    // Enough time after the wait: sent once.
    const res = await gw.trade("c1", gw0.port, "POST", reply, { confirmed: true }, { timeoutMs: 20_000, notAfter: clock + 10_000, minLeftMs: 2_000 });
    assert.equal(res.status, 200);
    assert.equal(gw0.hits(), 1);

    // Without notAfter the old behaviour stays (the caller's timeout only).
    const plain = await gw.trade("c1", gw0.port, "POST", reply, { confirmed: true }, { timeoutMs: 5_000 });
    assert.equal(plain.status, 200);
    assert.equal(gw0.hits(), 2);
  } finally {
    await gw0.close();
  }
});
