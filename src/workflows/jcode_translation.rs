mod definition;
mod glossshift;
mod hooks;

use crate::{WorkflowError, workflows::WorkflowRegistration};

pub(super) use definition::{DEFINITION, WORKFLOW_ID, default_input, input_form, parse_input};

pub(crate) fn registration() -> Result<WorkflowRegistration, WorkflowError> {
    Ok(WorkflowRegistration::new(
        &DEFINITION,
        definition::build_graph()?,
        definition::parse_input,
        super::registration::no_scheduled_input,
        definition::project_trace,
    ))
}
