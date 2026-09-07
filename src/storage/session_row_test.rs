use graph_flow::Session;
use serde_json::{Value, json};

use super::SessionRow;
use crate::WorkflowError;

fn session() -> Session {
    Session::new_from_task("run-1".to_owned(), "start").with_graph_id("demo")
}

#[test]
fn round_trip_preserves_fixed_fields_nested_context_and_chat_history()
-> Result<(), Box<dyn std::error::Error>> {
    let mut original = session();
    original.version = 42;
    original.status_message = Some("paused for the next step".to_owned());
    original.context.set(
        "opaque-workflow-value",
        json!({"nested": [null, true, 3.5, {"unicode": "日本語"}]}),
    )?;
    original
        .context
        .set("an-independent-key", json!([1, 2, 3]))?;
    original.context.add_user_message("question".to_owned());
    original.context.add_assistant_message("answer".to_owned());

    let row = SessionRow::from_session(&original)?;

    assert_eq!(row.id, "run-1");
    assert_eq!(row.version, 42);
    assert_eq!(row.graph_id, "demo");
    assert_eq!(row.current_task_id, "start");
    assert_eq!(row.status_message, original.status_message);
    assert_eq!(
        serde_json::from_str::<Value>(&row.context)?,
        serde_json::to_value(&original.context)?
    );

    let restored = row.into_session()?;
    assert_eq!(
        serde_json::to_value(&restored)?,
        serde_json::to_value(&original)?
    );
    assert_eq!(restored.context.chat_history_len(), 2);
    Ok(())
}

#[test]
fn invalid_id_version_and_context_are_rejected_without_echoing_values() {
    let rows = [
        SessionRow {
            id: " \t".to_owned(),
            version: 1,
            graph_id: "demo".to_owned(),
            current_task_id: "start".to_owned(),
            status_message: None,
            context: "{}".to_owned(),
        },
        SessionRow {
            id: "run-1".to_owned(),
            version: 0,
            graph_id: "demo".to_owned(),
            current_task_id: "start".to_owned(),
            status_message: None,
            context: "{}".to_owned(),
        },
        SessionRow {
            id: "run-1".to_owned(),
            version: 1,
            graph_id: "demo".to_owned(),
            current_task_id: "start".to_owned(),
            status_message: None,
            context: "not-json-private-value".to_owned(),
        },
    ];

    for row in rows {
        assert!(matches!(
            row.into_session(),
            Err(WorkflowError::Storage { .. })
        ));
    }
}

#[test]
fn invalid_context_envelope_is_rejected_without_echoing_persisted_values() {
    let private_value = "private-persisted-value";
    let error = SessionRow {
        id: "run-1".to_owned(),
        version: 1,
        graph_id: "demo".to_owned(),
        current_task_id: "start".to_owned(),
        status_message: None,
        context: format!(
            r#"{{"data": [], "chat_history": {{"messages": []}}, "private": "{private_value}"}}"#
        ),
    }
    .into_session()
    .expect_err("invalid graph-flow context envelope must be rejected");

    assert!(matches!(error, WorkflowError::Storage { .. }));
    assert!(!error.to_string().contains(private_value));
}
