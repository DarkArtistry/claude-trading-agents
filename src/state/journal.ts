import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { AgentEvent, Candidate, Order, Side, Symbol } from "../types";

export interface DailyStats {
  date: string;
  realizedPnl: number;
  tradeCount: number;
  lossCount: number;
  consecutiveLosses: number;
  pausedReason: string | null;
}

export class Journal {
  constructor(private db: Database) {}

  logAgentEvent(event: AgentEvent): void {
    this.db
      .prepare(
        `INSERT INTO agent_events
         (id, ts, from_agent, to_agent, kind, duration_ms, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.ts,
        event.from,
        event.to,
        event.kind,
        event.durationMs ?? null,
        JSON.stringify(event.payload),
      );
  }

  saveCandidate(c: Candidate): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO candidates
         (id, symbol, side, strategy, strength, features_json, kline_close_time, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id,
        c.symbol,
        c.side,
        c.strategy,
        c.strength,
        JSON.stringify(c.features),
        c.klineCloseTime,
        c.createdAt,
      );
  }

  markCandidateOutcome(id: string, outcome: "taken" | "skipped" | "rejected", reason: string): void {
    this.db
      .prepare(`UPDATE candidates SET outcome = ?, outcome_reason = ? WHERE id = ?`)
      .run(outcome, reason, id);
  }

  saveOrder(o: Order, candidateId: string | null): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO orders
         (id, client_order_id, symbol, side, type, price, amount, status,
          filled_amount, avg_fill_price, candidate_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.id,
        o.clientOrderId,
        o.symbol,
        o.side,
        o.type,
        o.price,
        o.amount,
        o.status,
        o.filledAmount,
        o.avgFillPrice,
        candidateId,
        o.createdAt,
        o.updatedAt,
      );
  }

  recordTrade(trade: {
    orderId: string;
    symbol: Symbol;
    side: Side;
    price: number;
    amount: number;
    realizedPnl: number;
    ts: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO trades (id, order_id, symbol, side, price, amount, realized_pnl, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        trade.orderId,
        trade.symbol,
        trade.side,
        trade.price,
        trade.amount,
        trade.realizedPnl,
        trade.ts,
      );
  }

  recentAgentEvents(limit: number): AgentEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, from_agent as "from", to_agent as "to", kind, duration_ms as durationMs, payload_json
         FROM agent_events ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit) as Array<Omit<AgentEvent, "payload"> & { payload_json: string }>;
    return rows.map(({ payload_json, ...rest }) => ({
      ...rest,
      payload: JSON.parse(payload_json),
    }));
  }

  getDailyStats(date: string = todayKey()): DailyStats {
    const row = this.db
      .prepare(
        `SELECT date, realized_pnl as realizedPnl, trade_count as tradeCount,
                loss_count as lossCount, consecutive_losses as consecutiveLosses,
                paused_reason as pausedReason
         FROM daily_stats WHERE date = ?`,
      )
      .get(date) as DailyStats | null;
    return (
      row ?? {
        date,
        realizedPnl: 0,
        tradeCount: 0,
        lossCount: 0,
        consecutiveLosses: 0,
        pausedReason: null,
      }
    );
  }

  applyTradeToDailyStats(realizedPnl: number, ts: number = Date.now()): DailyStats {
    const date = dateKey(ts);
    const cur = this.getDailyStats(date);
    const realized = cur.realizedPnl + realizedPnl;
    const tradeCount = cur.tradeCount + 1;
    const isLoss = realizedPnl < 0;
    const lossCount = cur.lossCount + (isLoss ? 1 : 0);
    const consecutiveLosses = isLoss ? cur.consecutiveLosses + 1 : 0;
    this.db
      .prepare(
        `INSERT INTO daily_stats (date, realized_pnl, trade_count, loss_count, consecutive_losses)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           realized_pnl = excluded.realized_pnl,
           trade_count = excluded.trade_count,
           loss_count = excluded.loss_count,
           consecutive_losses = excluded.consecutive_losses`,
      )
      .run(date, realized, tradeCount, lossCount, consecutiveLosses);
    return {
      date,
      realizedPnl: realized,
      tradeCount,
      lossCount,
      consecutiveLosses,
      pausedReason: cur.pausedReason,
    };
  }
}

function todayKey(): string {
  return dateKey(Date.now());
}

function dateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
