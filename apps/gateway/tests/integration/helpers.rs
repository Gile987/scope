// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

use gateway::ca::CertificateAuthority;
use gateway::filters::UrlFilter;
use gateway::plugin::PluginRegistry;
use gateway::plugins::har::plugin::HarPlugin;
use gateway::proxy::handler::{handle_client, ProxyState};
use gateway::session::SessionManager;
use tokio::net::TcpListener;

/// A fully wired test gateway that can be torn down after each test.
pub struct TestGateway {
    #[allow(dead_code)]
    pub proxy_addr: SocketAddr,
    pub api_addr: SocketAddr,
    #[allow(dead_code)]
    pub ca: Arc<CertificateAuthority>,
    #[allow(dead_code)]
    pub session_manager: Arc<SessionManager>,
    #[allow(dead_code)]
    pub har_dir: PathBuf,
}

impl TestGateway {
    /// Start a test gateway on ephemeral ports.
    pub async fn start(har_dir: PathBuf, urls: &[&str]) -> Self {
        // Install crypto provider (idempotent)
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

        let cert_dir = har_dir.join("certs");
        std::fs::create_dir_all(&cert_dir).unwrap();
        std::fs::create_dir_all(&har_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::new(&cert_dir, 100).unwrap());
        let url_strs: Vec<String> = urls.iter().map(|s| s.to_string()).collect();
        let url_filter = Arc::new(UrlFilter::new(&url_strs).unwrap());
        let har_plugin: Arc<dyn gateway::plugin::ProxyPlugin> =
            Arc::new(HarPlugin::new(har_dir.clone()));
        let registry = Arc::new(PluginRegistry::new(vec![har_plugin]));
        let iteration_store: Arc<dyn gateway::iteration_store::IterationStore> =
            Arc::new(gateway::iteration_store::LocalIterationStore::new());
        let session_manager = Arc::new(SessionManager::new(
            registry.clone(),
            Duration::from_secs(300),
            100,
            iteration_store,
        ));

        let http_client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(2)
            .build_http();

        let mut upstream_root_store = rustls::RootCertStore::empty();
        upstream_root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

        // Also trust the gateway's own CA so it can connect to test HTTPS backends
        // that present certs signed by this CA.
        let ca_pem = ca.ca_cert_pem();
        let ca_certs = rustls_pemfile::certs(&mut ca_pem.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for cert in ca_certs {
            upstream_root_store.add(cert).unwrap();
        }

        let upstream_tls_config = Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(upstream_root_store)
                .with_no_client_auth(),
        );

        let proxy_state = Arc::new(ProxyState {
            session_manager: session_manager.clone(),
            registry: registry.clone(),
            ca: ca.clone(),
            url_filter,
            http_client,
            upstream_tls_config,
            api_router: axum::Router::new(),
        });

        // Bind proxy on ephemeral port
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();

        tokio::spawn(async move {
            while let Ok((stream, peer_addr)) = proxy_listener.accept().await {
                let state = proxy_state.clone();
                tokio::spawn(async move {
                    let _ = handle_client(stream, peer_addr, state).await;
                });
            }
        });

        // Bind API on ephemeral port
        let api_state = Arc::new(gateway::api::routes::ApiState {
            session_manager: session_manager.clone(),
            ca: ca.clone(),
            blob_container_client: None,
        });

        let plugin_routes: Vec<axum::Router> = registry
            .plugins()
            .iter()
            .filter_map(|p| p.api_routes())
            .collect();

        let api_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_addr = api_listener.local_addr().unwrap();

        tokio::spawn(async move {
            use axum::routing::{delete, get, post};
            use axum::Router;

            let session_routes = Router::new()
                .route("/", get(gateway::api::routes::get_session))
                .route("/stop", post(gateway::api::routes::post_stop_session))
                .route("/", delete(gateway::api::routes::delete_session))
                .with_state(api_state.clone());

            // Merge plugin-provided session-scoped routes
            let session_routes = plugin_routes
                .into_iter()
                .fold(session_routes, |r, plugin_r| r.merge(plugin_r));

            let api_v1 = Router::new()
                .route("/cacert", get(gateway::api::routes::get_cacert))
                .route("/sessions", post(gateway::api::routes::post_create_session))
                .route("/sessions", get(gateway::api::routes::get_list_sessions))
                .with_state(api_state)
                .nest("/sessions/{id}", session_routes);

            let app = Router::new()
                .route("/health", get(gateway::api::routes::get_health))
                .nest("/api/v1", api_v1);

            axum::serve(
                api_listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });

        // Wait briefly for listeners to be ready
        tokio::time::sleep(Duration::from_millis(50)).await;

        TestGateway {
            proxy_addr,
            api_addr,
            ca,
            session_manager,
            har_dir,
        }
    }

    pub fn api_url(&self, path: &str) -> String {
        format!("http://{}{}", self.api_addr, path)
    }
}

// ---------------------------------------------------------------------------
// Test HTTPS backend — serves HTTPS using a cert signed by the gateway's CA
// ---------------------------------------------------------------------------

use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio_rustls::TlsAcceptor;

/// A mock HTTPS backend for end-to-end tests.
/// Uses a cert forged by the gateway's CA so the proxy trusts it.
pub struct TestHttpsBackend {
    pub addr: SocketAddr,
}

/// Route handler type: receives the request path, returns (status, headers, body).
type RouteHandler = Box<
    dyn Fn(
            String,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = (u16, Vec<(String, String)>, Vec<u8>)> + Send>,
        > + Send
        + Sync,
>;

impl TestHttpsBackend {
    /// Start a mock HTTPS server on an ephemeral port.
    /// `ca` is used to generate a cert for "localhost".
    /// `handler` maps request path → (status, extra_headers, body).
    pub async fn start(ca: &Arc<CertificateAuthority>, handler: RouteHandler) -> Self {
        let server_config = ca.server_config_for_domain("localhost").unwrap();
        let tls_acceptor = TlsAcceptor::from(server_config);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let handler = Arc::new(handler);

        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let acceptor = tls_acceptor.clone();
                let handler = handler.clone();

                tokio::spawn(async move {
                    let Ok(tls_stream) = acceptor.accept(stream).await else {
                        return;
                    };
                    let io = TokioIo::new(tls_stream);

                    let handler = handler.clone();
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(
                            io,
                            service_fn(move |req: hyper::Request<Incoming>| {
                                let handler = handler.clone();
                                let path = req.uri().path().to_string();
                                async move {
                                    let (status, headers, body) = handler(path).await;
                                    let mut resp = hyper::Response::builder().status(status);
                                    for (k, v) in &headers {
                                        resp = resp.header(k.as_str(), v.as_str());
                                    }
                                    Ok::<_, hyper::Error>(
                                        resp.body(Full::new(Bytes::from(body))).unwrap(),
                                    )
                                }
                            }),
                        )
                        .await;
                });
            }
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        TestHttpsBackend { addr }
    }
}

/// A mock HTTPS backend that streams SSE events with configurable delays.
pub struct TestSseBackend {
    pub addr: SocketAddr,
}

/// A streaming body that sends pre-built chunks with delays between them.
struct SseBody {
    rx: mpsc::Receiver<Bytes>,
}

impl hyper::body::Body for SseBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Self::Data>, Self::Error>>> {
        self.get_mut()
            .rx
            .poll_recv(cx)
            .map(|opt| opt.map(|b| Ok(hyper::body::Frame::data(b))))
    }
}

