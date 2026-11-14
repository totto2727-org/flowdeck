use jcode_sdk::{ToolCall, TurnResult, Usage};
use serde::{Deserialize, Serialize};

/// Stable graph-flow context key containing the latest jcode turn output.
pub const JCODE_OUTPUT_KEY: &str = "jcode_output";

/// Serializable result retained in graph-flow context after a jcode turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JcodeOutput {
    /// jcode session that executed the task.
    pub session_id: String,
    /// Assistant response text.
    pub text: String,
    /// Provider reasoning text when exposed by jcode.
    pub reasoning: String,
    /// Completed tool calls made by the coding agent.
    pub tool_calls: Vec<JcodeToolCall>,
    /// Token accounting when exposed by the provider.
    pub usage: Option<JcodeUsage>,
}

/// Serializable tool-call result retained by the workflow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JcodeToolCall {
    /// jcode call identifier.
    pub call_id: String,
    /// Tool name selected by the coding agent.
    pub name: String,
    /// Tool output.
    pub output: String,
    /// Tool error when execution failed.
    pub error: Option<String>,
}

/// Serializable provider token accounting retained by the workflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JcodeUsage {
    /// Input tokens consumed.
    pub input: u64,
    /// Output tokens produced.
    pub output: u64,
    /// Cached input tokens reported by the provider.
    pub cache_read_input: Option<u64>,
}

impl JcodeOutput {
    pub(crate) fn from_turn(session_id: String, result: TurnResult) -> Self {
        Self {
            session_id,
            text: result.text,
            reasoning: result.reasoning,
            tool_calls: result
                .tool_calls
                .into_iter()
                .map(JcodeToolCall::from)
                .collect(),
            usage: result.usage.map(JcodeUsage::from),
        }
    }
}

impl From<ToolCall> for JcodeToolCall {
    fn from(call: ToolCall) -> Self {
        Self {
            call_id: call.call_id,
            name: call.name,
            output: call.output,
            error: call.error,
        }
    }
}

impl From<Usage> for JcodeUsage {
    fn from(usage: Usage) -> Self {
        Self {
            input: usage.input,
            output: usage.output,
            cache_read_input: usage.cache_read_input,
        }
    }
}
