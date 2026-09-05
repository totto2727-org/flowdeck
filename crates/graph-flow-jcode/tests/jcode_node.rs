//! Contract coverage for one complete graph-flow-backed jcode turn.

/// Scripted protocol peer used by the integration contract.
pub mod support;

use graph_flow::{Context, NextAction, Task};
use graph_flow_jcode::{
    AfterRun, BeforeRun, JcodeHooks, JcodeNode, JcodeNodeError, JcodeOutput, JcodeProcessScope,
    ProviderCredential, SessionMode, SessionOptions,
    jcode_sdk::{RunOptions, api::ApiRequest},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use workflow_resources::{ResourceKey, ResourceStore, with_resources};

type TestResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Debug)]
struct RecordingHooks {
    phases: Arc<Mutex<Vec<&'static str>>>,
}

impl JcodeHooks for RecordingHooks {
    fn before_run(&self, stage: BeforeRun<'_>) -> Result<(), JcodeNodeError> {
        stage.prompt.push_str(" with hook context");
        self.record("before_run");
        Ok(())
    }

    fn after_run(&self, stage: AfterRun<'_>) -> Result<(), JcodeNodeError> {
        if stage.result.text != "translated output" {
            return Err(JcodeNodeError::hook(
                "after_run",
                "the translated output did not pass validation",
            ));
        }
        stage
            .context
            .set("translation_validated", true)
            .map_err(|error| JcodeNodeError::context(&error))?;
        self.record("after_run");
        Ok(())
    }
}

