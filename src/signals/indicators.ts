import type { Kline } from "../types";

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i]! * k + out[i - 1]! * (1 - k));
  }
  return out;
}

export function rsi(values: number[], period = 14): number[] {
  if (values.length <= period) return new Array(values.length).fill(NaN);
  const out: number[] = new Array(values.length).fill(NaN);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function atr(klines: Kline[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 0; i < klines.length; i++) {
    const k = klines[i]!;
    if (i === 0) {
      trs.push(k.high - k.low);
      continue;
    }
    const prev = klines[i - 1]!;
    trs.push(Math.max(k.high - k.low, Math.abs(k.high - prev.close), Math.abs(k.low - prev.close)));
  }
  const out: number[] = new Array(klines.length).fill(NaN);
  if (klines.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i]!;
  out[period - 1] = sum / period;
  for (let i = period; i < klines.length; i++) {
    out[i] = (out[i - 1]! * (period - 1) + trs[i]!) / period;
  }
  return out;
}
