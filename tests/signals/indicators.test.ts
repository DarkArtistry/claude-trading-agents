import { describe, expect, test } from "bun:test";
import { ema, rsi, atr } from "../../src/signals/indicators";
import type { Kline } from "../../src/types";

describe("ema", () => {
  test("first value equals the seed", () => {
    const out = ema([10, 11, 12, 13], 3);
    expect(out[0]).toBe(10);
  });
  test("tracks a constant series to the constant", () => {
    const out = ema(new Array(30).fill(100), 9);
    expect(out.at(-1)).toBeCloseTo(100, 6);
  });
  test("fast ema reacts quicker than slow", () => {
    const values = [...new Array(20).fill(100), ...new Array(20).fill(110)];
    const fast = ema(values, 5);
    const slow = ema(values, 20);
    expect(fast.at(-1)!).toBeGreaterThan(slow.at(-1)!);
  });
});

describe("rsi", () => {
  test("constant series yields 100 (no losses) after warmup", () => {
    const out = rsi(new Array(30).fill(100), 14);
    expect(out.at(-1)).toBe(100);
  });
  test("monotonically rising prices yield high RSI", () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i);
    const out = rsi(values, 14);
    expect(out.at(-1)!).toBeGreaterThan(70);
  });
  test("monotonically falling prices yield low RSI", () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 - i);
    const out = rsi(values, 14);
    expect(out.at(-1)!).toBeLessThan(30);
  });
  test("returns NaN for indices before warmup", () => {
    const out = rsi(new Array(30).fill(100), 14);
    expect(Number.isNaN(out[0]!)).toBe(true);
    expect(Number.isNaN(out[13]!)).toBe(true);
    expect(Number.isNaN(out[14]!)).toBe(false);
  });
});

describe("atr", () => {
  test("constant prices with zero range yield ATR of 0", () => {
    const klines: Kline[] = Array.from({ length: 20 }, (_, i) => ({
      symbol: "X",
      openTime: i,
      closeTime: i,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
    }));
    const out = atr(klines, 14);
    expect(out.at(-1)).toBe(0);
  });
  test("wide daily ranges produce nonzero ATR", () => {
    const klines: Kline[] = Array.from({ length: 20 }, (_, i) => ({
      symbol: "X",
      openTime: i,
      closeTime: i,
      open: 100,
      high: 110,
      low: 90,
      close: 100,
      volume: 1,
    }));
    const out = atr(klines, 14);
    expect(out.at(-1)!).toBeGreaterThan(0);
  });
});
