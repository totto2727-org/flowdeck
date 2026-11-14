use graph_flow::Context;
use graph_flow_jcode::{AfterRun, BeforeRun, JcodeHooks, JcodeNodeError, jcode_sdk::LaunchOptions};
use serde::Deserialize;
use serde_json::Value;
use std::{fs, path::PathBuf, time::Duration};

use super::glossshift;
use crate::workflows::WORKFLOW_INPUT_KEY;

const MAX_FILE_BYTES: u64 = 1_048_576;

#[derive(Deserialize)]
pub(super) struct TranslationTaskInput {
    pub(super) source_path: String,
    pub(super) target_path: String,
    pub(super) target_language: String,
}

#[derive(Debug)]
pub(super) struct TranslationHooks;

impl JcodeHooks for TranslationHooks {
    fn before_run(&self, stage: BeforeRun<'_>) -> Result<(), JcodeNodeError> {
        let input = task_input(stage.context)?;
        let target = workspace().join(&input.target_path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| JcodeNodeError::hook("before_run", error.to_string()))?;
        }
        let source = stage.client.read_file(
            &stage.session.session_id,
            &input.source_path,
            Some(MAX_FILE_BYTES),
        )?;
        if source.truncated || source.content.trim().is_empty() {
            return Err(JcodeNodeError::hook(
                "before_run",
                "translation source is empty or exceeds the node file limit",
            ));
        }
        Ok(())
    }

    fn after_run(&self, stage: AfterRun<'_>) -> Result<(), JcodeNodeError> {
        let input = task_input(stage.context)?;
        let status = stage
            .client
            .file_status(&stage.session.session_id, &input.target_path)?;
        if !status.exists || status.kind != "file" {
            return Err(JcodeNodeError::hook(
                "after_run",
                "jcode did not create the requested translation file",
            ));
        }
        let output = stage.client.read_file(
            &stage.session.session_id,
            &input.target_path,
            Some(MAX_FILE_BYTES),
        )?;
        if output.truncated || output.content.trim().is_empty() {
            return Err(JcodeNodeError::hook(
                "after_run",
                "the generated translation is empty or exceeds the node file limit",
            ));
        }
        stage
            .context
            .set("translation_output_path", input.target_path.clone())
            .map_err(|error| JcodeNodeError::context(&error))?;
        if stage.result.text.trim().is_empty() {
            stage.result.text = format!("Translation written to {}", input.target_path);
        }
        Ok(())
    }
}

pub(super) fn launch_options() -> Result<LaunchOptions, JcodeNodeError> {
    let workspace = workspace();
    let mut options = LaunchOptions {
        working_dir: Some(workspace),
        inherit_logins: false,
        binary: Some(jcode_binary()),
        startup_timeout: Duration::from_mins(1),
        request_timeout: Some(Duration::from_mins(1)),
        ..LaunchOptions::default()
    };
    glossshift::apply_launch_environment(&mut options)?;
    Ok(options)
}

pub(super) fn session_options(
    context: &Context,
) -> Result<graph_flow_jcode::SessionOptions, JcodeNodeError> {
    let _ = task_input(context)?;
    glossshift::session_options(&workspace())
}

pub(super) fn prompt(context: &Context) -> Result<String, JcodeNodeError> {
    let input = task_input(context)?;
    Ok(format!(
        "Translate {source} into {language} and write the complete translation to {target}. Use jcode's file tools to read and write files. Preserve Markdown structure, do not modify any other file, and finish only after checking the output file.",
        source = input.source_path,
        language = input.target_language,
        target = input.target_path,
    ))
}

fn task_input(context: &Context) -> Result<TranslationTaskInput, JcodeNodeError> {
    let input = context
        .get::<Value>(WORKFLOW_INPUT_KEY)
        .ok_or_else(|| JcodeNodeError::configuration("translation workflow input is missing"))?;
    serde_json::from_value(input).map_err(|error| {
        JcodeNodeError::configuration(format!("translation workflow input is invalid: {error}"))
    })
}

fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn jcode_binary() -> PathBuf {
    std::env::var_os("JCODE_BIN").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".tools/jcode/bin/jcode"),
        PathBuf::from,
    )
}
