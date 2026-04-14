import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type Config } from "../config";
import { createLogger } from "../util/logger";
import { openDb } from "../state/db";
import { Journal } from "../state/journal";
import { PositionStore } from "../state/positions";
import { BinanceClient } from "../binance/client";
import { KlineStream } from "../binance/stream";
import { SignalRouter } from "../signals";
import { RiskEngine } from "../risk/limits";
import { SignalLoop } from "../loops/signal-loop";
import { FastLoop } from "../loops/fast-loop";
import { Ops, CandidateQueue } from "./ops";
import { SubAgents } from "./subagents";
import { buildMcpServer } from "./server";
import { startMcpHttp } from "./http";

export interface McpRuntime {
  config: Config;
  stop: () => Promise<void>;
}

export async function startMcp(): Promise<McpRuntime> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { proc: "mcp" });
  logger.info("boot", {
    testnet: config.binance.useTestnet,
    universe: config.universe,
    dryRun: config.dryRun,
    port: config.mcp.port,
  });

  const db = openDb(config.dbPath);
  const journal = new Journal(db);
  const positions = new PositionStore(db);

  const binance = new BinanceClient(config.binance);
  await binance.loadMarkets();
  logger.info("binance markets loaded");

  const risk = new RiskEngine(config.risk, positions, db);
  const ops = new Ops({
    binance,
    positions,
    journal,
    risk,
    logger: logger.child({ c: "ops" }),
    dryRun: config.dryRun,
    symbolCooldownMs: config.risk.symbolCooldownMs,
  });

  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const subagents = new SubAgents({
    client: anthropic,
    ops,
    model: config.agents.subAgentModel,
    logger: logger.child({ c: "subagents" }),
  });

  const candidates = new CandidateQueue();

  const router = new SignalRouter({
    getSymbolState: (s) => ({
      symbol: s,
      lastCandidateAt: null,
      lastTradeAt: null,
      cooldownUntil: ops.getCooldownUntil(s),
      position: positions.get(s),
    }),
  });

  const stream = new KlineStream(config.universe, config.timeframe, config.binance.useTestnet);
  stream.on("error", (err) => logger.warn("kline stream error", { err: err.message }));
  stream.on("reconnect", (sym) => logger.info("kline stream reconnecting", { symbol: sym }));
  const signalLoop = new SignalLoop({
    binance,
    stream,
    router,
    journal,
    logger: logger.child({ loop: "signal" }),
    timeframe: config.timeframe,
  });
  signalLoop.on("candidate", (c) => {
    logger.info("candidate queued", { symbol: c.symbol, strategy: c.strategy });
    candidates.push(c);
  });

  const fastLoop = new FastLoop({ binance, positions, risk, logger: logger.child({ loop: "fast" }) });
  fastLoop.on("stopTriggered", (pos) => {
    void ops
      .closePosition(pos.symbol, "stop-loss")
      .catch((err) => logger.error("stop-close failed", { symbol: pos.symbol, err: (err as Error).message }));
  });

  await signalLoop.start(config.universe);
  fastLoop.start();

  const httpServer = await startMcpHttp({
    serverFactory: () =>
      buildMcpServer({
        ops,
        subagents,
        candidates,
        journal,
        streamHealth: () => stream.health(),
        logger: logger.child({ c: "mcp-server" }),
      }),
    port: config.mcp.port,
    authToken: config.mcp.authToken,
    logger: logger.child({ c: "mcp-http" }),
  });

  return {
    config,
    stop: async () => {
      signalLoop.halt();
      fastLoop.halt();
      stream.stop();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      db.close();
    },
  };
}
