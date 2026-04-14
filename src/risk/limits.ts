import type { PositionStore } from "../state/positions";
import type { Database } from "bun:sqlite";
import type { RiskDecision, RiskLimits, Side, Symbol } from "../types";

export interface RiskContext {
  equityQuote: number;
  lastPrice: number;
  hardStopPct: number;
}

export class RiskEngine {
  constructor(
    public readonly limits: RiskLimits,
    private readonly positions: PositionStore,
    private readonly db: Database,
  ) {}

  evaluate(
    symbol: Symbol,
    side: Side,
    desiredNotionalQuote: number,
    ctx: RiskContext,
  ): RiskDecision {
    const open = this.positions.all();
    if (open.length >= this.limits.maxConcurrentPositions) {
      return reject(`max concurrent positions (${this.limits.maxConcurrentPositions}) reached`);
    }
    if (this.positions.get(symbol)) {
      return reject(`already have an open ${symbol} position`);
    }

    const today = todayKey();
    const stats = this.db
      .prepare(
        `SELECT realized_pnl as realizedPnl, consecutive_losses as consecutiveLosses, paused_reason as pausedReason
         FROM daily_stats WHERE date = ?`,
      )
      .get(today) as { realizedPnl: number; consecutiveLosses: number; pausedReason: string | null } | null;

    if (stats?.pausedReason) return reject(`trading paused: ${stats.pausedReason}`);
    if (stats && stats.realizedPnl < -(ctx.equityQuote * this.limits.maxDailyLossPctEquity) / 100) {
      return reject(`daily loss cap hit (${this.limits.maxDailyLossPctEquity}%)`);
    }
    if (stats && stats.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
      return reject(`${this.limits.maxConsecutiveLosses} consecutive losses — cooling off`);
    }

    const maxNotional = (ctx.equityQuote * this.limits.maxPositionPctEquity) / 100;
    const sizeQuote = Math.min(desiredNotionalQuote, maxNotional);
    if (sizeQuote <= 0) return reject("non-positive size after limits");

    const stopPct = this.limits.hardStopPctFromEntry / 100;
    const stopPrice =
      side === "buy" ? ctx.lastPrice * (1 - stopPct) : ctx.lastPrice * (1 + stopPct);
    const takeProfitPrice =
      side === "buy" ? ctx.lastPrice * (1 + stopPct * 2) : ctx.lastPrice * (1 - stopPct * 2);

    return {
      approved: true,
      sizeBase: sizeQuote / ctx.lastPrice,
      sizeQuote,
      stopPrice,
      takeProfitPrice,
      reason: `sized ${((sizeQuote / ctx.equityQuote) * 100).toFixed(2)}% of equity, stop ${stopPct * 100}% from entry`,
    };
  }

  pause(reason: string): void {
    const today = todayKey();
    this.db
      .prepare(
        `INSERT INTO daily_stats (date, paused_reason) VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET paused_reason = excluded.paused_reason`,
      )
      .run(today, reason);
  }

  resume(): void {
    this.db
      .prepare(`UPDATE daily_stats SET paused_reason = NULL WHERE date = ?`)
      .run(todayKey());
  }
}

function reject(reason: string): RiskDecision {
  return { approved: false, sizeBase: 0, sizeQuote: 0, stopPrice: null, takeProfitPrice: null, reason };
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
