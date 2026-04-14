import { randomUUID } from "node:crypto";
import type { BinanceClient } from "../binance/client";
import type { Journal } from "../state/journal";
import type { PositionStore } from "../state/positions";
import type { RiskEngine } from "../risk/limits";
import type { Logger } from "../util/logger";
import type {
  Candidate,
  Order,
  OrderType,
  PortfolioSummary,
  Position,
  RiskDecision,
  Side,
  Symbol,
} from "../types";
import { ema, rsi, atr } from "../signals/indicators";

export interface OpsDeps {
  binance: BinanceClient;
  positions: PositionStore;
  journal: Journal;
  risk: RiskEngine;
  logger: Logger;
  dryRun: boolean;
  quoteAsset?: string;
  symbolCooldownMs?: number;
}

export interface PlaceOrderInput {
  symbol: Symbol;
  side: Side;
  type: OrderType;
  amount: number;
  price?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  candidateId: string;
}

export class Ops {
  private readonly quoteAsset: string;
  private readonly cooldowns = new Map<Symbol, number>();
  private readonly symbolCooldownMs: number;

  constructor(private readonly deps: OpsDeps) {
    this.quoteAsset = deps.quoteAsset ?? "USDT";
    this.symbolCooldownMs = deps.symbolCooldownMs ?? 15 * 60 * 1000;
  }

  async getPortfolioSummary(): Promise<PortfolioSummary> {
    const balances = await this.deps.binance.fetchBalance();
    const quote = balances.find((b) => b.asset === this.quoteAsset);
    const free = quote?.free ?? 0;
    const positions = this.deps.positions.all();
    const unrealizedPnl = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
    const quoteValue = positions.reduce((a, p) => a + p.amount * p.entryPrice, 0);
    const stats = this.deps.journal.getDailyStats();

    return {
      equityQuote: free + quoteValue + unrealizedPnl,
      freeQuote: free,
      positions,
      realizedPnlToday: stats.realizedPnl,
      unrealizedPnl,
      openPositionCount: positions.length,
      tradeCountToday: stats.tradeCount,
      status: stats.pausedReason ? "paused" : "running",
    };
  }

  getPositions(): Position[] {
    return this.deps.positions.all();
  }

  getCooldownUntil(symbol: Symbol): number | null {
    return this.cooldowns.get(symbol) ?? null;
  }

  async getTicker(symbol: Symbol) {
    return this.deps.binance.fetchTicker(symbol);
  }

  async getKlines(symbol: Symbol, timeframe: string, limit = 200) {
    return this.deps.binance.fetchKlines(symbol, timeframe, limit);
  }

  async getIndicators(symbol: Symbol, timeframe: string) {
    const klines = await this.deps.binance.fetchKlines(symbol, timeframe, 100);
    const closes = klines.map((k) => k.close);
    return {
      symbol,
      timeframe,
      ema9: ema(closes, 9).at(-1),
      ema21: ema(closes, 21).at(-1),
      ema50: ema(closes, 50).at(-1),
      rsi14: rsi(closes, 14).at(-1),
      atr14: atr(klines, 14).at(-1),
      lastClose: closes.at(-1),
    };
  }

  async checkRiskLimits(
    symbol: Symbol,
    side: Side,
    desiredNotionalQuote: number,
  ): Promise<RiskDecision> {
    const [ticker, portfolio] = await Promise.all([
      this.deps.binance.fetchTicker(symbol),
      this.getPortfolioSummary(),
    ]);
    return this.deps.risk.evaluate(symbol, side, desiredNotionalQuote, {
      equityQuote: portfolio.equityQuote,
      lastPrice: ticker.last,
      hardStopPct: 2,
    });
  }

  async placeOrder(input: PlaceOrderInput): Promise<Order> {
    const order = this.deps.dryRun
      ? await this.makeDryOrder(input)
      : await this.makeLiveOrder(input);
    this.deps.journal.saveOrder(order, input.candidateId);
    if (order.status === "filled" || order.status === "partially_filled") {
      this.applyFill(input, order);
    }
    return order;
  }

