use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use topcoat::{
    Result,
    context::{Cx, app_context},
    router::{StatusCode, content::Json, route},
};
use workflow_console_experiment::{
    EdgeSpec, NodeSpec, RunInput, RunSnapshot, RunStatus, RunTrigger, ScheduleSpec, StepTrace,
    StepTraceStatus, WorkflowInputDefinition, WorkflowService, workflow_definitions,
    workflow_schedules,
};

#[derive(Debug, Serialize)]
struct StateResponse {
    workflows: Vec<WorkflowDto>,
    runs: Vec<RunDto>,
}

#[derive(Debug, Serialize)]
struct WorkflowDto {
    workflow_id: &'static str,
    name: &'static str,
    description: &'static str,
    input: WorkflowInputDefinition,
    topology: TopologyDto,
    schedules: Vec<ScheduleSpec>,
}

#[derive(Debug, Serialize)]
struct TopologyDto {
    nodes: &'static [NodeSpec],
    edges: &'static [EdgeSpec],
}

#[derive(Debug, Serialize)]
struct RunDto {
    run_id: String,
    workflow_id: String,
    input: RunInputDto,
    trigger: &'static str,
    schedule_id: Option<String>,
    status: &'static str,
    error: Option<String>,
    current_node: Option<String>,
    current_edge: Option<String>,
    traversed_nodes: Vec<String>,
    traversed_edges: Vec<String>,
    route_summary: String,
    started_at_ms: u128,
    finished_at_ms: Option<u128>,
    elapsed_ms: u128,
    steps: Vec<StepTraceDto>,
}

#[derive(Debug, Serialize)]
struct StepTraceDto {
    sequence: usize,
    node_id: String,
    selected_edge: Option<String>,
    status: &'static str,
    error: Option<String>,
    state: StepStateDto,
    output: Option<String>,
    started_at_ms: u128,
    finished_at_ms: Option<u128>,
    elapsed_ms: u128,
}

#[derive(Debug, Serialize)]
struct StepStateDto {
    run_label: String,
    step_delay_ms: u64,
    task_token: Option<String>,
    branch_selected: Option<bool>,
    branch_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StartRequest {
    workflow_id: String,
    input: RunInputDto,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RunInputDto {
    label: String,
    step_delay_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
enum StartResponse {
    Accepted { run: Box<RunDto> },
    Rejected { error: String },
}

#[route(GET "/api/state")]
async fn state(cx: &Cx) -> Result<Json<StateResponse>> {
    let service = app_context::<WorkflowService>(cx);
    Ok(Json(state_response(service).await))
}

#[route(POST "/api/runs")]
async fn start_run(
    cx: &Cx,
    Json(request): Json<StartRequest>,
) -> Result<(StatusCode, Json<StartResponse>)> {
    let service = app_context::<WorkflowService>(cx);
    let input = RunInput::new(&request.input.label, request.input.step_delay_ms);
    let result = match input {
        Ok(input) => {
            service
                .start(&request.workflow_id, input, RunTrigger::Manual)
                .await
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(snapshot) => Ok((
            StatusCode::CREATED,
            Json(StartResponse::Accepted {
                run: Box::new(RunDto::from(snapshot)),
            }),
        )),
        Err(error) => Ok((
            StatusCode::BAD_REQUEST,
            Json(StartResponse::Rejected {
                error: error.to_string(),
            }),
        )),
    }
}

async fn state_response(service: &WorkflowService) -> StateResponse {
    let mut runs = service.list_runs().await;
    runs.reverse();
    StateResponse {
        workflows: workflow_definitions()
            .iter()
            .map(|definition| WorkflowDto {
                workflow_id: definition.workflow_id,
                name: definition.name,
                description: definition.description,
                input: definition.input,
                topology: TopologyDto {
                    nodes: definition.nodes,
                    edges: definition.edges,
                },
                schedules: workflow_schedules()
                    .iter()
                    .filter(|schedule| schedule.workflow_id == definition.workflow_id)
                    .copied()
                    .collect(),
            })
            .collect(),
        runs: runs.into_iter().map(RunDto::from).collect(),
    }
}

impl From<RunSnapshot> for RunDto {
    fn from(snapshot: RunSnapshot) -> Self {
        let now = SystemTime::now();
        let elapsed = snapshot
            .duration
            .or_else(|| now.duration_since(snapshot.started_at).ok())
            .unwrap_or(Duration::ZERO);
        let (status, error) = match snapshot.status {
            RunStatus::Running => ("Running", None),
            RunStatus::Completed => ("Completed", None),
            RunStatus::Failed { message } => ("Failed", Some(message)),
            _ => ("Failed", Some("Unsupported run status".to_owned())),
        };
        let input = RunInputDto {
            label: snapshot.input.label().to_owned(),
            step_delay_ms: snapshot.input.step_delay_ms(),
        };
        let (trigger, schedule_id) = match snapshot.trigger {
            RunTrigger::Manual => ("Manual", None),
            RunTrigger::Cron { schedule_id } => ("Cron", Some(schedule_id)),
            _ => ("Unknown", None),
        };
        Self {
            run_id: snapshot.run_id.to_string(),
            workflow_id: snapshot.workflow_id,
            input,
            trigger,
            schedule_id,
            status,
            error,
            current_node: snapshot.current_node,
            current_edge: snapshot.current_edge,
            traversed_nodes: snapshot.traversed_nodes,
            traversed_edges: snapshot.traversed_edges,
            route_summary: snapshot.route_summary,
            started_at_ms: epoch_millis(snapshot.started_at),
            finished_at_ms: snapshot.finished_at.map(epoch_millis),
            elapsed_ms: elapsed.as_millis(),
            steps: snapshot.steps.into_iter().map(StepTraceDto::from).collect(),
        }
    }
}

impl From<StepTrace> for StepTraceDto {
    fn from(step: StepTrace) -> Self {
        let elapsed = step
            .duration
            .or_else(|| SystemTime::now().duration_since(step.started_at).ok())
            .unwrap_or(Duration::ZERO);
        let (status, error) = match step.status {
            StepTraceStatus::Running => ("Running", None),
            StepTraceStatus::Completed => ("Completed", None),
            StepTraceStatus::Failed { message } => ("Failed", Some(message)),
            _ => ("Failed", Some("Unsupported step trace status".to_owned())),
        };
        Self {
            sequence: step.sequence,
            node_id: step.node_id,
            selected_edge: step.selected_edge,
            status,
            error,
            state: StepStateDto {
                run_label: step.state.run_label,
                step_delay_ms: step.state.step_delay_ms,
                task_token: step.state.task_token,
                branch_selected: step.state.branch_selected,
                branch_token: step.state.branch_token,
            },
            output: step.output,
            started_at_ms: epoch_millis(step.started_at),
            finished_at_ms: step.finished_at.map(epoch_millis),
            elapsed_ms: elapsed.as_millis(),
        }
    }
}

fn epoch_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}
