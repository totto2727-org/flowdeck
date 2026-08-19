#![allow(
    clippy::redundant_pub_crate,
    reason = "Feature modules use the private application navigation entrypoint."
)]

mod console;
mod document;
mod navigation;
mod page;
mod routes;

#[cfg(test)]
mod tests;

pub(crate) use navigation::workflow_url;
