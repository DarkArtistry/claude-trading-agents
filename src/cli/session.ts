import Anthropic from "@anthropic-ai/sdk";
import { EventEmitter } from "node:events";
import { buildPmAgentCreateParams } from "../agents/pm";
import { loadAgentCache, saveAgentCache, type AgentCache } from "./agent-cache";
import type { Logger } from "../util/logger";

export interface PmSessionEventMap {
  agentMessage: [string];
  agentMcpToolUse: [{ name: string; server: string; input: unknown }];
  agentMcpToolResult: [{ name: string; server: string; output: unknown }];
  agentThinking: [];
  sessionIdle: [];
  error: [Error];
}

export interface PmSessionOpts {
  apiKey: string;
  pmModel: string;
  mcpPublicUrl: string;
  mcpAuthToken: string;
  agentCachePath: string;
  logger: Logger;
  /**
   * If set, attach to an existing session instead of calling
   * `beta.sessions.create`. Lets multiple Bun TUIs observe + drive the same
   * session concurrently (every frontend streams events and can `send`).
   */
  attachSessionId?: string;
}

export class PmSession extends EventEmitter<PmSessionEventMap> {
  private client: Anthropic;
  private cache: AgentCache;
  private sessionId: string | null = null;
  private streaming = false;

  constructor(private opts: PmSessionOpts) {
    super();
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.cache = loadAgentCache(opts.agentCachePath);
  }

  async start(): Promise<{ sessionId: string; agentId: string; environmentId: string }> {
    const agentId = await this.ensureAgent();
    const environmentId = await this.ensureEnvironment();
    if (this.opts.attachSessionId) {
      this.sessionId = this.opts.attachSessionId;
      this.opts.logger.info("session attached", { id: this.sessionId });
    } else {
      const session = await this.anthropic().beta.sessions.create({
        agent: agentId,
        environment_id: environmentId,
        title: "Trading PM",
      });
      this.sessionId = session.id;
      this.opts.logger.info("session created", { id: session.id });
    }
    void this.streamLoop();
    return { sessionId: this.sessionId, agentId, environmentId };
  }

  async stop(): Promise<void> {
    this.streaming = false;
    // Attached frontends must NOT delete the shared session — only the process
    // that created it is allowed to tear it down.
    if (this.sessionId && !this.opts.attachSessionId) {
      await this.anthropic().beta.sessions.delete(this.sessionId).catch(() => undefined);
    }
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.sessionId) throw new Error("session not started");
    await this.anthropic().beta.sessions.events.send(this.sessionId, {
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    });
  }

  private async ensureAgent(): Promise<string> {
    if (this.cache.agentId && this.cache.mcpUrl === this.opts.mcpPublicUrl) return this.cache.agentId;
    const params = buildPmAgentCreateParams({
      model: this.opts.pmModel,
      mcpPublicUrl: this.opts.mcpPublicUrl,
      mcpAuthToken: this.opts.mcpAuthToken,
    });
    const agent = await this.anthropic().beta.agents.create(params as never);
    this.cache = { ...this.cache, agentId: agent.id, agentVersion: agent.version, mcpUrl: this.opts.mcpPublicUrl };
    saveAgentCache(this.opts.agentCachePath, this.cache);
    this.opts.logger.info("agent created", { id: agent.id, version: agent.version });
    return agent.id;
  }

  private async ensureEnvironment(): Promise<string> {
    if (this.cache.environmentId) return this.cache.environmentId;
    const env = await this.anthropic().beta.environments.create({
      name: "trading-agents-env",
      config: { type: "cloud", networking: { type: "unrestricted" } },
    } as never);
    this.cache = { ...this.cache, environmentId: env.id };
    saveAgentCache(this.opts.agentCachePath, this.cache);
    this.opts.logger.info("environment created", { id: env.id });
    return env.id;
  }

  private async streamLoop(): Promise<void> {
    if (!this.sessionId) return;
    this.streaming = true;
    try {
      const stream = await this.anthropic().beta.sessions.events.stream(this.sessionId);
      for await (const event of stream) {
        if (!this.streaming) break;
        this.dispatch(event);
      }
    } catch (err) {
      this.emit("error", err as Error);
    }
  }

  private dispatch(raw: unknown): void {
    const event = raw as { type: string } & Record<string, unknown>;
    switch (event.type) {
      case "agent.message": {
        const content = event.content as Array<{ type: string; text?: string }> | undefined;
        const text = (content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
        this.emit("agentMessage", text);
        break;
      }
      case "agent.thinking":
        this.emit("agentThinking");
        break;
      case "agent.mcp_tool_use":
        this.emit("agentMcpToolUse", {
          name: event.name as string,
          server: event.mcp_server_name as string,
          input: event.input,
        });
        break;
      case "agent.mcp_tool_result":
        this.emit("agentMcpToolResult", {
          name: event.name as string,
          server: event.mcp_server_name as string,
          output: event.output,
        });
        break;
      case "session.status_idle":
        this.emit("sessionIdle");
        break;
    }
  }

  private anthropic(): Anthropic {
    return this.client;
  }
}
