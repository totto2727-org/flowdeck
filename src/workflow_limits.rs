use std::time::Duration;

use serde::Serialize;

use crate::WorkflowError;

/// Default multiplier used to derive a workflow's total step budget from its node count.
pub const DEFAULT_WORKFLOW_STEP_MULTIPLIER: usize = 5;
/// Default workflow duration budget assigned to every allowed step.
pub const DEFAULT_WORKFLOW_TIMEOUT_PER_STEP: Duration = Duration::from_mins(5);
/// Default number of times one node may execute during a run.
pub const DEFAULT_NODE_MAX_EXECUTIONS: usize = 5;
/// Default duration allowed for one node execution.
pub const DEFAULT_NODE_TIMEOUT: Duration = Duration::from_mins(5);
/// Count and duration bounds for one execution target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct ExecutionLimit {
    /// Maximum executions or traversals during one workflow run.
    pub max_executions: usize,
    /// Maximum duration of one execution or traversal.
    pub timeout: Duration,
}

impl ExecutionLimit {
    /// Construct a target execution limit.
    pub const fn new(max_executions: usize, timeout: Duration) -> Self {
        Self {
            max_executions,
            timeout,
        }
    }
}

/// Effective bounds applied to one workflow run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct WorkflowExecutionLimits {
    /// Maximum number of node executions across the run.
    pub max_steps: usize,
    /// Maximum wall-clock duration of the run.
    pub timeout: Duration,
    /// Default bound applied to each node ID.
    pub node: ExecutionLimit,
}

impl WorkflowExecutionLimits {
    /// Construct an explicit workflow limit override.
    pub const fn new(max_steps: usize, timeout: Duration, node: ExecutionLimit) -> Self {
        Self {
            max_steps,
            timeout,
            node,
        }
    }

    pub(crate) fn defaults(node_count: usize) -> Result<Self, WorkflowError> {
        let max_steps = node_count
            .checked_mul(DEFAULT_WORKFLOW_STEP_MULTIPLIER)
            .ok_or_else(|| invalid_limits("workflow step budget overflowed"))?;
        let timeout_multiplier = u32::try_from(max_steps)
            .map_err(|_| invalid_limits("workflow timeout multiplier exceeded u32"))?;
        let timeout = DEFAULT_WORKFLOW_TIMEOUT_PER_STEP
            .checked_mul(timeout_multiplier)
            .ok_or_else(|| invalid_limits("workflow timeout overflowed"))?;
        Self::new(
            max_steps,
            timeout,
            ExecutionLimit::new(DEFAULT_NODE_MAX_EXECUTIONS, DEFAULT_NODE_TIMEOUT),
        )
        .validated()
    }

    pub(crate) fn validated(self) -> Result<Self, WorkflowError> {
        if self.max_steps == 0 {
            return Err(invalid_limits(
                "workflow max_steps must be greater than zero",
            ));
        }
        if self.timeout.is_zero() {
            return Err(invalid_limits("workflow timeout must be greater than zero"));
        }
        if self.node.max_executions == 0 || self.node.timeout.is_zero() {
            return Err(invalid_limits(
                "node execution count and timeout must be greater than zero",
            ));
        }
        Ok(self)
    }
}

fn invalid_limits(message: &str) -> WorkflowError {
    WorkflowError::ExecutionLimits {
        message: message.to_owned(),
    }
}
