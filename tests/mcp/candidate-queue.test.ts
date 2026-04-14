import { describe, expect, test } from "bun:test";
import { CandidateQueue } from "../../src/mcp/ops";
import type { Candidate } from "../../src/types";

function fake(id = "c1"): Candidate {
  return {
    id,
    symbol: "BTC/USDT",
    side: "buy",
    strategy: "ema_crossover",
    strength: 0.5,
    features: {},
    klineCloseTime: Date.now(),
    createdAt: Date.now(),
  };
}

describe("CandidateQueue", () => {
  test("returns queued candidate immediately", async () => {
    const q = new CandidateQueue();
    q.push(fake("a"));
    const c = await q.next(100);
    expect(c?.id).toBe("a");
  });

  test("waiter wakes up when candidate arrives", async () => {
    const q = new CandidateQueue();
    const pending = q.next(500);
    setTimeout(() => q.push(fake("b")), 20);
    const c = await pending;
    expect(c?.id).toBe("b");
  });

  test("returns null after timeout", async () => {
    const q = new CandidateQueue();
    const c = await q.next(50);
    expect(c).toBeNull();
  });

  test("multiple pushes, single waiter eats one", async () => {
    const q = new CandidateQueue();
    q.push(fake("a"));
    q.push(fake("b"));
    const first = await q.next(100);
    expect(first?.id).toBe("a");
    const second = await q.next(100);
    expect(second?.id).toBe("b");
  });
});
