use std::time::{Duration, SystemTime};

use garde::Validate;
use toasty::{Executor, sql};

use super::{
    error,
    models::RunStatusRow,
    run_rows::{RunRow, RunTriggerRow, StepRow, StepStatusRow},
};
use crate::{
    HistoryView, RunId, RunSnapshot, RunStatus, RunTrigger, StepId, StepState, StepTrace,
    StepTraceStatus, WorkflowError,
};

pub(super) async fn insert(
    executor: &mut dyn Executor,
    snapshot: &RunSnapshot,
) -> Result<(), WorkflowError> {
    let row = RunRow::from_snapshot(snapshot)?;
    create_run(executor, row).await?;
    replace_steps(executor, snapshot).await
}

pub(super) async fn update(
    executor: &mut dyn Executor,
    snapshot: &RunSnapshot,
) -> Result<(), WorkflowError> {
    let row = RunRow::from_snapshot(snapshot)?;
    sql::statement(
        "UPDATE runs SET workflow_id = ?1, input = ?2, input_summary = ?3, trigger = ?4, \
         schedule_id = ?5, status = ?6, status_message = ?7, current_node = ?8, route_summary = ?9, \
         started_at = ?10, started_at_submillis = ?11, finished_at = ?12, \
         finished_at_submillis = ?13 WHERE id = ?14",
    )
    .bind(row.workflow_id)
    .bind(row.input)
    .bind(row.input_summary)
    .bind(row.trigger.as_str())
    .bind_typed(row.schedule_id, toasty::schema::db::Type::Text)
    .bind(row.status.as_str())
    .bind_typed(row.status_message, toasty::schema::db::Type::Text)
    .bind_typed(row.current_node, toasty::schema::db::Type::Text)
    .bind(row.route_summary)
    .bind(row.started_at)
    .bind(row.started_at_submillis)
    .bind_typed(row.finished_at, toasty::schema::db::Type::Integer(8))
    .bind_typed(
        row.finished_at_submillis,
        toasty::schema::db::Type::Integer(8),
    )
    .bind(row.id)
    .exec(executor)
    .await
    .map_err(error)?;
    replace_steps(executor, snapshot).await
}

pub(super) async fn get(
    executor: &mut dyn Executor,
    id: &RunId,
) -> Result<Option<RunSnapshot>, WorkflowError> {
    let Some(row) = RunRow::filter_by_id(id.as_str())
        .first()
        .exec(executor)
        .await
        .map_err(error)?
    else {
        return Ok(None);
    };
    let steps = StepRow::filter_by_run_id(id.as_str())
        .exec(executor)
        .await
        .map_err(error)?;
    row.into_snapshot(steps).map(Some)
}

pub(super) async fn history(executor: &mut dyn Executor) -> Result<HistoryView, WorkflowError> {
    let mut rows = RunRow::all().exec(executor).await.map_err(error)?;
    let steps = StepRow::all().exec(executor).await.map_err(error)?;
    rows.sort_by(|left, right| (left.started_at, &left.id).cmp(&(right.started_at, &right.id)));

    let mut steps_by_run = std::collections::HashMap::<String, Vec<StepRow>>::new();
    for step in steps {
        steps_by_run
            .entry(step.run_id.clone())
            .or_default()
            .push(step);
    }
    let runs = rows
        .into_iter()
        .map(|row| {
            let steps = steps_by_run.remove(&row.id).unwrap_or_default();
            row.into_snapshot(steps)
        })
        .collect::<Result<_, _>>()?;
    if !steps_by_run.is_empty() {
        return Err(error("persisted step references a missing run"));
    }
    Ok(HistoryView { runs })
}

impl RunRow {
    fn from_snapshot(snapshot: &RunSnapshot) -> Result<Self, WorkflowError> {
        RunSnapshot::restore(snapshot.clone())?;
        let (trigger, schedule_id) = match &snapshot.trigger {
            RunTrigger::Manual => (RunTriggerRow::Manual, None),
            RunTrigger::Cron { schedule_id } => (RunTriggerRow::Cron, Some(schedule_id.clone())),
        };
        let (status, status_message) = status_fields(&snapshot.status);
        let (started_at, started_at_submillis) = timestamp_to_columns(snapshot.started_at)?;
        let (finished_at, finished_at_submillis) = snapshot
            .finished_at
            .map(timestamp_to_columns)
            .transpose()?
            .map_or((None, None), |(millis, submillis)| {
                (Some(millis), Some(submillis))
            });
        let row = Self {
            id: snapshot.run_id.to_string(),
            workflow_id: snapshot.workflow_id.clone(),
            input: serde_json::to_string(snapshot.input.state()).map_err(error)?,
            input_summary: snapshot.input.summary().to_owned(),
            trigger,
            schedule_id,
            status,
            status_message,
            current_node: snapshot.current_node.clone(),
            route_summary: snapshot.route_summary.clone(),
            started_at,
            started_at_submillis,
            finished_at,
            finished_at_submillis,
        };
        row.validate().map_err(error)?;
        Ok(row)
    }

