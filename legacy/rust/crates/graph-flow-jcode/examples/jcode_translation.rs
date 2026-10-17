#![allow(missing_docs, reason = "Executable example has no public API.")]

use graph_flow::{
    ExecutionStatus, FlowRunner, GraphBuilder, InMemorySessionStorage, NextAction, Session,
    SessionStorage,
};
use graph_flow_jcode::{
    AfterRun, BeforeLaunch, BeforeRun, JcodeHooks, JcodeNode, JcodeNodeError, JcodeProcessHooks,
    JcodeProcessScope, SessionOptions, jcode_sdk::LaunchOptions,
};
use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use workflow_resources::{ResourceKey, ResourceStore, with_resources};

const SOURCE_PATH: &str = "source/hello.md";
const TARGET_PATH: &str = "output/hello.ja.md";
type ExampleError = Box<dyn Error + Send + Sync>;

#[derive(Debug)]
struct TranslationHooks;

impl JcodeHooks for TranslationHooks {
    fn before_run(&self, stage: BeforeRun<'_>) -> Result<(), JcodeNodeError> {
        let source =
            stage
                .client
                .read_file(&stage.session.session_id, SOURCE_PATH, Some(1_048_576))?;
        if source.truncated || source.content.trim().is_empty() {
            return Err(JcodeNodeError::hook(
                "before_run",
                "translation source is empty or truncated",
            ));
        }
        Ok(())
    }

    fn after_run(&self, stage: AfterRun<'_>) -> Result<(), JcodeNodeError> {
        let output =
            stage
                .client
                .read_file(&stage.session.session_id, TARGET_PATH, Some(1_048_576))?;
        if output.truncated || output.content.trim().is_empty() {
            return Err(JcodeNodeError::hook(
                "after_run",
                "jcode did not produce a complete translation",
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
struct RuntimeSetup {
    workspace: PathBuf,
}

impl JcodeProcessHooks for RuntimeSetup {
    fn before_launch(&self, _stage: BeforeLaunch<'_>) -> Result<(), JcodeNodeError> {
        prepare_workspace(&self.workspace)
    }
}

#[tokio::main]
async fn main() -> Result<(), ExampleError> {
    let workspace = std::env::temp_dir().join(format!(
        "graph-flow-jcode-translation-{}",
        std::process::id()
    ));
    let session_workspace = workspace.clone();
    let runtime_workspace = workspace.clone();
    let node = JcodeNode::new(
        "translate_files",
        ResourceKey::application("jcode-process"),
        move || {
            JcodeProcessScope::launch_with_hooks(
                LaunchOptions {
                    working_dir: Some(runtime_workspace.clone()),
                    inherit_logins: true,
                    binary: Some(jcode_binary()),
                    ..LaunchOptions::default()
                },
                &RuntimeSetup {
                    workspace: runtime_workspace.clone(),
                },
            )
        },
        |_| {
            Ok(format!(
                "Translate {SOURCE_PATH} into Japanese and write the complete translation to {TARGET_PATH}. Preserve Markdown structure, modify no other file, and read the output before finishing."
            ))
        },
    )
    .with_session_options(move |_| {
        Ok(SessionOptions::default().with_working_dir(session_workspace.to_string_lossy()))
    })
    .with_hooks(TranslationHooks)
    .with_next_action(NextAction::End);
    let graph = Arc::new(
        GraphBuilder::new("jcode_translation")
            .add_task(Arc::new(node))
            .build()?,
    );
    let storage = Arc::new(InMemorySessionStorage::new());
    let runner = FlowRunner::new(graph, storage.clone());
    let session_id = "jcode-translation-example";
    storage
        .save(Session::new_from_task(
            session_id.to_owned(),
            "translate_files",
        ))
        .await?;
    let result = with_resources(Arc::new(ResourceStore::new()), runner.run(session_id)).await?;
    if let status @ (ExecutionStatus::WaitingForInput | ExecutionStatus::Paused { .. }) =
        result.status
    {
        return Err(format!("example did not complete: {status:?}").into());
    }
    let output_path = workspace.join(TARGET_PATH);
    let output = fs::read_to_string(&output_path)?;
    println!("{}\n\nOutput: {}", output.trim(), output_path.display());
    Ok(())
}

fn prepare_workspace(workspace: &Path) -> Result<(), JcodeNodeError> {
    fs::create_dir_all(workspace.join("source"))
        .and_then(|()| fs::create_dir_all(workspace.join("output")))
        .and_then(|()| {
            fs::write(
                workspace.join(SOURCE_PATH),
                "# Hello\n\nThis file demonstrates a complete jcode node inside graph-flow.\n",
            )
        })
        .map_err(|error| JcodeNodeError::hook("before_launch", error.to_string()))
}

fn jcode_binary() -> PathBuf {
    std::env::var_os("JCODE_BIN").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.tools/jcode/bin/jcode"),
        PathBuf::from,
    )
}
