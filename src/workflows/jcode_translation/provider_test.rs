use super::*;
use std::{error::Error, fs, process::Command};

const CONFIG: &str = include_str!("../../../tests/fixtures/agents/config.toml");
const CREDENTIALS: &str = include_str!("../../../tests/fixtures/agents/credentials.toml");

type TestResult = Result<(), Box<dyn Error>>;

fn fixture(
    config: &str,
    credentials: &str,
) -> Result<(tempfile::TempDir, AgentConfigPaths), Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    let paths = AgentConfigPaths::new(
        directory.path().join("config.toml"),
        directory.path().join("credentials.toml"),
    )?;
    fs::write(paths.config(), config)?;
    fs::write(paths.credentials(), credentials)?;
    Ok((directory, paths))
}

fn env_value<'a>(options: &'a LaunchOptions, name: &str) -> Option<&'a str> {
    options
        .env
        .get(&OsString::from(name))
        .and_then(|value| value.to_str())
}

#[test]
fn selected_shared_provider_configures_the_existing_jcode_transport() -> TestResult {
    let (_directory, paths) = fixture(
        CONFIG,
        &CREDENTIALS.replace("synthetic-translation-key", "  synthetic-translation-key  "),
    )?;
    let config = load(paths)?;
    assert_eq!(config.active_provider_name(), "translation");
    let mut options = LaunchOptions::default();
    options.env.insert("APP_SETTING".into(), "preserved".into());
    apply_provider_environment(&mut options, config.active_provider()?);
    for (name, expected) in [
        ("APP_SETTING", "preserved"),
        (
            "JCODE_OPENROUTER_API_BASE",
            "https://gateway.invalid/custom/v1",
        ),
        ("JCODE_OPENROUTER_MODEL", "translation-model"),
        ("JCODE_OPENROUTER_STATIC_MODELS", "translation-model"),
        ("JCODE_OPENROUTER_API_KEY_NAME", "FLOWDECK_BRIDGE_KEY"),
        ("JCODE_OPENROUTER_CACHE_NAMESPACE", "flowdeck-shared"),
        ("JCODE_OPENROUTER_PROVIDER_FEATURES", "0"),
        ("JCODE_OPENROUTER_TRANSPORT_STATE", "direct-api-key"),
    ] {
        assert_eq!(env_value(&options, name), Some(expected), "{name}");
    }
    let extra: serde_json::Value = serde_json::from_str(
        env_value(&options, "JCODE_OPENAI_EXTRA_BODY").ok_or("missing extra body")?,
    )?;
    assert_eq!(
        extra,
        serde_json::json!({"reasoning_effort": "low", "chat_template_kwargs": {"thinking": true}})
    );
    assert!(env_value(&options, "JCODE_PROVIDER_PROFILE_NAME").is_none());
    assert!(env_value(&options, "JCODE_PROVIDER_PROFILE_ACTIVE").is_none());
    Ok(())
}

#[test]
fn empty_request_parameters_override_inherited_values() -> TestResult {
    let source = CONFIG
        .split("[providers.translation.request_parameters]")
        .next()
        .ok_or("missing fixture")?;
    let (_directory, paths) = fixture(source, CREDENTIALS)?;
    let config = load(paths)?;
    let mut options = LaunchOptions::default();
    options.env.insert(
        "JCODE_OPENAI_EXTRA_BODY".into(),
        r#"{"inherited":true}"#.into(),
    );
    apply_provider_environment(&mut options, config.active_provider()?);
    assert_eq!(env_value(&options, "JCODE_OPENAI_EXTRA_BODY"), Some("{}"));
    Ok(())
}

