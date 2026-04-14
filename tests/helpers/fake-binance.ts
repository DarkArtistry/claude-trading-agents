import type { BinanceClient } from "../../src/binance/client";
import type { Balance, Kline, Order, OrderType, Side, Symbol } from "../../src/types";

type TickerRow = { symbol: Symbol; last: number; bid: number; ask: number };

export class FakeBinance implements Pick<BinanceClient, "fetchBalance" | "fetchTicker" | "fetchKlines" | "createOrder" | "cancelOrder" | "fetchOrder" | "fetchOpenOrders" | "loadMarkets"> {
  balances: Balance[] = [{ asset: "USDT", free: 10_000, used: 0, total: 10_000 }];
  tickers: Record<Symbol, TickerRow> = {
    "BTC/USDT": { symbol: "BTC/USDT", last: 100, bid: 99.9, ask: 100.1 },
  };
  klines: Record<Symbol, Kline[]> = {};
  placed: Order[] = [];

  async loadMarkets(): Promise<void> {}
  async fetchBalance(): Promise<Balance[]> {
    return this.balances;
  }
  async fetchTicker(symbol: Symbol) {
    const t = this.tickers[symbol];
    if (!t) throw new Error(`no ticker for ${symbol}`);
    return t;
  }
  async fetchKlines(symbol: Symbol): Promise<Kline[]> {
    return this.klines[symbol] ?? [];
  }
  async createOrder(
    symbol: Symbol,
    type: OrderType,
    side: Side,
    amount: number,
    price?: number,
  ): Promise<Order> {
    const now = Date.now();
    const fill = price ?? this.tickers[symbol]?.last ?? 0;
    const order: Order = {
      id: `o_${this.placed.length + 1}`,
      clientOrderId: `c_${this.placed.length + 1}`,
      symbol,
      side,
      type,
      price: price ?? null,
      amount,
      status: "filled",
      filledAmount: amount,
      avgFillPrice: fill,
      createdAt: now,
      updatedAt: now,
    };
    this.placed.push(order);
    return order;
  }
  async cancelOrder(): Promise<void> {}
  async fetchOrder(id: string): Promise<Order> {
    const o = this.placed.find((x) => x.id === id);
    if (!o) throw new Error("not found");
    return o;
  }
  async fetchOpenOrders(): Promise<Order[]> {
    return [];
  }

  asClient(): BinanceClient {
    return this as unknown as BinanceClient;
  }
}
