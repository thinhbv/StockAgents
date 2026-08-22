CREATE TABLE intraday_flow_snapshot (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL REFERENCES universe(symbol),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB NOT NULL
);
CREATE INDEX intraday_flow_snapshot_symbol_idx ON intraday_flow_snapshot (symbol, captured_at DESC);
