# trading-agents

A multi-agent crypto trading system that puts the LLM where it earns its keep: **judgment, context, and explanation** — not detection or reflexes. Deterministic code generates candidate signals and enforces safety rails; agents decide whether to take them, how to size them, and explain why.

A Portfolio Manager agent chats with you and coordinates specialist sub-agents (Risk, Strategy, Execution) by calling tools on a self-hosted trading MCP server. A Bun terminal UI runs the chat + a live dashboard of positions, PnL, signals, and agent activity.

> **Status:** Binance **testnet** only. Dry-run mode on by default. Not financial advice.

---

## Why this exists

Most "LLM trading bot" demos are either (a) the LLM hallucinates a signal and places a trade, or (b) the LLM is a chatbot wrapper around a static strategy. Neither is interesting.

This project makes a deliberate split:

- **Reflexes are code.** Indicators (EMA, RSI, ATR), signal generators, stop-loss checks, position sizing limits, and circuit breakers all run as deterministic code on a tight loop. The LLM is never in the hot path.
- **Judgment is agents.** For each code-generated candidate, a Portfolio Manager agent decides whether to take it, delegates to specialist agents for sizing / qualitative review / execution, and explains every decision in the TUI.
- **Safety is non-negotiable.** Risk limits live in code. The LLM can't override them — only reason about their outputs.

It also doubles as a reference architecture for a **Claude + MCP** trading system where a thin trading server exposes domain tools to one or more agents.

---

## Architecture

### Two processes

```
┌─ Bun CLI (local) ─────────────┐     ┌─ Anthropic Messages API ────────┐
│ - Ink TUI: chat + dashboard   │     │                                 │
│ - LocalPm (in-process agent)  │────►│  Claude Opus/Sonnet/Haiku       │
│ - MCP client                  │     │  (tool_use loop)                │
└──────────────┬────────────────┘     └─────────────────────────────────┘
               │
               │  MCP over localhost HTTP (bearer-token auth)
               ▼
┌─ trading-agents-mcp (localhost:3333) ────────────────────────────────┐
│ - Binance testnet client                - Fast loop (stops, PnL)      │
│ - SQLite journal / positions            - Signal loop (candle-close) │
│ - Risk engine (hard rails)              - Candidate queue            │
│ - Sub-agents (Risk / Strategy / Execution) via Messages API          │
│                                                                      │
│ MCP tools exposed to the PM:                                         │
│   get_portfolio_summary, get_positions, get_ticker, get_klines,      │
│   get_indicators, check_risk_limits, place_order, cancel_order,      │
│   get_next_candidate,                                                │
│   delegate_to_risk, delegate_to_strategy, delegate_to_execution      │
└──────────────────────────────────────────────────────────────────────┘
```

The MCP server owns **all trading state** — Binance client, SQLite, risk engine, signal/fast loops, sub-agents. The CLI owns the TUI + the PM agent; it queries MCP every turn and has no local trading state.

> **Note on Claude Managed Agents.** The architecture is designed so the local `LocalPm` can be swapped for Anthropic's [Managed Agents API](https://platform.claude.com/docs/en/managed-agents/overview): the agent would run in Anthropic's container and call our MCP over a public HTTPS tunnel. The codebase has the full scaffolding (`src/agents/pm.ts`, `src/cli/session.ts`) but defaults to local mode for zero-config dev. Set `MCP_PUBLIC_URL` to a public HTTPS URL and swap `LocalPm` for `PmSession` in `bootstrap.ts` to flip it on.

### Two-speed loop

The LLM is never in the hot path.

```
FAST LOOP (code, ~5s, in MCP)          SIGNAL LOOP (candle close, in MCP)
├─ Poll open orders                    ├─ Run signal generators per symbol
├─ Check stop-loss / take-profit       ├─ If candidate fires → candidate queue
├─ Update unrealized PnL               └─ CLI long-polls → feeds PM agent
└─ Trip circuit breakers
```

Stop-losses and circuit breakers trigger in milliseconds via pure code. Agents are only invoked when there's a **decision** to make.

### Signal flow (end-to-end)

