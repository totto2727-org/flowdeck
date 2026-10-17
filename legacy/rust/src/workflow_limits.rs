use std::time::Duration;

use serde::Serialize;

use crate::{WorkflowError, WorkflowExecutionDefaults};
/// Count and duration bounds for one execution target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
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

    pub(crate) fn defaults(
        node_count: usize,
        defaults: &WorkflowExecutionDefaults,
    ) -> Result<Self, WorkflowError> {
        let max_steps = node_count
            .checked_mul(defaults.step_multiplier.get())
            .ok_or_else(|| invalid_limits("workflow step budget overflowed"))?;
        let timeout_multiplier = u32::try_from(max_steps)
            .map_err(|_| invalid_limits("workflow timeout multiplier exceeded u32"))?;
        let timeout = defaults
            .timeout_per_step
            .get()
            .checked_mul(timeout_multiplier)
            .ok_or_else(|| invalid_limits("workflow timeout overflowed"))?;
        Self::new(
            max_steps,
            timeout,
            ExecutionLimit::new(
                defaults.node.max_executions.get(),
                defaults.node.timeout.get(),
            ),
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
