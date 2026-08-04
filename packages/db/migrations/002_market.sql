CREATE TABLE universe (
  symbol   TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  sector   TEXT,
  name     TEXT,
  active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE ohlcv_daily (
  symbol     TEXT NOT NULL REFERENCES universe(symbol),
  trade_date DATE NOT NULL,
  open       NUMERIC(20,2) NOT NULL,
  high       NUMERIC(20,2) NOT NULL,
  low        NUMERIC(20,2) NOT NULL,
  close      NUMERIC(20,2) NOT NULL,
  volume     BIGINT NOT NULL,
  PRIMARY KEY (symbol, trade_date)
);
CREATE INDEX ohlcv_daily_symbol_date_idx ON ohlcv_daily (symbol, trade_date DESC);

CREATE TABLE indicator_snapshot (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL REFERENCES universe(symbol),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB NOT NULL
);
CREATE INDEX indicator_snapshot_symbol_idx ON indicator_snapshot (symbol, captured_at DESC);

CREATE TABLE quote_tick (
  id     BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL REFERENCES universe(symbol),
  ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  price  NUMERIC(20,2) NOT NULL,
  volume BIGINT
);
CREATE INDEX quote_tick_symbol_ts_idx ON quote_tick (symbol, ts DESC);

CREATE TABLE market_index_snapshot (
  id          BIGSERIAL PRIMARY KEY,
  index_code  TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  value       NUMERIC(20,2) NOT NULL,
  change_pct  NUMERIC(10,4)
);

CREATE TABLE session_state (
  trade_date        DATE PRIMARY KEY,
  state             TEXT NOT NULL,
  data_captured_at  TIMESTAMPTZ,
  note              TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ingest_errors (
  id          BIGSERIAL PRIMARY KEY,
  job         TEXT NOT NULL,
  symbol      TEXT,
  message     TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ingest_errors_occurred_idx ON ingest_errors (occurred_at DESC);
