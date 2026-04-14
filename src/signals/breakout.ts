import { randomUUID } from "node:crypto";
import type { Candidate, Kline } from "../types";

const LOOKBACK = 20;

export function breakout(klines: Kline[]): Candidate | null {
  if (klines.length < LOOKBACK + 1) return null;
  const i = klines.length - 1;
  const last = klines[i]!;
  const window = klines.slice(i - LOOKBACK, i);
  const hi = Math.max(...window.map((k) => k.high));
  const lo = Math.min(...window.map((k) => k.low));
  const avgVol = window.reduce((a, k) => a + k.volume, 0) / window.length;

  const brokeUp = last.close > hi && last.volume > avgVol * 1.25;
  const brokeDown = last.close < lo && last.volume > avgVol * 1.25;
  if (!brokeUp && !brokeDown) return null;

  const move = brokeUp ? (last.close - hi) / hi : (lo - last.close) / lo;
  const strength = Math.min(1, move * 100);

  return {
    id: randomUUID(),
    symbol: last.symbol,
    side: brokeUp ? "buy" : "sell",
    strategy: "breakout",
    strength,
    features: { priorHigh: hi, priorLow: lo, avgVol, thisVol: last.volume },
    klineCloseTime: last.closeTime,
    createdAt: Date.now(),
  };
}
