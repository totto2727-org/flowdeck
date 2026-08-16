//! Local workflow execution domain.

mod workflow;
mod workflow_scheduler;
pub(crate) mod workflow_trace;
#[doc(hidden)]
pub mod workflows;

use std::{
    error::Error,
    fmt,
    time::{Duration, SystemTime},
};

pub use workflow::{WorkflowEvent, WorkflowService};
pub use workflow_scheduler::{ScheduleSpec, workflow_schedules};
pub use workflow_trace::{StepState, StepTrace, StepTraceStatus};
pub use workflows::{
    EdgeSpec, NodeSpec, WorkflowDefinition, workflow_default_input, workflow_definitions,
    workflow_input_form,
};

/// Return the only workflow ID accepted by this local experiment.
pub const fn workflow_id() -> &'static str {
    workflows::default_definition().workflow_id
}

/// An observable workflow run state.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RunStatus {
    /// The background driver is executing the graph.
    Running,
    /// The terminal graph task completed.
    Completed,
    /// The background driver stopped after an execution error.
    Failed {
        /// Description returned from graph-flow or its session storage.
        message: String,
    },
}

/// Validated workflow-specific parameters placed into graph-flow's initial context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunInput {
    state: serde_json::Value,
    summary: String,
}

impl RunInput {
    pub(crate) const fn new(state: serde_json::Value, summary: String) -> Self {
        Self { state, summary }
    }

    /// Return the workflow-owned state accepted at the boundary.
    pub const fn state(&self) -> &serde_json::Value {
        &self.state
    }

    /// Return the workflow-owned display summary.
    pub fn summary(&self) -> &str {
        &self.summary
    }
}

/// Source that caused a workflow execution to start.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RunTrigger {
    /// A user submitted the workflow form.
    Manual,
    /// A code-defined cron schedule fired.
    Cron {
        /// Stable code-defined schedule identifier.
        schedule_id: String,
    },
}

/// Immutable state returned by workflow start and list calls.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct RunSnapshot {
    /// Identifier for this execution.
    pub run_id: RunId,
    /// Code-defined workflow selected at the boundary.
    pub workflow_id: String,
    /// Initial graph state accepted for this execution.
    pub input: RunInput,
    /// Source that initiated the run.
    pub trigger: RunTrigger,
    /// Current execution state.
    pub status: RunStatus,
    /// Active task, or the terminal task after completion.
    pub current_node: Option<String>,
    /// Most recently selected edge.
    pub current_edge: Option<String>,
    /// Tasks executed in order.
    pub traversed_nodes: Vec<String>,
    /// Edges traversed in order.
    pub traversed_edges: Vec<String>,
    /// Route text suitable for a future UI.
    pub route_summary: String,
    /// Acceptance time for the run.
    pub started_at: SystemTime,
    /// Terminal-state time, when available.
    pub finished_at: Option<SystemTime>,
    /// Duration recorded at terminal state.
    pub duration: Option<Duration>,
    /// Per-node execution traces retained for debugging and performance inspection.
    pub steps: Vec<StepTrace>,
}

/// Opaque ID assigned to one background run.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct RunId(pub(crate) String);

impl RunId {
    /// Return the ID for storage or route parameters.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RunId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Typed failures at the workflow service boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum WorkflowError {
    /// The supplied ID does not name this experiment's workflow.
    UnknownWorkflow {
        /// Caller-provided value rejected by the service boundary.
        workflow_id: String,
    },
    /// A boundary value could not be parsed into workflow input.
    InvalidInput {
        /// Human-readable boundary failure.
        message: String,
    },
    /// The supplied ID does not name a code-defined schedule.
    UnknownSchedule {
        /// Caller-provided value rejected by the service boundary.
        schedule_id: String,
    },
    /// A code-defined cron expression or occurrence could not be evaluated.
    Schedule {
        /// Scheduler parsing or time calculation failure.
        message: String,
    },
    /// The static graph could not be built.
    GraphBuild {
        /// graph-flow validation failure for the static workflow.
        message: String,
    },
    /// The in-memory session layer rejected an operation.
    Session {
        /// In-memory session storage failure.
        message: String,
    },
}

impl fmt::Display for WorkflowError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownWorkflow { workflow_id } => {
                write!(formatter, "unknown workflow: {workflow_id}")
            }
            Self::InvalidInput { message } => write!(formatter, "invalid run input: {message}"),
            Self::UnknownSchedule { schedule_id } => {
                write!(formatter, "unknown schedule: {schedule_id}")
            }
            Self::Schedule { message } => write!(formatter, "workflow schedule failed: {message}"),
            Self::GraphBuild { message } => {
                write!(formatter, "workflow graph build failed: {message}")
            }
            Self::Session { message } => write!(formatter, "workflow session failed: {message}"),
        }
    }
}

impl Error for WorkflowError {}
