import { randomUUID } from "node:crypto";
import type { Candidate, Kline } from "../types";
import { ema } from "./indicators";

const FAST = 9;
const SLOW = 21;

export function emaCrossover(klines: Kline[]): Candidate | null {
  if (klines.length < SLOW + 2) return null;
  const closes = klines.map((k) => k.close);
  const fast = ema(closes, FAST);
  const slow = ema(closes, SLOW);
  const i = closes.length - 1;
  const last = klines[i]!;
  const fNow = fast[i]!;
  const sNow = slow[i]!;
  const fPrev = fast[i - 1]!;
  const sPrev = slow[i - 1]!;

  const crossedUp = fPrev <= sPrev && fNow > sNow;
  const crossedDown = fPrev >= sPrev && fNow < sNow;
  if (!crossedUp && !crossedDown) return null;

  const gap = Math.abs(fNow - sNow) / sNow;
  const strength = Math.min(1, gap * 200);

  return {
    id: randomUUID(),
    symbol: last.symbol,
    side: crossedUp ? "buy" : "sell",
    strategy: "ema_crossover",
    strength,
    features: { fast: fNow, slow: sNow, gapPct: gap * 100 },
    klineCloseTime: last.closeTime,
    createdAt: Date.now(),
  };
}
