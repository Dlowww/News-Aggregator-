-- Defense Strategy Brief: application tables (runs automatically on first Postgres start).
-- n8n keeps its own tables in the separate "n8n" database (created by 00-databases.sh).
\connect dsb

CREATE TABLE IF NOT EXISTS sent_articles (
  url_norm   TEXT PRIMARY KEY,           -- normalized URL (tracking params stripped)
  url        TEXT NOT NULL,
  title      TEXT,
  source_id  TEXT,
  run_id     TEXT,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sent_articles_sent_at ON sent_articles (sent_at);

CREATE TABLE IF NOT EXISTS run_log (
  run_id      TEXT PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      TEXT NOT NULL,             -- sent | no_stories | failed
  stats       JSONB NOT NULL
);

-- Convenience view: one row per run with the headline numbers.
CREATE OR REPLACE VIEW run_summary AS
SELECT run_id, started_at, status,
       (stats->>'feeds_ok')::int        AS feeds_ok,
       (stats->>'feeds_failed')::int    AS feeds_failed,
       (stats->>'articles_fetched')::int AS articles_fetched,
       (stats->>'relevance_pass')::int  AS relevance_pass,
       (stats->>'clusters')::int        AS clusters,
       (stats->>'stories_sent')::int    AS stories_sent
FROM run_log ORDER BY started_at DESC;

