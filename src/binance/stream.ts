import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { Kline, Symbol } from "../types";

const TESTNET_WS = "wss://stream.testnet.binance.vision:9443/ws";
const MAINNET_WS = "wss://stream.binance.com:9443/ws";

type Events = {
  candleClose: [Kline];
  error: [Error];
  reconnect: [Symbol];
};

interface Connection {
  symbol: Symbol;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

export class KlineStream extends EventEmitter<Events> {
  private connections: Connection[] = [];
  private lastCloseAt = new Map<Symbol, number>();

  constructor(
    private symbols: Symbol[],
    private timeframe: string,
    private useTestnet: boolean,
  ) {
    super();
  }

  health(): Record<string, { lastCloseAt: number | null }> {
    const out: Record<string, { lastCloseAt: number | null }> = {};
    for (const s of this.symbols) {
      out[s] = { lastCloseAt: this.lastCloseAt.get(s) ?? null };
    }
    return out;
  }

  start(): void {
    for (const symbol of this.symbols) {
      const conn: Connection = { symbol, ws: null, reconnectTimer: null, stopped: false };
      this.connections.push(conn);
      this.open(conn);
    }
  }

  stop(): void {
    for (const c of this.connections) {
      c.stopped = true;
      if (c.reconnectTimer) clearTimeout(c.reconnectTimer);
      c.ws?.removeAllListeners();
      c.ws?.close();
    }
    this.connections = [];
  }

  private open(conn: Connection): void {
    const base = this.useTestnet ? TESTNET_WS : MAINNET_WS;
    const stream = `${conn.symbol.replace("/", "").toLowerCase()}@kline_${this.timeframe}`;
    const url = `${base}/${stream}`;

    const ws = new WebSocket(url);
    conn.ws = ws;

    ws.on("message", (buf) => this.onMessage(conn.symbol, buf.toString()));
    ws.on("close", () => {
      if (conn.stopped) return;
      conn.reconnectTimer = setTimeout(() => {
        this.emit("reconnect", conn.symbol);
        this.open(conn);
      }, 2_000);
    });
    ws.on("error", (err) => this.emit("error", err));
  }

  private onMessage(symbol: Symbol, raw: string): void {
    const msg = JSON.parse(raw);
    const k = msg.k;
    if (!k || !k.x) return;
    this.lastCloseAt.set(symbol, Date.now());
    this.emit("candleClose", {
      symbol,
      openTime: k.t,
      closeTime: k.T,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
    });
  }
}
