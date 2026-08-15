//! Local workflow execution domain.

mod workflow;
mod workflow_graph;

use std::{
    error::Error,
    fmt,
    time::{Duration, SystemTime},
};

pub use workflow::WorkflowService;
use workflow_graph::{EDGES, NODES, WORKFLOW_ID, build_graph};
pub use workflow_graph::{EdgeSpec, NodeSpec, workflow_topology};

/// Return the only workflow ID accepted by this local experiment.
pub const fn workflow_id() -> &'static str {
    WORKFLOW_ID
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

/// Immutable state returned by workflow start, list, and polling calls.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct RunSnapshot {
    /// Identifier for this execution.
    pub run_id: RunId,
    /// Code-defined workflow selected at the boundary.
    pub workflow_id: String,
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
            Self::GraphBuild { message } => {
                write!(formatter, "workflow graph build failed: {message}")
            }
            Self::Session { message } => write!(formatter, "workflow session failed: {message}"),
        }
    }
}

impl Error for WorkflowError {}
