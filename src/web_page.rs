mod console;
mod document;
pub(crate) mod presentation;
mod rail;
mod routes;

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
    presentation::{elapsed, run_status, trigger},
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
