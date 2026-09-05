use crate::RunSnapshot;

/// Atomic snapshot of every currently retained run.
#[derive(Clone, Debug)]
pub struct HistoryView {
    /// Retained runs in start order.
    pub runs: Vec<RunSnapshot>,
}
