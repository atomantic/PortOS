import { describe, it, expect } from "vitest";
import { createFileWriteQueue } from "./fileWriteQueue.js";

// Defer one event-loop tick (setImmediate is a check-phase macrotask, not a
// microtask) so we can interleave with another awaiter.
const tick = () => new Promise((r) => setImmediate(r));

describe("createFileWriteQueue", () => {
  it("runs queued fns in submission order even when their work yields", async () => {
    const queue = createFileWriteQueue();
    const order = [];
    const a = queue(async () => { await tick(); order.push("a"); });
    const b = queue(async () => { order.push("b"); });
    const c = queue(async () => { await tick(); order.push("c"); });
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("an earlier rejection does not poison later waiters AND order is preserved", async () => {
    const queue = createFileWriteQueue();
    const order = [];
    // Without `tail.then(fn, fn)` (running fn on the rejection path), a
    // rejected tail would skip the next call's fn — the second test below
    // would fail. The `tick()` ensures the order assertion fails for a
    // pass-through queue (where parallel fns would land in submission order
    // but the rejecting one would still log AFTER the fast resolver).
    const bad = queue(async () => { await tick(); order.push("bad"); throw new Error("nope"); });
    const good = queue(async () => { order.push("good"); return "ok"; });
    await expect(bad).rejects.toThrow("nope");
    await expect(good).resolves.toBe("ok");
    expect(order).toEqual(["bad", "good"]);
  });

  it("each call sees the resolved value of its own fn", async () => {
    const queue = createFileWriteQueue();
    const r1 = await queue(() => Promise.resolve(1));
    const r2 = await queue(() => Promise.resolve(2));
    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });

  it("separate queues are independent", async () => {
    const qA = createFileWriteQueue();
    const qB = createFileWriteQueue();
    const order = [];
    // qA's work yields; qB's work should not wait for it.
    const aSlow = qA(async () => { await tick(); order.push("a-slow"); });
    const bFast = qB(async () => { order.push("b-fast"); });
    await Promise.all([aSlow, bFast]);
    expect(order).toEqual(["b-fast", "a-slow"]);
  });
});
