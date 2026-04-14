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

### Two PM backends (one codebase)

The PM agent can run in either of two modes — selected at runtime via `PM_BACKEND`:

**`managed` — [Anthropic Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) (the project's purpose).** The PM agent lives in Anthropic's server-side harness. Anthropic runs the tool-use loop and calls our MCP server directly over HTTPS. The CLI only streams events from `beta.sessions.events.stream`. **Multiple frontends can attach to the same session id** — a TUI, a web UI, a webhook — and see the same tool activity, because the session isn't anchored to any one process. The agent and environment are created once and cached in `data/agent-cache.json`.

**`local` — in-process Messages API.** The CLI runs the tool loop itself via `client.messages.create`, invoking MCP tools in the same process. No tunnel, no Anthropic-side state. Zero-config, but single-frontend only.

```
                 PM_BACKEND=managed (multi-frontend)
   ┌────────────┐   ┌────────────┐   ┌────────────┐
   │ Bun TUI    │   │ Web UI     │   │ Webhook    │   ← any number of clients
   └──────┬─────┘   └──────┬─────┘   └──────┬─────┘     stream the same session
          │                │                │
          ▼                ▼                ▼
   ┌─────────────────────────────────────────────────┐
   │  Anthropic Managed Agents  (beta.sessions)      │
   │  - Agent + Environment created once, cached     │
   │  - Runs Claude tool-use loop server-side        │
   └──────────────────────┬──────────────────────────┘
                          │ MCP over public HTTPS
                          │ (bearer token as ?token=... query)
                          ▼
   ┌─────────────────────────────────────────────────┐
   │  trading-agents-mcp  (public URL via tunnel)    │
   │  Binance · SQLite · risk · signal/fast loops ·  │
   │  sub-agents (Risk / Strategy / Execution)       │
   └─────────────────────────────────────────────────┘


                 PM_BACKEND=local (single-frontend dev)
   ┌─ Bun CLI ──────────────────────┐   ┌─ Anthropic Messages API ─┐
   │ Ink TUI + in-process PM loop   │──►│  Claude tool_use          │
   └──────────────┬─────────────────┘   └───────────────────────────┘
                  │ MCP over localhost HTTP
                  ▼
           trading-agents-mcp (localhost:3333)
```

**Tools the PM calls (same list in both modes):** `get_portfolio_summary`, `get_positions`, `get_ticker`, `get_klines`, `get_indicators`, `check_risk_limits`, `place_order`, `cancel_order`, `get_next_candidate`, `delegate_to_risk`, `delegate_to_strategy`, `delegate_to_execution`.

The MCP server owns **all trading state** — Binance client, SQLite, risk engine, signal/fast loops, sub-agents. The CLI has no local trading state; it queries MCP every turn.

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
│   ├── session.ts            # Managed Agents PM (PM_BACKEND=managed)
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
| `MCP_PUBLIC_URL` | Public HTTPS URL (required for `PM_BACKEND=managed`) | unset |
| `PM_BACKEND` | `managed` (Anthropic-hosted session) or `local` (in-process) | `local` |
| `SESSION_ID` | If set under `PM_BACKEND=managed`, attach to this existing session instead of creating a new one (multi-frontend mode) | unset |
| `AGENT_CACHE_PATH` | Where the managed agent / environment ids are cached | `./data/agent-cache.json` |
| `PM_MODEL` | PM agent model | `claude-opus-4-6` |
| `SUB_AGENT_MODEL` | Risk / Strategy / Execution model | `claude-sonnet-4-6` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |

> **Cost tip:** Opus is ~5× Sonnet per token. For exploration, set `PM_MODEL=claude-sonnet-4-6`.

---

## Run

Two PM backends, selected at startup via `PM_BACKEND`. Pick one:

### Option A — Managed Agents (recommended; **the project's purpose**)

The PM runs inside Anthropic's managed-agents harness and calls our MCP over public HTTPS. Multiple frontends can attach to the same session.

**1. Start the MCP server locally**

```bash
bun run dev:mcp
```

It binds `http://localhost:3333` with `MCP_AUTH_TOKEN` as the bearer.

**2. Expose MCP via a public HTTPS URL**

Anthropic's container can't reach `localhost`. Use a tunnel:

```bash
# Cloudflare Quick Tunnel (no account required, force HTTP/2 to avoid QUIC issues)
cloudflared tunnel --protocol http2 --url http://localhost:3333
# prints:  https://<random>.trycloudflare.com
```

Any HTTPS reverse tunnel works (ngrok, localtunnel, a real domain); Cloudflare is fastest to stand up.

**3. Point the CLI at it and flip the backend to `managed`**

Add these to `.env` (or export inline):

```bash
PM_BACKEND=managed
MCP_PUBLIC_URL=https://<random>.trycloudflare.com
# MCP_AUTH_TOKEN must match the token the MCP server is running with
```

**4. Start the CLI**

```bash
bun run dev:cli
```

On first launch the CLI calls `beta.agents.create` + `beta.environments.create`, caches the ids in `data/agent-cache.json`, then opens a `beta.sessions.create`. Subsequent launches reuse the cached agent and environment — only a fresh `session` is created.

You'll see log lines confirming the mode:

```
INFO  using managed PM backend (Anthropic-hosted session)
INFO  agent created       { id: "agt_...", version: 1 }
INFO  environment created { id: "env_..." }
INFO  session created     { id: "ses_..." }
```

**Multi-frontend:** once a session exists, any other process holding the same `sessionId` and API key can call `client.beta.sessions.events.stream(sessionId)` to observe the same PM conversation live, and `client.beta.sessions.events.send(sessionId, ...)` to push user input. The MCP server is hit by Anthropic's harness, not by any individual frontend, so adding a web UI or webhook alongside the TUI is additive.

#### Launching multiple Bun TUIs (the default: one session per window)

Every `dev:cli` launch calls `beta.sessions.create` and gets a **fresh session id**. Open as many terminals as you want — each is an independent conversation with its own PM, all fanning out tool calls to the same shared MCP server via Anthropic's harness.

```bash
# Window 1 — creates session S1
PM_BACKEND=managed MCP_PUBLIC_URL=https://<tunnel>.trycloudflare.com bun run dev:cli
# log:  INFO  session created  { id: "ses_aaa..." }

# Window 2 — creates session S2 (entirely separate)
PM_BACKEND=managed MCP_PUBLIC_URL=https://<tunnel>.trycloudflare.com bun run dev:cli
# log:  INFO  session created  { id: "ses_bbb..." }

# Window 3, window N — same story
```

Each window:
- Has its own Claude conversation + its own system-prompt state.
- Reuses the cached `agentId` + `environmentId` from `data/agent-cache.json` (only a fresh **session** is minted — agents/environments are created once).
- Streams events and `send`s user input over its own session id.
- Reads the **same** MCP state: Binance, SQLite, positions, risk limits. Any order placed from window 1 shows up in window 2's dashboard pane on the next poll.

Good use cases: a teammate on their own machine driving a second session; side-by-side Opus vs Sonnet windows; an analyst running "what-if" reads against the live portfolio while you work in the main window.

**Heads-up on the candidate firehose.** Every window long-polls `get_next_candidate`. The MCP queue delivers each candidate to exactly one caller, so with N windows running, auto-fired candidates get split non-deterministically across them. For autonomous-mode demos, run a single window (or disable the candidate poll in secondary windows by attaching — see below).

#### Advanced: multiple TUIs sharing one session

Opt in with `SESSION_ID=<the id from window 1's log>` on the second window. Both windows then see every agent message and tool call in lockstep, either human can type, and only the primary polls for candidates. Secondary windows won't tear down the session on exit.

```bash
# Primary — creates the session
PM_BACKEND=managed MCP_PUBLIC_URL=... bun run dev:cli
# log:  INFO  session created  { id: "ses_abc..." }

# Secondary — attaches to the SAME session
PM_BACKEND=managed MCP_PUBLIC_URL=... SESSION_ID=ses_abc... bun run dev:cli
# log:  INFO  session attached   { id: "ses_abc..." }
#       INFO  attached frontend: skipping candidate poll (primary owns it)
```

**Rotating the MCP URL.** If your tunnel URL changes, bump `MCP_PUBLIC_URL` and restart the CLI — the cache keys on `mcpUrl`, so it'll automatically mint a new agent for the new URL.

**Tearing down cached agents.** Delete `data/agent-cache.json` to force a clean `agents.create` / `environments.create` on next launch.

### Option B — Local (in-process, zero-config dev)

No tunnel, no cloud agent. The CLI runs the PM tool-use loop itself against the Messages API. Single frontend only.

```bash
# Terminal 1
bun run dev:mcp

# Terminal 2
PM_BACKEND=local bun run dev:cli    # or just `bun run dev:cli` (local is the default)
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
You set `PM_BACKEND=managed` but `MCP_PUBLIC_URL` still points at localhost (or is unset and something else fell through). Anthropic's container can't reach your laptop. Either:
- Drop back to `PM_BACKEND=local` (in-process PM, no public URL needed), or
- Stand up a public tunnel (`cloudflared tunnel --protocol http2 --url http://localhost:3333`) and set `MCP_PUBLIC_URL` to the `https://...` URL it prints.

### `PM_BACKEND=managed requires MCP_PUBLIC_URL`
Bootstrap threw this on startup because you opted into managed mode without giving it a URL to hand to Anthropic. Set `MCP_PUBLIC_URL` in `.env` (see the managed-mode run section above).

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
- Second frontend (web UI) attaching to the same managed session as the TUI, to demo multi-client streaming
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
