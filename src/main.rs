//! Local Topcoat workflow console server.

mod features;
mod web_page;

use std::{error::Error, time::Instant};

use tokio::net::TcpListener;
use topcoat::{
    asset::{AssetBundle, RouterBuilderAssetExt},
    context::CxBuilder,
    router::{Body, Layer, LayerFuture, Next, Path, Router, RouterBuilderDiscoverExt, parts},
};
use tracing_subscriber::EnvFilter;
use workflow_console_experiment::WorkflowService;

const BIND_ADDRESS: &str = "127.0.0.1:3000";
const SERVER_URL: &str = "http://127.0.0.1:3000";

#[derive(Debug)]
struct RequestLogging;

impl Layer for RequestLogging {
    fn path(&self) -> &Path {
        Path::new("/")
    }

    fn handle<'a>(&'a self, cx: &'a mut CxBuilder, body: Body, next: Next<'a>) -> LayerFuture<'a> {
        Box::pin(async move {
            let method = parts(cx).method.clone();
            let uri = parts(cx).uri.clone();
            let started = Instant::now();
            let result = next.run(cx, body).await;

            if let Ok(response) = &result {
                tracing::info!(
                    method = %method,
                    uri = %uri,
                    status = response.status().as_u16(),
                    elapsed_ms = %started.elapsed().as_millis(),
                    "request completed"
                );
            }

            result
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("workflow_console_experiment=info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .try_init()?;

    let service = WorkflowService::new()?;
    let scheduler = service.clone();
    let assets = AssetBundle::load()?;
    let router = Router::builder()
        .layer(RequestLogging)
        .discover()
        .app_context(service)
        .assets(assets)
        .build();
    let listener = TcpListener::bind(BIND_ADDRESS).await?;
    tracing::info!(url = SERVER_URL, "server listening");
    tokio::select! {
        result = topcoat::serve(listener, router) => result?,
        result = scheduler.run_scheduler() => result?,
    }
    Ok(())
}
