CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  persona_prompt  TEXT NOT NULL,
  initial_capital NUMERIC(20,2) NOT NULL,
  risk_config     JSONB NOT NULL DEFAULT '{}',
  active          BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE orders (
  id            BIGSERIAL PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  symbol        TEXT NOT NULL REFERENCES universe(symbol),
  side          TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty           INTEGER NOT NULL CHECK (qty > 0),
  order_type    TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'ATC')),
  limit_price   NUMERIC(20,2),
  status        TEXT NOT NULL CHECK (status IN ('PENDING', 'FILLED', 'REJECTED', 'CANCELLED')),
  reject_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_agent_idx ON orders (agent_id, created_at DESC);

CREATE TABLE fills (
  id        BIGSERIAL PRIMARY KEY,
  order_id  BIGINT NOT NULL REFERENCES orders(id),
  qty       INTEGER NOT NULL CHECK (qty > 0),
  price     NUMERIC(20,2) NOT NULL,
  fee       NUMERIC(20,2) NOT NULL DEFAULT 0,
  tax       NUMERIC(20,2) NOT NULL DEFAULT 0,
  filled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE positions (
  id           BIGSERIAL PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  symbol       TEXT NOT NULL REFERENCES universe(symbol),
  qty_total    INTEGER NOT NULL,
  qty_sellable INTEGER NOT NULL DEFAULT 0,
  avg_cost     NUMERIC(20,2) NOT NULL,
  exit_plan    JSONB NOT NULL DEFAULT '{}',
  peak_price   NUMERIC(20,2),
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX positions_open_unique
  ON positions (agent_id, symbol) WHERE closed_at IS NULL;

CREATE TABLE position_lots (
  id            BIGSERIAL PRIMARY KEY,
  position_id   BIGINT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  cost          NUMERIC(20,2) NOT NULL,
  sellable_from DATE NOT NULL
);

CREATE TABLE trades (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  symbol      TEXT NOT NULL REFERENCES universe(symbol),
  action      TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
  price       NUMERIC(20,2) NOT NULL,
  qty         INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  confidence  NUMERIC(4,3) CHECK (confidence BETWEEN 0 AND 1),
  trigger     TEXT,
  context_ref JSONB NOT NULL DEFAULT '{}',
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trades_agent_idx ON trades (agent_id, decided_at DESC);

CREATE TABLE trade_outcomes (
  trade_id      BIGINT PRIMARY KEY REFERENCES trades(id),
  exit_trade_id BIGINT REFERENCES trades(id),
  pnl           NUMERIC(20,2) NOT NULL,
  pnl_pct       NUMERIC(10,4) NOT NULL,
  holding_days  INTEGER NOT NULL
);

CREATE TABLE portfolio_snapshot (
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  snap_date    DATE NOT NULL,
  cash         NUMERIC(20,2) NOT NULL,
  market_value NUMERIC(20,2) NOT NULL,
  nav          NUMERIC(20,2) NOT NULL,
  day_pnl      NUMERIC(20,2) NOT NULL,
  PRIMARY KEY (agent_id, snap_date)
);

CREATE TABLE metrics_daily (
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  snap_date         DATE NOT NULL,
  total_return_pct  NUMERIC(10,4),
  win_rate          NUMERIC(6,4) CHECK (win_rate BETWEEN 0 AND 1),
  sharpe            NUMERIC(10,4),
  max_drawdown      NUMERIC(10,4),
  avg_holding_days  NUMERIC(10,2),
  trade_count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, snap_date)
);
