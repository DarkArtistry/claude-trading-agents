import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { RiskEngine } from "../../src/risk/limits";
import { PositionStore } from "../../src/state/positions";
import { Journal } from "../../src/state/journal";
import { DEFAULT_RISK_LIMITS } from "../../src/config";
import { memDb } from "../helpers/db";

let db: Database;
let positions: PositionStore;
let journal: Journal;
let engine: RiskEngine;

beforeEach(() => {
  db = memDb();
  positions = new PositionStore(db);
  journal = new Journal(db);
  engine = new RiskEngine(DEFAULT_RISK_LIMITS, positions, db);
});
afterEach(() => db.close());

const ctx = { equityQuote: 10_000, lastPrice: 100, hardStopPct: 2 };

describe("RiskEngine", () => {
  test("approves a first trade within limits", () => {
    const d = engine.evaluate("BTC/USDT", "buy", 500, ctx);
    expect(d.approved).toBe(true);
    expect(d.sizeQuote).toBe(500);
    expect(d.stopPrice).toBeGreaterThan(0);
    expect(d.takeProfitPrice).toBeGreaterThan(0);
  });

  test("caps sizeQuote at max position % of equity", () => {
    const d = engine.evaluate("BTC/USDT", "buy", 5_000, ctx);
    expect(d.approved).toBe(true);
    expect(d.sizeQuote).toBe((ctx.equityQuote * DEFAULT_RISK_LIMITS.maxPositionPctEquity) / 100);
  });

  test("rejects when already holding a position in that symbol", () => {
    positions.upsert({
      symbol: "BTC/USDT",
      side: "buy",
      amount: 1,
      entryPrice: 100,
      stopPrice: null,
      takeProfitPrice: null,
      unrealizedPnl: 0,
      realizedPnl: 0,
      openedAt: Date.now(),
    });
    const d = engine.evaluate("BTC/USDT", "buy", 500, ctx);
    expect(d.approved).toBe(false);
    expect(d.reason).toContain("BTC/USDT");
  });

  test("rejects when at max concurrent positions", () => {
    for (let i = 0; i < DEFAULT_RISK_LIMITS.maxConcurrentPositions; i++) {
      positions.upsert({
        symbol: `X${i}/USDT`,
        side: "buy",
        amount: 1,
        entryPrice: 100,
        stopPrice: null,
        takeProfitPrice: null,
        unrealizedPnl: 0,
        realizedPnl: 0,
        openedAt: Date.now(),
      });
    }
    const d = engine.evaluate("NEW/USDT", "buy", 100, ctx);
    expect(d.approved).toBe(false);
    expect(d.reason).toContain("max concurrent");
  });

  test("rejects once the daily loss cap is exceeded", () => {
    const lossCap = (ctx.equityQuote * DEFAULT_RISK_LIMITS.maxDailyLossPctEquity) / 100;
    journal.applyTradeToDailyStats(-(lossCap + 1));
    const d = engine.evaluate("BTC/USDT", "buy", 100, ctx);
    expect(d.approved).toBe(false);
    expect(d.reason).toContain("daily loss");
  });

  test("rejects after consecutive losses trigger", () => {
    for (let i = 0; i < DEFAULT_RISK_LIMITS.maxConsecutiveLosses; i++) {
      journal.applyTradeToDailyStats(-10);
    }
    const d = engine.evaluate("BTC/USDT", "buy", 100, ctx);
    expect(d.approved).toBe(false);
    expect(d.reason).toContain("consecutive");
  });

  test("pause blocks trading until resume", () => {
    engine.pause("manual");
    const blocked = engine.evaluate("BTC/USDT", "buy", 100, ctx);
    expect(blocked.approved).toBe(false);
    expect(blocked.reason).toContain("paused");
    engine.resume();
    const ok = engine.evaluate("BTC/USDT", "buy", 100, ctx);
    expect(ok.approved).toBe(true);
  });
});
