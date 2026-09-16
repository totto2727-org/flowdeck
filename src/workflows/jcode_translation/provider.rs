use graph_flow_jcode::{JcodeNodeError, SessionOptions, jcode_sdk::LaunchOptions};
use llm_profiles::{AgentConfigPaths, LoadedAgentsConfig, ResolvedProvider, load_from_paths};
use std::{ffi::OsString, path::Path};

// The private jcode profile is application-owned, independent of shared provider names.
const JCODE_PROVIDER: &str = "flowdeck-shared";

pub(super) fn load_standard() -> Result<LoadedAgentsConfig, JcodeNodeError> {
    load(AgentConfigPaths::standard().map_err(|error| config_error(&error))?)
}

pub(super) fn session_options(working_dir: &Path) -> SessionOptions {
    // Each run's process already starts with the exact configured model. A later bare
    // set_model call can trigger jcode's catalog heuristics and switch the endpoint.
    SessionOptions::default().with_working_dir(working_dir.to_string_lossy())
}

pub(super) fn process_scope(
    config: std::sync::Arc<LoadedAgentsConfig>,
    bridge: std::sync::Arc<super::provider_bridge::ProviderBridge>,
) -> graph_flow_jcode::JcodeProcessScope {
    // The factory retains the bridge until after the SDK process is dropped.
    graph_flow_jcode::JcodeProcessScope::deferred(move || {
        let mut options = super::hooks::launch_options();
        apply_provider_environment(
            &mut options,
            config
                .active_provider()
                .map_err(|error| config_error(&error))?,
        );
        bridge.configure(&mut options);
        Ok(graph_flow_jcode::jcode_sdk::JcodeClient::launch(options)?)
    })
}

fn load(paths: AgentConfigPaths) -> Result<LoadedAgentsConfig, JcodeNodeError> {
    // Read existing shared settings only. Provisioning and migration belong to the user.
    let config = load_from_paths(paths).map_err(|error| config_error(&error))?;
    let provider = config
        .active_provider()
        .map_err(|error| config_error(&error))?;
    if provider.api_key().trim() == "replace-me" {
        return Err(JcodeNodeError::configuration(
            "shared agent credential still uses the template value",
        ));
    }
    Ok(config)
}

fn config_error(error: &llm_profiles::ConfigError) -> JcodeNodeError {
    // The shared library's Display omits raw TOML and credential/header values.
    JcodeNodeError::configuration(format!("shared agent configuration: {error}"))
}

fn apply_provider_environment(options: &mut LaunchOptions, provider: &ResolvedProvider) {
    for (name, value) in [
        ("JCODE_OPENROUTER_API_BASE", provider.base_url().to_string()),
        (
            "JCODE_OPENROUTER_API_KEY_NAME",
            "FLOWDECK_BRIDGE_KEY".to_owned(),
        ),
        (
            "JCODE_OPENROUTER_ENV_FILE",
            "flowdeck-shared.env".to_owned(),
        ),
        (
            "JCODE_OPENROUTER_CACHE_NAMESPACE",
            JCODE_PROVIDER.to_owned(),
        ),
        ("JCODE_OPENROUTER_PROVIDER_FEATURES", "0".to_owned()),
        (
            "JCODE_OPENROUTER_TRANSPORT_STATE",
            "direct-api-key".to_owned(),
        ),
        (
            "JCODE_OPENROUTER_STATIC_MODELS",
            provider.model().to_owned(),
        ),
        ("JCODE_OPENROUTER_MODEL", provider.model().to_owned()),
        // Always set an object, even when empty, so inherited extra-body values cannot leak in.
        (
            "JCODE_OPENAI_EXTRA_BODY",
            serde_json::Value::Object(provider.request_parameters().clone()).to_string(),
        ),
    ] {
        options
            .env
            .insert(OsString::from(name), OsString::from(value));
    }
}

#[cfg(test)]
#[path = "provider_test.rs"]
mod tests;
