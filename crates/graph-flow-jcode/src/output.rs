use garde::Validate;
use graph_flow::Context;
use jcode_sdk::TurnResult;
use serde::{Deserialize, Serialize};

use crate::JcodeNodeError;

/// Stable graph-flow context key containing the latest jcode turn output.
pub const JCODE_OUTPUT_KEY: &str = "jcode_output";

/// Validated result of a jcode turn, independent of its storage representation.
#[derive(Clone, Debug, PartialEq, Eq)]
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

/// Tool-call result retained by the workflow.
#[derive(Clone, Debug, PartialEq, Eq)]
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

/// Provider token accounting retained by the workflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JcodeUsage {
    /// Input tokens consumed.
    pub input: u64,
    /// Output tokens produced.
    pub output: u64,
    /// Cached input tokens reported by the provider.
    pub cache_read_input: Option<u64>,
}

/// Wire representation used only at graph-flow context and trace boundaries.
#[derive(Clone, Debug, Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct JcodeOutputDto {
    #[garde(custom(non_blank))]
    session_id: String,
    #[garde(skip)]
    text: String,
    #[garde(skip)]
    reasoning: String,
    #[garde(dive)]
    tool_calls: Vec<ToolCallDto>,
    #[garde(dive)]
    usage: Option<UsageDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct ToolCallDto {
    #[garde(custom(non_blank))]
    call_id: String,
    #[garde(custom(non_blank))]
    name: String,
    #[garde(skip)]
    output: String,
    #[garde(skip)]
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct UsageDto {
    #[garde(skip)]
    input: u64,
    #[garde(skip)]
    output: u64,
    #[garde(skip)]
    cache_read_input: Option<u64>,
}

impl JcodeOutput {
    /// Decode and validate an output retained in graph-flow context.
    ///
    /// # Errors
    /// Returns a configuration error if the retained wire output is invalid.
    pub fn from_context(context: &Context) -> Result<Option<Self>, JcodeNodeError> {
        let Some(value) = context.get::<serde_json::Value>(JCODE_OUTPUT_KEY) else {
            return Ok(None);
        };
        let dto = serde_json::from_value::<JcodeOutputDto>(value).map_err(|_| {
            JcodeNodeError::configuration("jcode output has invalid JSON structure")
        })?;
        Self::try_from(dto).map(Some)
    }

    /// Project a domain output into its outbound storage or trace representation.
    #[must_use]
    pub fn to_dto(&self) -> JcodeOutputDto {
        JcodeOutputDto {
            session_id: self.session_id.clone(),
            text: self.text.clone(),
            reasoning: self.reasoning.clone(),
            tool_calls: self
                .tool_calls
                .iter()
                .map(|call| ToolCallDto {
                    call_id: call.call_id.clone(),
                    name: call.name.clone(),
                    output: call.output.clone(),
                    error: call.error.clone(),
                })
                .collect(),
            usage: self.usage.map(|usage| UsageDto {
                input: usage.input,
                output: usage.output,
                cache_read_input: usage.cache_read_input,
            }),
        }
    }

    pub(crate) fn from_turn(
        session_id: String,
        result: TurnResult,
    ) -> Result<Self, JcodeNodeError> {
        Self::try_from(JcodeOutputDto {
            session_id,
            text: result.text,
            reasoning: result.reasoning,
            tool_calls: result
                .tool_calls
                .into_iter()
                .map(|call| ToolCallDto {
                    call_id: call.call_id,
                    name: call.name,
                    output: call.output,
                    error: call.error,
                })
                .collect(),
            usage: result.usage.map(|usage| UsageDto {
                input: usage.input,
                output: usage.output,
                cache_read_input: usage.cache_read_input,
            }),
        })
    }
}

impl TryFrom<JcodeOutputDto> for JcodeOutput {
    type Error = JcodeNodeError;

    fn try_from(dto: JcodeOutputDto) -> Result<Self, Self::Error> {
        dto.validate()
            .map_err(|_| JcodeNodeError::configuration("jcode output failed validation"))?;
        let mut call_ids = std::collections::HashSet::with_capacity(dto.tool_calls.len());
        if dto
            .tool_calls
            .iter()
            .any(|call| !call_ids.insert(&call.call_id))
        {
            return Err(JcodeNodeError::configuration(
                "jcode output contains duplicate tool call IDs",
            ));
        }
        Ok(Self {
            session_id: dto.session_id,
            text: dto.text,
            reasoning: dto.reasoning,
            tool_calls: dto
                .tool_calls
                .into_iter()
                .map(|call| JcodeToolCall {
                    call_id: call.call_id,
                    name: call.name,
                    output: call.output,
                    error: call.error,
                })
                .collect(),
            usage: dto.usage.map(|usage| JcodeUsage {
                input: usage.input,
                output: usage.output,
                cache_read_input: usage.cache_read_input,
            }),
        })
    }
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde validator signature."
)]
fn non_blank(value: &str, _: &()) -> garde::Result {
    if value.trim().is_empty() {
        return Err(garde::Error::new("must not be blank"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn duplicate_tool_call_ids_fail_domain_construction() -> Result<(), Box<dyn std::error::Error>>
    {
        let context = Context::new();
        context.set(
            JCODE_OUTPUT_KEY,
            json!({
                "session_id": "session-1", "text": "", "reasoning": "", "usage": null,
                "tool_calls": [
                    { "call_id": "same", "name": "read_file", "output": "", "error": null },
                    { "call_id": "same", "name": "write_file", "output": "", "error": null }
                ]
            }),
        )?;
        assert!(matches!(
            JcodeOutput::from_context(&context),
            Err(JcodeNodeError::Configuration { .. })
        ));
        Ok(())
    }

    #[test]
    fn malformed_retained_output_is_an_error_not_missing() -> Result<(), Box<dyn std::error::Error>>
    {
        let context = Context::new();
        context.set(JCODE_OUTPUT_KEY, json!({"session_id": 42}))?;
        assert!(matches!(
            JcodeOutput::from_context(&context),
            Err(JcodeNodeError::Configuration { .. })
        ));
        Ok(())
    }

    #[test]
    fn blank_retained_session_fails_semantic_validation() -> Result<(), Box<dyn std::error::Error>>
    {
        let context = Context::new();
        context.set(
            JCODE_OUTPUT_KEY,
            json!({
                "session_id": " ", "text": "", "reasoning": "", "tool_calls": [], "usage": null
            }),
        )?;
        assert!(matches!(
            JcodeOutput::from_context(&context),
            Err(JcodeNodeError::Configuration { .. })
        ));
        Ok(())
    }

    #[test]
    fn output_dto_round_trip_preserves_optional_provider_fields()
    -> Result<(), Box<dyn std::error::Error>> {
        let output = JcodeOutput {
            session_id: "session-1".to_owned(),
            text: String::new(),
            reasoning: "reasoning".to_owned(),
            tool_calls: vec![JcodeToolCall {
                call_id: "call-1".to_owned(),
                name: "read_file".to_owned(),
                output: "body".to_owned(),
                error: None,
            }],
            usage: Some(JcodeUsage {
                input: 0,
                output: 3,
                cache_read_input: Some(0),
            }),
        };
        let context = Context::new();
        context.set(JCODE_OUTPUT_KEY, output.to_dto())?;
        assert_eq!(JcodeOutput::from_context(&context)?, Some(output));
        Ok(())
    }
}
