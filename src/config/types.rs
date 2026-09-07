use std::{error::Error, fmt, net::SocketAddr, num::NonZeroUsize, time::Duration};

use super::TursoRemoteConfig;
use crate::ScheduleOverlapPolicy;

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
pub struct PositiveDuration(pub(super) Duration);

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
    /// Turso-backed state, in memory or in a local file.
    Turso(TursoStateConfig),
}

/// Turso backend policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TursoStateConfig {
    /// Database location.
    pub location: TursoLocation,
    /// Optional embedded sync target with a single writer, not a direct SQL connection.
    pub remote: Option<TursoRemoteConfig>,
}

/// Turso connection target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TursoLocation {
    /// A private database lasting for the lifetime of the service.
    Memory,
    /// A database file preserved across service restarts.
    File(std::path::PathBuf),
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
    /// Remote connection settings failed validation.
    InvalidTursoRemote,
}

impl fmt::Display for ApplicationConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroDuration => formatter.write_str("application duration must be positive"),
            Self::InvalidTursoRemote => formatter.write_str("invalid Turso remote configuration"),
        }
    }
}

impl Error for ApplicationConfigError {}
