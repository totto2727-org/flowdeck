use super::*;
use llm_profiles::{AgentConfigPaths, load_from_paths};
use std::{error::Error, fs};
use tokio::sync::{Notify, mpsc};

type TestResult = Result<(), Box<dyn Error>>;

fn config(base_url: &str) -> Result<Arc<LoadedAgentsConfig>, Box<dyn Error>> {
    config_with_timeout(base_url, 30)
}

fn config_with_timeout(
    base_url: &str,
    seconds: u64,
) -> Result<Arc<LoadedAgentsConfig>, Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    let paths = AgentConfigPaths::new(
        directory.path().join("config.toml"),
        directory.path().join("credentials.toml"),
    )?;
    let source = include_str!("../../../tests/fixtures/agents/config.toml")
        .replace("https://gateway.invalid/custom/v1", base_url)
        .replace("model = \"translation-model\"", &format!("model = \"translation-model\"\nfirst_chunk_timeout_seconds = {seconds}\nstream_idle_timeout_seconds = {seconds}"));
    fs::write(paths.config(), source)?;
    fs::write(
        paths.credentials(),
        include_str!("../../../tests/fixtures/agents/credentials.toml")
            .replace("synthetic-translation-key", "  synthetic-translation-key  "),
    )?;
    Ok(Arc::new(load_from_paths(paths)?))
}

struct MockServer {
    base_url: String,
    requests: mpsc::UnboundedReceiver<(HeaderMap, Bytes)>,
    release: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}

impl MockServer {
    async fn start(status: StatusCode) -> Result<Self, Box<dyn Error>> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let base_url = format!("http://{}/custom/v1", listener.local_addr()?);
        let (sender, requests) = mpsc::unbounded_channel();
        let release = Arc::new(Notify::new());
        let notify = Arc::clone(&release);
        let app = Router::new().route(
            "/custom/v1/chat/completions",
            post(move |headers: HeaderMap, body: Bytes| {
                let sender = sender.clone();
                let notify = Arc::clone(&notify);
                async move {
                    let _ = sender.send((headers, body));
                    let stream = async_stream::stream! {
                        yield Ok::<_, std::io::Error>(Bytes::from_static(b"data: first\n\n"));
                        notify.notified().await;
                        yield Ok::<_, std::io::Error>(Bytes::from_static(b"data: [DONE]\n\n"));
                    };
                    (
                        status,
                        [
                            (header::CONTENT_TYPE, "text/event-stream"),
                            (header::LOCATION, "http://127.0.0.1:1/never"),
                        ],
                        Body::from_stream(stream),
                    )
                }
            }),
        );
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            base_url,
            requests,
            release,
            task,
        })
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

async fn send(bridge: &ProviderBridge, body: &str) -> Result<reqwest::Response, reqwest::Error> {
    client()?
        .post(format!("{}/chat/completions", bridge.base_url))
        .bearer_auth(&bridge.token)
        .body(body.to_owned())
        .send()
        .await
}