```
1.  Signal generator (code)         per-symbol, on candle close
     ↓ emits Candidate
2.  Router (code)                   cooldown + position + universe filter
     ↓
3.  Candidate queue (in MCP server) long-poll from CLI
     ↓
4.  CLI → PM session                pushes "CANDIDATE ..." as user message
     ↓
5.  PM agent (Claude)               reasons about candidate + portfolio context
     ↓ calls MCP tool
6.  delegate_to_risk → Risk         sizing + stop/TP (or rejection)
     ↓
7.  delegate_to_strategy → Strategy qualitative judgment on market context
     ↓
8.  delegate_to_execution → Execution places order (dry-run by default)
     ↓ fill receipt
9.  Journal (code)                  persists every step with reasoning
```

### Agent roster

| Agent | Runtime | Role |
|---|---|---|
| **PM** | Messages API (local, in CLI) | User-facing orchestrator. Holds portfolio intent. Delegates. |
| **Risk / PnL** | Messages API (inside MCP) | Position sizing, exposure limits, realized/unrealized PnL. |
| **Strategy** | Messages API (inside MCP) | Qualitative judgment on a candidate given recent market context. |
| **Execution** | Messages API (inside MCP) | Places/cancels orders. Handles order types, slippage, fills. |

Every sub-agent is a short-lived Messages API call with a focused system prompt and a whitelist of tools — not its own long-running process.

### Signal generators (code, not LLM)

| Strategy | Trigger |
|---|---|
| **EMA crossover** | Fast EMA (9) crosses slow EMA (21). Strength ∝ gap. |
| **RSI reversion** | RSI(14) crosses back above 30 (oversold) or below 70 (overbought). |
| **Breakout** | Price closes above N-bar high (or below low) with ≥ 1.25× average volume. |

Each generator is a pure function of recent klines → `Candidate | null`. Adding a strategy is a single file in `src/signals/`.

---

## Safety rails (code-level, LLM cannot override)

All limits live in `src/risk/limits.ts`. The LLM receives them as tool outputs but cannot modify them.

- Max concurrent positions (default: 3)
- Max position size per symbol (default: 15% of equity)
- Max daily loss → auto-pause (default: 5% of equity)
- Max consecutive losses → auto-pause (default: 4)
- Cooldown per symbol after a trade (default: 15m)
- Per-order hard stop-loss (default: 2% from entry, not LLM-negotiable)
- **Mainnet interlock:** requires both `BINANCE_USE_TESTNET=false` and `I_UNDERSTAND_MAINNET=yes`
- Rate limiter on the Binance client
- MCP server requires a bearer token on every call

---

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Bun** 1.1+ | Fast, built-in SQLite + WS, single binary dev UX |
| Language | **TypeScript** (strict) | |
| Agents | **@anthropic-ai/sdk** (Messages API) | Tool-use loop with Opus / Sonnet / Haiku |
| MCP | **@modelcontextprotocol/sdk** | Standard MCP server + client |
| Exchange | **ccxt** (Binance testnet) | Multi-exchange future-proof |
| Data | **bun:sqlite** | Zero-dep, great for journaling |
| TUI | **Ink** (React for terminal) | Dual-pane layout, state hooks |
| Validation | **zod** | Env + tool input schemas |

---

## Project layout

