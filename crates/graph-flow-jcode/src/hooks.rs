use crate::JcodeNodeError;
use graph_flow::Context;
use jcode_sdk::{JcodeClient, LaunchOptions, RunOptions, SessionInfo, TurnResult};
use std::fmt;

/// Mutable launch stage passed once before the shared jcode process starts.
pub struct BeforeLaunch<'a> {
    /// Exact SDK options that will be passed to `JcodeClient::launch`.
    pub options: &'a mut LaunchOptions,
}

/// Connected-client stage passed after the jcode process starts.
pub struct AfterLaunch<'a> {
    /// Live high-level jcode SDK client.
    pub client: &'a JcodeClient,
}

/// Mutable turn stage passed after session configuration and before prompting.
pub struct BeforeRun<'a> {
    /// Shared graph-flow context.
    pub context: &'a Context,
    /// Live high-level jcode SDK client.
    pub client: &'a JcodeClient,
    /// Session created for this node execution.
    pub session: &'a SessionInfo,
    /// Prompt that will be sent to the jcode agent.
    pub prompt: &'a mut String,
    /// Exact SDK options that will be passed to `JcodeClient::run`.
    pub options: &'a mut RunOptions,
}

/// Mutable result stage used for validation and workflow-specific post-processing.
pub struct AfterRun<'a> {
    /// Shared graph-flow context.
    pub context: &'a Context,
    /// Live high-level jcode SDK client.
    pub client: &'a JcodeClient,
    /// Session that completed the turn.
    pub session: &'a SessionInfo,
    /// Complete SDK turn result available for validation or normalization.
    pub result: &'a mut TurnResult,
}

/// Lifecycle extension points around one shared jcode process startup.
pub trait JcodeRuntimeHooks: Send + Sync {
    /// Mutate launch settings immediately before the process starts.
    ///
    /// # Errors
    /// Returns an error when launch preparation rejects the execution.
    fn before_launch(&self, _stage: BeforeLaunch<'_>) -> Result<(), JcodeNodeError> {
        Ok(())
    }

    /// Run initialization code once against the connected shared client.
    ///
    /// # Errors
    /// Returns an error when client initialization rejects the execution.
    fn after_launch(&self, _stage: AfterLaunch<'_>) -> Result<(), JcodeNodeError> {
        Ok(())
    }
}

impl JcodeRuntimeHooks for () {}

/// Lifecycle extension points around one complete jcode agent turn.
pub trait JcodeHooks: Send + Sync + 'static {
    /// Read files, enrich the prompt, or update exact SDK run options.
    ///
    /// # Errors
    /// Returns an error when prompt preparation rejects the execution.
    fn before_run(&self, _stage: BeforeRun<'_>) -> Result<(), JcodeNodeError> {
        Ok(())
    }

    /// Validate agent output or inspect resulting files before graph completion.
    ///
    /// # Errors
    /// Returns an error when post-run validation rejects the execution.
    fn after_run(&self, _stage: AfterRun<'_>) -> Result<(), JcodeNodeError> {
        Ok(())
    }
}

impl JcodeHooks for () {}

macro_rules! stage_debug {
    ($stage:ty, $name:literal) => {
        impl fmt::Debug for $stage {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.debug_struct($name).finish_non_exhaustive()
            }
        }
    };
}

stage_debug!(BeforeLaunch<'_>, "BeforeLaunch");
stage_debug!(AfterLaunch<'_>, "AfterLaunch");
stage_debug!(BeforeRun<'_>, "BeforeRun");
stage_debug!(AfterRun<'_>, "AfterRun");
