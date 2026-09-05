use graph_flow::Session;
use serde_json::{Value, json};

use super::{SessionDto, decode, encode};
use crate::WorkflowError;

fn session() -> Session {
    Session::new_from_task("run-1".to_owned(), "start").with_graph_id("demo")
}

fn wire() -> Result<Value, Box<dyn std::error::Error>> {
    Ok(serde_json::from_str(&encode(&session())?)?)
}

fn assert_storage_error(value: &Value) -> Result<(), serde_json::Error> {
    assert!(matches!(
        decode(&serde_json::to_string(value)?),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn round_trip_preserves_graph_flow_fields_context_and_chat()
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

    let encoded = encode(&original)?;
    let restored = decode(&encoded)?;

    assert_eq!(
        serde_json::to_value(&restored)?,
        serde_json::to_value(&original)?
    );
    assert_eq!(restored.context.chat_history_len(), 2);
    assert_eq!(restored.version, 42);
    let dto: SessionDto = serde_json::from_str(&encoded)?;
    assert_eq!(dto.schema_version, 1);
    assert_eq!(dto.version, 42);
    assert_eq!(dto.context, serde_json::to_value(&original.context)?);
    Ok(())
}

#[test]
fn cas_versions_round_trip_without_incrementing_or_defaulting()
-> Result<(), Box<dyn std::error::Error>> {
    for version in [0, 1, 42, u64::try_from(i64::MAX)?] {
        let mut original = session();
        original.version = version;
        assert_eq!(decode(&encode(&original)?)?.version, version);
    }
    Ok(())
}

#[test]
fn corrupt_json_and_wrong_field_types_are_rejected() -> Result<(), Box<dyn std::error::Error>> {
    for invalid in ["{", "null", "[]", "true", "42"] {
        assert!(matches!(
            decode(invalid),
            Err(WorkflowError::Storage { .. })
        ));
    }
    for field in [
        "id",
        "graph_id",
        "current_task_id",
        "version",
        "schema_version",
    ] {
        let mut value = wire()?;
        value[field] = json!({"unexpected": true});
        assert_storage_error(&value)?;
    }
    Ok(())
}

#[test]
fn missing_required_wire_fields_are_rejected() -> Result<(), Box<dyn std::error::Error>> {
    for field in [
        "schema_version",
        "id",
        "graph_id",
        "current_task_id",
        "context",
        "version",
    ] {
        let value = wire()?;
        let Value::Object(mut fields) = value else {
            return Err("session fixture must be an object".into());
        };
        let _ = fields.remove(field);
        assert_storage_error(&Value::Object(fields))?;
    }
    Ok(())
}

#[test]
fn blank_identifiers_are_rejected_on_decode_and_encode() -> Result<(), Box<dyn std::error::Error>> {
    for field in ["id", "graph_id", "current_task_id"] {
        for blank in ["", " \t\n", "\u{3000}"] {
            let mut value = wire()?;
            value[field] = json!(blank);
            assert_storage_error(&value)?;
        }
    }
    let mut original = session();
    original.id.clear();
    assert!(matches!(
        encode(&original),
        Err(WorkflowError::Storage { .. })
    ));
    let mut original = session();
    original.graph_id = "  ".to_owned();
    assert!(matches!(
        encode(&original),
        Err(WorkflowError::Storage { .. })
    ));
    let mut original = session();
    original.current_task_id = "\t".to_owned();
    assert!(matches!(
        encode(&original),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn unsupported_schema_and_out_of_range_cas_versions_are_rejected()
-> Result<(), Box<dyn std::error::Error>> {
    for version in [json!(0), json!(2), json!(256), json!(-1)] {
        let mut value = wire()?;
        value["schema_version"] = version;
        assert_storage_error(&value)?;
    }
    for version in [json!(-1), json!(u64::MAX)] {
        let mut value = wire()?;
        value["version"] = version;
        assert_storage_error(&value)?;
    }
    let mut original = session();
    original.version = u64::MAX;
    assert!(matches!(
        encode(&original),
        Err(WorkflowError::Storage { .. })
    ));
    Ok(())
}

#[test]
fn invalid_context_shapes_are_rejected_before_domain_restoration()
-> Result<(), Box<dyn std::error::Error>> {
    for context in [
        json!(null),
        json!([]),
        json!("private-value"),
        json!({}),
        json!({"data": [], "chat_history": {"messages": []}}),
        json!({"data": {}, "chat_history": {"messages": "invalid"}}),
    ] {
        let mut value = wire()?;
        value["context"] = context;
        assert_storage_error(&value)?;
    }
    Ok(())
}

#[test]
fn unknown_wire_fields_are_rejected_but_workflow_context_is_opaque()
-> Result<(), Box<dyn std::error::Error>> {
    let mut value = wire()?;
    value["unrecognized"] = json!(true);
    assert_storage_error(&value)?;

    let original = session();
    original
        .context
        .set("unrecognized", json!({"future_field": true}))?;
    let restored = decode(&encode(&original)?)?;
    assert_eq!(
        restored.context.get::<Value>("unrecognized"),
        Some(json!({"future_field": true}))
    );
    Ok(())
}

#[test]
fn optional_status_message_preserves_none_and_empty_text() -> Result<(), Box<dyn std::error::Error>>
{
    for status_message in [None, Some(String::new()), Some("status".to_owned())] {
        let mut original = session();
        original.status_message = status_message.clone();
        assert_eq!(decode(&encode(&original)?)?.status_message, status_message);
    }
    Ok(())
}

#[test]
fn errors_do_not_echo_persisted_values() -> Result<(), Box<dyn std::error::Error>> {
    let mut value = wire()?;
    value["version"] = json!("private-persisted-value");
    let error = decode(&serde_json::to_string(&value)?)
        .err()
        .ok_or("expected error")?;
    assert!(!error.to_string().contains("private-persisted-value"));
    Ok(())
}
