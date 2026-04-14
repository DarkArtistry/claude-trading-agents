import { EventEmitter } from "node:events";
import type { BinanceClient } from "../binance/client";
import type { PositionStore } from "../state/positions";
import type { RiskEngine } from "../risk/limits";
import type { Logger } from "../util/logger";
import type { LoopStatus, Position } from "../types";

type Events = {
  stopTriggered: [Position];
  pauseRequested: [string];
  tick: [];
};

export interface FastLoopDeps {
  binance: BinanceClient;
  positions: PositionStore;
  risk: RiskEngine;
  logger: Logger;
  intervalMs?: number;
}

export class FastLoop extends EventEmitter<Events> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: LoopStatus = "paused";
  private readonly intervalMs: number;

  constructor(private deps: FastLoopDeps) {
    super();
    this.intervalMs = deps.intervalMs ?? 5_000;
  }

  start(): void {
    if (this.timer) return;
    this.status = "running";
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  pause(): void {
    this.status = "paused";
  }

  resume(): void {
    this.status = "running";
  }

  halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = "halted";
  }

  getStatus(): LoopStatus {
    return this.status;
  }

  private async tick(): Promise<void> {
    if (this.status !== "running") return;
    this.emit("tick");

    const open = this.deps.positions.all();
    for (const pos of open) {
      await this.checkStop(pos);
    }
  }

  private async checkStop(pos: Position): Promise<void> {
    if (pos.stopPrice === null) return;
    const ticker = await this.deps.binance.fetchTicker(pos.symbol);
    const breached =
      pos.side === "buy" ? ticker.last <= pos.stopPrice : ticker.last >= pos.stopPrice;
    if (!breached) return;

    this.deps.logger.warn("stop-loss breached", {
      symbol: pos.symbol,
      stop: pos.stopPrice,
      last: ticker.last,
    });
    this.emit("stopTriggered", pos);
  }
}
