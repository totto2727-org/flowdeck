use super::*;
use crate::WorkflowError;
use serde_json::json;

type TestResult = Result<(), Box<dyn std::error::Error>>;
const TOKEN: &str = "a35200d1-cd32-4ab5-a619-6a5d83220283";

fn delay_context(value: &Value) -> Result<Context, GraphError> {
    let context = Context::new();
    context.set(
        WORKFLOW_INPUT_KEY,
        json!({ "label": "test", "step_delay_ms": value }),
    )?;
    context.set(INPUT_SUMMARY_KEY, "test")?;
    Ok(context)
}

#[test]
fn input_delay_accepts_lower_bound_as_domain_duration() -> TestResult {
    let context = delay_context(&json!(100))?;
    assert_eq!(
        input_delay(&context, "step_delay_ms")?,
        Duration::from_millis(100)
    );
    Ok(())
}

#[test]
fn input_delay_accepts_upper_bound_as_domain_duration() -> TestResult {
    let context = delay_context(&json!(2000))?;
    assert_eq!(
        input_delay(&context, "step_delay_ms")?,
        Duration::from_secs(2)
    );
    Ok(())
}

#[test]
fn input_delay_rejects_below_minimum() -> TestResult {
    let context = delay_context(&json!(99))?;
    assert!(matches!(
        input_delay(&context, "step_delay_ms"),
        Err(GraphError::ContextError(_))
    ));
    Ok(())
}

#[test]
fn input_delay_rejects_numeric_strings() -> TestResult {
    let context = delay_context(&json!("100"))?;
    assert!(matches!(
        input_delay(&context, "step_delay_ms"),
        Err(GraphError::ContextError(_))
    ));
    Ok(())
}

#[tokio::test]
async fn corrupt_huge_delay_fails_task_before_sleeping() -> TestResult {
    let context = delay_context(&json!(u64::MAX))?;
    let node = task(
        "prepare",
        TaskBehavior::Continue,
        TaskDelay::InputMilliseconds("step_delay_ms"),
    );
    let result = tokio::time::timeout(Duration::from_millis(100), node.run(context)).await?;
    assert!(matches!(result, Err(GraphError::ContextError(_))));
    Ok(())
}

#[test]
fn absent_optional_trace_fields_remain_null() -> TestResult {
    let context = delay_context(&json!(100))?;
    assert_eq!(
        project_trace(&context, "prepare")?,
        json!({
            "input": { "label": "test", "step_delay_ms": 100 },
            "task_token": null, "branch_selected": null, "branch_token": null
        })
    );
    Ok(())
}

#[test]
fn malformed_optional_token_is_not_silently_treated_as_absent() -> TestResult {
    let context = delay_context(&json!(100))?;
    context.set("task_token:prepare", false)?;
    assert!(matches!(
        project_trace(&context, "prepare"),
        Err(WorkflowError::Trace { .. })
    ));
    Ok(())
}

#[test]
fn malformed_uuid_token_fails_semantic_validation() -> TestResult {
    let context = delay_context(&json!(100))?;
    context.set("task_token:prepare", "not-a-uuid")?;
    assert!(matches!(
        project_trace(&context, "prepare"),
        Err(WorkflowError::Trace { .. })
    ));
    Ok(())
}

#[test]
fn malformed_branch_boolean_is_not_silently_treated_as_absent() -> TestResult {
    let context = delay_context(&json!(100))?;
    context.set(BRANCH_KEY, "true")?;
    context.set(BRANCH_TOKEN_KEY, TOKEN)?;
    assert!(matches!(
        project_trace(&context, "prepare"),
        Err(WorkflowError::Trace { .. })
    ));
    Ok(())
}

#[test]
fn branch_selection_without_token_fails_domain_construction() -> TestResult {
    let context = delay_context(&json!(100))?;
    context.set(BRANCH_KEY, true)?;
    assert!(matches!(
        project_trace(&context, "prepare"),
        Err(WorkflowError::Trace { .. })
    ));
    Ok(())
}

#[test]
fn valid_trace_keeps_the_existing_outbound_shape() -> TestResult {
    let context = delay_context(&json!(100))?;
    context.set("task_token:prepare", TOKEN)?;
    context.set(BRANCH_KEY, true)?;
    context.set(BRANCH_TOKEN_KEY, TOKEN)?;
    assert_eq!(
        project_trace(&context, "prepare")?,
        json!({
            "input": { "label": "test", "step_delay_ms": 100 },
            "task_token": TOKEN, "branch_selected": true, "branch_token": TOKEN
        })
    );
    Ok(())
}

#[test]
fn explicit_null_token_is_corruption_not_absence() -> TestResult {
    let context = delay_context(&json!(100))?;
    context.set("task_token:prepare", Value::Null)?;
    assert!(matches!(
        project_trace(&context, "prepare"),
        Err(WorkflowError::Trace { .. })
    ));
    Ok(())
}