    pub(super) fn into_snapshot(
        mut self,
        mut rows: Vec<StepRow>,
    ) -> Result<RunSnapshot, WorkflowError> {
        self.validate().map_err(error)?;
        rows.sort_by(|left, right| {
            (left.sequence, left.step_id).cmp(&(right.sequence, right.step_id))
        });
        let steps = rows
            .into_iter()
            .map(StepRow::into_trace)
            .collect::<Result<Vec<_>, _>>()?;
        let traversed_nodes = steps
            .iter()
            .filter(|step| step.status == StepTraceStatus::Completed)
            .map(|step| step.node_id.clone())
            .collect();
        let traversed_edges: Vec<_> = steps
            .iter()
            .filter_map(|step| step.selected_edge.clone())
            .collect();
        let current_edge = traversed_edges.last().cloned();
        let started_at = columns_to_timestamp(self.started_at, self.started_at_submillis)?;
        let finished_at =
            timestamp_from_optional_columns(self.finished_at, self.finished_at_submillis)?;
        let duration = finished_at
            .map(|finished| finished.duration_since(started_at).map_err(error))
            .transpose()?;
        let input = serde_json::from_str(&self.input).map_err(error)?;
        let input =
            crate::workflows::restore_run_input(&self.workflow_id, input, self.input_summary)
                .map_err(error)?;
        let trigger = match self.trigger {
            RunTriggerRow::Manual => RunTrigger::Manual,
            RunTriggerRow::Cron => RunTrigger::Cron {
                schedule_id: self
                    .schedule_id
                    .take()
                    .ok_or_else(|| error("persisted cron run is missing schedule ID"))?,
            },
        };
        RunSnapshot::restore(RunSnapshot {
            run_id: RunId(self.id),
            workflow_id: self.workflow_id,
            input,
            trigger,
            status: status_from_row(self.status, self.status_message),
            current_node: self.current_node,
            current_edge,
            traversed_nodes,
            traversed_edges,
            route_summary: self.route_summary,
            started_at,
            finished_at,
            duration,
            steps,
        })
    }
}

impl StepRow {
    fn from_trace(run_id: &str, trace: &StepTrace) -> Result<Self, WorkflowError> {
        let (status, status_message) = step_status_fields(&trace.status);
        let (started_at, started_at_submillis) = timestamp_to_columns(trace.started_at)?;
        let (finished_at, finished_at_submillis) = trace
            .finished_at
            .map(timestamp_to_columns)
            .transpose()?
            .map_or((None, None), |(millis, submillis)| {
                (Some(millis), Some(submillis))
            });
        let row = Self {
            run_id: run_id.to_owned(),
            step_id: i64::try_from(trace.step_id.value()).map_err(error)?,
            sequence: i64::try_from(trace.sequence).map_err(error)?,
            node_id: trace.node_id.clone(),
            node_execution: i64::try_from(trace.node_execution).map_err(error)?,
            selected_edge: trace.selected_edge.clone(),
            status,
            status_message,
            output: trace.output.clone(),
            started_at,
            started_at_submillis,
            finished_at,
            finished_at_submillis,
            state: serde_json::to_string(&trace.state.payload).map_err(error)?,
        };
        row.validate().map_err(error)?;
        Ok(row)
    }

    fn into_trace(self) -> Result<StepTrace, WorkflowError> {
        self.validate().map_err(error)?;
        let started_at = columns_to_timestamp(self.started_at, self.started_at_submillis)?;
        let finished_at =
            timestamp_from_optional_columns(self.finished_at, self.finished_at_submillis)?;
        let duration = finished_at
            .map(|finished| finished.duration_since(started_at).map_err(error))
            .transpose()?;
        Ok(StepTrace {
            step_id: StepId::from_persisted(usize::try_from(self.step_id).map_err(error)?)?,
            sequence: usize::try_from(self.sequence).map_err(error)?,
            node_id: self.node_id,
            node_execution: usize::try_from(self.node_execution).map_err(error)?,
            selected_edge: self.selected_edge,
            status: step_status_from_row(self.status, self.status_message),
            state: StepState {
                payload: serde_json::from_str(&self.state).map_err(error)?,
            },
            output: self.output,
            started_at,
            finished_at,
            duration,
        })
    }
}

impl RunTriggerRow {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Cron => "cron",
        }
    }
}

