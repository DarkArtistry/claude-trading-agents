import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

const state: {
  httpServer?: http.Server;
  client?: TradingMcpClient;
  candidates?: CandidateQueue;
  binance?: FakeBinance;
  ops?: Ops;
  db?: ReturnType<typeof memDb>;
  url?: string;
  port?: number;
} = {};

beforeAll(async () => {
  const db = memDb();
  const journal = new Journal(db);
  const positions = new PositionStore(db);
  const binance = new FakeBinance();
  binance.tickers["ETH/USDT"] = { symbol: "ETH/USDT", last: 3000, bid: 2999.5, ask: 3000.5 };
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
    client: new Anthropic({ apiKey: "test-key-not-used-in-this-test" }),
    ops,
    model: "claude-sonnet-4-6",
    logger: silent,
  });
  const httpServer = await startMcpHttp({
    serverFactory: () => buildMcpServer({ ops, subagents, candidates, logger: silent }),
    port: 0,
    authToken: "test-token-16-characters",
    logger: silent,
  });
  const address = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const client = new TradingMcpClient({ url, authToken: "test-token-16-characters" });
  await client.connect();

  state.db = db;
  state.httpServer = httpServer;
  state.client = client;
  state.candidates = candidates;
  state.binance = binance;
  state.ops = ops;
  state.url = url;
  state.port = address.port;
});

afterAll(async () => {
  await state.client?.close();
  await new Promise<void>((r) => state.httpServer?.close(() => r()));
  state.db?.close();
});

describe("MCP server e2e (real MCP + real HTTP + real client)", () => {
  test("get_portfolio_summary returns equity and zero positions", async () => {
    const p = await state.client!.getPortfolioSummary();
    expect(p.freeQuote).toBe(10_000);
    expect(p.openPositionCount).toBe(0);
    expect(p.status).toBe("running");
  });

  test("get_positions returns empty initially", async () => {
    expect(await state.client!.getPositions()).toEqual([]);
  });

  test("get_next_candidate returns null on timeout", async () => {
    const c = await state.client!.getNextCandidate(300);
    expect(c).toBeNull();
  });

  test("candidate pushed into the queue is delivered to the client", async () => {
    const candidate: Candidate = {
      id: "e2e_cand_1",
      symbol: "BTC/USDT",
      side: "buy",
      strategy: "ema_crossover",
      strength: 0.7,
      features: { fast: 101, slow: 100 },
      klineCloseTime: Date.now(),
      createdAt: Date.now(),
    };
    const poll = state.client!.getNextCandidate(1_500);
    await new Promise((r) => setTimeout(r, 50));
    state.candidates!.push(candidate);
    const received = await poll;
    expect(received?.id).toBe("e2e_cand_1");
  });

  test("auth rejection: client with wrong token fails to connect", async () => {
    const bad = new TradingMcpClient({ url: state.url!, authToken: "wrong-token" });
    await expect(bad.connect()).rejects.toThrow();
  });

  test("health endpoint is accessible without auth", async () => {
    const res = await fetch(`${state.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("MCP server e2e — end-to-end trade flow via MCP client", () => {
  test("full open → close flow through MCP tools updates portfolio", async () => {
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
      client: new Anthropic({ apiKey: "test-key" }),
      ops,
      model: "claude-sonnet-4-6",
      logger: silent,
    });
    const httpServer = await startMcpHttp({
      serverFactory: () => buildMcpServer({ ops, subagents, candidates, logger: silent }),
      port: 0,
      authToken: "token-16-chars-long!",
      logger: silent,
    });
    const port = (httpServer.address() as AddressInfo).port;
    const client = new TradingMcpClient({
      url: `http://127.0.0.1:${port}`,
      authToken: "token-16-chars-long!",
    });
    await client.connect();

    try {
      const summaryBefore = await client.getPortfolioSummary();
      expect(summaryBefore.openPositionCount).toBe(0);

      await ops.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.5,
        candidateId: "c1",
      });

      const mid = await client.getPortfolioSummary();
      expect(mid.openPositionCount).toBe(1);

      binance.tickers["BTC/USDT"] = { symbol: "BTC/USDT", last: 120, bid: 119.9, ask: 120.1 };
      await ops.closePosition("BTC/USDT", "manual");

      const after = await client.getPortfolioSummary();
      expect(after.openPositionCount).toBe(0);
      expect(after.realizedPnlToday).toBeCloseTo(10, 3);
      expect(after.tradeCountToday).toBe(1);
    } finally {
      await client.close();
      await new Promise<void>((r) => httpServer.close(() => r()));
      db.close();
    }
  });
});
