import type { Database } from "bun:sqlite";
import type { Position, Symbol } from "../types";

export class PositionStore {
  constructor(private db: Database) {}

  get(symbol: Symbol): Position | null {
    const row = this.db
      .prepare(
        `SELECT symbol, side, amount, entry_price as entryPrice,
                stop_price as stopPrice, take_profit_price as takeProfitPrice,
                unrealized_pnl as unrealizedPnl, realized_pnl as realizedPnl,
                opened_at as openedAt
         FROM positions WHERE symbol = ?`,
      )
      .get(symbol) as Position | null;
    return row;
  }

  upsert(p: Position): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO positions
         (symbol, side, amount, entry_price, stop_price, take_profit_price,
          unrealized_pnl, realized_pnl, opened_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           side = excluded.side,
           amount = excluded.amount,
           entry_price = excluded.entry_price,
           stop_price = excluded.stop_price,
           take_profit_price = excluded.take_profit_price,
           unrealized_pnl = excluded.unrealized_pnl,
           realized_pnl = positions.realized_pnl + excluded.realized_pnl,
           updated_at = excluded.updated_at`,
      )
      .run(
        p.symbol,
        p.side,
        p.amount,
        p.entryPrice,
        p.stopPrice,
        p.takeProfitPrice,
        p.unrealizedPnl,
        p.realizedPnl,
        p.openedAt,
        now,
      );
  }

  close(symbol: Symbol): void {
    this.db.prepare(`DELETE FROM positions WHERE symbol = ?`).run(symbol);
  }

  all(): Position[] {
    return this.db
      .prepare(
        `SELECT symbol, side, amount, entry_price as entryPrice,
                stop_price as stopPrice, take_profit_price as takeProfitPrice,
                unrealized_pnl as unrealizedPnl, realized_pnl as realizedPnl,
                opened_at as openedAt
         FROM positions`,
      )
      .all() as Position[];
  }
}
