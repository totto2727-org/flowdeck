use std::{collections::HashMap, num::NonZeroUsize};

use ringbuffer::{AllocRingBuffer, RingBuffer};

use crate::{RunId, RunSnapshot};

/// Atomic snapshot of every currently retained run.
#[derive(Clone, Debug)]
pub struct HistoryView {
    /// Retained runs in start order.
    pub runs: Vec<RunSnapshot>,
}

struct RetainedRun {
    sequence: u64,
    snapshot: RunSnapshot,
}

pub(super) struct HistoryState {
    active: HashMap<RunId, RetainedRun>,
    terminal: AllocRingBuffer<RetainedRun>,
    next_sequence: u64,
}

impl HistoryState {
    pub(super) fn new(terminal_capacity: NonZeroUsize) -> Self {
        Self {
            active: HashMap::new(),
            terminal: AllocRingBuffer::new(terminal_capacity.get()),
            next_sequence: 0,
        }
    }

    pub(super) fn view(&self) -> HistoryView {
        let mut retained: Vec<_> = self.active.values().chain(self.terminal.iter()).collect();
        retained.sort_by_key(|run| run.sequence);
        HistoryView {
            runs: retained
                .into_iter()
                .map(|run| run.snapshot.clone())
                .collect(),
        }
    }

    pub(super) fn insert_active(&mut self, snapshot: RunSnapshot) {
        let run_id = snapshot.run_id.clone();
        let retained = self.retained(snapshot);
        let _ = self.active.insert(run_id, retained);
    }

    pub(super) fn insert_terminal(&mut self, snapshot: RunSnapshot) {
        let retained = self.retained(snapshot);
        self.terminal.enqueue(retained);
    }

    pub(super) fn mutate_active<R>(
        &mut self,
        run_id: &RunId,
        mutation: impl FnOnce(&mut RunSnapshot) -> R,
    ) -> Option<R> {
        self.active
            .get_mut(run_id)
            .map(|run| mutation(&mut run.snapshot))
    }

    pub(super) fn finish<R>(
        &mut self,
        run_id: &RunId,
        mutation: impl FnOnce(&mut RunSnapshot) -> R,
    ) -> Option<R> {
        let mut retained = self.active.remove(run_id)?;
        let result = mutation(&mut retained.snapshot);
        self.terminal.enqueue(retained);
        Some(result)
    }

    pub(super) fn get(&self, run_id: &RunId) -> Option<RunSnapshot> {
        self.active
            .get(run_id)
            .into_iter()
            .chain(self.terminal.iter())
            .find(|run| run.snapshot.run_id == *run_id)
            .map(|run| run.snapshot.clone())
    }

    const fn retained(&mut self, snapshot: RunSnapshot) -> RetainedRun {
        let retained = RetainedRun {
            sequence: self.next_sequence,
            snapshot,
        };
        self.next_sequence = self.next_sequence.saturating_add(1);
        retained
    }
}

#[cfg(test)]
mod tests {
    use std::{num::NonZeroUsize, time::SystemTime};

    use super::HistoryState;
    use crate::{RunId, RunInput, RunSnapshot, RunStatus, RunTrigger};

    #[test]
    fn terminal_ring_overwrites_oldest_without_evicting_active_runs() {
        let mut history = HistoryState::new(NonZeroUsize::new(2).unwrap_or(NonZeroUsize::MIN));
        history.insert_active(snapshot("active-a", RunStatus::Running));
        history.insert_active(snapshot("active-b", RunStatus::Running));
        history.insert_terminal(snapshot("terminal-a", RunStatus::Completed));
        history.insert_terminal(snapshot("terminal-b", RunStatus::Completed));
        history.insert_terminal(snapshot("terminal-c", RunStatus::Completed));

        let retained: Vec<_> = history
            .view()
            .runs
            .into_iter()
            .map(|run| run.run_id.to_string())
            .collect();

        assert_eq!(
            retained,
            ["active-a", "active-b", "terminal-b", "terminal-c"]
        );
        assert!(history.get(&RunId("terminal-a".to_owned())).is_none());
        drop(history);
    }

    #[test]
    fn terminal_transition_moves_active_run_into_the_bounded_ring() {
        let mut history = HistoryState::new(NonZeroUsize::MIN);
        history.insert_active(snapshot("first", RunStatus::Running));
        history.insert_active(snapshot("second", RunStatus::Running));

        let _ = history.finish(&RunId("first".to_owned()), |run| {
            run.status = RunStatus::Completed;
        });
        let _ = history.finish(&RunId("second".to_owned()), |run| {
            run.status = RunStatus::Completed;
        });

        assert!(history.get(&RunId("first".to_owned())).is_none());
        assert!(matches!(
            history.get(&RunId("second".to_owned())),
            Some(run) if run.status == RunStatus::Completed
        ));
        drop(history);
    }

    fn snapshot(run_id: &str, status: RunStatus) -> RunSnapshot {
        RunSnapshot {
            run_id: RunId(run_id.to_owned()),
            workflow_id: "test-workflow".to_owned(),
            input: RunInput::new(serde_json::json!({}), String::new()),
            trigger: RunTrigger::Manual,
            status,
            current_node: None,
            current_edge: None,
            traversed_nodes: Vec::new(),
            traversed_edges: Vec::new(),
            route_summary: String::new(),
            started_at: SystemTime::UNIX_EPOCH,
            finished_at: None,
            duration: None,
            steps: Vec::new(),
        }
    }
}
