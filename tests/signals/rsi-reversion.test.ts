import { describe, expect, test } from "bun:test";
import { rsiReversion } from "../../src/signals/rsi-reversion";
import type { Kline } from "../../src/types";

function kl(closes: number[]): Kline[] {
  return closes.map((c, i) => ({
    symbol: "ETH/USDT",
    openTime: i,
    closeTime: i,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
  }));
}

describe("rsiReversion", () => {
  test("returns null when not enough klines", () => {
    expect(rsiReversion(kl([100, 101, 102]))).toBeNull();
  });
  test("emits buy when RSI crosses up through 30 on the last bar", () => {
    // 20 down-bars push RSI near 0; one large up-bar lifts it above 30.
    const falling = Array.from({ length: 20 }, (_, i) => 100 - i);
    const bounce = [falling[falling.length - 1]! + 20];
    const klines = kl([...falling, ...bounce]);
    const c = rsiReversion(klines);
    expect(c).not.toBeNull();
    expect(c!.side).toBe("buy");
  });
  test("emits sell when RSI crosses down through 70 on the last bar", () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    const pullback = [rising[rising.length - 1]! - 20];
    const klines = kl([...rising, ...pullback]);
    const c = rsiReversion(klines);
    expect(c).not.toBeNull();
    expect(c!.side).toBe("sell");
  });
});
