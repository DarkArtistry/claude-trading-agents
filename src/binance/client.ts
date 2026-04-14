import ccxt, { type Exchange } from "ccxt";
import type { Balance, Kline, Order, OrderType, Side, Symbol } from "../types";
import { RateLimiter } from "./rate-limiter";

export interface BinanceClientOpts {
  apiKey: string;
  apiSecret: string;
  useTestnet: boolean;
}

export class BinanceClient {
  private readonly ex: Exchange;
  private readonly limiter = new RateLimiter(10, 8);

  constructor(opts: BinanceClientOpts) {
    this.ex = new ccxt.binance({
      apiKey: opts.apiKey,
      secret: opts.apiSecret,
      enableRateLimit: true,
      options: { defaultType: "spot", adjustForTimeDifference: true },
    });
    if (opts.useTestnet) this.ex.setSandboxMode(true);
  }

  async loadMarkets(): Promise<void> {
    await this.limiter.take();
    await this.ex.loadMarkets();
  }

  async fetchKlines(symbol: Symbol, timeframe: string, limit = 200): Promise<Kline[]> {
    await this.limiter.take();
    const raw = await this.ex.fetchOHLCV(symbol, timeframe, undefined, limit);
    return raw.map((k) => ({
      symbol,
      openTime: k[0]!,
      closeTime: k[0]! + timeframeMs(timeframe) - 1,
      open: k[1]!,
      high: k[2]!,
      low: k[3]!,
      close: k[4]!,
      volume: k[5]!,
    }));
  }

  async fetchTicker(symbol: Symbol): Promise<{ symbol: Symbol; last: number; bid: number; ask: number }> {
    await this.limiter.take();
    const t = await this.ex.fetchTicker(symbol);
    return { symbol, last: t.last ?? 0, bid: t.bid ?? 0, ask: t.ask ?? 0 };
  }

  async fetchBalance(): Promise<Balance[]> {
    await this.limiter.take();
    const b = (await this.ex.fetchBalance()) as unknown as {
      total?: Record<string, number>;
      free?: Record<string, number>;
      used?: Record<string, number>;
    };
    const out: Balance[] = [];
    const totals = b.total ?? {};
    for (const [asset, totalRaw] of Object.entries(totals)) {
      if (typeof totalRaw !== "number") continue;
      out.push({
        asset,
        free: b.free?.[asset] ?? 0,
        used: b.used?.[asset] ?? 0,
        total: totalRaw,
      });
    }
    return out;
  }

  async createOrder(
    symbol: Symbol,
    type: OrderType,
    side: Side,
    amount: number,
    price?: number,
    params: Record<string, unknown> = {},
  ): Promise<Order> {
    await this.limiter.take(2);
    const o = await this.ex.createOrder(symbol, type, side, amount, price, params);
    return toOrder(o);
  }

  async cancelOrder(id: string, symbol: Symbol): Promise<void> {
    await this.limiter.take();
    await this.ex.cancelOrder(id, symbol);
  }

  async fetchOrder(id: string, symbol: Symbol): Promise<Order> {
    await this.limiter.take();
    const o = await this.ex.fetchOrder(id, symbol);
    return toOrder(o);
  }

  async fetchOpenOrders(symbol?: Symbol): Promise<Order[]> {
    await this.limiter.take();
    const orders = await this.ex.fetchOpenOrders(symbol);
    return orders.map(toOrder);
  }
}

function toOrder(raw: unknown): Order {
  const o = raw as Record<string, unknown>;
  return {
    id: String(o.id ?? ""),
    clientOrderId: (o.clientOrderId as string | undefined) ?? String(o.id ?? ""),
    symbol: o.symbol as string,
    side: o.side as Side,
    type: o.type as OrderType,
    price: (o.price as number | null | undefined) ?? null,
    amount: (o.amount as number | undefined) ?? 0,
    status: ((o.status as string | undefined) ?? "open") as Order["status"],
    filledAmount: (o.filled as number | undefined) ?? 0,
    avgFillPrice: (o.average as number | null | undefined) ?? null,
    createdAt: (o.timestamp as number | undefined) ?? Date.now(),
    updatedAt: (o.lastUpdateTimestamp as number | undefined) ?? (o.timestamp as number | undefined) ?? Date.now(),
  };
}

function timeframeMs(tf: string): number {
  const n = parseInt(tf, 10);
  if (tf.endsWith("m")) return n * 60_000;
  if (tf.endsWith("h")) return n * 3_600_000;
  if (tf.endsWith("d")) return n * 86_400_000;
  throw new Error(`unsupported timeframe: ${tf}`);
}
