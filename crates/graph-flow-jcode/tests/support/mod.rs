use graph_flow_jcode::jcode_sdk::{
    ConnectOptions, JcodeClient, Transport,
    api::{
        API_VERSION_MAJOR, ApiEvent, ApiRequest, ClientFrame, ServerFrame, SessionInfo, read_frame,
        write_frame,
    },
};
use std::{
    error::Error,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    sync::{Arc, Mutex},
    time::Duration,
};

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

struct PairTransport(UnixStream);

impl Transport for PairTransport {
    fn split(
        self: Box<Self>,
    ) -> graph_flow_jcode::jcode_sdk::Result<(Box<dyn BufRead + Send>, Box<dyn Write + Send>)> {
        let writer = self.0.try_clone().map_err(|error| {
            graph_flow_jcode::jcode_sdk::Error::new(
                graph_flow_jcode::jcode_sdk::ErrorKind::Transport,
                error.to_string(),
            )
        })?;
        Ok((Box::new(BufReader::new(self.0)), Box::new(writer)))
    }
}

/// Connect a jcode SDK client to a scripted in-process harness.
///
/// # Errors
/// Returns an error when the socket pair or SDK handshake fails.
pub fn fake_client(requests: Arc<Mutex<Vec<ApiRequest>>>) -> TestResult<JcodeClient> {
    let (client_socket, server_socket) = UnixStream::pair()?;
    let _server = std::thread::spawn(move || serve(server_socket, requests.as_ref()));
    let client = JcodeClient::connect_with(
        Box::new(PairTransport(client_socket)),
        ConnectOptions {
            ensure_runtime: false,
            request_timeout: Some(Duration::from_secs(5)),
            ..ConnectOptions::default()
        },
    )?;
    Ok(client)
}

fn serve(socket: UnixStream, requests: &Mutex<Vec<ApiRequest>>) -> TestResult<()> {
    let reader_socket = socket.try_clone()?;
    let mut reader = BufReader::new(reader_socket);
    let mut writer = socket;
    let mut session_count = 0_u64;
    while let Ok(frame) = read_frame::<_, ClientFrame>(&mut reader) {
        if matches!(frame.request, ApiRequest::Hello { .. }) {
            reply(
                &frame,
                ApiEvent::HelloOk {
                    version: API_VERSION_MAJOR,
                    server: "fake-jcode/1.0".to_owned(),
                    capabilities: vec!["sessions".to_owned()],
                },
                &mut writer,
            )?;
            continue;
        }
        requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(frame.request.clone());
        match &frame.request {
            ApiRequest::CreateSession { working_dir } => {
                session_count = session_count.saturating_add(1);
                reply(
                    &frame,
                    ApiEvent::Attached {
                        session: SessionInfo {
                            session_id: format!("session-{session_count}"),
                            working_dir: working_dir.clone(),
                            title: None,
                            status: "idle".to_owned(),
                            transcript_bytes: None,
                            archived: false,
                            archived_at_ms: None,
                        },
                    },
                    &mut writer,
                )?;
            }
            ApiRequest::SetApiKey { provider, .. } => reply(
                &frame,
                ApiEvent::CredentialUpdated {
                    provider: provider.clone(),
                    configured: true,
                },
                &mut writer,
            )?,
            ApiRequest::SetModel { .. } | ApiRequest::SetReasoningEffort { .. } => {
                reply(&frame, ApiEvent::Ok, &mut writer)?;
            }
            ApiRequest::SendMessage { session_id, .. } => {
                push(
                    ApiEvent::MessageAccepted {
                        session_id: session_id.clone(),
                    },
                    &mut writer,
                )?;
                push(
                    ApiEvent::TextDelta {
                        session_id: session_id.clone(),
                        text: "translated output".to_owned(),
                    },
                    &mut writer,
                )?;
                push(
                    ApiEvent::TurnDone {
                        session_id: session_id.clone(),
                    },
                    &mut writer,
                )?;
            }
            other => return Err(format!("unexpected fake request: {other:?}").into()),
        }
    }
    Ok(())
}

fn reply(frame: &ClientFrame, event: ApiEvent, writer: &mut impl Write) -> TestResult<()> {
    write_frame(writer, &ServerFrame::reply(frame.id, event))?;
    Ok(())
}

fn push(event: ApiEvent, writer: &mut impl Write) -> TestResult<()> {
    write_frame(writer, &ServerFrame::event(event))?;
    Ok(())
}
