use std::fmt;

use garde::Validate;

use super::ApplicationConfigError;

/// Remote target for embedded sync with a single writer, not direct SQL.
///
/// Inject externally supplied credentials through Rust application configuration.
/// Neither the URL nor the authentication token is included in debug output.
#[derive(Clone, PartialEq, Eq)]
pub struct TursoRemoteConfig {
    url: String,
    auth_token: String,
}

impl TursoRemoteConfig {
    /// Require nonempty connection settings and pass them unchanged to Turso.
    /// URL and token formats are interpreted by the driver.
    ///
    /// # Errors
    /// Returns a generic error for empty settings without revealing input.
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

    /// Return the remote URL unchanged for the storage adapter.
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
    #[garde(length(min = 1))]
    url: String,
    #[garde(length(min = 1))]
    auth_token: String,
}

#[cfg(test)]
#[path = "remote_test.rs"]
mod tests;
