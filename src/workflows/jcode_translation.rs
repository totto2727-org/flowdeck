mod definition;
mod glossshift;
mod hooks;

use graph_flow_jcode::{JcodeNodeError, JcodeProcessScope, jcode_sdk::JcodeClient};
use std::sync::Arc;

use crate::{WorkflowError, workflows::WorkflowRegistration};

pub(super) use definition::{DEFINITION, WORKFLOW_ID, default_input, input_form};

pub(crate) fn registration() -> Result<WorkflowRegistration, WorkflowError> {
    let process_scope = Arc::new(JcodeProcessScope::deferred(|| {
        let options = hooks::launch_options()?;
        JcodeClient::launch(options).map_err(JcodeNodeError::from)
    }));
    Ok(WorkflowRegistration::new(
        &DEFINITION,
        definition::build_graph(process_scope)?,
        definition::parse_input,
        super::registration::no_scheduled_input,
        definition::project_trace,
    ))
}
