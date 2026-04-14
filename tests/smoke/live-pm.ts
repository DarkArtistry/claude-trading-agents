import { loadConfig } from "../../src/config";
import { createLogger } from "../../src/util/logger";
import { TradingMcpClient } from "../../src/cli/mcp-client";
import { LocalPm } from "../../src/cli/local-pm";

async function ask(pm: LocalPm, text: string) {
  console.log(`\n── you ────────────────────────────`);
  console.log(text);
  const replies: string[] = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const onMsg = (t: string) => replies.push(t);
  const onTool = (e: { name: string; input: unknown }) => {
    toolCalls.push({ name: e.name, input: e.input });
    console.log(`  [tool] ${e.name} ${JSON.stringify(e.input)}`);
  };
  pm.on("agentMessage", onMsg);
  pm.on("agentMcpToolUse", onTool);
  await new Promise<void>((resolve, reject) => {
    const off = () => {
      pm.off("agentMessage", onMsg);
      pm.off("agentMcpToolUse", onTool);
      pm.off("sessionIdle", done);
      pm.off("error", fail);
    };
    const done = () => { off(); resolve(); };
    const fail = (err: Error) => { off(); reject(err); };
    pm.on("sessionIdle", done);
    pm.on("error", fail);
    pm.sendUserMessage(text).catch(fail);
  });
  console.log(`── PM ─────────────────────────────`);
  console.log(replies.join("\n") || "(no text response)");
  return { replies, toolCalls };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger("warn", { proc: "smoke" });
  const mcp = new TradingMcpClient({
    url: config.mcp.publicUrl ?? `http://localhost:${config.mcp.port}`,
    authToken: config.mcp.authToken,
  });
  await mcp.connect();
  const pm = new LocalPm({
    apiKey: config.anthropicApiKey,
    model: config.agents.pmModel,
    mcp,
    logger,
  });
  await pm.start();
  try {
    await ask(pm, "what's the price of BTC? keep it short.");
    await ask(pm, "summarize my portfolio in one line.");
  } finally {
    await mcp.close();
  }
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
