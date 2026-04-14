import { EventEmitter } from "node:events";
import React from "react";
import { render } from "ink";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config";
import { createLogger } from "../util/logger";
import { LocalPm } from "./local-pm";
import { TradingMcpClient } from "./mcp-client";
import { App } from "../tui/App";
import type { ChatMessage, StateSource, TuiState } from "../tui/hooks";
import type { AgentEvent, Candidate, LoopStatus, PortfolioSummary, Position } from "../types";

export async function startCli(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { proc: "cli" });

  const mcpUrl = config.mcp.publicUrl ?? `http://localhost:${config.mcp.port}`;
  logger.info("cli starting", { mcp: mcpUrl });

  const state = {
    status: "running" as LoopStatus,
    portfolio: null as PortfolioSummary | null,
    positions: [] as Position[],
    recentCandidates: [] as Candidate[],
    recentAgentEvents: [] as AgentEvent[],
    chatMessages: [] as ChatMessage[],
    pending: false,
  };
  const bus = new EventEmitter();
  const update = () => bus.emit("update");

  const mcp = new TradingMcpClient({ url: mcpUrl, authToken: config.mcp.authToken });
  await mcp.connect();
  logger.info("mcp connected");

  const pm = new LocalPm({
    apiKey: config.anthropicApiKey,
    model: config.agents.pmModel,
    mcp,
    logger: logger.child({ c: "local-pm" }),
  });

  pm.on("agentMessage", (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    state.chatMessages.push({ role: "pm", text: trimmed, ts: Date.now() });
    update();
  });
  pm.on("sessionIdle", () => {
    state.pending = false;
    update();
  });
  pm.on("agentMcpToolUse", ({ name, server, input }) => {
    state.recentAgentEvents.unshift(
      makeEvent("pm", inferAgent(name), "call", { tool: name, server, input }),
    );
    trim(state.recentAgentEvents);
    update();
  });
  pm.on("agentMcpToolResult", ({ name, server, output }) => {
    state.recentAgentEvents.unshift(
      makeEvent(inferAgent(name), "pm", "response", { tool: name, server, output }),
    );
    trim(state.recentAgentEvents);
    update();
  });
  pm.on("error", (err) => logger.error("pm error", { err: err.message }));

  await pm.start();

  void pollDashboard();
  void pollCandidates();

  const stateSource: StateSource = {
    getSnapshot: (): TuiState => ({
      status: state.status,
      portfolio: state.portfolio,
      positions: state.positions,
      recentCandidates: [...state.recentCandidates],
      recentAgentEvents: [...state.recentAgentEvents],
      chatMessages: [...state.chatMessages],
      pending: state.pending,
    }),
    on: (event, listener) => bus.on(event, listener),
    off: (event, listener) => bus.off(event, listener),
  };

  render(
    React.createElement(App, {
      stateSource,
      sendToPm: async (text: string) => {
        state.chatMessages.push({ role: "user", text, ts: Date.now() });
        state.pending = true;
        update();
        await pm.sendUserMessage(text);
      },
      onPause: () => {
        state.status = "paused";
        update();
      },
      onResume: () => {
        state.status = "running";
        update();
      },
      onKill: async () => {
        state.status = "halted";
        update();
        await pm.stop();
        await mcp.close();
      },
    }),
  );

  async function pollDashboard(): Promise<void> {
    while (state.status !== "halted") {
      try {
        const p = await mcp.getPortfolioSummary();
        state.portfolio = p;
        state.positions = p.positions;
        update();
      } catch (err) {
        logger.warn("dashboard poll failed", { err: (err as Error).message });
      }
      await sleep(5_000);
    }
  }

  async function pollCandidates(): Promise<void> {
    while (state.status !== "halted") {
      try {
        const c = await mcp.getNextCandidate(25_000);
        if (!c) continue;
        state.recentCandidates.unshift(c);
        trim(state.recentCandidates);
        update();
        const prompt = `CANDIDATE ${c.symbol} ${c.side.toUpperCase()} via ${c.strategy} (strength ${c.strength.toFixed(
          2,
        )}).\nFeatures: ${JSON.stringify(c.features)}\nCandidateId: ${c.id}\nDecide what to do.`;
        state.pending = true;
        update();
        await pm.sendUserMessage(prompt);
      } catch (err) {
        logger.warn("candidate poll failed", { err: (err as Error).message });
        await sleep(3_000);
      }
    }
  }
}

function makeEvent(
  from: AgentEvent["from"],
  to: AgentEvent["from"],
  kind: AgentEvent["kind"],
  payload: unknown,
): AgentEvent {
  return { id: randomUUID(), ts: Date.now(), from, to, kind, payload };
}

function inferAgent(toolName: string): AgentEvent["from"] {
  if (toolName === "delegate_to_risk") return "risk";
  if (toolName === "delegate_to_strategy") return "strategy";
  if (toolName === "delegate_to_execution") return "execution";
  return "code";
}

function trim<T>(arr: T[], limit = 50): void {
  while (arr.length > limit) arr.pop();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
