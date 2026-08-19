#![allow(
    clippy::redundant_pub_crate,
    reason = "Typed filter values cross feature and page modules while their defining module remains private."
)]

use serde::{Deserialize, Serialize};
use workflow_console_experiment::{RunSnapshot, RunStatus, RunTrigger, workflow_definitions};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct HistoryFilterValues {
    #[serde(rename = "historyWorkflowFilter")]
    pub(crate) workflow: String,
    #[serde(rename = "historyTriggerFilter")]
    pub(crate) trigger: String,
    #[serde(rename = "historyStatusFilter")]
    pub(crate) status: String,
}

#[allow(
    clippy::struct_field_names,
    reason = "This query DTO mirrors the stable URL parameter names at the Serde boundary."
)]
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct HistoryFilterQuery {
    pub(crate) history_workflow: Option<String>,
    pub(crate) history_trigger: Option<String>,
    pub(crate) history_status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HistoryFilters {
    workflow: Option<String>,
    trigger: TriggerFilter,
    status: StatusFilter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TriggerFilter {
    All,
    Manual,
    Cron,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatusFilter {
    All,
    Running,
    Completed,
    Failed,
}

impl Default for HistoryFilters {
    fn default() -> Self {
        Self {
            workflow: None,
            trigger: TriggerFilter::All,
            status: StatusFilter::All,
        }
    }
}

impl HistoryFilters {
    pub(crate) fn from_query(query: &HistoryFilterQuery) -> Self {
        Self::from_values(&HistoryFilterValues {
            workflow: query.history_workflow.clone().unwrap_or_default(),
            trigger: query.history_trigger.clone().unwrap_or_default(),
            status: query.history_status.clone().unwrap_or_default(),
        })
    }

    pub(crate) fn from_values(values: &HistoryFilterValues) -> Self {
        let workflow = workflow_definitions()
            .iter()
            .any(|definition| definition.workflow_id == values.workflow)
            .then(|| values.workflow.clone());
        let trigger = match values.trigger.as_str() {
            "manual" => TriggerFilter::Manual,
            "cron" => TriggerFilter::Cron,
            _ => TriggerFilter::All,
        };
        let status = match values.status.as_str() {
            "running" => StatusFilter::Running,
            "completed" => StatusFilter::Completed,
            "failed" => StatusFilter::Failed,
            _ => StatusFilter::All,
        };
        Self {
            workflow,
            trigger,
            status,
        }
    }

    pub(crate) fn values(&self) -> HistoryFilterValues {
        HistoryFilterValues {
            workflow: self.workflow.as_deref().unwrap_or("all").to_owned(),
            trigger: self.trigger.as_str().to_owned(),
            status: self.status.as_str().to_owned(),
        }
    }

    pub(crate) fn is_active(&self) -> bool {
        self.workflow.is_some()
            || self.trigger != TriggerFilter::All
            || self.status != StatusFilter::All
    }

    pub(crate) fn query_suffix(&self) -> String {
        let values = self.values();
        let mut fields = Vec::with_capacity(3);
        if values.workflow != "all" {
            fields.push(format!("history_workflow={}", values.workflow));
        }
        if values.trigger != "all" {
            fields.push(format!("history_trigger={}", values.trigger));
        }
        if values.status != "all" {
            fields.push(format!("history_status={}", values.status));
        }
        fields
            .is_empty()
            .then(String::new)
            .unwrap_or_else(|| format!("?{}", fields.join("&")))
    }

    pub(crate) fn matches(&self, run: &RunSnapshot) -> bool {
        let workflow_matches = self
            .workflow
            .as_ref()
            .is_none_or(|workflow| workflow == &run.workflow_id);
        let trigger_matches = match self.trigger {
            TriggerFilter::All => true,
            TriggerFilter::Manual => matches!(run.trigger, RunTrigger::Manual),
            TriggerFilter::Cron => matches!(run.trigger, RunTrigger::Cron { .. }),
        };
        let status_matches = match self.status {
            StatusFilter::All => true,
            StatusFilter::Running => matches!(run.status, RunStatus::Running),
            StatusFilter::Completed => matches!(run.status, RunStatus::Completed),
            StatusFilter::Failed => matches!(run.status, RunStatus::Failed { .. }),
        };
        workflow_matches && trigger_matches && status_matches
    }
}

impl TriggerFilter {
    const fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Manual => "manual",
            Self::Cron => "cron",
        }
    }
}

impl StatusFilter {
    const fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{HistoryFilterQuery, HistoryFilters};

    #[test]
    fn history_filters_normalize_missing_and_invalid_query_values_to_all() {
        let filters = HistoryFilters::from_query(&HistoryFilterQuery {
            history_workflow: Some("unknown-workflow".to_owned()),
            history_trigger: Some("webhook".to_owned()),
            history_status: None,
        });

        assert_eq!(filters.values().workflow, "all");
        assert_eq!(filters.values().trigger, "all");
        assert_eq!(filters.values().status, "all");
        assert_eq!(filters.query_suffix(), "");
    }

    #[test]
    fn history_filters_render_a_canonical_query_suffix_without_all_values() {
        let filters = HistoryFilters::from_query(&HistoryFilterQuery {
            history_workflow: Some("review-pipeline".to_owned()),
            history_trigger: Some("all".to_owned()),
            history_status: Some("completed".to_owned()),
        });

        assert_eq!(
            filters.query_suffix(),
            "?history_workflow=review-pipeline&history_status=completed"
        );
    }
}
