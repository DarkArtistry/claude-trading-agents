import { z } from "zod";
import type { RiskLimits, Symbol } from "./types";

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  BINANCE_API_KEY: z.string().min(1),
  BINANCE_API_SECRET: z.string().min(1),
  BINANCE_USE_TESTNET: z.enum(["true", "false"]).default("true"),
  I_UNDERSTAND_MAINNET: z.enum(["yes", "no"]).default("no"),
  UNIVERSE: z.string().default("BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT"),
  TIMEFRAME: z.enum(["1m", "5m", "15m"]).default("5m"),
  DRY_RUN: z.enum(["true", "false"]).default("true"),
  DB_PATH: z.string().default("./data/journal.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  MCP_PORT: z.coerce.number().int().positive().default(3333),
  MCP_AUTH_TOKEN: z.string().min(16).default("change-me-dev-token-please"),
  MCP_PUBLIC_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional(),
  ),

  PM_MODEL: z.string().default("claude-opus-4-6"),
  SUB_AGENT_MODEL: z.string().default("claude-sonnet-4-6"),
  AGENT_CACHE_PATH: z.string().default("./data/agent-cache.json"),
  PM_BACKEND: z.enum(["local", "managed"]).default("local"),
  SESSION_ID: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().optional(),
  ),
});

export interface Config {
  anthropicApiKey: string;
  binance: {
    apiKey: string;
    apiSecret: string;
    useTestnet: boolean;
  };
  universe: Symbol[];
  timeframe: "1m" | "5m" | "15m";
  dryRun: boolean;
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  risk: RiskLimits;
  mcp: {
    port: number;
    authToken: string;
    publicUrl: string | undefined;
  };
  agents: {
    pmModel: string;
    subAgentModel: string;
    cachePath: string;
    pmBackend: "local" | "managed";
    attachSessionId: string | undefined;
  };
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxConcurrentPositions: 3,
  maxPositionPctEquity: 15,
  maxDailyLossPctEquity: 5,
  maxConsecutiveLosses: 4,
  symbolCooldownMs: 15 * 60 * 1000,
  hardStopPctFromEntry: 2,
  maxOrdersPerMinute: 10,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);

  const useTestnet = parsed.BINANCE_USE_TESTNET === "true";
  if (!useTestnet && parsed.I_UNDERSTAND_MAINNET !== "yes") {
    throw new Error(
      "Mainnet refused: set I_UNDERSTAND_MAINNET=yes to confirm you really mean it.",
    );
  }

  return {
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    binance: {
      apiKey: parsed.BINANCE_API_KEY,
      apiSecret: parsed.BINANCE_API_SECRET,
      useTestnet,
    },
    universe: parsed.UNIVERSE.split(",").map((s) => s.trim()).filter(Boolean),
    timeframe: parsed.TIMEFRAME,
    dryRun: parsed.DRY_RUN === "true",
    dbPath: parsed.DB_PATH,
    logLevel: parsed.LOG_LEVEL,
    risk: DEFAULT_RISK_LIMITS,
    mcp: {
      port: parsed.MCP_PORT,
      authToken: parsed.MCP_AUTH_TOKEN,
      publicUrl: parsed.MCP_PUBLIC_URL,
    },
    agents: {
      pmModel: parsed.PM_MODEL,
      subAgentModel: parsed.SUB_AGENT_MODEL,
      cachePath: parsed.AGENT_CACHE_PATH,
      pmBackend: parsed.PM_BACKEND,
      attachSessionId: parsed.SESSION_ID,
    },
  };
}
