use std::{
    fmt,
    time::{Duration, SystemTime},
};

use serde_json::Value;

use crate::{RunSnapshot, StepTraceStatus::Running};

/// Stable one-based identity of a node execution within one run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StepId(usize);

impl StepId {
    pub(crate) fn from_persisted(value: usize) -> Result<Self, crate::WorkflowError> {
        if value == 0 {
            return Err(crate::WorkflowError::Storage {
                message: "step identity must be positive".to_owned(),
            });
        }
        Ok(Self(value))
    }
    /// Return the run-local numeric identity.
    pub const fn value(self) -> usize {
        self.0
    }
}

impl fmt::Display for StepId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Typed graph state retained immediately after one node executes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepState {
    /// Workflow-owned, explicitly projected and redacted state.
    pub payload: Value,
}

/// Lifecycle state for one retained node execution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StepTraceStatus {
    /// The node is currently executing.
    Running,
    /// The node completed and returned an output.
    Completed,
    /// The node execution failed.
    Failed {
        /// Error returned by graph-flow or session storage.
        message: String,
    },
}

/// Observable performance and debugging data for one node execution.
#[derive(Clone, Debug)]
pub struct StepTrace {
    /// Stable one-based identity within the run.
    pub step_id: StepId,
    /// Zero-based execution order within the run.
    pub sequence: usize,
    /// Stable graph node ID.
    pub node_id: String,
    /// One-based execution count for this node ID within the run.
    pub node_execution: usize,
    /// Edge selected after the node completed, when applicable.
    pub selected_edge: Option<String>,
    /// Node lifecycle state.
    pub status: StepTraceStatus,
    /// State available at this execution point.
    pub state: StepState,
    /// Output returned by the node.
    pub output: Option<String>,
    /// Node start time.
    pub started_at: SystemTime,
    /// Node finish time, when available.
    pub finished_at: Option<SystemTime>,
    /// Node execution duration, when available.
    pub duration: Option<Duration>,
}

impl RunSnapshot {
    pub(crate) fn begin_step(&mut self, node_id: &str) -> StepId {
        let step_id = StepId(self.steps.len().saturating_add(1));
        let node_execution = self
            .steps
            .iter()
            .filter(|step| step.node_id == node_id)
            .count()
            .saturating_add(1);
        self.steps.push(StepTrace {
            step_id,
            sequence: self.steps.len(),
            node_id: node_id.to_owned(),
            node_execution,
            selected_edge: None,
            status: Running,
            state: StepState {
                payload: serde_json::json!({ "input": self.input.state() }),
            },
            output: None,
            started_at: SystemTime::now(),
            finished_at: None,
            duration: None,
        });
        step_id
    }

    pub(crate) fn finish_step(
        &mut self,
        step_id: StepId,
        selected_edge: Option<&str>,
        output: Option<String>,
        state: StepState,
    ) {
        let Some(step) = self
            .steps
            .iter_mut()
            .rev()
            .find(|step| step.step_id == step_id && step.status == Running)
        else {
            return;
        };
        let finished_at = SystemTime::now();
        step.selected_edge = selected_edge.map(str::to_owned);
        step.status = StepTraceStatus::Completed;
        step.state = state;
        step.output = output;
        step.duration = finished_at.duration_since(step.started_at).ok();
        step.finished_at = Some(finished_at);
    }

    pub(crate) fn fail_step(
        &mut self,
        step_id: Option<StepId>,
        message: &str,
        finished_at: SystemTime,
    ) {
        let Some(step_id) = step_id else {
            return;
        };
        let Some(step) = self
            .steps
            .iter_mut()
            .find(|step| step.step_id == step_id && step.status == Running)
        else {
            return;
        };
        step.status = StepTraceStatus::Failed {
            message: message.to_owned(),
        };
        step.output = Some(message.to_owned());
        step.duration = finished_at.duration_since(step.started_at).ok();
        step.finished_at = Some(finished_at);
    }
}
