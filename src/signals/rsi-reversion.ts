import { randomUUID } from "node:crypto";
import type { Candidate, Kline } from "../types";
import { rsi } from "./indicators";

const LOW = 30;
const HIGH = 70;

export function rsiReversion(klines: Kline[]): Candidate | null {
  if (klines.length < 16) return null;
  const closes = klines.map((k) => k.close);
  const values = rsi(closes, 14);
  const i = values.length - 1;
  const now = values[i]!;
  const prev = values[i - 1]!;
  const last = klines[i]!;

  const turnedUp = prev < LOW && now >= LOW;
  const turnedDown = prev > HIGH && now <= HIGH;
  if (!turnedUp && !turnedDown) return null;

  const extreme = turnedUp ? LOW - prev : prev - HIGH;
  const strength = Math.min(1, Math.max(0, extreme / 20));

  return {
    id: randomUUID(),
    symbol: last.symbol,
    side: turnedUp ? "buy" : "sell",
    strategy: "rsi_reversion",
    strength,
    features: { rsi: now, prevRsi: prev },
    klineCloseTime: last.closeTime,
    createdAt: Date.now(),
  };
}
