use crate::{
    AfterRun, BeforeRun, JCODE_OUTPUT_KEY, JcodeHooks, JcodeNodeError, JcodeOutput,
    JcodeProcessScope, SessionMode, SessionOptions,
};
use async_trait::async_trait;
use graph_flow::{Context, GraphError, NextAction, Task, TaskResult};
use jcode_sdk::RunOptions;
use std::{fmt, sync::Arc};
use workflow_resources::{ResourceKey, current_resources};

type PromptFactory = dyn Fn(&Context) -> Result<String, JcodeNodeError> + Send + Sync + 'static;
type SessionFactory =
    dyn Fn(&Context) -> Result<SessionOptions, JcodeNodeError> + Send + Sync + 'static;
type SessionModeFactory =
    dyn Fn(&Context) -> Result<SessionMode, JcodeNodeError> + Send + Sync + 'static;
type RunFactory = dyn Fn(&Context) -> Result<RunOptions, JcodeNodeError> + Send + Sync + 'static;
type ProcessFactory = dyn Fn() -> Result<JcodeProcessScope, JcodeNodeError> + Send + Sync + 'static;

struct ExecutionPolicy<'a> {
    process_scope: &'a JcodeProcessScope,
    prompt_factory: &'a PromptFactory,
    session_factory: &'a SessionFactory,
    session_mode_factory: &'a SessionModeFactory,
    run_factory: &'a RunFactory,
    hooks: &'a dyn JcodeHooks,
    next_action: NextAction,
}

/// A graph-flow task that executes one complete high-level jcode agent turn.
#[must_use]
pub struct JcodeNode {
    id: String,
    process_key: ResourceKey,
    process_factory: Arc<ProcessFactory>,
    prompt_factory: Arc<PromptFactory>,
    session_factory: Arc<SessionFactory>,
    session_mode_factory: Arc<SessionModeFactory>,
    run_factory: Arc<RunFactory>,
    hooks: Arc<dyn JcodeHooks>,
    next_action: NextAction,
}

impl JcodeNode {
    /// Create a node that lazily resolves one application-owned jcode runtime resource.
    pub fn new<F, P>(
        id: impl Into<String>,
        process_key: ResourceKey,
        process_factory: F,
        prompt_factory: P,
    ) -> Self
    where
        F: Fn() -> Result<JcodeProcessScope, JcodeNodeError> + Send + Sync + 'static,
        P: Fn(&Context) -> Result<String, JcodeNodeError> + Send + Sync + 'static,
    {
        Self {
            id: id.into(),
            process_key,
            process_factory: Arc::new(process_factory),
            prompt_factory: Arc::new(prompt_factory),
            session_factory: Arc::new(|_| Ok(SessionOptions::default())),
            session_mode_factory: Arc::new(|_| Ok(SessionMode::New)),
            run_factory: Arc::new(|_| Ok(RunOptions::default())),
            hooks: Arc::new(()),
            next_action: NextAction::Continue,
        }
    }

    /// Select a new session or a named session shared across graph-flow nodes.
    pub fn with_session_mode<F>(mut self, factory: F) -> Self
    where
        F: Fn(&Context) -> Result<SessionMode, JcodeNodeError> + Send + Sync + 'static,
    {
        self.session_mode_factory = Arc::new(factory);
        self
    }

    /// Override working directory, credentials, model, or reasoning per execution.
    pub fn with_session_options<F>(mut self, factory: F) -> Self
    where
        F: Fn(&Context) -> Result<SessionOptions, JcodeNodeError> + Send + Sync + 'static,
    {
        self.session_factory = Arc::new(factory);
        self
    }

    /// Pass exact jcode SDK run options, including event callbacks and images.
    pub fn with_run_options<F>(mut self, factory: F) -> Self
    where
        F: Fn(&Context) -> Result<RunOptions, JcodeNodeError> + Send + Sync + 'static,
    {
        self.run_factory = Arc::new(factory);
        self
    }

