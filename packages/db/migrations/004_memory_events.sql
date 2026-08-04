CREATE TABLE news_items (
  id           BIGSERIAL PRIMARY KEY,
  symbol       TEXT REFERENCES universe(symbol),
  source       TEXT NOT NULL,
  url          TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT,
  sentiment    NUMERIC(4,3) CHECK (sentiment BETWEEN -1 AND 1),
  published_at TIMESTAMPTZ
);
CREATE INDEX news_items_symbol_idx ON news_items (symbol, published_at DESC);

CREATE TABLE lessons (
  id                 BIGSERIAL PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  lesson             TEXT NOT NULL,
  confidence         NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  times_retrieved    INTEGER NOT NULL DEFAULT 0,
  times_helped       INTEGER NOT NULL DEFAULT 0,
  evidence_trade_ids BIGINT[] NOT NULL DEFAULT '{}',
  retired            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lessons_agent_idx ON lessons (agent_id) WHERE retired = FALSE;

CREATE TABLE lesson_usage (
  id        BIGSERIAL PRIMARY KEY,
  lesson_id BIGINT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  trade_id  BIGINT NOT NULL REFERENCES trades(id),
  outcome   TEXT
);

CREATE TABLE event_log (
  id       BIGSERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  type     TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  symbol   TEXT,
  payload  JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX event_log_ts_idx ON event_log (ts DESC);
