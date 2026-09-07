use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    num::NonZeroUsize,
    time::Duration,
};

use crate::ScheduleOverlapPolicy;

mod remote;
mod types;
pub use remote::TursoRemoteConfig;
pub use types::{
    ApplicationConfig, ApplicationConfigError, EventConfig, ExecutionTargetDefaults, HttpConfig,
    PositiveDuration, SchedulerConfig, SchedulerMode, StateBackendConfig, StateConfig,
    TursoLocation, TursoStateConfig, WorkflowConfig, WorkflowExecutionDefaults,
};

const DEFAULT_WORKFLOW_STEP_MULTIPLIER: NonZeroUsize = match NonZeroUsize::new(5) {
    Some(value) => value,
    None => NonZeroUsize::MIN,
};
const DEFAULT_NODE_MAX_EXECUTIONS: NonZeroUsize = match NonZeroUsize::new(5) {
    Some(value) => value,
    None => NonZeroUsize::MIN,
};
const DEFAULT_WORKFLOW_EVENT_CAPACITY: NonZeroUsize = match NonZeroUsize::new(128) {
    Some(value) => value,
    None => NonZeroUsize::MIN,
};
const DEFAULT_MAX_CONCURRENT_RUNS: NonZeroUsize = match NonZeroUsize::new(100) {
    Some(value) => value,
    None => NonZeroUsize::MIN,
};
const DEFAULT_WORKFLOW_TIMEOUT_PER_STEP: PositiveDuration =
    PositiveDuration(Duration::from_mins(5));
const DEFAULT_NODE_TIMEOUT: PositiveDuration = PositiveDuration(Duration::from_mins(5));

impl ApplicationConfig {
    /// Preserve the experiment's local-only, Turso operating profile.
    #[must_use]
    pub const fn local_default() -> Self {
        Self {
            http: HttpConfig {
                bind_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3000),
            },
            workflows: WorkflowConfig {
                max_concurrent_runs: DEFAULT_MAX_CONCURRENT_RUNS,
                execution: WorkflowExecutionDefaults {
                    step_multiplier: DEFAULT_WORKFLOW_STEP_MULTIPLIER,
                    timeout_per_step: DEFAULT_WORKFLOW_TIMEOUT_PER_STEP,
                    node: ExecutionTargetDefaults {
                        max_executions: DEFAULT_NODE_MAX_EXECUTIONS,
                        timeout: DEFAULT_NODE_TIMEOUT,
                    },
                },
            },
            state: StateConfig {
                backend: StateBackendConfig::Turso(TursoStateConfig {
                    location: TursoLocation::Memory,
                    remote: None,
                }),
            },
            scheduler: SchedulerConfig {
                mode: SchedulerMode::Enabled,
                default_overlap_policy: ScheduleOverlapPolicy::SkipWhileRunning,
            },
            events: EventConfig {
                workflow_capacity: DEFAULT_WORKFLOW_EVENT_CAPACITY,
            },
        }
    }
}

impl Default for ApplicationConfig {
    fn default() -> Self {
        Self::local_default()
    }
}

#[cfg(test)]
#[path = "config/defaults_test.rs"]
mod tests;
