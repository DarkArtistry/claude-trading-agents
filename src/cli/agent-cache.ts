import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AgentCache {
  agentId?: string;
  agentVersion?: number;
  environmentId?: string;
  mcpUrl?: string;
}

export function loadAgentCache(path: string): AgentCache {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function saveAgentCache(path: string, cache: AgentCache): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2));
}
