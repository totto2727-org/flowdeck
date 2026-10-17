use std::fmt;

/// One provider credential applied through the jcode SDK before session creation.
pub struct ProviderCredential {
    provider: String,
    api_key: String,
}

impl ProviderCredential {
    /// Create a credential without exposing its API key through `Debug`.
    pub fn new(provider: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            api_key: api_key.into(),
        }
    }

    pub(crate) fn provider(&self) -> &str {
        &self.provider
    }

    pub(crate) fn api_key(&self) -> &str {
        &self.api_key
    }
}

impl fmt::Debug for ProviderCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderCredential")
            .field("provider", &self.provider)
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}

/// Settings applied at the jcode session boundary.
#[derive(Default, Debug)]
#[must_use]
pub struct SessionOptions {
    pub(crate) working_dir: Option<String>,
    pub(crate) credentials: Vec<ProviderCredential>,
    pub(crate) model: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
}

impl SessionOptions {
    /// Override the working directory passed to `create_session`.
    pub fn with_working_dir(mut self, working_dir: impl Into<String>) -> Self {
        self.working_dir = Some(working_dir.into());
        self
    }

    /// Add a provider credential to persist in the isolated jcode instance.
    pub fn with_credential(mut self, credential: ProviderCredential) -> Self {
        self.credentials.push(credential);
        self
    }

    /// Select a jcode model after session creation.
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Select the provider-supported reasoning effort after session creation.
    pub fn with_reasoning_effort(mut self, effort: impl Into<String>) -> Self {
        self.reasoning_effort = Some(effort.into());
        self
    }
}
