import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Journal } from "../../src/state/journal";
import { memDb } from "../helpers/db";
import type { Candidate, Order } from "../../src/types";
import { randomUUID } from "node:crypto";

let db: Database;
let j: Journal;

beforeEach(() => {
  db = memDb();
  j = new Journal(db);
});
afterEach(() => db.close());

function fakeCandidate(id = "c1"): Candidate {
  return {
    id,
    symbol: "BTC/USDT",
    side: "buy",
    strategy: "ema_crossover",
    strength: 0.8,
    features: { x: 1 },
    klineCloseTime: Date.now(),
    createdAt: Date.now(),
  };
}

function fakeOrder(id = "o1"): Order {
  const now = Date.now();
  return {
    id,
    clientOrderId: `client_${id}`,
    symbol: "BTC/USDT",
    side: "buy",
    type: "market",
    price: 100,
    amount: 1,
    status: "filled",
    filledAmount: 1,
    avgFillPrice: 100,
    createdAt: now,
    updatedAt: now,
  };
}

describe("Journal", () => {
  test("persists candidates and records outcomes", () => {
    const c = fakeCandidate();
    j.saveCandidate(c);
    j.markCandidateOutcome(c.id, "skipped", "low confidence");
    const row = db.prepare("SELECT outcome, outcome_reason FROM candidates WHERE id = ?").get(c.id) as {
      outcome: string;
      outcome_reason: string;
    } | null;
    expect(row?.outcome).toBe("skipped");
    expect(row?.outcome_reason).toBe("low confidence");
  });

  test("persists orders", () => {
    const c = fakeCandidate();
    j.saveCandidate(c);
    const o = fakeOrder();
    j.saveOrder(o, c.id);
    const row = db.prepare("SELECT status, candidate_id FROM orders WHERE id = ?").get(o.id) as {
      status: string;
      candidate_id: string;
    };
    expect(row.status).toBe("filled");
    expect(row.candidate_id).toBe(c.id);
  });

  test("records trades and increments daily stats", () => {
    const stats1 = j.applyTradeToDailyStats(50, Date.UTC(2026, 3, 14, 12));
    expect(stats1.realizedPnl).toBe(50);
    expect(stats1.tradeCount).toBe(1);
    expect(stats1.consecutiveLosses).toBe(0);

    const stats2 = j.applyTradeToDailyStats(-20, Date.UTC(2026, 3, 14, 13));
    expect(stats2.realizedPnl).toBe(30);
    expect(stats2.lossCount).toBe(1);
    expect(stats2.consecutiveLosses).toBe(1);

    const stats3 = j.applyTradeToDailyStats(-10, Date.UTC(2026, 3, 14, 14));
    expect(stats3.consecutiveLosses).toBe(2);

    const stats4 = j.applyTradeToDailyStats(+5, Date.UTC(2026, 3, 14, 15));
    expect(stats4.consecutiveLosses).toBe(0);
  });

  test("getDailyStats returns defaults when no row yet", () => {
    const stats = j.getDailyStats("2099-01-01");
    expect(stats.tradeCount).toBe(0);
    expect(stats.realizedPnl).toBe(0);
    expect(stats.pausedReason).toBeNull();
  });

  test("logs and reads back agent events", () => {
    j.logAgentEvent({
      id: randomUUID(),
      ts: 1000,
      from: "pm",
      to: "risk",
      kind: "call",
      payload: { task: "size BTC" },
    });
    const events = j.recentAgentEvents(10);
    expect(events.length).toBe(1);
    expect(events[0]!.from).toBe("pm");
    expect(events[0]!.to).toBe("risk");
    expect((events[0]!.payload as { task: string }).task).toBe("size BTC");
  });

  test("recordTrade persists into trades table", () => {
    j.recordTrade({
      orderId: "o1",
      symbol: "BTC/USDT",
      side: "sell",
      price: 110,
      amount: 1,
      realizedPnl: 10,
      ts: Date.now(),
    });
    const n = db.prepare("SELECT COUNT(*) as n FROM trades").get() as { n: number };
    expect(n.n).toBe(1);
  });
});
