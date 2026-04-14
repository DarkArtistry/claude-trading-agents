import type { Candidate, Kline, Symbol, SymbolState } from "../types";
import { emaCrossover } from "./ema-crossover";
import { rsiReversion } from "./rsi-reversion";
import { breakout } from "./breakout";

type Generator = (klines: Kline[]) => Candidate | null;

const GENERATORS: Generator[] = [emaCrossover, rsiReversion, breakout];

export interface RouterDeps {
  getSymbolState: (symbol: Symbol) => SymbolState;
}

export class SignalRouter {
  constructor(private deps: RouterDeps) {}

  evaluate(symbol: Symbol, klines: Kline[]): Candidate[] {
    const state = this.deps.getSymbolState(symbol);
    const now = Date.now();
    if (state.cooldownUntil && now < state.cooldownUntil) return [];
    if (state.position) return [];

    const out: Candidate[] = [];
    for (const gen of GENERATORS) {
      const c = gen(klines);
      if (c) out.push(c);
    }
    return out;
  }
}
