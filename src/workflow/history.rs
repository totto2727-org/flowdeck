use crate::RunSnapshot;

/// Atomic snapshot of every currently retained run.
#[derive(Clone, Debug)]
pub struct HistoryView {
    /// Retained runs by start milliseconds ascending, then run ID ascending.
    pub runs: Vec<RunSnapshot>,
}
