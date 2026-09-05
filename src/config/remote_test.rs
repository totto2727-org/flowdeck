use super::TursoRemoteConfig;
use crate::{ApplicationConfig, ApplicationConfigError, StateBackendConfig};

type TestResult = Result<(), ApplicationConfigError>;

macro_rules! accepts_url {
    ($name:ident, $url:literal) => {
        #[test]
        fn $name() -> TestResult {
            let config = TursoRemoteConfig::new($url, "test-token")?;
            assert_eq!(
                config.url(),
                $url,
                "validated URL must reach storage unchanged"
            );
            assert_eq!(
                config.auth_token(),
                "test-token",
                "token must reach storage unchanged"
            );
            Ok(())
        }
    };
}

macro_rules! rejects_url {
    ($name:ident, $url:literal) => {
        #[test]
        fn $name() {
            assert_eq!(
                TursoRemoteConfig::new($url, "test-token"),
                Err(ApplicationConfigError::InvalidTursoRemote),
                "invalid remote URL must return the generic typed error"
            );
        }
    };
}

macro_rules! rejects_token {
    ($name:ident, $token:literal) => {
        #[test]
        fn $name() {
            assert_eq!(
                TursoRemoteConfig::new("https://database.example", $token),
                Err(ApplicationConfigError::InvalidTursoRemote),
                "invalid authentication token must return the generic typed error"
            );
        }
    };
}

accepts_url!(https_remote_is_accepted, "https://database.example");
accepts_url!(libsql_remote_is_accepted, "libsql://database.example");
accepts_url!(http_localhost_is_accepted, "http://localhost:8080");
accepts_url!(http_ipv4_loopback_is_accepted, "http://127.0.0.1:8080");
accepts_url!(http_ipv6_loopback_is_accepted, "http://[::1]:8080");
rejects_url!(http_remote_is_rejected, "http://database.example");
rejects_url!(http_private_network_is_rejected, "http://192.168.0.1");
rejects_url!(http_ipv6_remote_is_rejected, "http://[2001:db8::1]");
rejects_url!(localhost_suffix_is_rejected, "http://localhost.example");
rejects_url!(unsupported_scheme_is_rejected, "ftp://database.example");
rejects_url!(missing_host_is_rejected, "libsql://");
rejects_url!(relative_url_is_rejected, "database.example");
rejects_url!(malformed_ipv6_is_rejected, "https://[broken]");
rejects_url!(invalid_port_is_rejected, "https://database.example:99999");
rejects_url!(username_is_rejected, "https://secret@database.example");
rejects_url!(
    password_is_rejected,
    "libsql://user:secret@database.example"
);
rejects_url!(empty_userinfo_is_rejected, "https://@database.example");
rejects_url!(query_is_rejected, "https://database.example?token=secret");
rejects_url!(empty_query_is_rejected, "https://database.example?");
rejects_url!(fragment_is_rejected, "https://database.example#secret");
rejects_url!(url_whitespace_is_rejected, " https://database.example");
rejects_url!(url_control_is_rejected, "https://data\nbase.example");
rejects_url!(
    url_backslash_is_rejected,
    "https://database.example\\secret"
);
rejects_token!(empty_token_is_rejected, "");
rejects_token!(blank_token_is_rejected, "   ");
rejects_token!(token_leading_space_is_rejected, " secret");
rejects_token!(token_trailing_space_is_rejected, "secret ");
rejects_token!(token_internal_space_is_rejected, "sec ret");
rejects_token!(token_unicode_whitespace_is_rejected, "sec\u{a0}ret");
rejects_token!(token_newline_is_rejected, "secret\n");
rejects_token!(token_control_is_rejected, "sec\0ret");

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
    let result = TursoRemoteConfig::new("https://secret@private.example", "private token");
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