    /// Install prompt and result lifecycle hooks for each node turn.
    pub fn with_hooks<H>(mut self, hooks: H) -> Self
    where
        H: JcodeHooks,
    {
        self.hooks = Arc::new(hooks);
        self
    }

    /// Select graph-flow routing after a successful jcode turn.
    pub fn with_next_action(mut self, next_action: NextAction) -> Self {
        self.next_action = next_action;
        self
    }
}

impl fmt::Debug for JcodeNode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JcodeNode")
            .field("id", &self.id)
            .field("next_action", &self.next_action)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl Task for JcodeNode {
    fn id(&self) -> &str {
        &self.id
    }

    async fn run(&self, context: Context) -> graph_flow::Result<TaskResult> {
        let resources = current_resources()
            .map_err(|error| GraphError::TaskExecutionFailed(error.to_string()))?;
        let process_key = self.process_key.clone();
        let process_factory = Arc::clone(&self.process_factory);
        let prompt_factory = Arc::clone(&self.prompt_factory);
        let session_factory = Arc::clone(&self.session_factory);
        let session_mode_factory = Arc::clone(&self.session_mode_factory);
        let run_factory = Arc::clone(&self.run_factory);
        let hooks = Arc::clone(&self.hooks);
        let next_action = self.next_action.clone();
        tokio::task::spawn_blocking(move || {
            let process_scope = resources.get_or_try_init(process_key, || process_factory())?;
            execute(
                &context,
                ExecutionPolicy {
                    process_scope: &process_scope,
                    prompt_factory: &*prompt_factory,
                    session_factory: &*session_factory,
                    session_mode_factory: &*session_mode_factory,
                    run_factory: &*run_factory,
                    hooks: &*hooks,
                    next_action,
                },
            )
        })
        .await
        .map_err(|error| GraphError::TaskExecutionFailed(error.to_string()))?
        .map_err(|error| GraphError::TaskExecutionFailed(error.to_string()))
    }
}

fn execute(context: &Context, policy: ExecutionPolicy<'_>) -> Result<TaskResult, JcodeNodeError> {
    let SessionOptions {
        working_dir,
        credentials,
        model,
        reasoning_effort,
    } = (policy.session_factory)(context)?;
    let client = policy.process_scope.client()?;
    for credential in &credentials {
        client.set_api_key(credential.provider(), credential.api_key())?;
    }
    let session_mode = (policy.session_mode_factory)(context)?;
    policy
        .process_scope
        .with_session(session_mode, working_dir, |client, session| {
            execute_turn(context, policy, client, session, model, reasoning_effort)
        })
}

fn execute_turn(
    context: &Context,
    policy: ExecutionPolicy<'_>,
    client: &jcode_sdk::JcodeClient,
    session: &jcode_sdk::SessionInfo,
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<TaskResult, JcodeNodeError> {
    if let Some(model) = model {
        client.set_model(&session.session_id, &model)?;
    }
    if let Some(effort) = reasoning_effort {
        client.set_reasoning_effort(&session.session_id, &effort)?;
    }
    let mut prompt = (policy.prompt_factory)(context)?;
    let mut run_options = (policy.run_factory)(context)?;
    policy.hooks.before_run(BeforeRun {
        context,
        client,
        session,
        prompt: &mut prompt,
        options: &mut run_options,
    })?;
    context.add_user_message(prompt.clone());
    let mut result = client.run(&session.session_id, &prompt, run_options)?;
    policy.hooks.after_run(AfterRun {
        context,
        client,
        session,
        result: &mut result,
    })?;
    let output = JcodeOutput::from_turn(session.session_id.clone(), result)?;
    context.add_assistant_message(output.text.clone());
    let response = output.text.clone();
    context
        .set(JCODE_OUTPUT_KEY, output.to_dto())
        .map_err(|error| JcodeNodeError::context(&error))?;
    Ok(TaskResult::new(Some(response), policy.next_action))
}
