import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Ops, CandidateQueue } from "./ops";
import type { SubAgents } from "./subagents";
import type { Journal } from "../state/journal";
import type { Logger } from "../util/logger";
import type { AgentEvent, AgentName } from "../types";

export interface McpServerDeps {
  ops: Ops;
  subagents: SubAgents;
  candidates: CandidateQueue;
  journal: Journal;
  streamHealth: () => Record<string, { lastCloseAt: number | null }>;
  logger: Logger;
}

export function buildMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: "trading-agents", version: "0.1.0" });
  const ok = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x) }] });

  const logEvent = (
    from: AgentEvent["from"],
    to: AgentEvent["to"],
    kind: AgentEvent["kind"],
    payload: unknown,
    durationMs?: number,
  ): void => {
    const event: AgentEvent = {
      id: randomUUID(),
      ts: Date.now(),
      from,
      to,
      kind,
      ...(durationMs !== undefined ? { durationMs } : {}),
      payload,
    };
    deps.journal.logAgentEvent(event);
  };

  const delegate = async (
    agent: AgentName,
    runner: (task: string, context?: Record<string, unknown>) => Promise<string>,
    task: string,
    context: Record<string, unknown> | undefined,
  ) => {
    logEvent("pm", agent, "call", { task, context });
    const start = Date.now();
    try {
      const text = await runner(task, context);
      logEvent(agent, "pm", "response", { text }, Date.now() - start);
      return ok({ text });
    } catch (err) {
      const message = (err as Error).message;
      logEvent(agent, "pm", "error", { error: message }, Date.now() - start);
      throw err;
    }
  };

  server.registerTool(
    "get_portfolio_summary",
    {
      description: "Return current equity, free quote balance, open positions, unrealized PnL, today's realized PnL, and loop status.",
      inputSchema: {},
    },
    async () => ok(await deps.ops.getPortfolioSummary()),
  );

  server.registerTool(
    "get_positions",
    {
      description: "List currently open positions with entry, stop, unrealized PnL.",
      inputSchema: {},
    },
    async () => ok(deps.ops.getPositions()),
  );

  server.registerTool(
    "get_ticker",
    {
      description: "Get best bid / ask / last price for a symbol on Binance.",
      inputSchema: { symbol: z.string() },
    },
    async ({ symbol }) => ok(await deps.ops.getTicker(symbol)),
  );

  server.registerTool(
    "get_klines",
    {
      description: "Fetch recent OHLCV candles for a symbol.",
      inputSchema: {
        symbol: z.string(),
        timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]),
        limit: z.number().int().min(10).max(500).optional(),
      },
    },
    async ({ symbol, timeframe, limit }) => ok(await deps.ops.getKlines(symbol, timeframe, limit)),
  );

  server.registerTool(
    "get_indicators",
    {
      description: "Compute EMA9, EMA21, EMA50, RSI14, ATR14 and lastClose for a symbol+timeframe.",
      inputSchema: {
        symbol: z.string(),
        timeframe: z.enum(["1m", "5m", "15m", "1h"]),
      },
    },
    async ({ symbol, timeframe }) => ok(await deps.ops.getIndicators(symbol, timeframe)),
  );

  server.registerTool(
    "check_risk_limits",
    {
      description:
        "Code-level risk check. Returns approved sizeBase/sizeQuote + stopPrice + takeProfitPrice, or rejection with a reason. LLMs cannot override this.",
      inputSchema: {
        symbol: z.string(),
        side: z.enum(["buy", "sell"]),
        desiredNotionalQuote: z.number().positive(),
      },
    },
    async ({ symbol, side, desiredNotionalQuote }) =>
      ok(await deps.ops.checkRiskLimits(symbol, side, desiredNotionalQuote)),
  );

  server.registerTool(
    "place_order",
    {
      description:
        "Place an order on Binance. In dry-run, returns a simulated filled order. Must pass candidateId for journaling (use 'manual' prefix for user-initiated trades).",
      inputSchema: {
        symbol: z.string(),
        side: z.enum(["buy", "sell"]),
        type: z.enum(["market", "limit", "stop_market", "stop_limit"]),
        amount: z.number().positive(),
        price: z.number().positive().optional(),
        stopPrice: z.number().positive().optional(),
        candidateId: z.string(),
      },
    },
    async (input) => ok(await deps.ops.placeOrder(input)),
  );

  server.registerTool(
    "cancel_order",
    {
      description: "Cancel an open order by id.",
      inputSchema: {
        orderId: z.string(),
        symbol: z.string(),
      },
    },
    async ({ orderId, symbol }) => ok(await deps.ops.cancelOrder(orderId, symbol)),
  );

  server.registerTool(
    "get_next_candidate",
    {
      description:
        "Long-poll for the next code-generated signal candidate. Blocks up to timeoutMs (default 25000). Returns the candidate object or null if no candidate arrived in time.",
      inputSchema: {
        timeoutMs: z.number().int().min(100).max(55_000).optional(),
      },
    },
    async ({ timeoutMs }) => ok(await deps.candidates.next(timeoutMs ?? 25_000)),
  );

  server.registerTool(
    "record_candidate_outcome",
    {
      description:
        "Mark what happened to a candidate: 'taken' (we placed the trade), 'skipped' (we chose not to), or 'rejected' (risk blocked it). Pass a short reason.",
      inputSchema: {
        candidateId: z.string(),
        outcome: z.enum(["taken", "skipped", "rejected"]),
        reason: z.string().max(500),
      },
    },
    async ({ candidateId, outcome, reason }) => {
      deps.ops.recordCandidateOutcome(candidateId, outcome, reason);
      logEvent("pm", "code", "info", { candidateId, outcome, reason });
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "get_stream_health",
    {
      description:
        "Diagnostic: for each symbol in the universe, return last candle-close timestamp observed by the Binance WebSocket stream. Use when 'Recent signals' seems empty to distinguish quiet market from broken stream.",
      inputSchema: {},
    },
    async () => ok(deps.streamHealth()),
  );

  server.registerTool(
    "get_recent_agent_events",
    {
      description:
        "Read the last N agent events (PM→Risk/Strategy/Execution calls + responses) from the journal. Use to explain recent decisions.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ limit }) => ok(deps.journal.recentAgentEvents(limit ?? 20)),
  );

  server.registerTool(
    "delegate_to_risk",
    {
      description:
        "Delegate a sizing / risk-limit decision to the Risk agent. Provide the candidate or a description of the proposed trade. Returns the Risk agent's JSON decision.",
      inputSchema: {
        task: z.string(),
        context: z.record(z.unknown()).optional(),
      },
    },
    async ({ task, context }) => delegate("risk", deps.subagents.delegateToRisk.bind(deps.subagents), task, context),
  );

  server.registerTool(
    "delegate_to_strategy",
    {
      description:
        "Delegate qualitative judgment on a candidate to the Strategy agent. Returns the Strategy agent's JSON verdict (takeIt + confidence + reasoning).",
      inputSchema: {
        task: z.string(),
        context: z.record(z.unknown()).optional(),
      },
    },
    async ({ task, context }) =>
      delegate("strategy", deps.subagents.delegateToStrategy.bind(deps.subagents), task, context),
  );

  server.registerTool(
    "delegate_to_execution",
    {
      description:
        "Delegate order placement to the Execution agent. Pass the risk-approved size, stop, take-profit, and candidateId. Returns the Execution agent's JSON receipt.",
      inputSchema: {
        task: z.string(),
        context: z.record(z.unknown()).optional(),
      },
    },
    async ({ task, context }) =>
      delegate("execution", deps.subagents.delegateToExecution.bind(deps.subagents), task, context),
  );

  return server;
}
