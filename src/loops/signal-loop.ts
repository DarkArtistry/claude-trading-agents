import { EventEmitter } from "node:events";
import type { BinanceClient } from "../binance/client";
import type { KlineStream } from "../binance/stream";
import type { Journal } from "../state/journal";
import type { SignalRouter } from "../signals";
import type { Logger } from "../util/logger";
import type { Candidate, Kline, LoopStatus, Symbol } from "../types";

type Events = {
  candidate: [Candidate];
  tick: [Symbol];
};

export interface SignalLoopDeps {
  binance: BinanceClient;
  stream: KlineStream;
  router: SignalRouter;
  journal: Journal;
  logger: Logger;
  timeframe: string;
  klineBufferSize?: number;
}

export class SignalLoop extends EventEmitter<Events> {
  private buffers: Map<Symbol, Kline[]> = new Map();
  private status: LoopStatus = "paused";
  private readonly bufferSize: number;

  constructor(private deps: SignalLoopDeps) {
    super();
    this.bufferSize = deps.klineBufferSize ?? 200;
  }

  async start(symbols: Symbol[]): Promise<void> {
    for (const s of symbols) {
      const klines = await this.deps.binance.fetchKlines(s, this.deps.timeframe, this.bufferSize);
      this.buffers.set(s, klines);
    }
    this.deps.stream.on("candleClose", (k) => this.onCandleClose(k));
    this.deps.stream.start();
    this.status = "running";
  }

  pause(): void { this.status = "paused"; }
  resume(): void { this.status = "running"; }
  halt(): void { this.status = "halted"; this.deps.stream.stop(); }
  getStatus(): LoopStatus { return this.status; }

  private onCandleClose(k: Kline): void {
    if (this.status !== "running") return;
    const buf = this.buffers.get(k.symbol);
    if (!buf) return;
    buf.push(k);
    if (buf.length > this.bufferSize) buf.shift();
    this.emit("tick", k.symbol);

    const candidates = this.deps.router.evaluate(k.symbol, buf);
    for (const c of candidates) {
      this.deps.journal.saveCandidate(c);
      this.deps.logger.info("candidate emitted", {
        symbol: c.symbol,
        side: c.side,
        strategy: c.strategy,
        strength: c.strength.toFixed(3),
      });
      this.emit("candidate", c);
    }
  }
}
