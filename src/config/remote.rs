use std::fmt;

use garde::Validate;
use url::{Host, Url};

use super::ApplicationConfigError;

/// Validated remote target for embedded sync with a single writer, not direct SQL.
///
/// Inject externally supplied credentials through Rust application configuration.
/// Neither the URL nor the authentication token is included in debug output.
#[derive(Clone, PartialEq, Eq)]
pub struct TursoRemoteConfig {
    url: String,
    auth_token: String,
}

impl TursoRemoteConfig {
    /// Validate an HTTPS or libsql URL and a nonempty, whitespace-free token.
    /// HTTP is accepted only for loopback hosts in tests and local development.
    ///
    /// # Errors
    /// Returns a generic error for invalid URLs or tokens without revealing input.
    pub fn new(
        url: impl Into<String>,
        auth_token: impl Into<String>,
    ) -> Result<Self, ApplicationConfigError> {
        let input = RemoteInput {
            url: url.into(),
            auth_token: auth_token.into(),
        };
        input
            .validate()
            .map_err(|_| ApplicationConfigError::InvalidTursoRemote)?;
        Ok(Self {
            url: input.url,
            auth_token: input.auth_token,
        })
    }

    /// Return the validated remote URL for the storage adapter.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Return the authentication token for the storage adapter. Do not log it.
    pub fn auth_token(&self) -> &str {
        &self.auth_token
    }
}

impl fmt::Debug for TursoRemoteConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TursoRemoteConfig")
            .field("url", &"[REDACTED]")
            .field("auth_token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Validate)]
struct RemoteInput {
    #[garde(custom(remote_url))]
    url: String,
    #[garde(custom(token))]
    auth_token: String,
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators require a borrowed context."
)]
fn remote_url(value: &str, (): &()) -> garde::Result {
    let invalid = || garde::Error::new("invalid remote URL");
    // URL parsing normalizes some whitespace and empty user information away.
    // Reject those raw forms before accepting the parsed authority.
    if value.chars().any(|c| c.is_whitespace() || c.is_control()) || value.contains('\\') {
        return Err(invalid());
    }
    let authority = value
        .split_once("://")
        .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())
        .ok_or_else(invalid)?;
    let parsed = Url::parse(value).map_err(|_| invalid())?;
    if authority.contains('@')
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.host_str().is_none_or(str::is_empty)
    {
        return Err(invalid());
    }
    match parsed.scheme() {
        "https" | "libsql" => Ok(()),
        "http" => match parsed.host() {
            Some(Host::Domain("localhost")) => Ok(()),
            Some(Host::Ipv4(address)) if address.is_loopback() => Ok(()),
            Some(Host::Ipv6(address)) if address.is_loopback() => Ok(()),
            _ => Err(invalid()),
        },
        _ => Err(invalid()),
    }
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators require a borrowed context."
)]
fn token(value: &str, (): &()) -> garde::Result {
    if value.is_empty() || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        Err(garde::Error::new("invalid authentication token"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "remote_test.rs"]
mod tests;
