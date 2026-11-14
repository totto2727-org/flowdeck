use garde::Validate;
use graph_flow::{Context, GraphBuilder};
use graph_flow_jcode::{JCODE_OUTPUT_KEY, JcodeNode, JcodeOutput, JcodeProcessScope, SessionMode};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};
use topcoat::{
    Result,
    view::{component, view},
};
use workflow_resources::ResourceKey;

use super::hooks::{TranslationHooks, prompt, session_options};
use crate::{
    RunInput, WorkflowError,
    workflows::{
        EdgeSpec, NodeSpec, WORKFLOW_INPUT_KEY, WORKFLOW_RUN_ID_KEY, WorkflowDefinition,
        graph_build_error,
    },
};

pub(crate) const WORKFLOW_ID: &str = "jcode-translation";

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct TranslationInput {
    #[garde(custom(validate_relative_file), length(chars, max = 160))]
    source_path: String,
    #[garde(custom(validate_relative_file), length(chars, max = 160))]
    target_path: String,
    #[garde(custom(validate_non_blank), length(chars, max = 40))]
    target_language: String,
}

const NODES: [NodeSpec; 1] = [NodeSpec {
    id: "translate_files",
    label: "jcode translate",
}];
const EDGES: [EdgeSpec; 0] = [];

pub(crate) const DEFINITION: WorkflowDefinition = WorkflowDefinition {
    workflow_id: WORKFLOW_ID,
    name: "jcode translation",
    description: "Runs a complete coding-agent turn and validates its translated file.",
    start_node: "translate_files",
    nodes: &NODES,
    edges: &EDGES,
    limits: None,
};

#[component]
pub(crate) async fn input_form(active: bool) -> Result {
    let _ = active;
    view! {
        <form class="mt-4 grid gap-3 border-t border-border pt-4" data-show=(format!("$selectedWorkflowId === '{WORKFLOW_ID}'")) data-workflow-id=(WORKFLOW_ID) data-on:submit="@post('/actions/runs')" data-indicator="_requesting" aria-labelledby="jcode-translation-form-title">
            <div>
                <p class="text-xs font-semibold uppercase tracking-label text-text-muted">"Run selected"</p>
                <h3 class="text-xl font-semibold" id="jcode-translation-form-title">"jcode translation"</h3>
            </div>
            <label class="grid gap-1 text-sm font-semibold text-text-secondary" for="jcode-source-path">
                <span>"Source file"</span>
                <input class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset" id="jcode-source-path" name="source_path" type="text" data-bind="input.source_path" required="required" maxlength="160">
            </label>
            <label class="grid gap-1 text-sm font-semibold text-text-secondary" for="jcode-target-path">
                <span>"Target file"</span>
                <input class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset" id="jcode-target-path" name="target_path" type="text" data-bind="input.target_path" required="required" maxlength="160">
            </label>
            <label class="grid gap-1 text-sm font-semibold text-text-secondary" for="jcode-target-language">
                <span>"Target language"</span>
                <input class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset" id="jcode-target-language" name="target_language" type="text" data-bind="input.target_language" required="required" maxlength="40">
            </label>
            <button class="min-h-[var(--control-min)] rounded-control border border-accent-hover bg-accent px-4 font-semibold text-text-primary shadow-inset transition-[filter,transform] duration-[var(--motion-micro)] ease-[var(--ease-standard)] hover:brightness-110 active:translate-y-[var(--border-width)] disabled:cursor-wait disabled:opacity-65" type="submit" data-attr:disabled="$_requesting">"Run jcode workflow"</button>
        </form>
    }
}

pub(crate) fn default_input() -> Value {
    json!({
        "source_path": "README.md",
        "target_path": "target/jcode-translation/README.ja.md",
        "target_language": "Japanese"
    })
}

pub(crate) fn parse_input(value: Value) -> Result<RunInput, WorkflowError> {
    let input = serde_json::from_value::<TranslationInput>(value).map_err(invalid_input)?;
    input.validate().map_err(invalid_input)?;
    let source_path = input.source_path.trim().to_owned();
    let target_path = input.target_path.trim().to_owned();
    let target_language = input.target_language.trim().to_owned();
    let summary = format!("{source_path} -> {target_path} · {target_language}");
    Ok(RunInput::new(
        json!({
            "source_path": source_path,
            "target_path": target_path,
            "target_language": target_language
        }),
        summary,
    ))
}

pub(crate) fn build_graph() -> Result<graph_flow::Graph, WorkflowError> {
    let node = Arc::new(
        JcodeNode::new(
            "translate_files",
            ResourceKey::application("jcode-process"),
            || {
                let options = super::hooks::launch_options()?;
                JcodeProcessScope::launch(options)
            },
            prompt,
        )
        .with_session_mode(shared_session)
        .with_session_options(session_options)
        .with_hooks(TranslationHooks)
        .with_next_action(graph_flow::NextAction::End),
    );
    GraphBuilder::new(WORKFLOW_ID)
        .add_task(node)
        .build()
        .map_err(|error| graph_build_error(&error))
}

fn shared_session(context: &Context) -> Result<SessionMode, graph_flow_jcode::JcodeNodeError> {
    let key = context.get::<String>(WORKFLOW_RUN_ID_KEY).ok_or_else(|| {
        graph_flow_jcode::JcodeNodeError::configuration("run session key is missing")
    })?;
    SessionMode::reuse(key)
}

pub(crate) fn project_trace(context: &Context, _node_id: &str) -> Result<Value, WorkflowError> {
    let input = context
        .get::<Value>(WORKFLOW_INPUT_KEY)
        .ok_or_else(|| trace_error("translation workflow input is missing"))?;
    Ok(json!({
        "input": input,
        "jcode_output": context.get::<JcodeOutput>(JCODE_OUTPUT_KEY),
        "translation_output_path": context.get::<String>("translation_output_path"),
    }))
}

fn trace_error(message: &str) -> WorkflowError {
    WorkflowError::Trace {
        message: message.to_owned(),
    }
}

fn invalid_input(error: impl std::fmt::Display) -> WorkflowError {
    WorkflowError::InvalidInput {
        message: format!("{WORKFLOW_ID}: {error}"),
    }
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators receive their context by reference."
)]
fn validate_relative_file(value: &str, _: &()) -> garde::Result {
    let path = Path::new(value.trim());
    if value.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(garde::Error::new("must be a safe relative file path"));
    }
    Ok(())
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators receive their context by reference."
)]
fn validate_non_blank(value: &str, _: &()) -> garde::Result {
    if value.trim().is_empty() {
        return Err(garde::Error::new("must not be blank"));
    }
    Ok(())
}
