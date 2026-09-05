use std::time::{Duration, SystemTime};

use garde::Validate;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    RunId, RunSnapshot, RunStatus, RunTrigger, StepId, StepState, StepTrace, StepTraceStatus,
    WorkflowError,
};

/// The versioned storage wire contract is deliberately independent of domain types.
#[derive(Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct RunDto {
    #[garde(range(min = 1, max = 1))]
    version: u8,
    #[garde(custom(non_blank))]
    run_id: String,
    #[garde(custom(non_blank))]
    workflow_id: String,
    // Workflow-owned JSON is opaque here. Its contract is checked by the workflow boundary.
    #[garde(custom(object))]
    input: Value,
    #[garde(skip)]
    input_summary: String,
    #[garde(dive)]
    trigger: TriggerDto,
    #[garde(dive)]
    status: RunStatusDto,
    #[garde(inner(custom(non_blank)))]
    current_node: Option<String>,
    #[garde(inner(custom(non_blank)))]
    current_edge: Option<String>,
    #[garde(inner(custom(non_blank)))]
    traversed_nodes: Vec<String>,
    #[garde(inner(custom(non_blank)))]
    traversed_edges: Vec<String>,
    #[garde(skip)]
    route_summary: String,
    // Serde validates representability. Relationships belong to RunSnapshot::restore.
    #[garde(skip)]
    started_at: SystemTime,
    #[garde(skip)]
    finished_at: Option<SystemTime>,
    #[garde(skip)]
    duration: Option<Duration>,
    #[garde(dive)]
    steps: Vec<StepDto>,
}

#[derive(Serialize, Deserialize, Validate)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum TriggerDto {
    Manual,
    Cron {
        #[garde(custom(non_blank))]
        schedule_id: String,
    },
}

#[derive(Serialize, Deserialize, Validate)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum RunStatusDto {
    Running,
    Completed,
    Failed {
        #[garde(skip)]
        message: String,
    },
    Skipped {
        #[garde(custom(non_blank))]
        reason: String,
    },
}

#[derive(Serialize, Deserialize, Validate)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum StepStatusDto {
    Running,
    Completed,
    Failed {
        #[garde(skip)]
        message: String,
    },
}

#[derive(Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct StepDto {
    #[garde(range(min = 1))]
    step_id: usize,
    #[garde(skip)]
    sequence: usize,
    #[garde(custom(non_blank))]
    node_id: String,
    #[garde(range(min = 1))]
    node_execution: usize,
    #[garde(inner(custom(non_blank)))]
    selected_edge: Option<String>,
    #[garde(dive)]
    status: StepStatusDto,
    // A trace projector owns this opaque, redacted JSON payload.
    #[garde(skip)]
    state: Value,
    #[garde(skip)]
    output: Option<String>,
    #[garde(skip)]
    started_at: SystemTime,
    #[garde(skip)]
    finished_at: Option<SystemTime>,
    #[garde(skip)]
    duration: Option<Duration>,
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators require a borrowed context."
)]
fn non_blank(value: &str, (): &()) -> garde::Result {
    if value.trim().is_empty() {
        Err(garde::Error::new("must not be blank"))
    } else {
        Ok(())
    }
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators require a borrowed context."
)]
fn object(value: &Value, (): &()) -> garde::Result {
    if value.is_object() {
        Ok(())
    } else {
        Err(garde::Error::new("must be a JSON object"))
    }
}

pub(super) fn encode(snapshot: &RunSnapshot) -> Result<String, WorkflowError> {
    let dto = RunDto::from(snapshot);
    dto.validate()
        .map_err(|error| storage_error("validation", error))?;
    serde_json::to_string(&dto).map_err(|error| storage_error("encoding", error))
}

