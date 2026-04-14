export type Side = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop_market" | "stop_limit";
export type OrderStatus = "pending" | "open" | "filled" | "partially_filled" | "canceled" | "rejected";
export type LoopStatus = "running" | "paused" | "halted";

export type Symbol = string;

export interface Kline {
  symbol: Symbol;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Candidate {
  id: string;
  symbol: Symbol;
  side: Side;
  strategy: string;
  strength: number;
  features: Record<string, number>;
  klineCloseTime: number;
  createdAt: number;
}

export interface RiskDecision {
  approved: boolean;
  sizeBase: number;
  sizeQuote: number;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  reason: string;
}

export interface StrategyJudgment {
  takeIt: boolean;
  confidence: number;
  reasoning: string;
}

export interface Order {
  id: string;
  clientOrderId: string;
  symbol: Symbol;
  side: Side;
  type: OrderType;
  price: number | null;
  amount: number;
  status: OrderStatus;
  filledAmount: number;
  avgFillPrice: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Position {
  symbol: Symbol;
  side: Side;
  amount: number;
  entryPrice: number;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  unrealizedPnl: number;
  realizedPnl: number;
  openedAt: number;
}

export interface Balance {
  asset: string;
  free: number;
  used: number;
  total: number;
}

export interface SymbolState {
  symbol: Symbol;
  lastCandidateAt: number | null;
  lastTradeAt: number | null;
  cooldownUntil: number | null;
  position: Position | null;
}

export interface PortfolioSummary {
  equityQuote: number;
  freeQuote: number;
  positions: Position[];
  realizedPnlToday: number;
  unrealizedPnl: number;
  openPositionCount: number;
  tradeCountToday: number;
  status: LoopStatus;
}

export type AgentName = "pm" | "risk" | "strategy" | "execution" | "market_data";

export interface AgentEvent {
  id: string;
  ts: number;
  from: AgentName | "code";
  to: AgentName | "user" | "code";
  kind: "call" | "response" | "error" | "info";
  durationMs?: number;
  payload: unknown;
}

export interface RiskLimits {
  maxConcurrentPositions: number;
  maxPositionPctEquity: number;
  maxDailyLossPctEquity: number;
  maxConsecutiveLosses: number;
  symbolCooldownMs: number;
  hardStopPctFromEntry: number;
  maxOrdersPerMinute: number;
}
