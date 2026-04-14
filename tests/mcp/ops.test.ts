import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { memDb } from "../helpers/db";
import { FakeBinance } from "../helpers/fake-binance";
import { Journal } from "../../src/state/journal";
import { PositionStore } from "../../src/state/positions";
import { RiskEngine } from "../../src/risk/limits";
import { DEFAULT_RISK_LIMITS } from "../../src/config";
import { Ops } from "../../src/mcp/ops";
import { createLogger } from "../../src/util/logger";

const silent = createLogger("error");

function setup(opts: { dryRun?: boolean; cooldownMs?: number } = {}) {
  const db = memDb();
  const journal = new Journal(db);
  const positions = new PositionStore(db);
  const binance = new FakeBinance();
  const risk = new RiskEngine(DEFAULT_RISK_LIMITS, positions, db);
  const ops = new Ops({
    binance: binance.asClient(),
    positions,
    journal,
    risk,
    logger: silent,
    dryRun: opts.dryRun ?? true,
    symbolCooldownMs: opts.cooldownMs ?? 60_000,
  });
  return { db, journal, positions, binance, risk, ops };
}

describe("Ops.placeOrder (open)", () => {
  let db: Database | null = null;
  afterEach(() => db?.close());

  test("dry-run returns a filled order and creates a position", async () => {
    const ctx = setup();
    db = ctx.db;
    const order = await ctx.ops.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 0.5,
      stopPrice: 95,
      takeProfitPrice: 110,
      candidateId: "cand_1",
    });
    expect(order.status).toBe("filled");
    expect(order.filledAmount).toBe(0.5);

    const pos = ctx.positions.get("BTC/USDT");
    expect(pos).not.toBeNull();
    expect(pos!.side).toBe("buy");
    expect(pos!.amount).toBe(0.5);
    expect(pos!.entryPrice).toBe(100);
    expect(pos!.stopPrice).toBe(95);
    expect(pos!.takeProfitPrice).toBe(110);

    expect(ctx.ops.getCooldownUntil("BTC/USDT")).toBeGreaterThan(Date.now());
  });

  test("placing an order on a symbol we already hold is a no-op for position averaging", async () => {
    const ctx = setup();
    db = ctx.db;
    await ctx.ops.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 1,
      candidateId: "a",
    });
    await ctx.ops.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 0.5,
      candidateId: "b",
    });
    const pos = ctx.positions.get("BTC/USDT")!;
    expect(pos.amount).toBe(1);
  });
});

describe("Ops.closePosition", () => {
  let db: Database | null = null;
  afterEach(() => db?.close());

  test("returns null when no position exists", async () => {
    const ctx = setup();
    db = ctx.db;
    const out = await ctx.ops.closePosition("BTC/USDT", "manual");
    expect(out).toBeNull();
  });

  test("closing a profitable long realizes PnL and records a trade", async () => {
    const ctx = setup();
    db = ctx.db;
    await ctx.ops.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 1,
      candidateId: "open",
    });
    ctx.binance.tickers["BTC/USDT"] = { symbol: "BTC/USDT", last: 110, bid: 109.9, ask: 110.1 };

    const closeOrder = await ctx.ops.closePosition("BTC/USDT", "take-profit");
    expect(closeOrder).not.toBeNull();
    expect(closeOrder!.status).toBe("filled");

    expect(ctx.positions.get("BTC/USDT")).toBeNull();

    const stats = ctx.journal.getDailyStats();
    expect(stats.tradeCount).toBe(1);
    expect(stats.realizedPnl).toBeCloseTo(10, 3);
    expect(stats.consecutiveLosses).toBe(0);
  });

  test("closing a losing long updates consecutive loss count", async () => {
    const ctx = setup();
    db = ctx.db;
    await ctx.ops.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 1,
      candidateId: "open",
    });
    ctx.binance.tickers["BTC/USDT"] = { symbol: "BTC/USDT", last: 90, bid: 89.9, ask: 90.1 };

    await ctx.ops.closePosition("BTC/USDT", "stop-loss");
    const stats = ctx.journal.getDailyStats();
    expect(stats.realizedPnl).toBeCloseTo(-10, 3);
    expect(stats.consecutiveLosses).toBe(1);
  });

  test("enough consecutive losses auto-pauses risk engine", async () => {
    const ctx = setup();
    db = ctx.db;
    for (let i = 0; i < DEFAULT_RISK_LIMITS.maxConsecutiveLosses; i++) {
      const symbol = `X${i}/USDT`;
      ctx.binance.tickers[symbol] = { symbol, last: 100, bid: 99, ask: 101 };
      await ctx.ops.placeOrder({
        symbol,
        side: "buy",
        type: "market",
        amount: 1,
        candidateId: `open_${i}`,
      });
      ctx.binance.tickers[symbol] = { symbol, last: 90, bid: 89, ask: 91 };
      await ctx.ops.closePosition(symbol, "stop-loss");
    }
    const summary = await ctx.ops.getPortfolioSummary();
    expect(summary.status).toBe("paused");
  });
});

describe("Ops.getPortfolioSummary", () => {
  test("reflects realized PnL from daily stats and open positions", async () => {
    const ctx = setup();
    await ctx.ops.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 1,
      candidateId: "open",
    });
    const summary = await ctx.ops.getPortfolioSummary();
    expect(summary.openPositionCount).toBe(1);
    expect(summary.positions.length).toBe(1);
    expect(summary.equityQuote).toBeGreaterThan(0);
    ctx.db.close();
  });
});
