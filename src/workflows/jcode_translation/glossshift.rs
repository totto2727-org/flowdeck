use garde::Validate;
use graph_flow_jcode::{JcodeNodeError, SessionOptions, jcode_sdk::LaunchOptions};
use serde::Deserialize;
use std::{collections::HashMap, ffi::OsString, fs, path::Path};

const JCODE_PROVIDER: &str = "opencode-go";

// GlossShift owns this file schema, so unrelated extension fields remain accepted.
#[derive(Deserialize, Validate)]
struct AppConfigDto {
    #[garde(custom(non_blank))]
    active_provider: String,
    #[garde(dive)]
    providers: HashMap<String, ProviderConfigDto>,
}

#[derive(Deserialize, Validate)]
struct ProviderConfigDto {
    #[garde(custom(http_endpoint))]
    base_url: String,
    #[garde(custom(non_blank))]
    model: String,
    #[garde(custom(non_blank))]
    credential: String,
}

#[derive(Deserialize, Validate)]
struct CredentialsFileDto {
    #[garde(dive)]
    credentials: HashMap<String, CredentialDto>,
}

#[derive(Deserialize, Validate)]
struct CredentialDto {
    #[garde(custom(validate_api_key))]
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
    decode(&app_source, &credential_source)
}

fn decode(
    app_source: &str,
    credential_source: &str,
) -> Result<CompatibilityConfig, JcodeNodeError> {
    // TOML parser diagnostics can contain the source line, including credentials.
    let app: AppConfigDto = toml::from_str(app_source).map_err(|_| {
        JcodeNodeError::configuration("GlossShift config.toml has invalid TOML structure")
    })?;
    let credentials: CredentialsFileDto = toml::from_str(credential_source).map_err(|_| {
        JcodeNodeError::configuration("GlossShift credentials.toml has invalid TOML structure")
    })?;
    app.validate().map_err(|_| {
        JcodeNodeError::configuration("GlossShift provider configuration failed validation")
    })?;
    credentials
        .validate()
        .map_err(|_| JcodeNodeError::configuration("GlossShift credentials failed validation"))?;
    CompatibilityConfig::try_from((app, credentials))
}

impl TryFrom<(AppConfigDto, CredentialsFileDto)> for CompatibilityConfig {
    type Error = JcodeNodeError;

    fn try_from(
        (app, credentials): (AppConfigDto, CredentialsFileDto),
    ) -> Result<Self, Self::Error> {
        let provider = app
            .providers
            .get(app.active_provider.trim())
            .ok_or_else(|| {
                JcodeNodeError::configuration("GlossShift active provider is not configured")
            })?;
        let api_key = credentials
            .credentials
            .get(provider.credential.trim())
            .ok_or_else(|| {
                JcodeNodeError::configuration("GlossShift credential is not configured")
            })?
            .api_key
            .trim();

        // Future provider-profile integration belongs here. This temporary adapter deliberately maps
        // GlossShift's selected API key and model onto jcode's built-in opencode-go profile only.
        Ok(Self {
            base_url: provider.base_url.trim().to_owned(),
            model: provider.model.trim().to_owned(),
            api_key: api_key.to_owned(),
        })
    }
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde validator signature."
)]
fn non_blank(value: &str, _: &()) -> garde::Result {
    if value.trim().is_empty() || value.contains(['\0', '\n', '\r']) {
        return Err(garde::Error::new("must be non-blank single-line text"));
    }
    Ok(())
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde validator signature."
)]
fn validate_api_key(value: &str, context: &()) -> garde::Result {
    non_blank(value, context)?;
    if value.trim() == "replace-me" {
        return Err(garde::Error::new("must not use a template credential"));
    }
    Ok(())
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde validator signature."
)]
fn http_endpoint(value: &str, context: &()) -> garde::Result {
    non_blank(value, context)?;
    let uri = value
        .trim()
        .parse::<topcoat::router::Uri>()
        .map_err(|_| garde::Error::new("must be a valid HTTP endpoint"))?;
    if !matches!(uri.scheme_str(), Some("http" | "https"))
        || uri.host().is_none_or(str::is_empty)
        || uri
            .authority()
            .is_some_and(|authority| authority.as_str().contains('@'))
        || uri.query().is_some()
    {
        return Err(garde::Error::new(
            "must be an HTTP endpoint without embedded credentials or query",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = r#"
active_provider = "selected"
[providers.selected]
base_url = " https://example.com/v1 "
model = " model-1 "
credential = " selected-key "
"#;
    const CREDENTIALS: &str = "[credentials.selected-key]\napi_key = \" secret-value \"\n";

    #[test]
    fn accepted_provider_fields_are_normalized_before_sdk_configuration()
    -> Result<(), JcodeNodeError> {
        let config = decode(APP, CREDENTIALS)?;
        assert_eq!(config.base_url, "https://example.com/v1");
        assert_eq!(config.model, "model-1");
        assert_eq!(config.api_key, "secret-value");
        Ok(())
    }

    #[test]
    fn credentials_parse_errors_do_not_include_secret_source_lines() {
        let error = decode(APP, "[credentials.selected-key]\napi_key = secret-value")
            .err()
            .expect("invalid TOML");
        assert!(!error.to_string().contains("secret-value"));
    }

    #[test]
    fn blank_model_is_rejected_before_sdk_configuration() {
        assert!(matches!(
            decode(&APP.replace("model-1", " "), CREDENTIALS),
            Err(JcodeNodeError::Configuration { .. })
        ));
    }

    #[test]
    fn missing_provider_credential_is_rejected_during_domain_construction() {
        assert!(matches!(
            decode(APP, "[credentials.other]\napi_key = \"secret\""),
            Err(JcodeNodeError::Configuration { .. })
        ));
    }

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
