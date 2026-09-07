CREATE TABLE runs (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    workflow_id TEXT NOT NULL CHECK (length(trim(workflow_id)) > 0),
    input TEXT NOT NULL CHECK (json_valid(input) AND json_type(input) = 'object'),
    input_summary TEXT NOT NULL,
    "trigger" TEXT NOT NULL CHECK ("trigger" IN ('manual', 'cron')),
    schedule_id TEXT CHECK (schedule_id IS NULL OR length(trim(schedule_id)) > 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
    status_message TEXT,
    current_node TEXT CHECK (current_node IS NULL OR length(trim(current_node)) > 0),
    route_summary TEXT NOT NULL,
    started_at BIGINT NOT NULL CHECK (started_at >= 0),
    started_at_submillis BIGINT NOT NULL CHECK (started_at_submillis BETWEEN 0 AND 999999),
    finished_at BIGINT CHECK (finished_at >= 0),
    finished_at_submillis BIGINT CHECK (finished_at_submillis BETWEEN 0 AND 999999),
    CHECK (("trigger" = 'manual') = (schedule_id IS NULL)),
    CHECK ((status IN ('running', 'completed')) = (status_message IS NULL)),
    CHECK (status != 'skipped' OR length(trim(status_message)) > 0),
    CHECK ((status = 'running') = (finished_at IS NULL)),
    CHECK ((finished_at IS NULL) = (finished_at_submillis IS NULL))
);
-- #[toasty::breakpoint]
CREATE TABLE run_steps (
    run_id TEXT NOT NULL,
    step_id BIGINT NOT NULL CHECK (step_id > 0),
    sequence BIGINT NOT NULL CHECK (sequence >= 0),
    node_id TEXT NOT NULL CHECK (length(trim(node_id)) > 0),
    node_execution BIGINT NOT NULL CHECK (node_execution > 0),
    selected_edge TEXT CHECK (selected_edge IS NULL OR length(trim(selected_edge)) > 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    status_message TEXT,
    state TEXT NOT NULL CHECK (json_valid(state)),
    output TEXT,
    started_at BIGINT NOT NULL CHECK (started_at >= 0),
    started_at_submillis BIGINT NOT NULL CHECK (started_at_submillis BETWEEN 0 AND 999999),
    finished_at BIGINT CHECK (finished_at >= 0),
    finished_at_submillis BIGINT CHECK (finished_at_submillis BETWEEN 0 AND 999999),
    PRIMARY KEY (run_id, step_id),
    UNIQUE (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
    CHECK ((status = 'failed') = (status_message IS NOT NULL)),
    CHECK ((status = 'running') = (finished_at IS NULL)),
    CHECK ((finished_at IS NULL) = (finished_at_submillis IS NULL))
);
-- #[toasty::breakpoint]
CREATE TABLE graph_sessions (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    version BIGINT NOT NULL CHECK (version > 0),
    graph_id TEXT NOT NULL CHECK (length(trim(graph_id)) > 0),
    current_task_id TEXT NOT NULL CHECK (length(trim(current_task_id)) > 0),
    status_message TEXT,
    context TEXT NOT NULL CHECK (json_valid(context) AND json_type(context) = 'object')
);
-- #[toasty::breakpoint]
CREATE TABLE schedule_leases (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0)
);
