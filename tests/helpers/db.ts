import type { Database } from "bun:sqlite";
import { openDb } from "../../src/state/db";

export function memDb(): Database {
  return openDb(":memory:");
}
