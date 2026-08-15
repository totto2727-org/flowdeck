use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use topcoat::{
    Result,
    context::{Cx, app_context},
    router::{StatusCode, content::Json, route},
};
use workflow_console_experiment::{
    EdgeSpec, NodeSpec, RunSnapshot, RunStatus, WorkflowService, workflow_id, workflow_topology,
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
    topology: TopologyDto,
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
}

#[derive(Debug, Deserialize)]
struct StartRequest {
    workflow_id: String,
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
    match service.start(&request.workflow_id).await {
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
    let (nodes, edges) = workflow_topology();
    let mut runs = service.list_runs().await;
    runs.reverse();
    StateResponse {
        workflows: vec![WorkflowDto {
            workflow_id: workflow_id(),
            name: "Branch and converge",
            topology: TopologyDto { nodes, edges },
        }],
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
        Self {
            run_id: snapshot.run_id.to_string(),
            workflow_id: snapshot.workflow_id,
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
        }
    }
}

fn epoch_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}
