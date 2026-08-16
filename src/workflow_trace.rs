use std::time::{Duration, SystemTime};

use graph_flow::Context;
use serde::Serialize;
use serde_json::Value;

use crate::{RunSnapshot, StepTraceStatus::Running, workflows::WORKFLOW_INPUT_KEY};

const BRANCH_KEY: &str = "branch_yes";
const BRANCH_TOKEN_KEY: &str = "branch_token";

/// Typed graph state retained immediately after one node executes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct StepState {
    /// Workflow-owned input state from the initial graph context.
    pub input: Value,
    /// Random token produced by this node, when available.
    pub task_token: Option<String>,
    /// Branch decision after the route-selection node executes.
    pub branch_selected: Option<bool>,
    /// Token used to derive the branch decision.
    pub branch_token: Option<String>,
}

/// Lifecycle state for one retained node execution.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
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
#[non_exhaustive]
pub struct StepTrace {
    /// Zero-based execution order within the run.
    pub sequence: usize,
    /// Stable graph node ID.
    pub node_id: String,
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
    pub(crate) fn begin_step(&mut self, node_id: &str) {
        self.steps.push(StepTrace {
            sequence: self.steps.len(),
            node_id: node_id.to_owned(),
            selected_edge: None,
            status: Running,
            state: StepState {
                input: self.input.state().clone(),
                task_token: None,
                branch_selected: None,
                branch_token: None,
            },
            output: None,
            started_at: SystemTime::now(),
            finished_at: None,
            duration: None,
        });
    }

    pub(crate) fn finish_step(
        &mut self,
        node_id: &str,
        selected_edge: Option<&str>,
        output: Option<String>,
        state: StepState,
    ) {
        let Some(step) = self
            .steps
            .iter_mut()
            .rev()
            .find(|step| step.node_id == node_id && step.status == Running)
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

    pub(crate) fn fail_step(&mut self, message: &str, finished_at: SystemTime) {
        let Some(step) = self
            .steps
            .iter_mut()
            .rev()
            .find(|step| step.status == Running)
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

impl StepState {
    pub(crate) fn after(context: &Context, node_id: &str) -> Option<Self> {
        let task_token_key = format!("task_token:{node_id}");
        Some(Self {
            input: context.get(WORKFLOW_INPUT_KEY)?,
            task_token: context.get(&task_token_key),
            branch_selected: context.get(BRANCH_KEY),
            branch_token: context.get(BRANCH_TOKEN_KEY),
        })
    }
}
