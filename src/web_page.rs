mod console;
mod document;
mod history;
mod presentation;
mod rail;
mod render;
mod routes;
mod topology;
mod trace;

#[cfg(test)]
mod tests;

use topcoat::{
    Result,
    asset::{Asset, asset},
    context::Cx,
    router::{
        error::{NotFoundError, not_found as not_found_error},
        layout, page,
    },
};

#[allow(
    clippy::redundant_pub_crate,
    reason = "Sibling web modules use these private page rendering seams."
)]
pub(crate) use self::{
    render::{render_history_empty, render_history_row, render_run_inspector},
    routes::workflow_url,
};

const DATASTAR_JS: Asset =
    asset!("https://cdn.jsdelivr.net/gh/starfederation/datastar@1.0.2/bundles/datastar.js");
const NOT_FOUND_REDIRECT_DELAY_SECONDS: u8 = 2;

#[layout("/")]
async fn root_layout(cx: &Cx, slot: Result) -> Result {
    match slot {
        Err(error) if error.downcast_ref::<NotFoundError>().is_some() => {
            document::not_found_document(cx).await
        }
        content => content,
    }
}

#[page("/{*missing_path}")]
async fn missing_page() -> Result {
    Err(not_found_error().into())
}
