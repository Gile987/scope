// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use rustls::ClientConfig;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tracing::{debug, warn};

use crate::plugin::{ExchangeRequest, ExchangeResponse, HttpExchange, SessionId};
use crate::proxy::handler::ProxyState;

/// Intercept a TLS connection: MITM with forged cert, relay, and notify plugins.
pub async fn intercept_tls<S>(
    client_io: S,
    host: &str,
    session_id: &SessionId,
    state: &Arc<ProxyState>,
) -> anyhow::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    // Parse host without port for cert generation
    let domain = host.split(':').next().unwrap_or(host);
    let port: u16 = host
        .split(':')
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(443);

    // Get (or generate) a server config with a leaf cert for this domain
    let server_config = state.ca.server_config_for_domain(domain)?;
    let acceptor = TlsAcceptor::from(server_config);

    // TLS handshake with client (using forged cert)
    let client_tls = acceptor.accept(client_io).await?;
    debug!("TLS handshake complete with client for {}", domain);

    // Handle HTTP/1.1 over the intercepted TLS connection
    let io = TokioIo::new(client_tls);

    let state_clone = state.clone();
    let session_id_clone = session_id.clone();
    let domain_owned = domain.to_string();
    let port_owned = port;

    hyper::server::conn::http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req| {
                let state = state_clone.clone();
                let sid = session_id_clone.clone();
                let domain = domain_owned.clone();
                async move {
                    relay_request(req, &domain, port_owned, &sid, &state).await
                }
            }),
        )
        .await?;

    Ok(())
}

/// Relay a single request to the upstream, capture exchange, notify plugins.
async fn relay_request(
    req: hyper::Request<Incoming>,
    domain: &str,
    port: u16,
    session_id: &SessionId,
    state: &Arc<ProxyState>,
) -> Result<hyper::Response<Full<Bytes>>, hyper::Error> {
    match relay_request_inner(req, domain, port, session_id, state).await {
        Ok(resp) => Ok(resp),
        Err(e) => {
            warn!("Relay error for {}: {}", domain, e);
            Ok(hyper::Response::builder()
                .status(502)
                .body(Full::new(Bytes::from(format!("Upstream error: {}", e))))
                .unwrap())
        }
    }
}

async fn relay_request_inner(
    req: hyper::Request<Incoming>,
    domain: &str,
    port: u16,
    session_id: &SessionId,
    state: &Arc<ProxyState>,
) -> anyhow::Result<hyper::Response<Full<Bytes>>> {
    let started_at = chrono::Utc::now();
    let start_instant = std::time::Instant::now();

    // Capture request details
    let (parts, body) = req.into_parts();
    let req_body = body.collect().await?.to_bytes();

    let req_method = parts.method.clone();
    let req_uri = parts.uri.clone();
    let req_headers = parts.headers.clone();

    // Build the full URI for the upstream request
    let uri_str = format!("https://{}:{}{}", domain, port, parts.uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/"));
    let upstream_uri: hyper::Uri = uri_str.parse()?;

    // Connect to upstream with real TLS
    let upstream_tcp = TcpStream::connect(format!("{}:{}", domain, port)).await?;

    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let client_config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(client_config));

    let server_name = rustls::pki_types::ServerName::try_from(domain.to_string())?;
    let upstream_tls = connector.connect(server_name, upstream_tcp).await?;

    let io = TokioIo::new(upstream_tls);
    let (mut sender, conn) = hyper::client::conn::http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .handshake(io)
        .await?;

    tokio::spawn(async move {
        if let Err(e) = conn.await {
            debug!("Upstream connection ended: {}", e);
        }
    });

    // Build upstream request
    let mut upstream_req = hyper::Request::builder()
        .method(&parts.method)
        .uri(upstream_uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/"))
        .version(parts.version);

    for (key, value) in &parts.headers {
        upstream_req = upstream_req.header(key, value);
    }

    let upstream_req = upstream_req.body(Full::new(req_body.clone()))?;

    // Start timing from request send (after connect/TLS handshake)
    let request_instant = std::time::Instant::now();

    // Send to upstream and collect response
    let upstream_resp = sender.send_request(upstream_req).await?;
    let wait_ms = request_instant.elapsed().as_millis() as u64;
    let (resp_parts, resp_body) = upstream_resp.into_parts();
    let resp_body_bytes = resp_body.collect().await?.to_bytes();

    let elapsed_ms = request_instant.elapsed().as_millis() as u64;

    // Notify plugins
    let exchange = HttpExchange {
        request: ExchangeRequest {
            method: req_method,
            uri: req_uri,
            headers: req_headers,
            body: req_body,
        },
        response: ExchangeResponse {
            status: resp_parts.status,
            headers: resp_parts.headers.clone(),
            body: resp_body_bytes.clone(),
        },
        started_at,
        wait_ms,
        elapsed_ms,
    };

    state.session_manager.touch(session_id);
    state.registry.on_exchange(session_id, &exchange);

    // Build response back to client
    let mut resp = hyper::Response::builder().status(resp_parts.status);
    for (key, value) in &resp_parts.headers {
        resp = resp.header(key, value);
    }
    let resp = resp.body(Full::new(resp_body_bytes))?;

    Ok(resp)
}
