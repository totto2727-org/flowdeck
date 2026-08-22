use crate::{AfterLaunch, BeforeLaunch, JcodeNodeError, JcodeProcessHooks};
use jcode_sdk::{JcodeClient, LaunchOptions, SessionInfo};
use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
};

type ClientFactory = dyn Fn() -> Result<JcodeClient, JcodeNodeError> + Send + Sync + 'static;

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

struct JcodeProcess {
    client: JcodeClient,
    sessions: Mutex<HashMap<SessionKey, Arc<ManagedSession>>>,
}

impl JcodeProcess {
    fn new(client: JcodeClient) -> Self {
        Self {
            client,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn with_session<T, F>(
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

/// Lazily owns one jcode process and its process-local named session registry.
pub struct JcodeProcessScope {
    process: OnceLock<JcodeProcess>,
    initialize: Mutex<()>,
    client_factory: Box<ClientFactory>,
}

impl JcodeProcessScope {
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
        H: JcodeProcessHooks,
    {
        hooks.before_launch(BeforeLaunch {
            options: &mut options,
        })?;
        let client = JcodeClient::launch(options)?;
        hooks.after_launch(AfterLaunch { client: &client })?;
        Ok(Self::from_client(client))
    }

    /// Create a retryable scope whose client is initialized on the first node execution.
    #[must_use]
    pub fn deferred<F>(client_factory: F) -> Self
    where
        F: Fn() -> Result<JcodeClient, JcodeNodeError> + Send + Sync + 'static,
    {
        Self {
            process: OnceLock::new(),
            initialize: Mutex::new(()),
            client_factory: Box::new(client_factory),
        }
    }

    /// Create a retryable scope that launches jcode from options produced on first use.
    #[must_use]
    pub fn deferred_launch<F>(options_factory: F) -> Self
    where
        F: Fn() -> LaunchOptions + Send + Sync + 'static,
    {
        Self::deferred(move || Ok(JcodeClient::launch(options_factory())?))
    }

    /// Create a retryable scope with process hooks run for each launch attempt.
    #[must_use]
    pub fn deferred_launch_with_hooks<F, H>(options_factory: F, hooks: H) -> Self
    where
        F: Fn() -> LaunchOptions + Send + Sync + 'static,
        H: JcodeProcessHooks + 'static,
    {
        Self::deferred(move || {
            let mut options = options_factory();
            hooks.before_launch(BeforeLaunch {
                options: &mut options,
            })?;
            let client = JcodeClient::launch(options)?;
            hooks.after_launch(AfterLaunch { client: &client })?;
            Ok(client)
        })
    }

    /// Wrap a connected SDK client, primarily for embedding and deterministic tests.
    #[must_use]
    pub fn from_client(client: JcodeClient) -> Self {
        let process = OnceLock::new();
        let _ = process.set(JcodeProcess::new(client));
        Self {
            process,
            initialize: Mutex::new(()),
            client_factory: Box::new(|| {
                Err(JcodeNodeError::configuration(
                    "an initialized jcode process scope cannot relaunch its client",
                ))
            }),
        }
    }

    /// Access the shared high-level SDK client for process-wide initialization.
    ///
    /// # Errors
    /// Returns the launch or hook failure. A later call retries initialization.
    pub fn client(&self) -> Result<&JcodeClient, JcodeNodeError> {
        self.process().map(|process| &process.client)
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
        self.process()?.with_session(mode, working_dir, operation)
    }

    fn process(&self) -> Result<&JcodeProcess, JcodeNodeError> {
        if let Some(process) = self.process.get() {
            return Ok(process);
        }
        let _initialize = self
            .initialize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(process) = self.process.get() {
            return Ok(process);
        }
        let process = JcodeProcess::new((self.client_factory)()?);
        self.process
            .set(process)
            .map_err(|_| JcodeNodeError::configuration("jcode process initialized twice"))?;
        self.process.get().ok_or_else(|| {
            JcodeNodeError::configuration("jcode process initialization was not published")
        })
    }
}

impl fmt::Debug for JcodeProcessScope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut scope = formatter.debug_struct("JcodeProcessScope");
        if let Some(process) = self.process.get() {
            let session_count = process
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .len();
            scope
                .field("server", &process.client.server)
                .field("session_count", &session_count);
        } else {
            scope.field("initialized", &false);
        }
        scope.finish_non_exhaustive()
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
