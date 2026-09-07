use std::{net::Ipv4Addr, time::Duration};

use super::{
    ApplicationConfig, PositiveDuration, SchedulerMode, StateBackendConfig, TursoLocation,
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
    let StateBackendConfig::Turso(memory) = config.state.backend;
    assert_eq!(
        memory.remote, None,
        "local defaults must not connect remotely"
    );
    assert_eq!(memory.location, TursoLocation::Memory);
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
