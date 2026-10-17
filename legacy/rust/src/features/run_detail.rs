#![allow(
    clippy::redundant_pub_crate,
    reason = "Feature entrypoints are crate-visible while the top-level feature registry remains private."
)]

mod component;
mod fragments;
mod sse;

pub(crate) use component::selected_inspector_host;
