use std::{collections::HashMap, sync::Arc};

use graph_flow::{FlowRunner, Graph, SessionStorage};
use tokio::sync::broadcast;

use super::{
    ActiveRunGroup, ApplicationState, Inner, TraceProjector, WorkflowRuntime, WorkflowService,
};
use crate::{
    ApplicationConfig, SchedulerMode, WorkflowDefinition, WorkflowError, WorkflowExecutionDefaults,
    WorkflowExecutionLimits,
    workflows::{WorkflowRegistration, workflow_registrations},
};

struct GraphExecutionConfig {
    definition: &'static WorkflowDefinition,
    graph: Arc<Graph>,
    session_storage: Arc<dyn SessionStorage>,
    limits: WorkflowExecutionLimits,
    input: Arc<dyn super::WorkflowInputContract>,
    trace_projector: Arc<dyn TraceProjector>,
}

impl WorkflowService {
    /// Build every registered workflow without starting optional node backends.
    pub fn new() -> Result<Self, WorkflowError> {
        Self::with_config(ApplicationConfig::local_default())
    }

    /// Build every registered workflow with explicit application policy.
    pub fn with_config(config: ApplicationConfig) -> Result<Self, WorkflowError> {
        Self::build(workflow_registrations()?, config)
    }

    fn build(
        registrations: Vec<WorkflowRegistration>,
        config: ApplicationConfig,
    ) -> Result<Self, WorkflowError> {
        let state = ApplicationState::build(&config.state.backend);
        let mut runtimes = HashMap::new();
        for registration in registrations {
            let execution =
                generate_execution_config(registration, &config.workflows.execution, &state)?;
            runtimes.insert(
                execution.definition.workflow_id,
                WorkflowRuntime {
                    definition: execution.definition,
                    input: execution.input,
                    trace_projector: execution.trace_projector,
                    limits: execution.limits,
                    runner: FlowRunner::new(
                        execution.graph,
                        Arc::clone(&execution.session_storage),
                    ),
                    storage: execution.session_storage,
                },
            );
        }
        let (events, _) = broadcast::channel(config.events.workflow_capacity.get());
        let service = Self {
            inner: Arc::new(Inner {
                runtimes,
                state,
                scheduler: config.scheduler,
                run_group: ActiveRunGroup::new(config.workflows.max_concurrent_runs),
                events,
            }),
        };
        if service.inner.scheduler.mode == SchedulerMode::Enabled {
            crate::workflow_scheduler::validate_schedules(&service)?;
        }
        Ok(service)
    }
}

fn generate_execution_config(
    registration: WorkflowRegistration,
    defaults: &WorkflowExecutionDefaults,
    state: &ApplicationState,
) -> Result<GraphExecutionConfig, WorkflowError> {
    Ok(GraphExecutionConfig {
        definition: registration.definition,
        limits: registration.definition.execution_limits(defaults)?,
        graph: registration.graph,
        session_storage: Arc::clone(&state.graph_sessions),
        input: registration.input,
        trace_projector: registration.trace_projector,
    })
}