fn status_fields(status: &RunStatus) -> (RunStatusRow, Option<String>) {
    match status {
        RunStatus::Running => (RunStatusRow::Running, None),
        RunStatus::Completed => (RunStatusRow::Completed, None),
        RunStatus::Failed { message } => (RunStatusRow::Failed, Some(message.clone())),
        RunStatus::Skipped { reason } => (RunStatusRow::Skipped, Some(reason.clone())),
    }
}

fn status_from_row(status: RunStatusRow, message: Option<String>) -> RunStatus {
    match status {
        RunStatusRow::Running => RunStatus::Running,
        RunStatusRow::Completed => RunStatus::Completed,
        RunStatusRow::Failed => RunStatus::Failed {
            message: message.unwrap_or_default(),
        },
        RunStatusRow::Skipped => RunStatus::Skipped {
            reason: message.unwrap_or_default(),
        },
    }
}

fn step_status_fields(status: &StepTraceStatus) -> (StepStatusRow, Option<String>) {
    match status {
        StepTraceStatus::Running => (StepStatusRow::Running, None),
        StepTraceStatus::Completed => (StepStatusRow::Completed, None),
        StepTraceStatus::Failed { message } => (StepStatusRow::Failed, Some(message.clone())),
    }
}

fn step_status_from_row(status: StepStatusRow, message: Option<String>) -> StepTraceStatus {
    match status {
        StepStatusRow::Running => StepTraceStatus::Running,
        StepStatusRow::Completed => StepTraceStatus::Completed,
        StepStatusRow::Failed => StepTraceStatus::Failed {
            message: message.unwrap_or_default(),
        },
    }
}

async fn create_run(executor: &mut dyn Executor, row: RunRow) -> Result<(), WorkflowError> {
    RunRow::create()
        .id(row.id)
        .workflow_id(row.workflow_id)
        .input(row.input)
        .input_summary(row.input_summary)
        .trigger(row.trigger)
        .schedule_id(row.schedule_id)
        .status(row.status)
        .status_message(row.status_message)
        .current_node(row.current_node)
        .route_summary(row.route_summary)
        .started_at(row.started_at)
        .started_at_submillis(row.started_at_submillis)
        .finished_at(row.finished_at)
        .finished_at_submillis(row.finished_at_submillis)
        .exec(executor)
        .await
        .map_err(error)?;
    Ok(())
}

async fn replace_steps(
    executor: &mut dyn Executor,
    snapshot: &RunSnapshot,
) -> Result<(), WorkflowError> {
    sql::statement("DELETE FROM run_steps WHERE run_id = ?1")
        .bind(snapshot.run_id.as_str())
        .exec(executor)
        .await
        .map_err(error)?;
    for trace in &snapshot.steps {
        let row = StepRow::from_trace(snapshot.run_id.as_str(), trace)?;
        StepRow::create()
            .run_id(row.run_id)
            .step_id(row.step_id)
            .sequence(row.sequence)
            .node_id(row.node_id)
            .node_execution(row.node_execution)
            .selected_edge(row.selected_edge)
            .status(row.status)
            .status_message(row.status_message)
            .output(row.output)
            .started_at(row.started_at)
            .started_at_submillis(row.started_at_submillis)
            .finished_at(row.finished_at)
            .finished_at_submillis(row.finished_at_submillis)
            .state(row.state)
            .exec(executor)
            .await
            .map_err(error)?;
    }
    Ok(())
}

fn timestamp_to_columns(time: SystemTime) -> Result<(i64, i64), WorkflowError> {
    let elapsed = time.duration_since(SystemTime::UNIX_EPOCH).map_err(error)?;
    let millis = i64::try_from(elapsed.as_millis()).map_err(error)?;
    let submillis = i64::from(elapsed.subsec_nanos() % 1_000_000);
    Ok((millis, submillis))
}

fn timestamp_from_optional_columns(
    millis: Option<i64>,
    submillis: Option<i64>,
) -> Result<Option<SystemTime>, WorkflowError> {
    match (millis, submillis) {
        (None, None) => Ok(None),
        (Some(millis), Some(submillis)) => columns_to_timestamp(millis, submillis).map(Some),
        _ => Err(error("persisted timestamp columns disagree")),
    }
}

fn columns_to_timestamp(millis: i64, submillis: i64) -> Result<SystemTime, WorkflowError> {
    let millis = u64::try_from(millis).map_err(error)?;
    let submillis = u32::try_from(submillis).map_err(error)?;
    let nanos = submillis
        .checked_add(0)
        .filter(|nanos| *nanos < 1_000_000)
        .ok_or_else(|| error("invalid persisted sub-millisecond timestamp"))?;
    SystemTime::UNIX_EPOCH
        .checked_add(Duration::from_millis(millis))
        .and_then(|time| time.checked_add(Duration::from_nanos(u64::from(nanos))))
        .ok_or_else(|| error("persisted timestamp is out of range"))
}

#[cfg(test)]
#[path = "run_rows_test.rs"]
mod tests;
