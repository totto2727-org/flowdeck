use std::time::{Duration, SystemTime};

use uuid::Uuid;

use super::{WorkflowEvent, WorkflowService};
use crate::{
    RunId, RunSnapshot, RunStatus, WorkflowError,
    workflow_scheduler::{UnstartedScheduleRun, UnstartedScheduleStatus},
};

impl WorkflowService {
    pub(crate) async fn retain_unstarted_schedule(
        &self,
        run: UnstartedScheduleRun,
    ) -> Result<RunSnapshot, WorkflowError> {
        let runtime = self
            .inner
            .runtimes
            .get(run.workflow_id.as_str())
            .ok_or_else(|| WorkflowError::UnknownWorkflow {
                workflow_id: run.workflow_id.clone(),
            })?;
        let input = runtime.input.parse(run.raw_input)?;
        let now = SystemTime::now();
        let run_id = RunId(Uuid::new_v4().to_string());
        let (status, route_summary, event) = match run.status {
            UnstartedScheduleStatus::Skipped { reason } => (
                RunStatus::Skipped {
                    reason: reason.clone(),
                },
                format!("Skipped: {reason}"),
                WorkflowEvent::RunSkipped {
                    run_id: run_id.clone(),
                    workflow_id: run.workflow_id.clone(),
                    reason,
                },
            ),
            UnstartedScheduleStatus::Failed { message } => (
                RunStatus::Failed {
                    message: message.clone(),
                },
                format!("Failed: {message}"),
                WorkflowEvent::RunFailed {
                    run_id: run_id.clone(),
                    workflow_id: run.workflow_id.clone(),
                    message,
                },
            ),
        };
        let snapshot = RunSnapshot {
            run_id,
            workflow_id: run.workflow_id,
            input,
            trigger: run.trigger,
            status,
            current_node: None,
            current_edge: None,
            traversed_nodes: Vec::new(),
            traversed_edges: Vec::new(),
            route_summary,
            started_at: now,
            finished_at: Some(now),
            duration: Some(Duration::ZERO),
            steps: Vec::new(),
        };
        self.inner
            .state
            .run_history
            .insert_terminal(snapshot.clone())
            .await;
        let _ = self.inner.events.send(event);
        Ok(snapshot)
    }
}
