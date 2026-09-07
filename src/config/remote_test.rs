use super::TursoRemoteConfig;
use crate::{ApplicationConfig, ApplicationConfigError, StateBackendConfig};

type TestResult = Result<(), ApplicationConfigError>;

#[test]
fn connection_settings_are_passed_through_without_format_validation() -> TestResult {
    let url = "driver-specific:target?option=value#fragment";
    let token = "opaque driver token";
    let remote = TursoRemoteConfig::new(url, token)?;
    assert_eq!(remote.url(), url);
    assert_eq!(remote.auth_token(), token);
    Ok(())
}

#[test]
fn empty_connection_settings_are_rejected() {
    for (url, token) in [("", "token"), ("https://database.example", "")] {
        assert_eq!(
            TursoRemoteConfig::new(url, token),
            Err(ApplicationConfigError::InvalidTursoRemote)
        );
    }
}

#[test]
fn debug_redacts_both_remote_values() -> TestResult {
    let remote = TursoRemoteConfig::new("https://private.example/secret-path", "private-token")?;
    assert_eq!(
        format!("{remote:?}"),
        "TursoRemoteConfig { url: \"[REDACTED]\", auth_token: \"[REDACTED]\" }",
        "remote debug output must contain neither endpoint nor credentials"
    );
    let mut application = ApplicationConfig::local_default();
    let StateBackendConfig::Turso(state) = &mut application.state.backend;
    state.remote = Some(remote);
    let debug = format!("{application:?}");
    assert!(
        !debug.contains("private"),
        "application debug must preserve remote redaction"
    );
    Ok(())
}

#[test]
fn clone_preserves_validated_configuration() -> TestResult {
    let remote = TursoRemoteConfig::new("libsql://database.example", "test-token")?;
    assert_eq!(
        remote.clone(),
        remote,
        "cloning must preserve remote configuration"
    );
    Ok(())
}

#[test]
fn validation_error_redacts_supplied_secrets() {
    let result = TursoRemoteConfig::new("", "private token");
    assert_eq!(
        result,
        Err(ApplicationConfigError::InvalidTursoRemote),
        "secrets must produce a payload-free error"
    );
    let error = ApplicationConfigError::InvalidTursoRemote;
    assert_eq!(
        error.to_string(),
        "invalid Turso remote configuration",
        "display must not expose submitted inputs"
    );
    assert_eq!(
        format!("{error:?}"),
        "InvalidTursoRemote",
        "debug must not expose submitted inputs"
    );
}
