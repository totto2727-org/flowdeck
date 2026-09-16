use axum::{
    Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{Next, from_fn_with_state},
    response::{IntoResponse, Response},
    routing::post,
};
use futures_util::StreamExt as _;
use graph_flow_jcode::{JcodeNodeError, jcode_sdk::LaunchOptions};
use llm_profiles::LoadedAgentsConfig;
use std::{
    net::TcpListener,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

// The pinned jcode OpenAI transport cannot attach arbitrary headers, even for named
// profiles. This private, authenticated, fixed-route bridge preserves those settings
// without a fork, credential files, a generic proxy, or response buffering.
pub(super) struct ProviderBridge {
    base_url: String,
    token: String,
    home: Arc<tempfile::TempDir>,
    stop: CancellationToken,
    upstream: Arc<Upstream>,
    #[cfg(test)]
    terminated: CancellationToken,
    #[cfg(test)]
    session_cancelled: CancellationToken,
}

struct Upstream {
    client: reqwest::Client,
    url: String,
    config: Arc<LoadedAgentsConfig>,
    session: Mutex<Option<(String, HeaderMap)>>,
    authorization: String,
    first_chunk_timeout: Duration,
    stream_idle_timeout: Duration,
    stop: CancellationToken,
}

impl ProviderBridge {
    pub(super) fn start(config: Arc<LoadedAgentsConfig>) -> Result<Self, JcodeNodeError> {
        let token = Uuid::new_v4().to_string();
        let provider = config
            .active_provider()
            .map_err(|_| bridge_error("active provider is unavailable"))?;
        let home = Arc::new(
            tempfile::tempdir().map_err(|_| bridge_error("failed to create private jcode home"))?,
        );
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| bridge_error("failed to build provider client"))?;
        let stop = CancellationToken::new();
        let state = Arc::new(Upstream {
            client,
            url: format!(
                "{}/chat/completions",
                provider.base_url().to_string().trim_end_matches('/')
            ),
            session: Mutex::new(None),
            authorization: format!("Bearer {token}"),
            first_chunk_timeout: provider.first_chunk_timeout(),
            stream_idle_timeout: provider.stream_idle_timeout(),
            stop: stop.clone(),
            config,
        });
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|_| bridge_error("failed to bind provider bridge"))?;
        listener
            .set_nonblocking(true)
            .map_err(|_| bridge_error("failed to configure provider bridge"))?;
        let address = listener
            .local_addr()
            .map_err(|_| bridge_error("failed to locate provider bridge"))?;
        let listener = tokio::net::TcpListener::from_std(listener)
            .map_err(|_| bridge_error("failed to initialize provider bridge"))?;
        let profile = serde_json::json!({
            "provider": {"default_provider": "flowdeck-shared", "default_model": provider_model(&state)?},
            "providers": {"flowdeck-shared": {
                "type": "openai-compatible",
                "base_url": format!("http://{address}/v1"),
                "api_key_env": "FLOWDECK_BRIDGE_KEY",
                "default_model": provider_model(&state)?,
                "models": [{"id": provider_model(&state)?}]
            }}
        });
        let source = toml::to_string(&profile)
            .map_err(|_| bridge_error("failed to encode private provider profile"))?;
        std::fs::write(home.path().join("config.toml"), source)
            .map_err(|_| bridge_error("failed to prepare private provider profile"))?;
        let router = Router::new()
            .route("/v1/chat/completions", post(forward))
            .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
            .layer(from_fn_with_state(Arc::clone(&state), protect_request))
            .with_state(Arc::clone(&state));
        let shutdown = stop.clone();
        #[cfg(test)]
        let terminated = CancellationToken::new();
        #[cfg(test)]
        let completed = terminated.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await;
            #[cfg(test)]
            completed.cancel();
        });
        Ok(Self {
            base_url: format!("http://{address}/v1"),
            token,
            home,
            stop,
            upstream: state,
            #[cfg(test)]
            terminated,
            #[cfg(test)]
            session_cancelled: CancellationToken::new(),
        })
    }

    pub(super) fn set_session(&self, session_id: &str) -> Result<(), JcodeNodeError> {
        if session_id.is_empty() {
            return Err(bridge_error("provider session ID is empty"));
        }
        let mut session = self
            .upstream
            .session
            .lock()
            .map_err(|_| bridge_error("provider session state is unavailable"))?;
        if let Some((existing, _)) = session.as_ref() {
            return if existing == session_id {
                Ok(())
            } else {
                Err(bridge_error(
                    "provider bridge cannot be shared across sessions",
                ))
            };
        }
        let provider = self
            .upstream
            .config
            .active_provider()
            .map_err(|_| bridge_error("active provider is unavailable"))?;
        let mut headers = provider
            .headers(Some(session_id))
            .map_err(|_| bridge_error("invalid provider headers"))?;
        if !headers.contains_key(header::AUTHORIZATION) {
            let mut value =
                axum::http::HeaderValue::from_str(&format!("Bearer {}", provider.api_key().trim()))
                    .map_err(|_| bridge_error("invalid provider credential"))?;
            value.set_sensitive(true);
            headers.insert(header::AUTHORIZATION, value);
        }
        *session = Some((session_id.to_owned(), headers));
        drop(session);
        Ok(())
    }

    pub(super) fn shutdown_guard(&self) -> tokio_util::sync::DropGuard {
        self.stop.clone().drop_guard()
    }

    pub(super) fn cancel_session_on_stop(
        &self,
        client: graph_flow_jcode::jcode_sdk::JcodeClient,
        session_id: String,
    ) {
        let stop = self.stop.clone();
        let home = Arc::clone(&self.home);
        #[cfg(test)]
        let session_cancelled = self.session_cancelled.clone();
        tokio::spawn(async move {
            stop.cancelled().await;
            // SDK cancellation is blocking and retains the same bounded request timeout.
            // Never log its errors, which can include provider diagnostics.
            let _ = tokio::task::spawn_blocking(move || {
                let result = client.cancel(&session_id);
                drop(client);
                drop(home);
                result
            })
            .await;
            #[cfg(test)]
            session_cancelled.cancel();
        });
    }

    pub(super) fn configure(&self, options: &mut LaunchOptions) {
        options.jcode_home = Some(self.home.path().to_owned());
        for (name, value) in [
            ("JCODE_OPENROUTER_API_BASE", self.base_url.clone()),
            ("FLOWDECK_BRIDGE_KEY", self.token.clone()),
            (
                "JCODE_OPENROUTER_API_KEY_NAME",
                "FLOWDECK_BRIDGE_KEY".to_owned(),
            ),
            (
                "JCODE_OPENROUTER_CACHE_NAMESPACE",
                "flowdeck-shared".to_owned(),
            ),
            ("JCODE_NAMED_PROVIDER_PROFILE", "flowdeck-shared".to_owned()),
            ("JCODE_PROVIDER_PROFILE_NAME", "flowdeck-shared".to_owned()),
            ("JCODE_PROVIDER_PROFILE_ACTIVE", "1".to_owned()),
            ("JCODE_RUNTIME_PROVIDER", "openrouter".to_owned()),
        ] {
            options.env.insert(name.into(), value.into());
        }
    }
}

