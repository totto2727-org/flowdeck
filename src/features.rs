#![allow(
    clippy::redundant_pub_crate,
    reason = "Feature entrypoints are crate-visible while the top-level feature registry remains private."
)]

pub(crate) mod run_history;
