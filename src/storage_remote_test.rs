use std::time::Duration;

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use crate::{ApplicationConfig, StateBackendConfig, TursoRemoteConfig, WorkflowError};

#[tokio::test]
async fn remote_configuration_reaches_http_and_auth_failure_is_redacted()
-> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/", listener.local_addr()?);
    let token = "test-only-secret-token";
    let StateBackendConfig::Turso(mut config) = ApplicationConfig::local_default().state.backend;
    config.remote = Some(TursoRemoteConfig::new(url, token.to_owned())?);

    let server = async {
        let (mut socket, _) = listener.accept().await?;
        let mut bytes = Vec::new();
        let mut chunk = [0; 1024];
        while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            let count = socket.read(&mut chunk).await?;
            if count == 0 || bytes.len() > 16_384 {
                return Err(std::io::Error::other("incomplete request headers"));
            }
            bytes.extend_from_slice(
                chunk
                    .get(..count)
                    .ok_or_else(|| std::io::Error::other("invalid read length"))?,
            );
        }
        let request = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
        assert!(request.contains("authorization: bearer test-only-secret-token\r\n"));
        // Even an error body echoing credentials must not enter WorkflowError or logs.
        let response = format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{token}",
            token.len()
        );
        socket.write_all(response.as_bytes()).await?;
        Ok::<(), std::io::Error>(())
    };
    let (opened, response_result) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(super::TursoStore::open(&config), server)
    })
    .await?;
    response_result?;
    let Err(WorkflowError::Storage { message }) = opened else {
        return Err("remote authorization failure must stop startup".into());
    };
    assert_eq!(message, "Turso remote connection failed");
    assert!(!message.contains(token));
    Ok(())
}
