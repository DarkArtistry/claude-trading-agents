import Anthropic from "@anthropic-ai/sdk";
import { EventEmitter } from "node:events";
import type { TradingMcpClient } from "./mcp-client";
import type { Logger } from "../util/logger";
import { PM_SYSTEM_PROMPT } from "../agents/pm";

export interface LocalPmEventMap {
  agentMessage: [string];
  agentMcpToolUse: [{ name: string; server: string; input: unknown }];
  agentMcpToolResult: [{ name: string; server: string; output: unknown }];
  sessionIdle: [];
  error: [Error];
}

export interface LocalPmOpts {
  apiKey: string;
  model: string;
  mcp: TradingMcpClient;
  logger: Logger;
  maxTurnsPerMessage?: number;
}

export class LocalPm extends EventEmitter<LocalPmEventMap> {
  private client: Anthropic;
  private tools: Anthropic.Tool[] = [];
  private history: Anthropic.MessageParam[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private opts: LocalPmOpts) {
    super();
    this.client = new Anthropic({ apiKey: opts.apiKey });
  }

  async start(): Promise<void> {
    const mcpTools = await this.opts.mcp.listTools();
    this.tools = mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    }));
    this.opts.logger.info("local PM ready", { toolCount: this.tools.length });
  }

  async stop(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  /**
   * Serialize incoming messages. If a message arrives while another is still
   * being processed, it waits in order — never dropped. Every processed
   * message ends in a `sessionIdle` emission, even on error.
   */
  sendUserMessage(text: string): Promise<void> {
    const run = this.queue.then(() => this.processOne(text)).catch(() => undefined);
    this.queue = run;
    return run;
  }

  private async processOne(text: string): Promise<void> {
    const snapshot = this.history.length;
    this.history.push({ role: "user", content: text });
    try {
      await this.runLoop();
    } catch (err) {
      this.emit("error", err as Error);
      // Roll back the user turn so the next exchange isn't malformed.
      this.history.length = snapshot;
    } finally {
      this.emit("sessionIdle");
    }
  }

  private async runLoop(): Promise<void> {
    const maxTurns = this.opts.maxTurnsPerMessage ?? 16;
    for (let turn = 0; turn < maxTurns; turn++) {
      const res = await this.client.messages.create({
        model: this.opts.model,
        max_tokens: 2048,
        system: PM_SYSTEM_PROMPT,
        tools: this.tools,
        messages: this.history,
      });

      const textBlocks = res.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      const text = textBlocks.map((b) => b.text).join("").trim();
      if (text) this.emit("agentMessage", text);

      this.history.push({ role: "assistant", content: res.content });

      const toolUses = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
        return;
      }

      const results = await Promise.all(
        toolUses.map(async (t) => {
          const input = t.input as Record<string, unknown>;
          this.emit("agentMcpToolUse", {
            name: t.name,
            server: "trading_agents",
            input,
          });
          try {
            const raw = await this.opts.mcp.callToolRaw(t.name, input);
            const first = raw.content[0];
            const body = first?.text ?? JSON.stringify(raw);
            this.emit("agentMcpToolResult", {
              name: t.name,
              server: "trading_agents",
              output: tryParse(body),
            });
            return {
              type: "tool_result" as const,
              tool_use_id: t.id,
              content: body,
              is_error: raw.isError ?? false,
            };
          } catch (err) {
            const message = (err as Error).message;
            this.emit("agentMcpToolResult", {
              name: t.name,
              server: "trading_agents",
              output: { error: message },
            });
            return {
              type: "tool_result" as const,
              tool_use_id: t.id,
              content: JSON.stringify({ error: message }),
              is_error: true,
            };
          }
        }),
      );

      this.history.push({ role: "user", content: results });
    }
    this.opts.logger.warn("local PM hit turn limit");
  }
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
