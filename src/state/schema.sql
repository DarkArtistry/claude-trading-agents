-- trading-agents journal
-- One database per process. Use WAL so the fast loop and TUI can read
-- while the signal loop writes.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS klines (
  symbol     TEXT    NOT NULL,
  open_time  INTEGER NOT NULL,
  close_time INTEGER NOT NULL,
  open       REAL    NOT NULL,
  high       REAL    NOT NULL,
  low        REAL    NOT NULL,
  close      REAL    NOT NULL,
  volume     REAL    NOT NULL,
  PRIMARY KEY (symbol, open_time)
);

CREATE INDEX IF NOT EXISTS idx_klines_close_time ON klines (symbol, close_time DESC);

CREATE TABLE IF NOT EXISTS candidates (
  id                TEXT    PRIMARY KEY,
  symbol            TEXT    NOT NULL,
  side              TEXT    NOT NULL CHECK (side IN ('buy','sell')),
  strategy          TEXT    NOT NULL,
  strength          REAL    NOT NULL,
  features_json     TEXT    NOT NULL,
  kline_close_time  INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  outcome           TEXT,
  outcome_reason    TEXT
);

CREATE INDEX IF NOT EXISTS idx_candidates_symbol_ts ON candidates (symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT    PRIMARY KEY,
  client_order_id  TEXT    NOT NULL UNIQUE,
  symbol           TEXT    NOT NULL,
  side             TEXT    NOT NULL,
  type             TEXT    NOT NULL,
  price            REAL,
  amount           REAL    NOT NULL,
  status           TEXT    NOT NULL,
  filled_amount    REAL    NOT NULL DEFAULT 0,
  avg_fill_price   REAL,
  candidate_id     TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_symbol_ts ON orders (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

CREATE TABLE IF NOT EXISTS positions (
  symbol             TEXT    PRIMARY KEY,
  side               TEXT    NOT NULL,
  amount             REAL    NOT NULL,
  entry_price        REAL    NOT NULL,
  stop_price         REAL,
  take_profit_price  REAL,
  unrealized_pnl     REAL    NOT NULL DEFAULT 0,
  realized_pnl       REAL    NOT NULL DEFAULT 0,
  opened_at          INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id             TEXT    PRIMARY KEY,
  order_id       TEXT    NOT NULL,
  symbol         TEXT    NOT NULL,
  side           TEXT    NOT NULL,
  price          REAL    NOT NULL,
  amount         REAL    NOT NULL,
  fee_asset      TEXT,
  fee            REAL,
  realized_pnl   REAL    NOT NULL DEFAULT 0,
  ts             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_symbol_ts ON trades (symbol, ts DESC);

CREATE TABLE IF NOT EXISTS agent_events (
  id           TEXT    PRIMARY KEY,
  ts           INTEGER NOT NULL,
  from_agent   TEXT    NOT NULL,
  to_agent     TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  duration_ms  INTEGER,
  payload_json TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_events_ts ON agent_events (ts DESC);

CREATE TABLE IF NOT EXISTS daily_stats (
  date                 TEXT    PRIMARY KEY,
  realized_pnl         REAL    NOT NULL DEFAULT 0,
  trade_count          INTEGER NOT NULL DEFAULT 0,
  loss_count           INTEGER NOT NULL DEFAULT 0,
  consecutive_losses   INTEGER NOT NULL DEFAULT 0,
  paused_reason        TEXT
);

CREATE TABLE IF NOT EXISTS loop_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
