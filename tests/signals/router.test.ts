import { describe, expect, test } from "bun:test";
import { SignalRouter } from "../../src/signals";
import type { Kline, SymbolState } from "../../src/types";

function crossKlines(): Kline[] {
  const closes = [...new Array(35).fill(100), 120];
  return closes.map((c, i) => ({
    symbol: "BTC/USDT",
    openTime: i,
    closeTime: i,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
  }));
}

function baseState(partial: Partial<SymbolState> = {}): SymbolState {
  return {
    symbol: "BTC/USDT",
    lastCandidateAt: null,
    lastTradeAt: null,
    cooldownUntil: null,
    position: null,
    ...partial,
  };
}

describe("SignalRouter", () => {
  test("emits candidates when no blocker", () => {
    const router = new SignalRouter({ getSymbolState: () => baseState() });
    const candidates = router.evaluate("BTC/USDT", crossKlines());
    expect(candidates.length).toBeGreaterThan(0);
  });
  test("suppresses candidates while in cooldown", () => {
    const router = new SignalRouter({
      getSymbolState: () => baseState({ cooldownUntil: Date.now() + 60_000 }),
    });
    expect(router.evaluate("BTC/USDT", crossKlines())).toEqual([]);
  });
  test("suppresses candidates when a position is open", () => {
    const router = new SignalRouter({
      getSymbolState: () =>
        baseState({
          position: {
            symbol: "BTC/USDT",
            side: "buy",
            amount: 1,
            entryPrice: 100,
            stopPrice: 99,
            takeProfitPrice: 102,
            unrealizedPnl: 0,
            realizedPnl: 0,
            openedAt: Date.now(),
          },
        }),
    });
    expect(router.evaluate("BTC/USDT", crossKlines())).toEqual([]);
  });
  test("allows candidates once cooldown has expired", () => {
    const router = new SignalRouter({
      getSymbolState: () => baseState({ cooldownUntil: Date.now() - 1_000 }),
    });
    expect(router.evaluate("BTC/USDT", crossKlines()).length).toBeGreaterThan(0);
  });
});
