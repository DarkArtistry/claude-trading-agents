import { describe, expect, test } from "bun:test";
import { breakout } from "../../src/signals/breakout";
import type { Kline } from "../../src/types";

function makeKlines(opts: { base: number; lastClose: number; lastVol: number; avgVol: number }): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < 20; i++) {
    out.push({
      symbol: "SOL/USDT",
      openTime: i,
      closeTime: i,
      open: opts.base,
      high: opts.base + 1,
      low: opts.base - 1,
      close: opts.base,
      volume: opts.avgVol,
    });
  }
  out.push({
    symbol: "SOL/USDT",
    openTime: 20,
    closeTime: 20,
    open: opts.base,
    high: opts.lastClose,
    low: opts.base - 1,
    close: opts.lastClose,
    volume: opts.lastVol,
  });
  return out;
}

describe("breakout", () => {
  test("returns null when close does not break the lookback high", () => {
    const klines = makeKlines({ base: 100, lastClose: 100.5, lastVol: 10, avgVol: 5 });
    expect(breakout(klines)).toBeNull();
  });
  test("requires volume confirmation", () => {
    const klines = makeKlines({ base: 100, lastClose: 110, lastVol: 5, avgVol: 5 });
    expect(breakout(klines)).toBeNull();
  });
  test("emits a buy on upside break with volume", () => {
    const klines = makeKlines({ base: 100, lastClose: 110, lastVol: 20, avgVol: 5 });
    const c = breakout(klines);
    expect(c).not.toBeNull();
    expect(c!.side).toBe("buy");
    expect(c!.strength).toBeGreaterThan(0);
  });
  test("emits a sell on downside break with volume", () => {
    const klines = makeKlines({ base: 100, lastClose: 90, lastVol: 20, avgVol: 5 });
    const c = breakout(klines);
    expect(c).not.toBeNull();
    expect(c!.side).toBe("sell");
  });
});
