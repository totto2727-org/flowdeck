use graph_flow_jcode::{JcodeNodeError, SessionOptions, jcode_sdk::LaunchOptions};
use serde::Deserialize;
use std::{collections::HashMap, ffi::OsString, fs, path::Path};

const JCODE_PROVIDER: &str = "opencode-go";

#[derive(Deserialize)]
struct AppConfig {
    active_provider: String,
    providers: HashMap<String, ProviderConfig>,
}

#[derive(Deserialize)]
struct ProviderConfig {
    base_url: String,
    model: String,
    credential: String,
}

#[derive(Deserialize)]
struct CredentialsFile {
    credentials: HashMap<String, Credential>,
}

#[derive(Deserialize)]
struct Credential {
    api_key: String,
}

struct CompatibilityConfig {
    base_url: String,
    model: String,
    api_key: String,
}

pub(super) fn session_options(working_dir: &Path) -> Result<SessionOptions, JcodeNodeError> {
    let config = load()?;
    Ok(SessionOptions::default()
        .with_working_dir(working_dir.to_string_lossy())
        .with_model(config.model))
}

pub(super) fn apply_launch_environment(options: &mut LaunchOptions) -> Result<(), JcodeNodeError> {
    let config = load()?;
    apply_profile_environment(options, config);
    Ok(())
}

fn apply_profile_environment(options: &mut LaunchOptions, config: CompatibilityConfig) {
    for (name, value) in [
        ("OPENCODE_GO_API_KEY", config.api_key),
        ("JCODE_OPENROUTER_API_BASE", config.base_url),
        (
            "JCODE_OPENROUTER_API_KEY_NAME",
            "OPENCODE_GO_API_KEY".to_owned(),
        ),
        ("JCODE_OPENROUTER_ENV_FILE", "opencode-go.env".to_owned()),
        (
            "JCODE_OPENROUTER_CACHE_NAMESPACE",
            JCODE_PROVIDER.to_owned(),
        ),
        ("JCODE_OPENROUTER_PROVIDER_FEATURES", "0".to_owned()),
        (
            "JCODE_OPENROUTER_TRANSPORT_STATE",
            "direct-api-key".to_owned(),
        ),
        ("JCODE_OPENROUTER_STATIC_MODELS", config.model.clone()),
        ("JCODE_OPENROUTER_MODEL", config.model),
    ] {
        options
            .env
            .insert(OsString::from(name), OsString::from(value));
    }
}

fn load() -> Result<CompatibilityConfig, JcodeNodeError> {
    let directory = xdg::BaseDirectories::with_prefix("glossshift")
        .get_config_home()
        .ok_or_else(|| {
            JcodeNodeError::configuration("GlossShift config directory is unavailable")
        })?;
    load_from_directory(&directory)
}

fn load_from_directory(directory: &Path) -> Result<CompatibilityConfig, JcodeNodeError> {
    let app_source = fs::read_to_string(directory.join("config.toml")).map_err(|error| {
        JcodeNodeError::configuration(format!("failed to read GlossShift config.toml: {error}"))
    })?;
    let credential_source =
        fs::read_to_string(directory.join("credentials.toml")).map_err(|error| {
            JcodeNodeError::configuration(format!(
                "failed to read GlossShift credentials.toml: {error}"
            ))
        })?;
    let app: AppConfig = toml::from_str(&app_source).map_err(|error| {
        JcodeNodeError::configuration(format!("GlossShift config.toml is invalid: {error}"))
    })?;
    let credentials: CredentialsFile = toml::from_str(&credential_source).map_err(|error| {
        JcodeNodeError::configuration(format!("GlossShift credentials.toml is invalid: {error}"))
    })?;
    let provider = app.providers.get(&app.active_provider).ok_or_else(|| {
        JcodeNodeError::configuration("GlossShift active provider is not configured")
    })?;
    if provider.base_url.trim().is_empty() {
        return Err(JcodeNodeError::configuration(
            "GlossShift provider base_url is empty",
        ));
    }
    let api_key = credentials
        .credentials
        .get(&provider.credential)
        .ok_or_else(|| JcodeNodeError::configuration("GlossShift credential is not configured"))?
        .api_key
        .trim();
    if api_key.is_empty() || api_key == "replace-me" {
        return Err(JcodeNodeError::configuration(
            "GlossShift credential is empty or still uses the template value",
        ));
    }

    // Future provider-profile integration belongs here. This temporary adapter deliberately maps
    // GlossShift's selected API key and model onto jcode's built-in opencode-go profile only.
    Ok(CompatibilityConfig {
        base_url: provider.base_url.clone(),
        model: provider.model.clone(),
        api_key: api_key.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_profile_mapping_does_not_select_a_custom_provider_profile() {
        let mut options = LaunchOptions::default();
        apply_profile_environment(
            &mut options,
            CompatibilityConfig {
                base_url: "https://opencode.ai/zen/go/v1".to_owned(),
                model: "deepseek-v4-flash".to_owned(),
                api_key: "secret".to_owned(),
            },
        );

        assert!(
            !options
                .env
                .contains_key(&OsString::from("JCODE_PROVIDER_PROFILE_NAME")),
            "the built-in opencode-go mapping must not ask jcode to load a custom provider profile"
        );
        assert!(
            !options
                .env
                .contains_key(&OsString::from("JCODE_PROVIDER_PROFILE_ACTIVE")),
            "the built-in opencode-go mapping must not activate custom profile resolution"
        );
    }
}
