import { describe, expect, test } from "bun:test";
import { emaCrossover } from "../../src/signals/ema-crossover";
import type { Kline } from "../../src/types";

function klinesFromCloses(closes: number[]): Kline[] {
  return closes.map((c, i) => ({
    symbol: "BTC/USDT",
    openTime: i * 60_000,
    closeTime: (i + 1) * 60_000 - 1,
    open: c,
    high: c * 1.001,
    low: c * 0.999,
    close: c,
    volume: 1,
  }));
}

describe("emaCrossover", () => {
  test("returns null when series is too short", () => {
    const klines = klinesFromCloses(new Array(10).fill(100));
    expect(emaCrossover(klines)).toBeNull();
  });
  test("emits a buy candidate when the last bar jumps fast above slow", () => {
    // 35 flat bars keeps fast ≈ slow; the final jump crosses fast above slow.
    const closes = [...new Array(35).fill(100), 120];
    const c = emaCrossover(klinesFromCloses(closes));
    expect(c).not.toBeNull();
    expect(c!.side).toBe("buy");
    expect(c!.strategy).toBe("ema_crossover");
    expect(c!.strength).toBeGreaterThan(0);
  });
  test("emits a sell candidate when the last bar drops fast below slow", () => {
    const closes = [...new Array(35).fill(100), 80];
    const c = emaCrossover(klinesFromCloses(closes));
    expect(c).not.toBeNull();
    expect(c!.side).toBe("sell");
  });
  test("returns null when there is no crossover", () => {
    const klines = klinesFromCloses(new Array(60).fill(100));
    expect(emaCrossover(klines)).toBeNull();
  });
});
