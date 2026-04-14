import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { memDb } from "../helpers/db";
import { FakeBinance } from "../helpers/fake-binance";
import { Journal } from "../../src/state/journal";
import { PositionStore } from "../../src/state/positions";
import { RiskEngine } from "../../src/risk/limits";
import { DEFAULT_RISK_LIMITS } from "../../src/config";
import { Ops, CandidateQueue } from "../../src/mcp/ops";
import { SubAgents } from "../../src/mcp/subagents";
import { buildMcpServer } from "../../src/mcp/server";
import { startMcpHttp } from "../../src/mcp/http";
import { TradingMcpClient } from "../../src/cli/mcp-client";
import { createLogger } from "../../src/util/logger";
import type { Candidate } from "../../src/types";

const silent = createLogger("error");
let ctx: {
  db: ReturnType<typeof memDb>;
  journal: Journal;
  httpServer: http.Server;
  client: TradingMcpClient;
};

beforeEach(async () => {
  const db = memDb();
  const journal = new Journal(db);
  const positions = new PositionStore(db);
  const binance = new FakeBinance();
  const risk = new RiskEngine(DEFAULT_RISK_LIMITS, positions, db);
  const ops = new Ops({
    binance: binance.asClient(),
    positions,
    journal,
    risk,
    logger: silent,
    dryRun: true,
    symbolCooldownMs: 1_000,
  });
  const candidates = new CandidateQueue();
  const subagents = new SubAgents({
    client: new Anthropic({ apiKey: "unused-in-this-test" }),
    ops,
    model: "claude-sonnet-4-6",
    logger: silent,
  });
  const httpServer = await startMcpHttp({
    serverFactory: () =>
      buildMcpServer({
        ops,
        subagents,
        candidates,
        journal,
        streamHealth: () => ({
          "BTC/USDT": { lastCloseAt: 1_700_000_000_000 },
          "ETH/USDT": { lastCloseAt: null },
        }),
        logger: silent,
      }),
    port: 0,
    authToken: "token-for-testing-16",
    logger: silent,
  });
  const port = (httpServer.address() as AddressInfo).port;
  const client = new TradingMcpClient({ url: `http://127.0.0.1:${port}`, authToken: "token-for-testing-16" });
  await client.connect();
  ctx = { db, journal, httpServer, client };
});

afterEach(async () => {
  await ctx.client.close();
  await new Promise<void>((r) => ctx.httpServer.close(() => r()));
  ctx.db.close();
});

function candidate(id = "c-e2e"): Candidate {
  return {
    id,
    symbol: "BTC/USDT",
    side: "buy",
    strategy: "ema_crossover",
    strength: 0.7,
    features: {},
    klineCloseTime: Date.now(),
    createdAt: Date.now(),
  };
}

describe("record_candidate_outcome", () => {
  test("updates the candidate row and logs an agent event", async () => {
    ctx.journal.saveCandidate(candidate("c1"));
    const r = await ctx.client.recordCandidateOutcome("c1", "taken", "strategy liked the setup");
    expect(r.ok).toBe(true);
    const row = ctx.db
      .prepare("SELECT outcome, outcome_reason FROM candidates WHERE id = ?")
      .get("c1") as { outcome: string; outcome_reason: string };
    expect(row.outcome).toBe("taken");
    expect(row.outcome_reason).toBe("strategy liked the setup");
    const events = ctx.journal.recentAgentEvents(10);
    expect(events.length).toBe(1);
    expect(events[0]!.from).toBe("pm");
    expect(events[0]!.kind).toBe("info");
  });
});

describe("get_stream_health", () => {
  test("returns per-symbol last-close timestamps", async () => {
    const health = await ctx.client.getStreamHealth();
    expect(health["BTC/USDT"]?.lastCloseAt).toBe(1_700_000_000_000);
    expect(health["ETH/USDT"]?.lastCloseAt).toBeNull();
  });
});

describe("get_recent_agent_events", () => {
  test("returns what Journal has logged", async () => {
    expect(await ctx.client.getRecentAgentEvents()).toEqual([]);
    ctx.journal.logAgentEvent({
      id: "evt_1",
      ts: 1_700_000_000_000,
      from: "pm",
      to: "risk",
      kind: "call",
      payload: { task: "size BTC" },
    });
    const events = (await ctx.client.getRecentAgentEvents()) as Array<{
      from: string;
      to: string;
      kind: string;
    }>;
    expect(events.length).toBe(1);
    expect(events[0]!.from).toBe("pm");
    expect(events[0]!.to).toBe("risk");
    expect(events[0]!.kind).toBe("call");
  });
});
