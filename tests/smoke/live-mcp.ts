import { TradingMcpClient } from "../../src/cli/mcp-client";

async function main() {
  const url = process.env.MCP_SMOKE_URL ?? "http://127.0.0.1:3333";
  const token = process.env.MCP_AUTH_TOKEN ?? "dev-secret-change-this-before-deploying";
  const client = new TradingMcpClient({ url, authToken: token });
  await client.connect();
  try {
    const portfolio = await client.getPortfolioSummary();
    console.log("portfolio:", JSON.stringify(portfolio, null, 2));
    const positions = await client.getPositions();
    console.log("positions:", positions);
    const candidate = await client.getNextCandidate(300);
    console.log("candidate(300ms timeout):", candidate);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
