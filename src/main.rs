//! Local Flowdeck server.

mod app;
mod features;

use std::{error::Error, time::Instant};

use flowdeck::{ApplicationConfig, WorkflowService};
use tokio::net::TcpListener;
use topcoat::{
    asset::{AssetBundle, RouterBuilderAssetExt},
    context::CxBuilder,
    router::{Body, Layer, LayerFuture, Next, Path, Router, RouterBuilderDiscoverExt, parts},
};
use tracing_subscriber::EnvFilter;

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
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("flowdeck=info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .try_init()?;

    let config = ApplicationConfig::local_default();
    let service = WorkflowService::with_config(config.clone()).await?;
    let scheduler = service.clone();
    let assets = AssetBundle::load()?;
    let router = Router::builder()
        .layer(RequestLogging)
        .discover()
        .app_context(service.clone())
        .assets(assets)
        .build();
    let listener = TcpListener::bind(config.http.bind_address).await?;
    tracing::info!(url = %format!("http://{}", config.http.bind_address), "server listening");
    let outcome: Result<(), Box<dyn Error + Send + Sync>> = tokio::select! {
        result = topcoat::serve(listener, router) => result.map_err(Into::into),
        result = scheduler.run_scheduler() => result.map_err(Into::into),
        result = shutdown_signal() => result.map_err(Into::into),
    };
    tracing::info!("flushing storage before shutdown");
    let flushed = service.flush_storage().await;
    if let Err(error) = &flushed {
        tracing::error!(%error, "storage flush failed during shutdown");
    } else {
        tracing::info!("storage flush completed");
    }
    outcome?;
    flushed?;
    Ok(())
}

async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;

    tracing::info!("shutdown signal received");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovered_routes_have_unique_asset_paths() -> Result<(), Box<dyn Error + Send + Sync>> {
        let assets = AssetBundle::load()?;
        let _router = Router::builder().discover().assets(assets).build();
        Ok(())
    }
}