impl RecordingHooks {
    fn record(&self, phase: &'static str) {
        self.phases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(phase);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_configured_jcode_session_and_records_graph_context() -> TestResult<()> {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let phases = Arc::new(Mutex::new(Vec::new()));
    let hooks = RecordingHooks {
        phases: Arc::clone(&phases),
    };
    let node = JcodeNode::new(
        "translate",
        ResourceKey::application("test-runtime"),
        {
            let requests = Arc::clone(&requests);
            move || {
                support::fake_client(Arc::clone(&requests))
                    .map(JcodeProcessScope::from_client)
                    .map_err(|error| JcodeNodeError::configuration(error.to_string()))
            }
        },
        |_| Ok("translate the source".to_owned()),
    )
    .with_session_options(|_| {
        Ok(SessionOptions::default()
            .with_working_dir("/workspace")
            .with_credential(ProviderCredential::new("openrouter", "secret"))
            .with_model("deepseek-v4-flash")
            .with_reasoning_effort("high"))
    })
    .with_run_options(|_| Ok(RunOptions::default()))
    .with_hooks(hooks)
    .with_next_action(NextAction::End);
    let context = Context::new();

    let result = with_resources(Arc::new(ResourceStore::new()), node.run(context.clone())).await?;

    assert_eq!(result.response.as_deref(), Some("translated output"));
    assert_eq!(result.next_action, NextAction::End);
    assert_eq!(context.get::<bool>("translation_validated"), Some(true));
    let Some(output) = JcodeOutput::from_context(&context)? else {
        return Err("jcode output missing from graph context".into());
    };
    assert_eq!(output.session_id, "session-1");
    assert_eq!(output.text, "translated output");
    assert_eq!(context.chat_history_len(), 2);
    assert_eq!(
        *phases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        ["before_run", "after_run"]
    );
    let captured_requests = requests
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert!(matches!(
        &captured_requests[0],
        ApiRequest::SetApiKey { provider, api_key }
            if provider == "openrouter" && api_key == "secret"
    ));
    assert!(matches!(
        &captured_requests[1],
        ApiRequest::CreateSession { working_dir }
            if working_dir.as_deref() == Some("/workspace")
    ));
    assert!(matches!(
        &captured_requests[2],
        ApiRequest::SetModel { model, .. } if model == "deepseek-v4-flash"
    ));
    assert!(matches!(
        &captured_requests[3],
        ApiRequest::SetReasoningEffort { effort, .. } if effort == "high"
    ));
    assert!(matches!(
        &captured_requests[4],
        ApiRequest::SendMessage { content, .. } if content == "translate the source with hook context"
    ));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reuses_named_sessions_and_keeps_new_sessions_isolated() -> TestResult<()> {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let process_key = ResourceKey::application("test-runtime");
    let shared = SessionMode::reuse("coding-run")?;
    let first = JcodeNode::new(
        "first",
        process_key.clone(),
        test_process_factory(Arc::clone(&requests)),
        |_| Ok("first".to_owned()),
    )
    .with_session_mode(move |_| Ok(shared.clone()));
    let shared = SessionMode::reuse("coding-run")?;
    let second = JcodeNode::new(
        "second",
        process_key.clone(),
        test_process_factory(Arc::clone(&requests)),
        |_| Ok("second".to_owned()),
    )
    .with_session_mode(move |_| Ok(shared.clone()));
    let isolated = JcodeNode::new(
        "isolated",
        process_key,
        test_process_factory(Arc::clone(&requests)),
        |_| Ok("isolated".to_owned()),
    );
    let context = Context::new();

    with_resources(Arc::new(ResourceStore::new()), async {
        first.run(context.clone()).await?;
        second.run(context.clone()).await?;
        isolated.run(context).await?;
        Ok::<_, graph_flow::GraphError>(())
    })
    .await?;

    let captured = requests
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let created = captured
        .iter()
        .filter(|request| matches!(request, ApiRequest::CreateSession { .. }))
        .count();
    let message_sessions = captured
        .iter()
        .filter_map(|request| match request {
            ApiRequest::SendMessage { session_id, .. } => Some(session_id.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(created, 2);
    assert_eq!(message_sessions, ["session-1", "session-1", "session-2"]);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_nodes_publish_one_application_runtime() -> TestResult<()> {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let launches = Arc::new(AtomicUsize::new(0));
    let process_factory = {
        let requests = Arc::clone(&requests);
        let launches = Arc::clone(&launches);
        move || {
            launches.fetch_add(1, Ordering::SeqCst);
            support::fake_client(Arc::clone(&requests))
                .map(JcodeProcessScope::from_client)
                .map_err(|error| JcodeNodeError::configuration(error.to_string()))
        }
    };
    let process_key = ResourceKey::application("test-runtime");
    let shared = SessionMode::reuse("coding-run")?;
    let first = JcodeNode::new("first", process_key.clone(), process_factory, |_| {
        Ok("first".to_owned())
    })
    .with_session_mode(move |_| Ok(shared.clone()));
    let shared = SessionMode::reuse("coding-run")?;
    let second = JcodeNode::new(
        "second",
        process_key,
        {
            let requests = Arc::clone(&requests);
            let launches = Arc::clone(&launches);
            move || {
                launches.fetch_add(1, Ordering::SeqCst);
                support::fake_client(Arc::clone(&requests))
                    .map(JcodeProcessScope::from_client)
                    .map_err(|error| JcodeNodeError::configuration(error.to_string()))
            }
        },
        |_| Ok("second".to_owned()),
    )
    .with_session_mode(move |_| Ok(shared.clone()));

    assert_eq!(launches.load(Ordering::SeqCst), 0);
    with_resources(Arc::new(ResourceStore::new()), async {
        let (first, second) = tokio::join!(first.run(Context::new()), second.run(Context::new()));
        first?;
        second?;
        Ok::<_, graph_flow::GraphError>(())
    })
    .await?;

    assert_eq!(launches.load(Ordering::SeqCst), 1);
    let created = requests
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .filter(|request| matches!(request, ApiRequest::CreateSession { .. }))
        .count();
    assert_eq!(created, 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_failed_application_runtime_initialization() -> TestResult<()> {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let launches = Arc::new(AtomicUsize::new(0));
    let node = JcodeNode::new(
        "retry",
        ResourceKey::application("test-runtime"),
        {
            let requests = Arc::clone(&requests);
            let launches = Arc::clone(&launches);
            move || {
                if launches.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Err(JcodeNodeError::configuration("first launch failed"));
                }
                support::fake_client(Arc::clone(&requests))
                    .map(JcodeProcessScope::from_client)
                    .map_err(|error| JcodeNodeError::configuration(error.to_string()))
            }
        },
        |_| Ok("retry".to_owned()),
    );
    let resources = Arc::new(ResourceStore::new());

    assert!(
        with_resources(Arc::clone(&resources), node.run(Context::new()))
            .await
            .is_err()
    );
    with_resources(resources, node.run(Context::new())).await?;

    assert_eq!(launches.load(Ordering::SeqCst), 2);
    Ok(())
}

#[tokio::test]
async fn rejects_execution_outside_resource_scope() {
    let node = JcodeNode::new(
        "outside",
        ResourceKey::application("test-runtime"),
        || Err(JcodeNodeError::configuration("factory must not run")),
        |_| Ok(String::from("unused")),
    );

    let error = node.run(Context::new()).await;

    assert!(
        matches!(error, Err(graph_flow::GraphError::TaskExecutionFailed(message)) if message.contains("outside an execution scope"))
    );
}

fn test_process_factory(
    requests: Arc<Mutex<Vec<ApiRequest>>>,
) -> impl Fn() -> Result<JcodeProcessScope, JcodeNodeError> + Send + Sync + 'static {
    move || {
        support::fake_client(Arc::clone(&requests))
            .map(JcodeProcessScope::from_client)
            .map_err(|error| JcodeNodeError::configuration(error.to_string()))
    }
}
