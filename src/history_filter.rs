#![allow(
    clippy::redundant_pub_crate,
    reason = "Typed filter values cross sibling web modules while their defining module remains private."
)]

use serde::{Deserialize, Serialize};
use topcoat::{
    context::Cx,
    cookie::{Cookie, Cookies, SameSite, cookies, time::Duration},
};
use workflow_console_experiment::{RunSnapshot, RunStatus, RunTrigger, workflow_definitions};

const WORKFLOW_COOKIE: &str = "workflow-console-history-workflow";
const TRIGGER_COOKIE: &str = "workflow-console-history-trigger";
const STATUS_COOKIE: &str = "workflow-console-history-status";
const COOKIE_MAX_AGE_DAYS: i64 = 30;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct HistoryFilterValues {
    #[serde(rename = "historyWorkflowFilter")]
    pub(super) workflow: String,
    #[serde(rename = "historyTriggerFilter")]
    pub(super) trigger: String,
    #[serde(rename = "historyStatusFilter")]
    pub(super) status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HistoryFilters {
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
    pub(super) fn from_values(values: &HistoryFilterValues) -> Self {
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

    pub(super) fn from_cookies(cx: &Cx) -> Self {
        let jar = cookies(cx);
        Self::from_values(&HistoryFilterValues {
            workflow: cookie_value(&jar, WORKFLOW_COOKIE),
            trigger: cookie_value(&jar, TRIGGER_COOKIE),
            status: cookie_value(&jar, STATUS_COOKIE),
        })
    }

    pub(super) fn store_in_cookies(&self, cx: &Cx) {
        let values = self.values();
        let jar = cookies(cx)
            .override_http_only(true)
            .override_same_site(SameSite::Lax)
            .override_path("/")
            .override_max_age(Duration::days(COOKIE_MAX_AGE_DAYS));
        jar.add(Cookie::new(WORKFLOW_COOKIE, values.workflow));
        jar.add(Cookie::new(TRIGGER_COOKIE, values.trigger));
        jar.add(Cookie::new(STATUS_COOKIE, values.status));
    }

    pub(super) fn values(&self) -> HistoryFilterValues {
        HistoryFilterValues {
            workflow: self.workflow.as_deref().unwrap_or("all").to_owned(),
            trigger: self.trigger.as_str().to_owned(),
            status: self.status.as_str().to_owned(),
        }
    }

    pub(super) fn is_active(&self) -> bool {
        self.workflow.is_some()
            || self.trigger != TriggerFilter::All
            || self.status != StatusFilter::All
    }

    pub(super) fn matches(&self, run: &RunSnapshot) -> bool {
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

fn cookie_value(jar: &impl Cookies, name: &str) -> String {
    jar.get(name)
        .map_or_else(|| "all".to_owned(), |cookie| cookie.value().to_owned())
}

#[cfg(test)]
mod tests {
    use topcoat::{
        context::{Cx, CxTestBuilder},
        cookie::{CookieJarCell, write_cookies},
        router::{Body, HeaderMap, Request, header},
    };

    use super::{HistoryFilterValues, HistoryFilters};

    #[test]
    fn history_filters_round_trip_through_cookie_jar() {
        let writer = cx_with_cookie(None);
        let expected = HistoryFilters::from_values(&HistoryFilterValues {
            workflow: "review-pipeline".to_owned(),
            trigger: "manual".to_owned(),
            status: "running".to_owned(),
        });
        expected.store_in_cookies(&writer);
        let mut headers = HeaderMap::new();
        write_cookies(&writer, &mut headers);
        let cookie_header = headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .filter_map(|value| value.split(';').next())
            .collect::<Vec<_>>()
            .join("; ");
        let reader = cx_with_cookie(Some(&cookie_header));

        assert_eq!(HistoryFilters::from_cookies(&reader), expected);
    }

    fn cx_with_cookie(cookie: Option<&str>) -> Cx {
        let mut request = Request::builder();
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let parts = request
            .body(Body::empty())
            .expect("test request should build")
            .into_parts()
            .0;
        CxTestBuilder::new()
            .request_context(parts)
            .request_context(CookieJarCell::new())
            .build()
    }
}
