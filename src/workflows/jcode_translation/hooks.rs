use graph_flow::Context;
use graph_flow_jcode::{AfterRun, BeforeRun, JcodeHooks, JcodeNodeError, jcode_sdk::LaunchOptions};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use super::glossshift;
use crate::workflows::WORKFLOW_INPUT_KEY;

const MAX_FILE_BYTES: u64 = 1_048_576;

#[derive(Debug)]
pub(super) struct TranslationHooks;

impl JcodeHooks for TranslationHooks {
    fn before_run(&self, stage: BeforeRun<'_>) -> Result<(), JcodeNodeError> {
        let input = task_input(stage.context)?;
        let target = checked_paths(&workspace(), &input)?;
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
        let _ = checked_paths(&workspace(), &input)?;
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

fn task_input(context: &Context) -> Result<super::definition::TranslationInput, JcodeNodeError> {
    let input = context
        .get::<Value>(WORKFLOW_INPUT_KEY)
        .ok_or_else(|| JcodeNodeError::configuration("translation workflow input is missing"))?;
    super::definition::TranslationInput::decode(input).map_err(|error| {
        JcodeNodeError::configuration(format!("translation workflow input is invalid: {error}"))
    })
}

// Hooks execute on the node's blocking worker, never the async graph executor.
fn checked_paths(
    workspace: &Path,
    input: &super::definition::TranslationInput,
) -> Result<PathBuf, JcodeNodeError> {
    let io_error = |error: std::io::Error| {
        JcodeNodeError::configuration(format!("translation path cannot be resolved: {error}"))
    };
    let root = workspace.canonicalize().map_err(io_error)?;
    let source = root
        .join(&input.source_path)
        .canonicalize()
        .map_err(io_error)?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err(JcodeNodeError::configuration(
            "translation source must be a file inside the workspace",
        ));
    }
    let target = root.join(&input.target_path);
    let mut ancestor = target.as_path();
    loop {
        match ancestor.symlink_metadata() {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor.parent().ok_or_else(|| {
                    JcodeNodeError::configuration("translation target has no existing parent")
                })?;
            }
            Err(error) => return Err(io_error(error)),
        }
    }
    let resolved = ancestor.canonicalize().map_err(io_error)?;
    if !resolved.starts_with(&root) {
        return Err(JcodeNodeError::configuration(
            "translation target must remain inside the workspace",
        ));
    }
    if ancestor == target && (resolved == source || !resolved.is_file()) {
        return Err(JcodeNodeError::configuration(
            "translation target must be a different file from the source",
        ));
    }
    Ok(target)
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

#[cfg(all(test, unix))]
mod tests {
    use super::super::definition::TranslationInput;
    use super::*;
    use std::os::unix::fs::symlink;

    struct Workspace(PathBuf);

    impl Workspace {
        fn new() -> std::io::Result<Self> {
            let root =
                std::env::temp_dir().join(format!("flowdeck-path-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("workspace"))?;
            fs::write(root.join("workspace/source.md"), "source")?;
            fs::write(root.join("outside.md"), "outside")?;
            Ok(Self(root))
        }

        fn path(&self) -> PathBuf {
            self.0.join("workspace")
        }
    }

    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn input(source: &str, target: &str) -> Result<TranslationInput, crate::WorkflowError> {
        TranslationInput::decode(serde_json::json!({
            "source_path": source, "target_path": target, "target_language": "Japanese"
        }))
    }

    #[test]
    fn source_symlink_outside_workspace_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
        let workspace = Workspace::new()?;
        symlink(
            workspace.0.join("outside.md"),
            workspace.path().join("link.md"),
        )?;
        assert!(matches!(
            checked_paths(&workspace.path(), &input("link.md", "out.md")?),
            Err(JcodeNodeError::Configuration { .. })
        ));
        Ok(())
    }

    #[test]
    fn new_target_under_escaping_symlink_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
        let workspace = Workspace::new()?;
        symlink(&workspace.0, workspace.path().join("escape"))?;
        assert!(matches!(
            checked_paths(&workspace.path(), &input("source.md", "escape/new/out.md")?),
            Err(JcodeNodeError::Configuration { .. })
        ));
        Ok(())
    }

    #[test]
    fn target_symlink_aliasing_source_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
        let workspace = Workspace::new()?;
        symlink(
            workspace.path().join("source.md"),
            workspace.path().join("alias.md"),
        )?;
        assert!(matches!(
            checked_paths(&workspace.path(), &input("source.md", "alias.md")?),
            Err(JcodeNodeError::Configuration { .. })
        ));
        Ok(())
    }

    #[test]
    fn nested_new_target_stays_inside_workspace() -> Result<(), Box<dyn std::error::Error>> {
        let workspace = Workspace::new()?;
        assert_eq!(
            checked_paths(&workspace.path(), &input("source.md", "new/nested/out.md")?)?,
            workspace.path().canonicalize()?.join("new/nested/out.md")
        );
        Ok(())
    }
}