impl Drop for ProviderBridge {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

fn provider_model(state: &Upstream) -> Result<&str, JcodeNodeError> {
    state
        .config
        .active_provider()
        .map(llm_profiles::ResolvedProvider::model)
        .map_err(|_| bridge_error("active provider is unavailable"))
}

fn bridge_error(message: &'static str) -> JcodeNodeError {
    JcodeNodeError::configuration(message)
}

async fn protect_request(
    State(upstream): State<Arc<Upstream>>,
    request: Request,
    next: Next,
) -> Response {
    if request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(upstream.authorization.as_str())
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // Cover extraction too: an incomplete local upload must not keep a cancelled run alive.
    tokio::select! {
        biased;
        () = upstream.stop.cancelled() => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        response = tokio::time::timeout(Duration::from_mins(1), next.run(request)) => response.map_or_else(|_| StatusCode::REQUEST_TIMEOUT.into_response(), std::convert::identity),
    }
}

async fn forward(State(upstream): State<Arc<Upstream>>, body: Bytes) -> Response {
    let provider_headers = match upstream.session.lock() {
        Ok(session) => match session.as_ref() {
            Some((_, headers)) => headers.clone(),
            None => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        },
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let deadline = tokio::time::Instant::now()
        .checked_add(upstream.first_chunk_timeout)
        .unwrap_or_else(tokio::time::Instant::now);
    let request = upstream
        .client
        .post(&upstream.url)
        .header(header::CONTENT_TYPE, "application/json")
        .headers(provider_headers)
        .body(body)
        .send();
    let response = tokio::select! {
        () = upstream.stop.cancelled() => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        result = tokio::time::timeout_at(deadline, request) => match result {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => return StatusCode::BAD_GATEWAY.into_response(),
            Err(_) => return StatusCode::GATEWAY_TIMEOUT.into_response(),
        },
    };
    let status = response.status();
    if !status.is_success() {
        // Upstream diagnostics can echo bearer/header values. Never pass them into
        // jcode's errors or Flowdeck traces, including redirect response bodies.
        return (status, "provider request failed").into_response();
    }
    let mut response_headers = HeaderMap::new();
    for name in [header::CONTENT_TYPE, header::CONTENT_ENCODING] {
        if let Some(value) = response.headers().get(&name) {
            response_headers.insert(name, value.clone());
        }
    }
    let mut chunks = response.bytes_stream();
    let stream = async_stream::stream! {
        let mut next_deadline = deadline;
        loop {
            let chunk = tokio::select! {
                () = upstream.stop.cancelled() => break,
                chunk = tokio::time::timeout_at(next_deadline, chunks.next()) => chunk,
            };
            match chunk {
                Ok(Some(Ok(bytes))) => yield Ok::<_, std::io::Error>(bytes),
                Ok(None) => break,
                Ok(Some(Err(_))) | Err(_) => {
                    yield Err(std::io::Error::other("provider response stream failed"));
                    break;
                },
            }
            next_deadline = tokio::time::Instant::now().checked_add(upstream.stream_idle_timeout).unwrap_or_else(tokio::time::Instant::now);
        }
    };
    (status, response_headers, Body::from_stream(stream)).into_response()
}

#[cfg(test)]
#[path = "provider_bridge_test.rs"]
mod tests;
