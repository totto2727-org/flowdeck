CREATE TABLE runs (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    started_at BIGINT NOT NULL CHECK (started_at >= 0),
    finished_at BIGINT CHECK (finished_at >= 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
    snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
    CHECK ((status = 'running') = (finished_at IS NULL))
);
-- #[toasty::breakpoint]
CREATE TABLE graph_sessions (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    version BIGINT NOT NULL CHECK (version > 0),
    payload TEXT NOT NULL CHECK (json_valid(payload))
);
-- #[toasty::breakpoint]
CREATE TABLE schedule_leases (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0)
);