  async closePosition(symbol: Symbol, reason: string): Promise<Order | null> {
    const pos = this.deps.positions.get(symbol);
    if (!pos) return null;
    const closingSide: Side = pos.side === "buy" ? "sell" : "buy";
    this.deps.logger.info("closing position", { symbol, reason });
    return this.placeOrder({
      symbol,
      side: closingSide,
      type: "market",
      amount: pos.amount,
      candidateId: `close_${randomUUID()}`,
    });
  }

  async cancelOrder(orderId: string, symbol: Symbol): Promise<{ ok: true }> {
    await this.deps.binance.cancelOrder(orderId, symbol);
    return { ok: true };
  }

  recordCandidateOutcome(
    candidateId: string,
    outcome: "taken" | "skipped" | "rejected",
    reason: string,
  ): void {
    this.deps.journal.markCandidateOutcome(candidateId, outcome, reason);
  }

  private async makeDryOrder(input: PlaceOrderInput): Promise<Order> {
    const now = Date.now();
    const fillPrice = input.price ?? (await this.getTicker(input.symbol)).last;
    return {
      id: `dry_${randomUUID()}`,
      clientOrderId: `dry_${randomUUID()}`,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      price: input.price ?? null,
      amount: input.amount,
      status: "filled",
      filledAmount: input.amount,
      avgFillPrice: fillPrice,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async makeLiveOrder(input: PlaceOrderInput): Promise<Order> {
    const params: Record<string, unknown> = {};
    if (input.stopPrice !== undefined) params.stopPrice = input.stopPrice;
    return this.deps.binance.createOrder(
      input.symbol,
      input.type,
      input.side,
      input.amount,
      input.price,
      params,
    );
  }

  private applyFill(input: PlaceOrderInput, order: Order): void {
    const existing = this.deps.positions.get(input.symbol);
    const fillPrice = order.avgFillPrice ?? order.price ?? 0;
    const now = Date.now();

    if (existing && isClosingSide(existing.side, input.side)) {
      const realized =
        existing.side === "buy"
          ? (fillPrice - existing.entryPrice) * Math.min(existing.amount, order.filledAmount)
          : (existing.entryPrice - fillPrice) * Math.min(existing.amount, order.filledAmount);
      this.deps.journal.recordTrade({
        orderId: order.id,
        symbol: input.symbol,
        side: input.side,
        price: fillPrice,
        amount: order.filledAmount,
        realizedPnl: realized,
        ts: now,
      });
      const stats = this.deps.journal.applyTradeToDailyStats(realized, now);
      this.deps.positions.close(input.symbol);
      this.cooldowns.set(input.symbol, now + this.symbolCooldownMs);
      this.deps.logger.info("position closed", {
        symbol: input.symbol,
        realizedPnl: realized,
        consecutiveLosses: stats.consecutiveLosses,
      });
      if (stats.consecutiveLosses >= this.deps.risk.limits.maxConsecutiveLosses) {
        this.deps.risk.pause(`${stats.consecutiveLosses} consecutive losses`);
      }
    } else if (!existing) {
      this.deps.positions.upsert({
        symbol: input.symbol,
        side: input.side,
        amount: order.filledAmount,
        entryPrice: fillPrice,
        stopPrice: input.stopPrice ?? null,
        takeProfitPrice: input.takeProfitPrice ?? null,
        unrealizedPnl: 0,
        realizedPnl: 0,
        openedAt: now,
      });
      this.cooldowns.set(input.symbol, now + this.symbolCooldownMs);
      this.deps.logger.info("position opened", {
        symbol: input.symbol,
        side: input.side,
        amount: order.filledAmount,
        entry: fillPrice,
      });
    } else {
      this.deps.logger.warn("fill ignored — position averaging not supported yet", {
        symbol: input.symbol,
        existingSide: existing.side,
        fillSide: input.side,
      });
    }
  }
}

function isClosingSide(positionSide: Side, fillSide: Side): boolean {
  return positionSide !== fillSide;
}

export class CandidateQueue {
  private queue: Candidate[] = [];
  private waiters: Array<(c: Candidate) => void> = [];

  push(c: Candidate): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(c);
    else this.queue.push(c);
  }

  async next(timeoutMs: number): Promise<Candidate | null> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolver);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      const resolver = (c: Candidate) => {
        clearTimeout(timer);
        resolve(c);
      };
      this.waiters.push(resolver);
    });
  }
}
