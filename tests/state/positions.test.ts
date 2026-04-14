import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { PositionStore } from "../../src/state/positions";
import { memDb } from "../helpers/db";
import type { Position } from "../../src/types";

let db: Database;
let store: PositionStore;

beforeEach(() => {
  db = memDb();
  store = new PositionStore(db);
});
afterEach(() => db.close());

function pos(overrides: Partial<Position> = {}): Position {
  return {
    symbol: "BTC/USDT",
    side: "buy",
    amount: 1,
    entryPrice: 100,
    stopPrice: 95,
    takeProfitPrice: 110,
    unrealizedPnl: 0,
    realizedPnl: 0,
    openedAt: Date.now(),
    ...overrides,
  };
}

describe("PositionStore", () => {
  test("get returns null for unknown symbol", () => {
    expect(store.get("ETH/USDT")).toBeNull();
  });

  test("upsert + get round-trips", () => {
    store.upsert(pos());
    const p = store.get("BTC/USDT");
    expect(p).not.toBeNull();
    expect(p!.entryPrice).toBe(100);
    expect(p!.stopPrice).toBe(95);
  });

  test("upsert updates an existing row without duplicating", () => {
    store.upsert(pos());
    store.upsert(pos({ stopPrice: 90 }));
    expect(store.all().length).toBe(1);
    expect(store.get("BTC/USDT")!.stopPrice).toBe(90);
  });

  test("close removes the row", () => {
    store.upsert(pos());
    store.close("BTC/USDT");
    expect(store.get("BTC/USDT")).toBeNull();
  });

  test("all returns every open position", () => {
    store.upsert(pos({ symbol: "BTC/USDT" }));
    store.upsert(pos({ symbol: "ETH/USDT" }));
    expect(store.all().length).toBe(2);
  });
});
