mod definition;
mod glossshift;
mod hooks;

use graph_flow_jcode::JcodeRuntime;
use std::sync::Arc;

use crate::WorkflowError;

pub(super) use definition::{
    DEFINITION, WORKFLOW_ID, build_graph, default_input, input_form, parse_input,
};

pub(crate) fn launch_runtime() -> Result<Arc<JcodeRuntime>, WorkflowError> {
    let options = hooks::launch_options().map_err(jcode_error)?;
    JcodeRuntime::launch(options)
        .map(Arc::new)
        .map_err(jcode_error)
}

fn jcode_error(error: impl std::fmt::Display) -> WorkflowError {
    WorkflowError::Jcode {
        message: error.to_string(),
    }
}