```
bin/
├── mcp.ts                    # entry: starts the MCP server + loops
└── cli.ts                    # entry: starts the TUI + local PM

src/
├── config.ts                 # env + universe + risk limits
├── types.ts                  # shared types
├── agents/
│   └── pm.ts                 # PM system prompt + Managed-Agents create-params factory
├── binance/
│   ├── client.ts             # ccxt wrapper (testnet by default)
│   ├── stream.ts             # kline WebSocket stream
│   └── rate-limiter.ts
├── cli/
│   ├── bootstrap.ts          # wires PM + MCP client + TUI
│   ├── local-pm.ts           # in-process Messages API PM loop
│   ├── session.ts            # Managed Agents PM (alternate backend, unused by default)
│   ├── mcp-client.ts         # client-side MCP
│   └── agent-cache.ts        # persist Managed Agent/Environment ids
├── loops/
│   ├── fast-loop.ts          # 5s code-only tick: fills, stops, circuits
│   └── signal-loop.ts        # candle-close → candidates
├── mcp/
│   ├── bootstrap.ts          # wires Binance + DB + ops + sub-agents + HTTP
│   ├── server.ts             # MCP tool registrations
│   ├── http.ts               # HTTP transport + auth + session routing
│   ├── ops.ts                # trading operations (single source of truth)
│   └── subagents.ts          # Risk / Strategy / Execution via Messages API
├── risk/
│   └── limits.ts             # hard rails (not LLM-negotiable)
├── signals/
│   ├── index.ts              # router: dedupe, cooldown, universe filter
│   ├── indicators.ts         # EMA, RSI, ATR
│   ├── ema-crossover.ts
│   ├── rsi-reversion.ts
│   └── breakout.ts
├── state/
│   ├── db.ts                 # bun:sqlite init
│   ├── schema.sql            # candidates, orders, trades, positions, agent_events, daily_stats
│   ├── positions.ts
│   └── journal.ts
├── tui/
│   ├── App.tsx               # Ink root
│   ├── ChatPane.tsx
│   ├── DashboardPane.tsx
│   └── hooks.ts
└── util/
    └── logger.ts

tests/
├── binance/rate-limiter.test.ts
├── e2e/mcp-server.test.ts    # real MCP server + real MCP client + fake Binance
├── helpers/
├── mcp/
├── risk/
├── signals/
├── smoke/live-mcp.ts         # manual smoke: hit a running MCP over HTTP
├── smoke/live-pm.ts          # manual smoke: fire LocalPm against live MCP + real Anthropic
└── state/
```

---

## Prerequisites

