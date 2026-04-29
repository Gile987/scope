// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Entry point for the gateway proxy binary.
//!
//! Parses CLI args, loads YAML config, initializes the CA, plugin registry,
//! session manager, and spawns two long-running tasks:
//! - The REST API server (Axum) for session management and plugin endpoints
//! - The TCP proxy listener that handles CONNECT tunneling and HTTP forwarding
//!
//! Shutdown is cooperative: if either task exits, `tokio::select!` logs and returns.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use clap::Parser;
use http_body_util::Full;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use tokio::net::TcpListener;
use tracing::{error, info};

use gateway::api::routes::ApiState;
use gateway::ca::CertificateAuthority;
use gateway::config::{Cli, Config};
use gateway::filters::UrlFilter;
use gateway::plugin::PluginRegistry;
use gateway::plugins::har::plugin::{HarPlugin, har_session_router};
use gateway::proxy::handler::{ProxyState, handle_client};
use gateway::session::SessionManager;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let config = Config::load(&cli)?;

    // Logging: RUST_LOG env var takes precedence, then config file's logLevel, then default
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| config.log_level.parse().unwrap_or_default()),
        )
        .init();

    info!("Starting gateway proxy");
    info!("Proxy port: {}, API port: {}", config.port, config.api_port);
    info!("Watching URLs: {:?}", config.urls_to_watch);

    // CA
    let ca = Arc::new(CertificateAuthority::new(&config.cert_dir, 1000)?);
    info!("CA loaded from {:?}", config.cert_dir);

    // URL filter
    let url_filter = Arc::new(UrlFilter::new(&config.urls_to_watch)?);

    // Plugins
    let har_plugin = Arc::new(HarPlugin::new(config.har_output_dir()));
    let registry = Arc::new(PluginRegistry::new(vec![har_plugin.clone()]));

    // Session manager
    let session_manager = Arc::new(SessionManager::new(
        registry.clone(),
        Duration::from_secs(300),
        100,
    ));

    // Shared HTTP/1.1 connection pool for plain (non-CONNECT) forwarding.
    // A single client avoids per-request connection setup and enables keepalive reuse.
    let http_client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new())
        .pool_idle_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(4)
        .build_http();

    // Pre-built TLS config for upstream connections (MITM relay).
    // Contains Mozilla roots + any additional CA certs from config.
    let upstream_root_store = config.upstream_root_store()?;
    let upstream_tls_config = Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(upstream_root_store)
            .with_no_client_auth(),
    );
    if !config.additional_ca_certs.is_empty() {
        info!("Loaded additional CA certs from {:?}", config.additional_ca_certs);
    }

    let proxy_state = Arc::new(ProxyState {
        session_manager: session_manager.clone(),
        registry: registry.clone(),
        ca: ca.clone(),
        url_filter,
        http_client,
        upstream_tls_config,
    });

    // API state
    let api_state = Arc::new(ApiState {
        session_manager: session_manager.clone(),
        ca: ca.clone(),
    });

    // Plugin API routes (session-scoped, mounted under /api/v1/sessions/:id/)
    let har_router = har_session_router(har_plugin);

    // Background task that periodically scans for sessions with no recent activity.
    // Orphaned sessions (e.g., client crashed without calling stop) are cleaned up here.
    let reaper_session_mgr = session_manager.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            let reaped = reaper_session_mgr.reap_idle();
            if !reaped.is_empty() {
                info!("Reaped {} idle sessions", reaped.len());
            }
        }
    });

    // Start API server
    let api_port = config.api_port;
    let api_handle = tokio::spawn(async move {
        if let Err(e) = gateway::api::server::run_api_server(api_state, api_port, vec![har_router]).await {
            error!("API server error: {}", e);
        }
    });

    // Start proxy listener
    let proxy_addr = format!("0.0.0.0:{}", config.port);
    let listener = TcpListener::bind(&proxy_addr).await?;
    info!("Proxy listening on {}", proxy_addr);

    let proxy_handle = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer_addr)) => {
                    let state = proxy_state.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_client(stream, peer_addr, state).await {
                            tracing::debug!("Client connection ended: {}", e);
                        }
                    });
                }
                Err(e) => {
                    error!("Accept error: {}", e);
                    // Back off on transient errors (e.g. EMFILE) to avoid hot-looping
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    });

    // Wait for either to finish (they shouldn't under normal operation)
    tokio::select! {
        _ = api_handle => { error!("API server exited unexpectedly"); }
        _ = proxy_handle => { error!("Proxy listener exited unexpectedly"); }
    }

    Ok(())
}
