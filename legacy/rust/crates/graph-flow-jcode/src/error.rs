use graph_flow::GraphError;

/// Failure raised while configuring or executing a jcode-backed task.
#[derive(Debug, thiserror::Error)]
pub enum JcodeNodeError {
    /// A caller-supplied node setting is invalid.
    #[error("jcode node configuration failed: {message}")]
    Configuration {
        /// Actionable configuration diagnostic.
        message: String,
    },
    /// A lifecycle hook rejected the current stage.
    #[error("jcode node hook `{phase}` failed: {message}")]
    Hook {
        /// Stable lifecycle phase that rejected execution.
        phase: &'static str,
        /// Actionable hook diagnostic.
        message: String,
    },
    /// graph-flow context serialization failed.
    #[error("jcode node context update failed: {message}")]
    Context {
        /// graph-flow serialization diagnostic.
        message: String,
    },
    /// The jcode SDK rejected a process, session, or turn operation.
    #[error(transparent)]
    Sdk(#[from] jcode_sdk::Error),
    /// Tokio could not join the blocking SDK task.
    #[error("jcode blocking task failed: {message}")]
    Join {
        /// Tokio join diagnostic.
        message: String,
    },
}

impl JcodeNodeError {
    /// Create a configuration error from an actionable message.
    #[must_use]
    pub fn configuration(message: impl Into<String>) -> Self {
        Self::Configuration {
            message: message.into(),
        }
    }

    /// Create a lifecycle-hook error with its stable phase name.
    #[must_use]
    pub fn hook(phase: &'static str, message: impl Into<String>) -> Self {
        Self::Hook {
            phase,
            message: message.into(),
        }
    }

    /// Translate a graph-flow context error without losing its diagnostic.
    #[must_use]
    pub fn context(error: &GraphError) -> Self {
        Self::Context {
            message: error.to_string(),
        }
    }
}