#[tokio::test]
async fn authentication_and_session_are_required_before_any_upstream_request() -> TestResult {
    let mut upstream = MockServer::start(StatusCode::OK).await?;
    let bridge = ProviderBridge::start(config(&upstream.base_url)?)?;
    let profile = fs::read_to_string(bridge.home.path().join("config.toml"))?;
    for forbidden in [
        "synthetic-translation-key",
        "synthetic-fixed-header",
        "${session_id}",
        upstream.base_url.as_str(),
        "reasoning_effort",
    ] {
        assert!(!profile.contains(forbidden));
    }
    let url = format!("{}/chat/completions", bridge.base_url);
    assert_eq!(
        client()?.post(&url).body("{}").send().await?.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(&bridge, "{}").await?.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(upstream.requests.try_recv().is_err());
    bridge.set_session("sdk-session-1")?;
    assert!(bridge.set_session("other-session").is_err());
    assert_eq!(
        client()?
            .get(&url)
            .bearer_auth(&bridge.token)
            .send()
            .await?
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        client()?
            .post(format!("{}/models", bridge.base_url))
            .bearer_auth(&bridge.token)
            .send()
            .await?
            .status(),
        StatusCode::NOT_FOUND
    );
    assert!(upstream.requests.try_recv().is_err());
    let terminated = bridge.terminated.clone();
    drop(bridge);
    tokio::time::timeout(Duration::from_secs(2), terminated.cancelled()).await?;
    Ok(())
}

#[tokio::test]
async fn parallel_sessions_preserve_headers_bodies_and_streaming_without_cross_talk() -> TestResult
{
    let mut upstream = MockServer::start(StatusCode::OK).await?;
    let config = config(&upstream.base_url)?;
    let first = ProviderBridge::start(Arc::clone(&config))?;
    let second = ProviderBridge::start(config)?;
    first.set_session("sdk-session-first")?;
    second.set_session("sdk-session-second")?;
    let (one, two) = tokio::join!(
        send(&first, r#"{"model":"one","stream":true}"#),
        send(&second, r#"{"model":"two","stream":true}"#)
    );
    let mut one = one?;
    let mut two = two?;
    for response in [&mut one, &mut two] {
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("text/event-stream")
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), response.chunk()).await??,
            Some(Bytes::from_static(b"data: first\n\n"))
        );
    }
    let mut observed = std::collections::BTreeMap::new();
    for _ in 0..2 {
        let (headers, body) = upstream.requests.recv().await.ok_or("missing request")?;
        assert_eq!(
            headers.get("x-fixed").and_then(|value| value.to_str().ok()),
            Some("synthetic-fixed-header")
        );
        assert_eq!(
            headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer synthetic-translation-key")
        );
        let session = headers
            .get("x-session")
            .ok_or("missing session")?
            .to_str()?
            .to_owned();
        observed.insert(session, String::from_utf8(body.to_vec())?);
    }
    assert_eq!(
        observed.get("sdk-session-first").map(String::as_str),
        Some(r#"{"model":"one","stream":true}"#)
    );
    assert_eq!(
        observed.get("sdk-session-second").map(String::as_str),
        Some(r#"{"model":"two","stream":true}"#)
    );
    upstream.release.notify_waiters();
    assert_eq!(one.text().await?, "data: [DONE]\n\n");
    assert_eq!(two.text().await?, "data: [DONE]\n\n");
    let mut options = LaunchOptions::default();
    first.configure(&mut options);
    assert!(
        !options
            .env
            .values()
            .any(|value| value == "synthetic-translation-key")
    );
    Ok(())
}

#[tokio::test]
async fn redirect_is_not_followed_and_status_is_preserved() -> TestResult {
    let mut upstream = MockServer::start(StatusCode::TEMPORARY_REDIRECT).await?;
    let bridge = ProviderBridge::start(config(&upstream.base_url)?)?;
    bridge.set_session("sdk-session")?;
    assert_eq!(
        send(&bridge, "{}").await?.status(),
        StatusCode::TEMPORARY_REDIRECT
    );
    assert!(upstream.requests.recv().await.is_some());
    assert!(upstream.requests.try_recv().is_err());
    Ok(())
}

#[tokio::test]
async fn outer_run_cancellation_stops_bridge_even_while_process_holds_it() -> TestResult {
    let upstream = MockServer::start(StatusCode::OK).await?;
    let bridge = Arc::new(ProviderBridge::start(config(&upstream.base_url)?)?);
    let process_reference = Arc::clone(&bridge);
    let guard = bridge.shutdown_guard();
    bridge.set_session("sdk-session")?;
    let mut response = send(&bridge, "{}").await?;
    assert!(response.chunk().await?.is_some());
    drop(guard);
    tokio::time::timeout(
        Duration::from_secs(2),
        process_reference.terminated.cancelled(),
    )
    .await?;
    assert!(response.chunk().await?.is_none());
    assert!(send(&process_reference, "{}").await.is_err());
    Ok(())
}

fn run_isolated_sdk_test() -> TestResult {
    const CHILD: &str = "FLOWDECK_ISOLATED_JCODE_TEST";
    let binary = fs::canonicalize(
        std::env::var_os("FLOWDECK_JCODE_TEST_BIN").ok_or("missing test binary")?,
    )?;
    let home = tempfile::tempdir()?;
    let mut command = if cfg!(target_os = "macos") {
        let mut command = std::process::Command::new("/usr/bin/sandbox-exec");
        command.args(["-p", "(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip \"localhost:*\") (remote unix-socket))"]).arg(std::env::current_exe()?);
        command
    } else {
        std::process::Command::new(std::env::current_exe()?)
    };
    let result = command
        .args(["--ignored", "--exact", "workflows::jcode_translation::provider_bridge::tests::real_private_jcode_process_sends_the_actual_session_header", "--nocapture"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", home.path())
        .env("XDG_CONFIG_HOME", home.path().join("config"))
        .env("JCODE_HOME", home.path().join("jcode"))
        .env("JCODE_BIN", binary)
        .env("HTTP_PROXY", "http://127.0.0.1:1")
        .env("HTTPS_PROXY", "http://127.0.0.1:1")
        .env("ALL_PROXY", "http://127.0.0.1:1")
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env(CHILD, "1")
        .current_dir(home.path())
        .output()?;
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(())
}

// Optional real SDK/process regression. The parent re-executes this test with an empty
// environment and synthetic HOME, so even jcode's ancillary discovery cannot see logins.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires FLOWDECK_JCODE_TEST_BIN pointing to the pinned jcode executable"]
async fn real_private_jcode_process_sends_the_actual_session_header() -> TestResult {
    const CHILD: &str = "FLOWDECK_ISOLATED_JCODE_TEST";
    if std::env::var_os(CHILD).is_none() {
        return run_isolated_sdk_test();
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let base_url = format!("http://{}/v1", listener.local_addr()?);
    let (sender, mut requests) = mpsc::unbounded_channel();
    let app = Router::new().route("/v1/chat/completions", post(move |headers: HeaderMap, body: Bytes| {
        let sender = sender.clone();
        async move {
            let _ = sender.send((headers, body));
            ([(header::CONTENT_TYPE, "text/event-stream")], concat!(
                "data: {\"id\":\"synthetic\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"translation-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"synthetic response\"},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"synthetic\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"translation-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ))
        }
    }));
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let config = config(&base_url)?;
    let bridge = Arc::new(ProviderBridge::start(Arc::clone(&config))?);
    let _guard = bridge.shutdown_guard();
    let terminated = bridge.terminated.clone();
    let session_cancelled = bridge.session_cancelled.clone();
    let worker = tokio::task::spawn_blocking(move || -> Result<_, JcodeNodeError> {
        let scope = super::super::provider::process_scope(config, Arc::clone(&bridge));
        let client = scope.client()?;
        let home = client.instance_home.clone();
        let session = client.create_session(std::env::var("HOME").ok())?;
        bridge.set_session(&session.session_id)?;
        bridge.cancel_session_on_stop(client.clone(), session.session_id.clone());
        let result = client.run(
            &session.session_id,
            "Reply with the single word synthetic. Do not use tools.",
            graph_flow_jcode::jcode_sdk::RunOptions::default(),
        )?;
        Ok((session.session_id, result.text, home))
    });
    let (session, text, home) = tokio::time::timeout(Duration::from_secs(90), worker).await???;
    assert!(text.contains("synthetic response"));
    let (headers, body) = requests.recv().await.ok_or("no provider request")?;
    assert_eq!(
        headers
            .get("x-session")
            .and_then(|value| value.to_str().ok()),
        Some(session.as_str())
    );
    assert_eq!(
        headers.get("x-fixed").and_then(|value| value.to_str().ok()),
        Some("synthetic-fixed-header")
    );
    assert_eq!(
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok()),
        Some("Bearer synthetic-translation-key")
    );
    let body: serde_json::Value = serde_json::from_slice(&body)?;
    assert_eq!(
        body.get("model"),
        Some(&serde_json::json!("translation-model"))
    );
    assert_eq!(
        body.get("reasoning_effort"),
        Some(&serde_json::json!("low"))
    );
    tokio::time::timeout(Duration::from_secs(15), session_cancelled.cancelled()).await?;
    assert!(
        home.is_some_and(|path| !path.exists()),
        "private jcode home must be removed after SDK client drop"
    );
    tokio::time::timeout(Duration::from_secs(2), terminated.cancelled()).await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn upstream_error_bodies_cannot_expose_credentials_in_jcode_errors() -> TestResult {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let base_url = format!("http://{}/v1", listener.local_addr()?);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            (
                StatusCode::UNAUTHORIZED,
                "synthetic-secret-credential synthetic-secret-header",
            )
        }),
    );
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let bridge = ProviderBridge::start(config(&base_url)?)?;
    bridge.set_session("sdk-session")?;
    let response = send(&bridge, "{}").await?;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.text().await?, "provider request failed");
    server.abort();
    Ok(())
}

#[tokio::test]
async fn incomplete_upload_does_not_prevent_run_shutdown() -> TestResult {
    let mut upstream = MockServer::start(StatusCode::OK).await?;
    let bridge = ProviderBridge::start(config(&upstream.base_url)?)?;
    let guard = bridge.shutdown_guard();
    let address = bridge
        .base_url
        .trim_start_matches("http://")
        .trim_end_matches("/v1");
    let stream = tokio::net::TcpStream::connect(address).await?;
    let request = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nContent-Length: 1000\r\n\r\nx",
        bridge.token
    );
    stream.writable().await?;
    assert_eq!(stream.try_write(request.as_bytes())?, request.len());
    tokio::task::yield_now().await;
    drop(guard);
    tokio::time::timeout(Duration::from_secs(2), bridge.terminated.cancelled()).await?;
    assert!(upstream.requests.try_recv().is_err());
    Ok(())
}

#[tokio::test]
async fn configured_timeout_stops_an_idle_response_stream() -> TestResult {
    let upstream = MockServer::start(StatusCode::OK).await?;
    let bridge = ProviderBridge::start(config_with_timeout(&upstream.base_url, 1)?)?;
    bridge.set_session("sdk-session")?;
    let mut response = send(&bridge, "{}").await?;
    assert!(response.chunk().await?.is_some());
    assert!(
        tokio::time::timeout(Duration::from_secs(3), response.chunk())
            .await?
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn configured_timeout_bounds_the_wait_for_response_headers() -> TestResult {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let base_url = format!("http://{}/v1", listener.local_addr()?);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(|| async { std::future::pending::<Response>().await }),
    );
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let bridge = ProviderBridge::start(config_with_timeout(&base_url, 1)?)?;
    bridge.set_session("sdk-session")?;
    let response = tokio::time::timeout(Duration::from_secs(3), send(&bridge, "{}")).await??;
    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
    server.abort();
    Ok(())
}
