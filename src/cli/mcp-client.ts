import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Candidate, PortfolioSummary, Position } from "../types";

export interface McpClientOpts {
  url: string;
  authToken: string;
}

export class TradingMcpClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  constructor(private opts: McpClientOpts) {}

  async connect(): Promise<void> {
    const url = new URL(this.opts.url);
    url.searchParams.set("token", this.opts.authToken);
    this.transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${this.opts.authToken}` } },
    });
    this.client = new Client({ name: "trading-agents-cli", version: "0.1.0" });
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> {
    if (!this.client) throw new Error("mcp client not connected");
    const res = await this.client.listTools();
    return (res.tools ?? []) as Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
  }

  async callToolRaw(name: string, args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }> {
    if (!this.client) throw new Error("mcp client not connected");
    return (await this.client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
  }

  private async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) throw new Error("mcp client not connected");
    const res = await this.client.callTool({ name, arguments: args });
    const first = (res.content as Array<{ type: string; text?: string }> | undefined)?.[0];
    if (!first || first.type !== "text" || !first.text) {
      throw new Error(`mcp ${name} returned unexpected content`);
    }
    if (res.isError) {
      throw new Error(`mcp ${name} returned error: ${first.text}`);
    }
    return JSON.parse(first.text) as T;
  }

  getPortfolioSummary(): Promise<PortfolioSummary> {
    return this.call("get_portfolio_summary");
  }
  getPositions(): Promise<Position[]> {
    return this.call("get_positions");
  }
  getNextCandidate(timeoutMs = 25_000): Promise<Candidate | null> {
    return this.call("get_next_candidate", { timeoutMs });
  }
}
