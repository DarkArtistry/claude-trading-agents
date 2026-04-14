import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../util/logger";

export interface McpHttpOpts {
  serverFactory: () => McpServer;
  port: number;
  authToken: string;
  logger: Logger;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export async function startMcpHttp(opts: McpHttpOpts): Promise<http.Server> {
  const sessions = new Map<string, Session>();

  const listener = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (!isAuthorized(req, opts.authToken)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    try {
      const body = await readJsonBody(req);
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session && req.method === "POST" && isInitializeRequest(body)) {
        const server = opts.serverFactory();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        session = { transport, server };
      }

      if (!session) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "missing Mcp-Session-Id or initialize request" },
            id: null,
          }),
        );
        return;
      }

      await session.transport.handleRequest(req, res, body);
    } catch (err) {
      opts.logger.error("mcp transport error", { err: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    }
  };

  const httpServer = http.createServer(listener);
  await new Promise<void>((resolve) => httpServer.listen(opts.port, resolve));
  opts.logger.info("mcp listening", { port: opts.port });
  return httpServer;
}

function isAuthorized(req: http.IncomingMessage, expected: string): boolean {
  const authHeader = req.headers.authorization ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : null;
  if (bearer && safeEq(bearer, expected)) return true;

  const urlStr = req.url ?? "";
  const qIdx = urlStr.indexOf("?");
  if (qIdx >= 0) {
    const params = new URLSearchParams(urlStr.slice(qIdx + 1));
    const tok = params.get("token");
    if (tok && safeEq(tok, expected)) return true;
  }
  return false;
}

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method !== "POST" && req.method !== "PUT") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