#[test]
fn invalid_shared_settings_fail_without_exposing_values() -> TestResult {
    for (config, credentials, expected) in [
        (
            CONFIG.replace(
                "active_provider = \"translation\"",
                "active_provider = \"missing\"",
            ),
            CREDENTIALS.to_owned(),
            "active provider",
        ),
        (
            CONFIG.replace("translation-key", "missing-key"),
            CREDENTIALS.to_owned(),
            "not configured",
        ),
        (
            CONFIG.replace("translation-model", ""),
            CREDENTIALS.to_owned(),
            "non-empty model",
        ),
        (
            CONFIG.replace("https://gateway.invalid/custom/v1", "not-a-url"),
            CREDENTIALS.to_owned(),
            "invalid base_url",
        ),
        (
            CONFIG.to_owned(),
            CREDENTIALS.replace("synthetic-translation-key", ""),
            "empty api_key",
        ),
        (
            CONFIG.to_owned(),
            CREDENTIALS.replace("synthetic-translation-key", "replace-me"),
            "template value",
        ),
        (
            CONFIG.to_owned(),
            "[credentials.translation-key]\napi_key = \"synthetic-secret-invalid".to_owned(),
            "credentials.toml is invalid",
        ),
        (
            format!("{CONFIG}\ninvalid = [\"synthetic-secret-invalid"),
            CREDENTIALS.to_owned(),
            "config.toml is invalid",
        ),
        (
            CONFIG.replace(
                "synthetic-fixed-header",
                "synthetic-secret-header\\ninvalid",
            ),
            CREDENTIALS.to_owned(),
            "invalid provider header value",
        ),
    ] {
        let (_directory, paths) = fixture(&config, &credentials)?;
        let Err(error) = load(paths) else {
            return Err("invalid configuration was accepted".into());
        };
        let message = error.to_string();
        assert!(message.contains(expected), "{message}");
        assert!(!message.contains("synthetic-secret"));
        assert!(!message.contains("synthetic-translation-key"));
    }
    Ok(())
}

#[test]
fn missing_files_are_not_initialized() -> TestResult {
    let directory = tempfile::tempdir()?;
    let paths = AgentConfigPaths::new(
        directory.path().join("config.toml"),
        directory.path().join("credentials.toml"),
    )?;
    assert!(load(paths.clone()).is_err());
    assert!(!paths.config().exists());
    assert!(!paths.credentials().exists());
    Ok(())
}

// Environment resolution is tested in a child process, never by mutating the test runner's
// environment or accessing the user's home. No app or jcode process is launched.
#[test]
fn standard_paths_use_only_the_isolated_home_or_absolute_override() -> TestResult {
    const CHILD: &str = "FLOWDECK_TEST_AGENT_PATHS";
    if std::env::var_os(CHILD).is_some() {
        let mut options = LaunchOptions::default();
        let config = load_standard()?;
        apply_provider_environment(&mut options, config.active_provider()?);
        assert_eq!(
            env_value(&options, "JCODE_OPENROUTER_MODEL"),
            Some("translation-model")
        );
        let session = session_options(Path::new("/synthetic-workspace"));
        let description = format!("{session:?}");
        assert!(description.contains("model: None"));
        assert!(description.contains("/synthetic-workspace"));
        assert!(!description.contains("synthetic-translation-key"));
        return Ok(());
    }
    let (directory, paths) = fixture(CONFIG, CREDENTIALS)?;
    let home = directory.path().join("home");
    fs::create_dir_all(home.join(".agents"))?;
    fs::write(home.join(".agents/config.toml"), CONFIG)?;
    fs::write(home.join(".agents/credentials.toml"), CREDENTIALS)?;
    for override_path in [
        None,
        Some(paths.config()),
        Some(Path::new("relative/config.toml")),
        Some(directory.path().join("missing/config.toml").as_path()),
    ] {
        let mut command = Command::new(std::env::current_exe()?);
        command.args(["--exact", "workflows::jcode_translation::provider::tests::standard_paths_use_only_the_isolated_home_or_absolute_override"])
            .env(CHILD, "1").env("HOME", &home).env_remove("AGENTS_CONFIG").current_dir(directory.path());
        if let Some(path) = override_path {
            command.env("AGENTS_CONFIG", path);
        }
        let output = command.output()?;
        let valid = override_path.is_none_or(|path| path == paths.config());
        assert_eq!(
            output.status.success(),
            valid,
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
    Ok(())
}
