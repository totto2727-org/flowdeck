CREATE TABLE runs (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    start_order BIGINT NOT NULL UNIQUE CHECK (start_order > 0),
    terminal_order BIGINT UNIQUE CHECK (terminal_order > 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
    snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
    CHECK ((status = 'running') = (terminal_order IS NULL))
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
-- #[toasty::breakpoint]
CREATE TABLE store_clocks (
    id TEXT PRIMARY KEY NOT NULL CHECK (id IN ('start', 'terminal')),
    value BIGINT NOT NULL CHECK (value >= 0)
);