use tokio::sync::mpsc;

impl TestSseBackend {
    /// Start a mock SSE backend. Sends `events` with `delay` between each.
    pub async fn start(
        ca: &Arc<CertificateAuthority>,
        events: Vec<String>,
        delay: Duration,
    ) -> Self {
        let server_config = ca.server_config_for_domain("localhost").unwrap();
        let tls_acceptor = TlsAcceptor::from(server_config);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let events = Arc::new(events);

        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let acceptor = tls_acceptor.clone();
                let events = events.clone();

                tokio::spawn(async move {
                    let Ok(tls_stream) = acceptor.accept(stream).await else {
                        return;
                    };
                    let io = TokioIo::new(tls_stream);

                    let events = events.clone();
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(
                            io,
                            service_fn(move |_req: hyper::Request<Incoming>| {
                                let events = events.clone();
                                async move {
                                    let (tx, rx) = mpsc::channel::<Bytes>(32);

                                    tokio::spawn(async move {
                                        for event in events.iter() {
                                            let chunk = format!("data: {}\n\n", event);
                                            if tx.send(Bytes::from(chunk)).await.is_err() {
                                                break;
                                            }
                                            tokio::time::sleep(delay).await;
                                        }
                                    });

                                    let resp = hyper::Response::builder()
                                        .status(200)
                                        .header("content-type", "text/event-stream")
                                        .header("cache-control", "no-cache")
                                        .body(SseBody { rx })
                                        .unwrap();
                                    Ok::<_, hyper::Error>(resp)
                                }
                            }),
                        )
                        .await;
                });
            }
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        TestSseBackend { addr }
    }
}

// ---------------------------------------------------------------------------
// Test plain HTTP backend
// ---------------------------------------------------------------------------

pub struct TestHttpBackend {
    pub addr: SocketAddr,
}

impl TestHttpBackend {
    /// Start a plain HTTP backend on an ephemeral port.
    pub async fn start(handler: RouteHandler) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let handler = Arc::new(handler);

        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let handler = handler.clone();

                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let handler = handler.clone();
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(
                            io,
                            service_fn(move |req: hyper::Request<Incoming>| {
                                let handler = handler.clone();
                                let path = req.uri().path().to_string();
                                async move {
                                    let (status, headers, body) = handler(path).await;
                                    let mut resp = hyper::Response::builder().status(status);
                                    for (k, v) in &headers {
                                        resp = resp.header(k.as_str(), v.as_str());
                                    }
                                    Ok::<_, hyper::Error>(
                                        resp.body(Full::new(Bytes::from(body))).unwrap(),
                                    )
                                }
                            }),
                        )
                        .await;
                });
            }
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        TestHttpBackend { addr }
    }
}
