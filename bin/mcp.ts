import { startMcp } from "../src/mcp/bootstrap";

const rt = await startMcp();

const shutdown = async (signal: string) => {
  console.error(`\n${signal} received, stopping...`);
  await rt.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
