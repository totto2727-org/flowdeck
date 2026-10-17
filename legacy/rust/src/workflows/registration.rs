use std::sync::Arc;

use graph_flow::{Context, Graph};
use serde_json::Value;

use crate::{RunInput, WorkflowDefinition, WorkflowError};

type InputParser = fn(Value) -> Result<RunInput, WorkflowError>;
type ScheduledInput = fn(&str) -> Result<Value, WorkflowError>;
type StateProjector = fn(&Context, &str) -> Result<Value, WorkflowError>;

pub(crate) trait WorkflowInputContract: Send + Sync {
    fn parse(&self, input: Value) -> Result<RunInput, WorkflowError>;
    fn scheduled(&self, schedule_id: &str) -> Result<Value, WorkflowError>;
}

pub(crate) trait TraceProjector: Send + Sync {
    fn project(&self, context: &Context, node_id: &str) -> Result<Value, WorkflowError>;
}

pub(crate) struct WorkflowRegistration {
    pub(crate) definition: &'static WorkflowDefinition,
    pub(crate) graph: Arc<Graph>,
    pub(crate) input: Arc<dyn WorkflowInputContract>,
    pub(crate) trace_projector: Arc<dyn TraceProjector>,
}

impl WorkflowRegistration {
    pub(crate) fn new(
        definition: &'static WorkflowDefinition,
        graph: Graph,
        parse: InputParser,
        scheduled: ScheduledInput,
        project: StateProjector,
    ) -> Self {
        Self {
            definition,
            graph: Arc::new(graph),
            input: Arc::new(FunctionInputContract { parse, scheduled }),
            trace_projector: Arc::new(FunctionTraceProjector { project }),
        }
    }
}

struct FunctionInputContract {
    parse: InputParser,
    scheduled: ScheduledInput,
}

impl WorkflowInputContract for FunctionInputContract {
    fn parse(&self, input: Value) -> Result<RunInput, WorkflowError> {
        (self.parse)(input)
    }

    fn scheduled(&self, schedule_id: &str) -> Result<Value, WorkflowError> {
        (self.scheduled)(schedule_id)
    }
}

struct FunctionTraceProjector {
    project: StateProjector,
}

impl TraceProjector for FunctionTraceProjector {
    fn project(&self, context: &Context, node_id: &str) -> Result<Value, WorkflowError> {
        (self.project)(context, node_id)
    }
}

pub(crate) fn no_scheduled_input(schedule_id: &str) -> Result<Value, WorkflowError> {
    Err(WorkflowError::UnknownSchedule {
        schedule_id: schedule_id.to_owned(),
    })
}