- [**Bun**](https://bun.sh) 1.1+
- An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com) (separate from claude.ai Team plan — API billing is its own pool)
- A **Binance testnet** key/secret from [testnet.binance.vision](https://testnet.binance.vision)

**Important:** both the Anthropic credits and the API key must live in the **same workspace**. If you have multiple workspaces on the console, pick one and use it for both.

---

## Setup

```bash
bun install
cp .env.example .env
# edit .env — ANTHROPIC_API_KEY, BINANCE_API_KEY, BINANCE_API_SECRET
```

Key env vars:

| Var | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Messages API access | (required) |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | testnet credentials | (required) |
| `BINANCE_USE_TESTNET` | Mainnet interlock | `true` |
| `I_UNDERSTAND_MAINNET` | Second mainnet gate | `no` |
| `UNIVERSE` | Comma-separated ccxt symbols | `BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT` |
| `TIMEFRAME` | Candle timeframe for signals | `5m` |
| `DRY_RUN` | Log orders instead of placing | `true` |
| `MCP_PORT` | MCP HTTP server port | `3333` |
| `MCP_AUTH_TOKEN` | Bearer token for MCP | (dev default — rotate) |
| `MCP_PUBLIC_URL` | Public HTTPS URL (for Managed Agents mode) | unset → local mode |
| `PM_MODEL` | PM agent model | `claude-opus-4-6` |
| `SUB_AGENT_MODEL` | Risk / Strategy / Execution model | `claude-sonnet-4-6` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |

> **Cost tip:** Opus is ~5× Sonnet per token. For exploration, set `PM_MODEL=claude-sonnet-4-6`.

---

## Run

**Two terminals. No tunnel, no cloud.**

```bash
# Terminal 1 — the MCP server (Binance, SQLite, signal loops, sub-agents)
bun run dev:mcp

# Terminal 2 — the TUI + local PM agent
bun run dev:cli
```

TUI layout:

```
┌─ Chat w/ PM ─────────────┐ ┌─ Dashboard ────────────────────┐
│ > why did we long SOL?   │ │ Status: RUNNING  Equity: $10,432│
│ PM: Strategy flagged a   │ │ ─ Positions ────────────────── │
│     breakout above the   │ │ BTC  +0.0124   +$42.10 (+1.2%)│
│     daily high on rising │ │ SOL  +1.80     -$3.40  (-0.3%)│
│     volume...            │ │ ─ Recent signals ───────────── │
│ > halt SOL               │ │ 14:02 ETH  EMA-X  skipped      │
│ PM: paused SOL. Reason?  │ │ 14:00 SOL  BREAK  filled @142.3│
│                          │ │ ─ Agent activity ────────────── │
│                          │ │ PM→risk  call  delegate_to_risk│
│                          │ │ risk→PM  response  420ms       │
└──────────────────────────┘ └───────────────────────────────┘
  [p]ause  [r]esume  [k]ill
```

Type a message and press enter. Watch the right-hand pane for live delegation.

---

## Use cases to test the agent with

Organized from cheapest (single tool call) to most involved (full multi-agent flow). Every case here is safe — dry-run is on, orders never hit the exchange unless you flip `DRY_RUN=false`.

### A. Smoke tests (1 tool call, cheapest)

1. **Ticker query**
   ```
   what's the price of BTC right now?
   ```
   *Expected:* PM calls `get_ticker`, replies with bid/ask/last.

2. **Portfolio snapshot**
   ```
   give me a one-line portfolio summary
   ```
   *Expected:* `get_portfolio_summary` → equity, free USDT, open positions, today's PnL.

3. **Positions readback**
   ```
   any open positions?
   ```
   *Expected:* `get_positions`. Should be empty on first run.

### B. Analysis (2–4 tool calls)

4. **Trend check**
   ```
   is ETH trending up or down on 15m? check EMAs and RSI
   ```
   *Expected:* `get_indicators` + short reasoning about trend alignment.

5. **Cross-symbol compare**
   ```
   compare BTC and SOL — which looks stronger right now on 1h?
   ```
   *Expected:* two `get_indicators` calls + qualitative read.

6. **Volatility read**
   ```
   what's ATR(14) on BNB 5m and is that high or low historically?
   ```
   *Expected:* `get_klines` + `get_indicators` + contextualised answer.

### C. Risk checks (no order placed)

7. **Sizing sanity**
   ```
   would Risk let me put $500 into SOL long? i just want the decision, don't place anything
   ```
   *Expected:* `delegate_to_risk` — see `PM → risk` lit up in the Agent Activity pane. Response includes sizeQuote, stopPrice, takeProfitPrice.

8. **Oversized request**
   ```
   evaluate putting $8000 into BTC long
   ```
   *Expected:* Risk approves but caps at `maxPositionPctEquity` of equity (default 15%).

9. **Already-holding rejection**
   Run this twice in a row:
   ```
   check risk for buying 0.01 BTC, then place it if approved (dry-run)
   ```
   *Expected:* First succeeds. Second's Risk call rejects with "already have an open BTC/USDT position".

### D. Full multi-agent flow (the demo)

10. **End-to-end entry**
    ```
    should i buy SOL right now? run the full workflow — risk sizing, strategy judgment, execution if approved
    ```
    *Expected:* PM → Risk → Strategy → Execution in sequence. Every hop visible in the Agent Activity pane. Dry-run fill appears under Positions.

11. **Strategy veto**
    ```
    we've got a weak EMA crossover candidate on BNB. run it through the full workflow but lean skeptical
    ```
    *Expected:* Risk approves sizing; Strategy weighs in — may say "skip" with reasoning. PM respects the veto.

12. **Manual close**
    ```
    close my BTC position at market
    ```
    *Expected:* PM calls `place_order` with the opposite side for the full position size. Dashboard refreshes with realized PnL.

### E. Portfolio management

13. **Market scan**
    ```
    give me a quick market overview of the whole universe — one line per symbol
    ```
    *Expected:* Four `get_ticker` calls (one per symbol), tabulated reply.

14. **Ranking**
    ```
    rank our universe by how promising a long entry looks right now
    ```
    *Expected:* Multiple `get_indicators` calls, ranked output with reasoning.

15. **Halt + resume**
    ```
    pause trading for the rest of the session
    ```
    Then later:
    ```
    resume trading
    ```
    *Expected:* PM calls the relevant tools; dashboard Status flips between RUNNING and PAUSED.

### E. Autonomous mode (wait for a real signal)

16. **Leave it running.** After a 5-minute candle closes and a code signal fires, a line appears in chat automatically:
    ```
    CANDIDATE ETH/USDT BUY via ema_crossover (strength 0.42). Features: {...}. CandidateId: ...
    ```
    PM processes it without you typing anything — delegates to Risk, then Strategy, then Execution. Watch the Agent Activity pane fill up.

17. **Force a synthetic candidate** (for faster iteration). Open a Bun shell against the running MCP and push a candidate directly:
    ```bash
    bun repl
    > const { TradingMcpClient } = await import("./src/cli/mcp-client");
    > const c = new TradingMcpClient({ url: "http://localhost:3333", authToken: "dev-secret-change-this-before-deploying" });
    > await c.connect();
    > // inject via your MCP test utility, or wait for a real candle close
    ```

### F. Safety-rail verification

18. **Circuit breaker**
    Simulate 4 consecutive losing trades (loop through "buy then close at loss" manually, or wait for adverse candles). After the fourth loss, Risk should auto-pause:
    ```
    risk check buying $100 of BTC
    ```
    *Expected:* rejected with "4 consecutive losses — cooling off".

19. **Daily loss cap**
    Similar but total PnL < -5% of equity. Risk rejects with "daily loss cap hit".

20. **Mainnet interlock**
    Set `BINANCE_USE_TESTNET=false` without setting `I_UNDERSTAND_MAINNET=yes`. Restart `dev:mcp`. It refuses to boot.

### G. Explainability

21. **Ask for rationale**
    After any autonomous decision:
    ```
    why did we skip the last SOL signal?
    ```
    *Expected:* PM summarizes what Strategy said plus any Risk context.

22. **Trade history**
    ```
    what was our most recent trade and why did we take it?
    ```
    *Expected:* PM surfaces the decision chain from journal / recent agent events.

---

## Example: a real multi-agent exchange

Here's a redacted transcript from an actual run — the user asks for a small test trade and watches PM, Risk, and Strategy coordinate:

> **You:** do a simple trade to show me you can actually trade
>
> **PM:** Let me check the current state first. I'll pull BTC's price and run a risk check before placing anything.
> *[PM → `get_ticker`]  [PM → `get_indicators`]*
> The trend looks bullish on 15m. Let me send a small test buy through Risk — say 1% of equity ($100 notional) to keep it truly small.
>
> *[PM → `delegate_to_risk`]*
>
> **PM:** Risk approved it. Now let me get the Strategy agent's qualitative take.
>
> *[PM → `delegate_to_strategy`]*
>
> **PM:** Here's the full picture:
>
> ### Trade Summary: BTC/USDT Small Test Buy — SKIPPED
>
> - **Risk Agent:** Approved $100 notional buy with stop at $73,172 and TP at $77,652.
> - **Strategy Agent:** Declined with 78% confidence. Key reasons:
>   1. **Stop is too tight vs. volatility** — the stop sits only $1,475 below entry, which is just 0.45× ATR. Normal BTC hourly moves exceed $2,000, meaning a stop-out is near-certain even if direction is correct.
>   2. **Chasing a completed move** — BTC already ran ~$3,500 from the $71k base. Price is now compressing and drifting lower on 15m.
>   3. Even as a $100 test, a near-guaranteed stop-out doesn't give useful data.
>
> ### What I'd recommend instead:
> - Wait for a pullback to the $73,000–$73,500 zone (near EMA21 support) for a better-anchored entry.
> - Or wait for a fresh breakout impulse on the 15m chart with a swing-low-based stop.
>
> Per my principles, I'm siding with the Strategy agent here — **skipping is cheap, bad trades are not**, even on testnet.

Notice:
- Risk approved, Strategy vetoed — and PM respected the veto. That's the safety architecture working as designed.
- Strategy's reasoning uses real technical analysis (ATR, EMA support, recent price action) grounded in live klines it pulled via `get_klines`.
- The user sees every delegation hop in the right-hand Agent Activity pane in real time.

---

## Cost expectations

This project calls Claude models on every user turn and every code-generated candidate. Rough per-message cost when `PM_MODEL=claude-opus-4-6` and `SUB_AGENT_MODEL=claude-sonnet-4-6`:

| Interaction | Calls | Typical cost |
|---|---|---|
| Simple read ("what's the BTC price?") | 1 PM turn + 1 tool call | ~$0.01 |
| Full multi-agent flow (PM → Risk → Strategy → Execution) | ~4 PM turns + 3 sub-agent runs | ~$0.10 – $0.30 |
| Autonomous mode, idle (no candidates) | 0 | $0 |
| Autonomous mode, busy day (~10 candidates, each evaluated) | ~30 API calls | ~$1 – $3 |

To cut cost dramatically, drop PM to Sonnet:
```bash
PM_MODEL=claude-sonnet-4-6
```
This makes PM ~5× cheaper at some reasoning depth. For Haiku, set `claude-haiku-4-5` — even cheaper, but will follow the system prompt less precisely.

Leave Opus for the demo / final testing; run day-to-day on Sonnet.

---

## Troubleshooting

### `Your credit balance is too low`
Your API key and your Anthropic credits are in **different workspaces**. The console's workspace dropdown (top-left) is sticky — credits added in workspace A aren't available to a key minted in workspace B. Fix: create a new API key in the workspace that shows your credit balance.

### `Agent has invalid configuration: mcp_servers[...].url: MCP server URL host "localhost" resolves to loopback`
You were trying to run the **Managed Agents** mode (CLI talking to an agent in Anthropic's cloud) without a public MCP URL. Anthropic's container can't reach your laptop. Either:
- Stick with local mode (default — `LocalPm` runs the PM in-process, no public URL needed), or
- Expose your MCP via `cloudflared tunnel --protocol http2 --url http://localhost:3333`, paste the https URL into `MCP_PUBLIC_URL`, and switch `bootstrap.ts` to use `PmSession` instead of `LocalPm`.

### `Streamable HTTP error: ... missing Mcp-Session-Id or initialize request`
Your CLI is holding a session id from a dead MCP server (likely restarted). Restart the CLI:
```bash
# Ctrl-C in the dev:cli terminal
bun run dev:cli
```

### `WebSocket connection to 'wss://testnet.binance.vision/...' failed: Expected 101 status code`
Testnet's WebSocket host is `stream.testnet.binance.vision:9443`, not `testnet.binance.vision`. The project uses the correct host — if you see this, you're on an outdated branch. Rebuild from `main`.

### `cloudflared tunnel ... ERR failed to serve tunnel connection`
QUIC gets blocked by some corporate / home-router configs. Force HTTP/2:
```bash
cloudflared tunnel --protocol http2 --url http://localhost:3333
```

### `FOREIGN KEY constraint failed` during tests
You're on a stale DB. Delete `data/journal.db` and rerun.

### PM "unable to reach tools" even though MCP is up
Session-id mismatch — see above. If persistent, also check that your `MCP_AUTH_TOKEN` in the CLI's process matches the MCP server's. A stale `.env` loaded by only one process is the usual cause.

### Input in the TUI appears frozen (`> (waiting for PM...)` stuck)
The LocalPm's state machine got stuck. The codebase clears `pending` on both `sessionIdle` and `error` — if you see this, it's a bug to file with the full `dev:cli` log output.

### Anthropic SDK error `two consecutive user turns`
Shouldn't happen anymore — the LocalPm rolls back a failed user turn in `processOne`'s `catch`. If it recurs, restart the CLI to wipe the in-memory history.

---

## Testing

```bash
bun test           # 63 unit + E2E tests (fake Binance, real MCP + real MCP client)
bun run typecheck  # strict tsc
bun run smoke:mcp  # requires MCP running: hit the live HTTP MCP as a real client
```

The E2E suite spins up the real MCP server in-process with a fake Binance, connects a real MCP client, and verifies every tool path including the full open → close trade flow.

---

## Roadmap

**v0.2**
- Journal agent surfaced as an MCP tool (natural-language queries over the trade log)
- Backtest harness (replay historical klines)
- Strategy voting / ensemble
- Price-refresh inside fast loop (accurate unrealized PnL)

**v0.3**
- Multi-tenant MCP (per-customer Binance credentials + DBs)
- Optional Managed Agents mode: swap `LocalPm` for `PmSession` + public HTTPS
- Portfolio-level rebalancing decisions
- Alternate exchanges via ccxt

---

## Design principles

1. **The LLM is never in the hot path.** Reflexes are code. Judgment is agents.
2. **Code is the backstop.** Risk limits live in code and are not LLM-negotiable.
3. **Every decision is explainable.** Every agent invocation, its inputs, its reasoning, and its output are journaled.
4. **Testnet by default.** Mainnet requires explicit, redundant opt-in.
5. **Delegation is visible.** The TUI surfaces every `delegate_to_*` tool call — it's both an operability tool and the demo.
6. **Sharp deployment shape.** The MCP server is the only thing with credentials and state. Scaling or multi-tenanting it is the natural growth path.

---

## License

MIT — see [LICENSE](LICENSE).
