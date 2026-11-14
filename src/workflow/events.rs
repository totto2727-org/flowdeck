use crate::{RunId, StepId};

/// Lifecycle notification emitted after a workflow snapshot is updated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkflowEvent {
    /// A run snapshot was retained and its driver was started.
    RunStarted {
        /// Identifier for the retained run.
        run_id: RunId,
        /// Identifier for the selected workflow.
        workflow_id: String,
    },
    /// A node execution trace was marked running.
    NodeStarted {
        /// Identifier for the retained run.
        run_id: RunId,
        /// Identifier for the selected workflow.
        workflow_id: String,
        /// Identifier for the node that began execution.
        node_id: String,
        /// Exact node execution represented by this event.
        step_id: StepId,
    },
    /// A node execution trace was completed.
    NodeCompleted {
        /// Identifier for the retained run.
        run_id: RunId,
        /// Identifier for the selected workflow.
        workflow_id: String,
        /// Identifier for the node that completed execution.
        node_id: String,
        /// Exact node execution represented by this event.
        step_id: StepId,
        /// Identifier for the selected edge, when the node selected one.
        edge_id: Option<String>,
    },
    /// A run snapshot reached its completed terminal state.
    RunCompleted {
        /// Identifier for the retained run.
        run_id: RunId,
        /// Identifier for the selected workflow.
        workflow_id: String,
    },
    /// A run snapshot reached its failed terminal state.
    RunFailed {
        /// Identifier for the retained run.
        run_id: RunId,
        /// Identifier for the selected workflow.
        workflow_id: String,
        /// Failure message retained by the snapshot.
        message: String,
    },
    /// A scheduled firing was retained without starting graph execution.
    RunSkipped {
        /// Identifier for the retained scheduled firing.
        run_id: RunId,
        /// Identifier for the selected workflow.
        workflow_id: String,
        /// Reason graph execution did not start.
        reason: String,
    },
}
