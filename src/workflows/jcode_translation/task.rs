use async_trait::async_trait;
use graph_flow::{Context, GraphError, Task, TaskResult};
use graph_flow_jcode::{JcodeNode, SessionMode};
use std::sync::Arc;
use workflow_resources::{ResourceKey, ResourceStore, with_resources};

use super::{hooks, provider, provider_bridge::ProviderBridge};
use crate::workflows::WORKFLOW_RUN_ID_KEY;

/// One isolated provider connection and private jcode process per translation run.
#[derive(Debug)]
pub(super) struct TranslationTask;

#[async_trait]
impl Task for TranslationTask {
    fn id(&self) -> &'static str {
        "translate_files"
    }

    async fn run(&self, context: Context) -> graph_flow::Result<TaskResult> {
        let run_id = context.get::<String>(WORKFLOW_RUN_ID_KEY).ok_or_else(|| {
            GraphError::TaskExecutionFailed("run session key is missing".to_owned())
        })?;
        let (config, bridge) = tokio::task::spawn_blocking(|| {
            let config = Arc::new(provider::load_standard()?);
            let bridge = Arc::new(ProviderBridge::start(Arc::clone(&config))?);
            Ok::<_, graph_flow_jcode::JcodeNodeError>((config, bridge))
        })
        .await
        .map_err(|_| GraphError::TaskExecutionFailed("provider loading task failed".to_owned()))?
        .map_err(|error| GraphError::TaskExecutionFailed(error.to_string()))?;
        // The bridge must stop when the outer run future is dropped, even while a
        // blocking SDK request still owns a process reference.
        let _shutdown = bridge.shutdown_guard();
        let process_config = Arc::clone(&config);
        let process_bridge = Arc::clone(&bridge);
        let node = JcodeNode::new(
            self.id(),
            ResourceKey::run(&run_id, "jcode-process"),
            move || {
                Ok(provider::process_scope(
                    Arc::clone(&process_config),
                    Arc::clone(&process_bridge),
                ))
            },
            hooks::prompt,
        )
        .with_session_mode(move |_| SessionMode::reuse(run_id.clone()))
        .with_session_options(hooks::session_options)
        .with_hooks(hooks::TranslationHooks::new(bridge))
        .with_next_action(graph_flow::NextAction::End);
        // Resource scopes are labels, not automatic eviction. A private store ensures
        // this run cannot leave its process in the application's resource store.
        with_resources(Arc::new(ResourceStore::new()), node.run(context)).await
    }
}
