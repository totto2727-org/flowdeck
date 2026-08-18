use std::collections::VecDeque;

use crate::{RunId, RunSnapshot};

pub(super) const HISTORY_JOURNAL_CAPACITY: usize = 512;

/// Monotonic version of the retained workflow history.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct HistoryRevision(u64);

impl HistoryRevision {
    /// Construct a revision from its wire representation.
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    /// Return the revision's wire representation.
    pub const fn value(self) -> u64 {
        self.0
    }

    const fn next(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

/// Atomic snapshot of all retained runs at one revision.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct HistoryView {
    /// Revision shared by every run in this view.
    pub revision: HistoryRevision,
    /// Retained runs in start order.
    pub runs: Vec<RunSnapshot>,
}

/// One atomic change to a retained run snapshot.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct HistoryDelta {
    /// Revision assigned after the mutation.
    pub revision: HistoryRevision,
    /// Run changed by this mutation.
    pub run_id: RunId,
    /// Snapshot immediately before the mutation, absent for insertion.
    pub before: Option<RunSnapshot>,
    /// Snapshot immediately after the mutation, absent for removal.
    pub after: Option<RunSnapshot>,
}

/// Result of replaying history changes after a caller's revision.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub enum HistoryReplay {
    /// Ordered retained changes newer than the requested revision.
    Changes(Vec<HistoryDelta>),
    /// The requested revision cannot be replayed from retained changes.
    Stale {
        /// Current revision callers should obtain with a fresh history view.
        current: HistoryRevision,
    },
}

pub(super) struct HistoryState {
    revision: HistoryRevision,
    runs: Vec<RunSnapshot>,
    journal: VecDeque<HistoryDelta>,
}

impl HistoryState {
    pub(super) const fn new() -> Self {
        Self {
            revision: HistoryRevision::new(0),
            runs: Vec::new(),
            journal: VecDeque::new(),
        }
    }

    pub(super) fn view(&self) -> HistoryView {
        HistoryView {
            revision: self.revision,
            runs: self.runs.clone(),
        }
    }

    pub(super) fn insert(&mut self, snapshot: RunSnapshot) -> HistoryDelta {
        let run_id = snapshot.run_id.clone();
        self.runs.push(snapshot.clone());
        self.record(run_id, None, Some(snapshot))
    }

    pub(super) fn mutate<R>(
        &mut self,
        run_id: &RunId,
        mutation: impl FnOnce(&mut RunSnapshot) -> R,
    ) -> Option<(R, HistoryDelta)> {
        let snapshot = self
            .runs
            .iter_mut()
            .find(|snapshot| snapshot.run_id == *run_id)?;
        let before = snapshot.clone();
        let result = mutation(snapshot);
        let after = snapshot.clone();
        let delta = self.record(run_id.clone(), Some(before), Some(after));
        Some((result, delta))
    }

    pub(super) fn get(&self, run_id: &RunId) -> Option<RunSnapshot> {
        self.runs
            .iter()
            .find(|snapshot| snapshot.run_id == *run_id)
            .cloned()
    }

    pub(super) fn replay(&self, after: HistoryRevision) -> HistoryReplay {
        let oldest_cursor = self.journal.front().map_or(self.revision, |delta| {
            HistoryRevision::new(delta.revision.value().saturating_sub(1))
        });
        if after > self.revision || after < oldest_cursor {
            return HistoryReplay::Stale {
                current: self.revision,
            };
        }
        HistoryReplay::Changes(
            self.journal
                .iter()
                .filter(|delta| delta.revision > after)
                .cloned()
                .collect(),
        )
    }

    fn record(
        &mut self,
        run_id: RunId,
        before: Option<RunSnapshot>,
        after: Option<RunSnapshot>,
    ) -> HistoryDelta {
        self.revision = self.revision.next();
        let delta = HistoryDelta {
            revision: self.revision,
            run_id,
            before,
            after,
        };
        if self.journal.len() == HISTORY_JOURNAL_CAPACITY {
            let _ = self.journal.pop_front();
        }
        self.journal.push_back(delta.clone());
        delta
    }
}

#[cfg(test)]
mod tests {
    use super::{HISTORY_JOURNAL_CAPACITY, HistoryReplay, HistoryRevision, HistoryState};
    use crate::RunId;

    #[test]
    fn replay_when_cursor_precedes_bounded_journal_is_stale() {
        // Given: one more mutation than the fixed journal retains.
        let mut history = HistoryState::new();
        for value in 0..=HISTORY_JOURNAL_CAPACITY {
            let _ = history.record(RunId(value.to_string()), None, None);
        }

        // When: replay is requested at and before the oldest recoverable cursor.
        let retained = history.replay(HistoryRevision::new(1));
        let expired = history.replay(HistoryRevision::new(0));

        // Then: the boundary cursor replays all retained entries and the older one is stale.
        assert!(
            matches!(retained, HistoryReplay::Changes(changes) if changes.len() == HISTORY_JOURNAL_CAPACITY)
        );
        assert!(
            matches!(expired, HistoryReplay::Stale { current } if current == HistoryRevision::new(513))
        );
    }
}
