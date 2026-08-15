//! Local-only Topcoat bootstrap for the workflow console experiment.

use serde::Serialize;
use topcoat::{
    Result,
    router::{Router, RouterBuilderDiscoverExt, content::Json, page, route},
    view::view,
};

#[derive(Debug, Serialize)]
struct Health {
    status: &'static str,
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    topcoat::start(Router::builder().discover().build()).await
}

#[page("/")]
async fn home() -> Result {
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="description" content="Local workflow console experiment">
                <title>"Workflow Console"</title>
            </head>
            <body>
                <main>
                    <h1>"Workflow Console"</h1>
                    <p>"Local Topcoat runtime is ready."</p>
                </main>
            </body>
        </html>
    }
}

#[route(GET "/api/health")]
async fn health() -> Result<Json<Health>> {
    Ok(Json(Health { status: "ok" }))
}
