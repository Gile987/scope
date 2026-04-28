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
use gateway::plugins::har::plugin::{HarPlugin, har_session_router};
use gateway::proxy::handler::{ProxyState, handle_client};
use gateway::session::SessionManager;

use tokio::net::TcpListener;

/// A fully wired test gateway that can be torn down after each test.
pub struct TestGateway {
    pub proxy_addr: SocketAddr,
    pub api_addr: SocketAddr,
    #[allow(dead_code)]
    pub ca: Arc<CertificateAuthority>,
    #[allow(dead_code)]
    pub session_manager: Arc<SessionManager>,
    #[allow(dead_code)]
    pub har_plugin: Arc<HarPlugin>,
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
        let har_plugin = Arc::new(HarPlugin::new(har_dir.clone()));
        let registry = Arc::new(PluginRegistry::new(vec![har_plugin.clone()]));
        let session_manager = Arc::new(SessionManager::new(
            registry.clone(),
            Duration::from_secs(300),
            100,
        ));

        let http_client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(2)
            .build_http();
        let proxy_state = Arc::new(ProxyState {
            session_manager: session_manager.clone(),
            registry: registry.clone(),
            ca: ca.clone(),
            url_filter,
            http_client,
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
        });

        let har_router = har_session_router(har_plugin.clone());

        let api_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_addr = api_listener.local_addr().unwrap();

        tokio::spawn(async move {
            use axum::routing::{delete, get, post};
            use axum::Router;

            let session_routes = Router::new()
                .route("/", get(gateway::api::routes::get_session))
                .route("/stop", post(gateway::api::routes::post_stop_session))
                .route("/", delete(gateway::api::routes::delete_session))
                .with_state(api_state.clone())
                .merge(har_router);

            let api_v1 = Router::new()
                .route("/cacert", get(gateway::api::routes::get_cacert))
                .route("/sessions", post(gateway::api::routes::post_create_session))
                .route("/sessions", get(gateway::api::routes::get_list_sessions))
                .with_state(api_state)
                .nest("/sessions/{id}", session_routes);

            let app = Router::new()
                .route("/healthz", get(gateway::api::routes::get_health))
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
            har_plugin,
            har_dir,
        }
    }

    pub fn api_url(&self, path: &str) -> String {
        format!("http://{}{}", self.api_addr, path)
    }
}
