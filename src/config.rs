use std::{
    error::Error,
    fmt,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    num::NonZeroUsize,
    time::Duration,
};

use crate::ScheduleOverlapPolicy;

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
const DEFAULT_RUN_RETENTION: NonZeroUsize = match NonZeroUsize::new(100) {
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

/// Immutable process-wide policy passed into application bootstrap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplicationConfig {
    /// HTTP listener policy.
    pub http: HttpConfig,
    /// Generic workflow execution policy.
    pub workflows: WorkflowConfig,
    /// State backend selection.
    pub state: StateConfig,
    /// Cron dispatcher policy.
    pub scheduler: SchedulerConfig,
    /// Broadcast channel capacities.
    pub events: EventConfig,
}

impl ApplicationConfig {
    /// Preserve the experiment's local-only, `SQLite` operating profile.
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
                backend: StateBackendConfig::Sqlite(SqliteStateConfig {
                    location: SqliteLocation::Memory,
                    history: RunHistoryConfig {
                        run_retention: RunRetention::KeepLatest(DEFAULT_RUN_RETENTION),
                    },
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

/// HTTP listener settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpConfig {
    /// Socket address accepted by the server listener.
    pub bind_address: SocketAddr,
}

/// Workflow-related application settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowConfig {
    /// Maximum number of workflow drivers that may run concurrently.
    pub max_concurrent_runs: NonZeroUsize,
    /// Defaults applied when a workflow has no explicit override.
    pub execution: WorkflowExecutionDefaults,
}

/// Default workflow and node execution limits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowExecutionDefaults {
    /// Multiplier applied to the number of registered nodes.
    pub step_multiplier: NonZeroUsize,
    /// Workflow timeout allocated to every derived step.
    pub timeout_per_step: PositiveDuration,
    /// Per-node execution defaults.
    pub node: ExecutionTargetDefaults,
}

/// Default limit applied to one node ID.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionTargetDefaults {
    /// Maximum executions of the same node in one run.
    pub max_executions: NonZeroUsize,
    /// Maximum wall-clock duration of one node execution.
    pub timeout: PositiveDuration,
}

/// Duration that cannot represent a zero timeout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PositiveDuration(Duration);

impl PositiveDuration {
    /// Validate a duration at the configuration boundary.
    ///
    /// # Errors
    /// Returns an error when `duration` is zero.
    pub const fn new(duration: Duration) -> Result<Self, ApplicationConfigError> {
        if duration.is_zero() {
            return Err(ApplicationConfigError::ZeroDuration);
        }
        Ok(Self(duration))
    }

    /// Return the validated standard duration.
    #[must_use]
    pub const fn get(self) -> Duration {
        self.0
    }
}

/// State backend settings without live state instances.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateConfig {
    /// Consistent backend bundle selected for every state category.
    pub backend: StateBackendConfig,
}

/// Supported state backend profiles.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StateBackendConfig {
    /// `SQLite`-backed state, in memory or in a local file.
    Sqlite(SqliteStateConfig),
}

/// `SQLite` backend policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SqliteStateConfig {
    /// Database location.
    pub location: SqliteLocation,
    /// Retained run settings.
    pub history: RunHistoryConfig,
}

/// `SQLite` connection target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SqliteLocation {
    /// A private database lasting for the lifetime of the service.
    Memory,
    /// A database file preserved across service restarts.
    File(std::path::PathBuf),
}

/// `SQLite` history retention policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunHistoryConfig {
    /// Terminal run snapshot retention policy.
    pub run_retention: RunRetention,
}

/// Supported run snapshot retention policies.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunRetention {
    /// Retain this many latest terminal snapshots.
    KeepLatest(NonZeroUsize),
}

/// Scheduler startup and inherited overlap policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchedulerConfig {
    /// Whether cron workers are started.
    pub mode: SchedulerMode,
    /// Policy used by schedules that do not explicitly override it.
    pub default_overlap_policy: ScheduleOverlapPolicy,
}

/// Cron worker startup mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchedulerMode {
    /// Validate schedules and run cron workers.
    Enabled,
    /// Keep manual execution available without cron workers.
    Disabled,
}

/// Event broadcast channel capacities.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventConfig {
    /// Workflow lifecycle event capacity.
    pub workflow_capacity: NonZeroUsize,
}

/// Invalid application configuration value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplicationConfigError {
    /// A timeout was configured as zero.
    ZeroDuration,
}

impl fmt::Display for ApplicationConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroDuration => formatter.write_str("application duration must be positive"),
        }
    }
}

impl Error for ApplicationConfigError {}

#[cfg(test)]
mod tests {
    use std::{net::Ipv4Addr, time::Duration};

    use super::{
        ApplicationConfig, PositiveDuration, RunRetention, SchedulerMode, StateBackendConfig,
    };
    use crate::ScheduleOverlapPolicy;

    #[test]
    fn local_defaults_preserve_current_operating_policy() {
        let config = ApplicationConfig::local_default();

        assert_eq!(config.http.bind_address.ip(), Ipv4Addr::LOCALHOST);
        assert_eq!(config.http.bind_address.port(), 3000);
        assert_eq!(config.workflows.execution.step_multiplier.get(), 5);
        assert_eq!(config.workflows.max_concurrent_runs.get(), 100);
        assert_eq!(
            config.workflows.execution.timeout_per_step.get(),
            Duration::from_mins(5)
        );
        assert_eq!(config.workflows.execution.node.max_executions.get(), 5);
        assert_eq!(
            config.workflows.execution.node.timeout.get(),
            Duration::from_mins(5)
        );
        let StateBackendConfig::Sqlite(memory) = config.state.backend;
        assert!(matches!(
            memory.history.run_retention,
            RunRetention::KeepLatest(capacity) if capacity.get() == 100
        ));
        assert_eq!(config.scheduler.mode, SchedulerMode::Enabled);
        assert_eq!(
            config.scheduler.default_overlap_policy,
            ScheduleOverlapPolicy::SkipWhileRunning
        );
        assert_eq!(config.events.workflow_capacity.get(), 128);
    }

    #[test]
    fn positive_duration_rejects_zero() {
        assert!(PositiveDuration::new(Duration::ZERO).is_err());
    }
}