pub(super) fn decode(json: &str) -> Result<RunSnapshot, WorkflowError> {
    let dto: RunDto =
        serde_json::from_str(json).map_err(|error| storage_error("decoding", error))?;
    dto.validate()
        .map_err(|error| storage_error("validation", error))?;
    let input = crate::workflows::restore_run_input(&dto.workflow_id, dto.input, dto.input_summary)
        .map_err(|error| storage_error("workflow input validation", error))?;
    RunSnapshot::restore(RunSnapshot {
        run_id: RunId(dto.run_id),
        workflow_id: dto.workflow_id,
        input,
        trigger: match dto.trigger {
            TriggerDto::Manual => RunTrigger::Manual,
            TriggerDto::Cron { schedule_id } => RunTrigger::Cron { schedule_id },
        },
        status: match dto.status {
            RunStatusDto::Running => RunStatus::Running,
            RunStatusDto::Completed => RunStatus::Completed,
            RunStatusDto::Failed { message } => RunStatus::Failed { message },
            RunStatusDto::Skipped { reason } => RunStatus::Skipped { reason },
        },
        current_node: dto.current_node,
        current_edge: dto.current_edge,
        traversed_nodes: dto.traversed_nodes,
        traversed_edges: dto.traversed_edges,
        route_summary: dto.route_summary,
        started_at: dto.started_at,
        finished_at: dto.finished_at,
        duration: dto.duration,
        steps: dto
            .steps
            .into_iter()
            .map(StepTrace::try_from)
            .collect::<Result<_, _>>()?,
    })
}

fn storage_error(stage: &str, error: impl std::fmt::Display) -> WorkflowError {
    WorkflowError::Storage {
        message: format!("persisted run {stage} failed: {error}"),
    }
}

impl From<&RunSnapshot> for RunDto {
    fn from(run: &RunSnapshot) -> Self {
        Self {
            version: 1,
            run_id: run.run_id.to_string(),
            workflow_id: run.workflow_id.clone(),
            input: run.input.state().clone(),
            input_summary: run.input.summary().to_owned(),
            trigger: match &run.trigger {
                RunTrigger::Manual => TriggerDto::Manual,
                RunTrigger::Cron { schedule_id } => TriggerDto::Cron {
                    schedule_id: schedule_id.clone(),
                },
            },
            status: match &run.status {
                RunStatus::Running => RunStatusDto::Running,
                RunStatus::Completed => RunStatusDto::Completed,
                RunStatus::Failed { message } => RunStatusDto::Failed {
                    message: message.clone(),
                },
                RunStatus::Skipped { reason } => RunStatusDto::Skipped {
                    reason: reason.clone(),
                },
            },
            current_node: run.current_node.clone(),
            current_edge: run.current_edge.clone(),
            traversed_nodes: run.traversed_nodes.clone(),
            traversed_edges: run.traversed_edges.clone(),
            route_summary: run.route_summary.clone(),
            started_at: run.started_at,
            finished_at: run.finished_at,
            duration: run.duration,
            steps: run.steps.iter().map(StepDto::from).collect(),
        }
    }
}

impl From<&StepTrace> for StepDto {
    fn from(step: &StepTrace) -> Self {
        Self {
            step_id: step.step_id.value(),
            sequence: step.sequence,
            node_id: step.node_id.clone(),
            node_execution: step.node_execution,
            selected_edge: step.selected_edge.clone(),
            status: match &step.status {
                StepTraceStatus::Running => StepStatusDto::Running,
                StepTraceStatus::Completed => StepStatusDto::Completed,
                StepTraceStatus::Failed { message } => StepStatusDto::Failed {
                    message: message.clone(),
                },
            },
            state: step.state.payload.clone(),
            output: step.output.clone(),
            started_at: step.started_at,
            finished_at: step.finished_at,
            duration: step.duration,
        }
    }
}

impl TryFrom<StepDto> for StepTrace {
    type Error = WorkflowError;

    fn try_from(step: StepDto) -> Result<Self, Self::Error> {
        Ok(Self {
            step_id: StepId::from_persisted(step.step_id)?,
            sequence: step.sequence,
            node_id: step.node_id,
            node_execution: step.node_execution,
            selected_edge: step.selected_edge,
            status: match step.status {
                StepStatusDto::Running => StepTraceStatus::Running,
                StepStatusDto::Completed => StepTraceStatus::Completed,
                StepStatusDto::Failed { message } => StepTraceStatus::Failed { message },
            },
            state: StepState {
                payload: step.state,
            },
            output: step.output,
            started_at: step.started_at,
            finished_at: step.finished_at,
            duration: step.duration,
        })
    }
}

#[cfg(test)]
#[path = "run_dto_test.rs"]
mod tests;
