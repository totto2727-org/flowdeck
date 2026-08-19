use std::collections::HashSet;

use workflow_console_experiment::{HistoryDelta, HistoryReplay, HistoryView, RunId};

use super::{
    filter::HistoryFilters,
    sse::{HistoryMembershipChange, HistoryTransition, history_transition},
};

pub(crate) struct FilteredHistoryMembership {
    run_ids: HashSet<RunId>,
}

impl FilteredHistoryMembership {
    pub(crate) fn at_cursor(
        view: &HistoryView,
        replay: &HistoryReplay,
        filters: &HistoryFilters,
    ) -> Self {
        let mut run_ids: HashSet<_> = view
            .runs
            .iter()
            .filter(|run| filters.matches(run))
            .map(|run| run.run_id.clone())
            .collect();
        if let HistoryReplay::Changes(changes) = replay {
            for delta in changes.iter().rev() {
                if delta.after.as_ref().is_some_and(|run| filters.matches(run)) {
                    run_ids.remove(&delta.run_id);
                }
                if delta
                    .before
                    .as_ref()
                    .is_some_and(|run| filters.matches(run))
                {
                    run_ids.insert(delta.run_id.clone());
                }
            }
        }
        Self { run_ids }
    }

    pub(crate) fn apply(
        &mut self,
        delta: &HistoryDelta,
        filters: &HistoryFilters,
    ) -> HistoryTransition {
        let before_matches = self.run_ids.contains(&delta.run_id);
        let after_matches = delta.after.as_ref().is_some_and(|run| filters.matches(run));
        let was_empty = self.run_ids.is_empty();
        if after_matches {
            self.run_ids.insert(delta.run_id.clone());
        } else {
            self.run_ids.remove(&delta.run_id);
        }
        let change = match (before_matches, after_matches) {
            (false, true) => HistoryMembershipChange::Entered { was_empty },
            (true, true) => HistoryMembershipChange::Stayed,
            (true, false) => HistoryMembershipChange::Left {
                is_empty: self.run_ids.is_empty(),
            },
            (false, false) => HistoryMembershipChange::Outside,
        };
        history_transition(change)
    }
}
