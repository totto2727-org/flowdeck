use crate::{AfterLaunch, BeforeLaunch, JcodeNodeError, JcodeRuntimeHooks};
use jcode_sdk::{JcodeClient, LaunchOptions, SessionInfo};
use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex, MutexGuard},
};

/// graph-flow context key used by applications to carry a shared session name.
pub const JCODE_SESSION_KEY: &str = "jcode_session_key";

/// Stable name used to share one jcode session across graph-flow nodes.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SessionKey(String);

impl SessionKey {
    /// Create a non-empty session key.
    ///
    /// # Errors
    /// Returns a configuration error when the key is blank.
    pub fn new(value: impl Into<String>) -> Result<Self, JcodeNodeError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(JcodeNodeError::configuration(
                "a shared jcode session key must not be blank",
            ));
        }
        Ok(Self(value))
    }

    /// Read the stable key value.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Select whether a node starts a session or resumes a named session.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
#[non_exhaustive]
pub enum SessionMode {
    /// Create a distinct session for this node execution.
    #[default]
    New,
    /// Reuse one process-local session for this key, creating it on first use.
    Reuse(SessionKey),
}

impl SessionMode {
    /// Select a shared session by a non-empty workflow-owned key.
    ///
    /// # Errors
    /// Returns a configuration error when the key is blank.
    pub fn reuse(key: impl Into<String>) -> Result<Self, JcodeNodeError> {
        SessionKey::new(key).map(Self::Reuse)
    }
}

struct ManagedSession {
    info: SessionInfo,
    turn: Mutex<()>,
}

impl ManagedSession {
    const fn info(&self) -> &SessionInfo {
        &self.info
    }

    fn lock_turn(&self) -> MutexGuard<'_, ()> {
        self.turn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// One long-lived jcode client and its process-local named session registry.
pub struct JcodeRuntime {
    client: JcodeClient,
    sessions: Mutex<HashMap<SessionKey, Arc<ManagedSession>>>,
}

impl JcodeRuntime {
    /// Launch and own exactly one private jcode process.
    ///
    /// # Errors
    /// Returns an SDK or hook error when the process cannot become ready.
    pub fn launch(options: LaunchOptions) -> Result<Self, JcodeNodeError> {
        Self::launch_with_hooks(options, &())
    }

    /// Launch one private process with initialization hooks run exactly once.
    ///
    /// # Errors
    /// Returns an SDK or hook error when initialization cannot complete.
    pub fn launch_with_hooks<H>(
        mut options: LaunchOptions,
        hooks: &H,
    ) -> Result<Self, JcodeNodeError>
    where
        H: JcodeRuntimeHooks,
    {
        hooks.before_launch(BeforeLaunch {
            options: &mut options,
        })?;
        let runtime = Self::from_client(JcodeClient::launch(options)?);
        hooks.after_launch(AfterLaunch {
            client: &runtime.client,
        })?;
        Ok(runtime)
    }

    /// Wrap a connected SDK client, primarily for embedding and deterministic tests.
    #[must_use]
    pub fn from_client(client: JcodeClient) -> Self {
        Self {
            client,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Access the shared high-level SDK client for process-wide initialization.
    #[must_use]
    pub const fn client(&self) -> &JcodeClient {
        &self.client
    }

    pub(crate) fn with_session<T, F>(
        &self,
        mode: SessionMode,
        working_dir: Option<String>,
        operation: F,
    ) -> Result<T, JcodeNodeError>
    where
        F: FnOnce(&JcodeClient, &SessionInfo) -> Result<T, JcodeNodeError>,
    {
        let session = self.session(mode, working_dir)?;
        let _turn = session.lock_turn();
        operation(&self.client, session.info())
    }

    fn session(
        &self,
        mode: SessionMode,
        working_dir: Option<String>,
    ) -> Result<Arc<ManagedSession>, JcodeNodeError> {
        match mode {
            SessionMode::New => self.create_session(working_dir),
            SessionMode::Reuse(key) => {
                let mut sessions = self
                    .sessions
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(session) = sessions.get(&key) {
                    ensure_working_dir(&key, session.info(), working_dir.as_deref())?;
                    return Ok(Arc::clone(session));
                }
                let session = self.create_session(working_dir)?;
                sessions.insert(key, Arc::clone(&session));
                drop(sessions);
                Ok(session)
            }
        }
    }

    fn create_session(
        &self,
        working_dir: Option<String>,
    ) -> Result<Arc<ManagedSession>, JcodeNodeError> {
        Ok(Arc::new(ManagedSession {
            info: self.client.create_session(working_dir)?,
            turn: Mutex::new(()),
        }))
    }
}

impl fmt::Debug for JcodeRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let session_count = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len();
        formatter
            .debug_struct("JcodeRuntime")
            .field("server", &self.client.server)
            .field("session_count", &session_count)
            .finish_non_exhaustive()
    }
}

fn ensure_working_dir(
    key: &SessionKey,
    session: &SessionInfo,
    requested: Option<&str>,
) -> Result<(), JcodeNodeError> {
    if let Some(requested) = requested
        && session.working_dir.as_deref() != Some(requested)
    {
        return Err(JcodeNodeError::configuration(format!(
            "shared jcode session `{}` already uses a different working directory",
            key.as_str()
        )));
    }
    Ok(())
}
