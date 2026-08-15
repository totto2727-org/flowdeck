#![allow(
    clippy::redundant_pub_crate,
    reason = "The private sibling imports graph definitions through the crate root."
)]

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use graph_flow::{Context, GraphBuilder, NextAction, Task, TaskResult};
use uuid::Uuid;

use crate::WorkflowError;

pub(super) const WORKFLOW_ID: &str = "demo-workflow";
const BRANCH_KEY: &str = "branch_yes";
const STEP_DELAY: Duration = Duration::from_millis(350);

/// A code-defined graph node retained independently from graph-flow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct NodeSpec {
    /// Stable task ID.
    pub id: &'static str,
    /// Short UI-facing label.
    pub label: &'static str,
}

/// A code-defined graph edge retained independently from graph-flow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct EdgeSpec {
    /// Stable edge ID.
    pub id: &'static str,
    /// Source task ID.
    pub from: &'static str,
    /// Target task ID.
    pub to: &'static str,
}

pub(super) const NODES: [NodeSpec; 6] = [
    NodeSpec {
        id: "prepare",
        label: "Prepare",
    },
    NodeSpec {
        id: "choose_route",
        label: "Choose route",
    },
    NodeSpec {
        id: "yes_path",
        label: "Yes path",
    },
    NodeSpec {
        id: "fallback_path",
        label: "Fallback path",
    },
    NodeSpec {
        id: "converge",
        label: "Converge",
    },
    NodeSpec {
        id: "complete",
        label: "Complete",
    },
];

pub(super) const EDGES: [EdgeSpec; 6] = [
    EdgeSpec {
        id: "prepare-to-choose",
        from: "prepare",
        to: "choose_route",
    },
    EdgeSpec {
        id: "choose-to-yes",
        from: "choose_route",
        to: "yes_path",
    },
    EdgeSpec {
        id: "choose-to-fallback",
        from: "choose_route",
        to: "fallback_path",
    },
    EdgeSpec {
        id: "yes-to-converge",
        from: "yes_path",
        to: "converge",
    },
    EdgeSpec {
        id: "fallback-to-converge",
        from: "fallback_path",
        to: "converge",
    },
    EdgeSpec {
        id: "converge-to-complete",
        from: "converge",
        to: "complete",
    },
];

/// Return the immutable topology unavailable from graph-flow at runtime.
pub const fn workflow_topology() -> (&'static [NodeSpec], &'static [EdgeSpec]) {
    (&NODES, &EDGES)
}

pub(super) fn build_graph() -> Result<graph_flow::Graph, WorkflowError> {
    let prepare = Arc::new(SleepTask::new(TaskKind::Prepare));
    let choose = Arc::new(SleepTask::new(TaskKind::Choose));
    let yes = Arc::new(SleepTask::new(TaskKind::Yes));
    let fallback = Arc::new(SleepTask::new(TaskKind::Fallback));
    let converge = Arc::new(SleepTask::new(TaskKind::Converge));
    let complete = Arc::new(SleepTask::new(TaskKind::Complete));
    GraphBuilder::new(WORKFLOW_ID)
        .add_task(prepare)
        .add_task(choose)
        .add_task(yes)
        .add_task(fallback)
        .add_task(converge)
        .add_task(complete)
        .add_edge("prepare", "choose_route")
        .add_conditional_edge(
            "choose_route",
            |context| {
                context
                    .get::<bool>(BRANCH_KEY)
                    .is_some_and(|selected| selected)
            },
            "yes_path",
            "fallback_path",
        )
        .add_edge("yes_path", "converge")
        .add_edge("fallback_path", "converge")
        .add_edge("converge", "complete")
        .build()
        .map_err(|error| WorkflowError::GraphBuild {
            message: error.to_string(),
        })
}

#[derive(Clone, Copy)]
enum TaskKind {
    Prepare,
    Choose,
    Yes,
    Fallback,
    Converge,
    Complete,
}

impl TaskKind {
    const fn id(self) -> &'static str {
        match self {
            Self::Prepare => "prepare",
            Self::Choose => "choose_route",
            Self::Yes => "yes_path",
            Self::Fallback => "fallback_path",
            Self::Converge => "converge",
            Self::Complete => "complete",
        }
    }
}

struct SleepTask {
    kind: TaskKind,
}

impl SleepTask {
    const fn new(kind: TaskKind) -> Self {
        Self { kind }
    }
}

#[async_trait]
impl Task for SleepTask {
    fn id(&self) -> &str {
        self.kind.id()
    }

    async fn run(&self, context: Context) -> graph_flow::Result<TaskResult> {
        tokio::time::sleep(STEP_DELAY).await;
        let token = Uuid::new_v4();
        context.set(format!("task_token:{}", self.kind.id()), token.to_string())?;
        if matches!(self.kind, TaskKind::Choose) {
            context.set(BRANCH_KEY, token.as_u128().is_multiple_of(2))?;
            context.set("branch_token", token.to_string())?;
        }
        let action = match self.kind {
            TaskKind::Complete => NextAction::End,
            TaskKind::Prepare
            | TaskKind::Choose
            | TaskKind::Yes
            | TaskKind::Fallback
            | TaskKind::Converge => NextAction::Continue,
        };
        Ok(TaskResult::new(
            Some(format!("{} complete: {token}", self.kind.id())),
            action,
        ))
    }
}
