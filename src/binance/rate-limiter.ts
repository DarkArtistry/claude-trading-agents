export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const delta = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + delta * this.refillPerSec);
    this.lastRefill = now;
  }

  async take(cost = 1): Promise<void> {
    this.refill();
    while (this.tokens < cost) {
      const deficit = cost - this.tokens;
      const waitMs = Math.ceil((deficit / this.refillPerSec) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
      this.refill();
    }
    this.tokens -= cost;
  }
}
