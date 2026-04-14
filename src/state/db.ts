import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const SCHEMA_PATH = new URL("./schema.sql", import.meta.url).pathname;

export function openDb(path: string): Database {
  const isMemory = path === ":memory:" || path.startsWith("file::memory:");
  if (!isMemory) mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path, { create: true });
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schema);
  return db;
}
