import { startCli } from "../src/cli/bootstrap";

try {
  await startCli();
} catch (err) {
  console.error("cli failed:", (err as Error).message);
  process.exit(1);
}
