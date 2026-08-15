//! Local Topcoat workflow console server.

mod web;
mod web_page;

use std::error::Error;

use tokio::net::TcpListener;
use topcoat::{
    asset::{AssetBundle, RouterBuilderAssetExt},
    router::{Router, RouterBuilderDiscoverExt},
};
use workflow_console_experiment::WorkflowService;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let service = WorkflowService::new()?;
    let assets = AssetBundle::load()?;
    let router = Router::builder()
        .discover()
        .app_context(service)
        .assets(assets)
        .build();
    let listener = TcpListener::bind("127.0.0.1:3000").await?;
    topcoat::serve(listener, router).await?;
    Ok(())
}
