import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../../src/binance/rate-limiter";

describe("RateLimiter", () => {
  test("takes quickly when tokens are available", async () => {
    const limiter = new RateLimiter(5, 10);
    const started = Date.now();
    for (let i = 0; i < 5; i++) await limiter.take();
    expect(Date.now() - started).toBeLessThan(50);
  });

  test("blocks once bucket is exhausted and refills at the configured rate", async () => {
    const limiter = new RateLimiter(2, 5);
    await limiter.take();
    await limiter.take();
    const before = Date.now();
    await limiter.take();
    const elapsed = Date.now() - before;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(500);
  });

  test("supports variable cost per take", async () => {
    const limiter = new RateLimiter(10, 100);
    const start = Date.now();
    await limiter.take(10);
    expect(Date.now() - start).toBeLessThan(20);
    const blockedStart = Date.now();
    await limiter.take(5);
    expect(Date.now() - blockedStart).toBeGreaterThanOrEqual(40);
  });
});
