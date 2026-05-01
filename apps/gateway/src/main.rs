// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Entry point for the gateway proxy binary.
//!
//! Parses CLI args, loads YAML config, initializes the CA, plugin registry,
//! session manager, and starts the unified TCP listener that handles both
//! proxy traffic (CONNECT tunneling, HTTP forwarding) and the REST API on a
//! single port. This ensures K8s sessionAffinity: ClientIP works correctly
//! since all traffic from a client uses the same port.

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
use gateway::api::server::build_api_router;
use gateway::ca::CertificateAuthority;
use gateway::config::{Cli, Config};
use gateway::filters::UrlFilter;
use gateway::plugin::PluginRegistry;
use gateway::plugins::har::plugin::HarPlugin;
use azure_storage::StorageCredentials;
use azure_storage_blobs::prelude::BlobServiceClient;
use gateway::proxy::handler::{handle_client, ProxyState};
use gateway::session::SessionManager;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Install the process-level CryptoProvider so that all rustls consumers
    // (our proxy TLS + reqwest in plugins) use the same aws-lc-rs backend.
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install default CryptoProvider");

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
    info!("Listening on port: {}", config.port);
    info!("Watching URLs: {:?}", config.urls_to_watch);

    // CA
    let ca = Arc::new(CertificateAuthority::new(&config.cert_dir, 1000)?);
    info!("CA loaded from {:?}", config.cert_dir);

    // URL filter
    let url_filter = Arc::new(UrlFilter::new(&config.urls_to_watch)?);

    // Plugins — HAR writer backend selected from config
    let har_plugin: Arc<dyn gateway::plugin::ProxyPlugin> = if let Some(blob_cfg) = &config.har_blob {
        info!(
            "HAR plugin: using Azure Blob Storage backend (account={}, container={})",
            blob_cfg.storage_account_url, blob_cfg.container_name
        );
        let credential = azure_identity::DefaultAzureCredentialBuilder::new()
            .build()
            .map_err(|e| anyhow::anyhow!("Failed to create Azure credential: {}", e))?;
        let storage_creds = StorageCredentials::token_credential(Arc::new(credential));
        let service_client = BlobServiceClient::new(&blob_cfg.storage_account_url, storage_creds);
        let container_client = service_client.container_client(&blob_cfg.container_name);
        Arc::new(HarPlugin::new_with_blob(container_client))
    } else {
        let har_dir = HarPlugin::output_dir_from_settings(&config.default_plugin_settings);
        info!("HAR plugin: using local filesystem backend ({:?})", har_dir);
        Arc::new(HarPlugin::new(har_dir))
    };

    // API state & router (served on the same port as proxy traffic)
    let api_state = Arc::new(ApiState {
        session_manager: session_manager.clone(),
        ca: ca.clone(),
    });
    let plugin_routes: Vec<axum::Router> = registry
        .plugins()
        .iter()
        .filter_map(|p| p.api_routes())
        .collect();
    let api_router = build_api_router(api_state, plugin_routes);

    let proxy_state = Arc::new(ProxyState {
        session_manager: session_manager.clone(),
        registry: registry.clone(),
        ca: ca.clone(),
        url_filter,
        http_client,
        upstream_tls_config,
        api_router,
    });

    // Background task that periodically scans for sessions with no recent activity.
    // Orphaned sessions (e.g., client crashed without calling stop) are cleaned up here.
    let reaper_session_mgr = session_manager.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            let reaped = reaper_session_mgr.reap_idle().await;
            if !reaped.is_empty() {
                info!("Reaped {} idle sessions", reaped.len());
            }
        }
    });

    // Start unified listener (proxy + API on the same port)
    let listen_addr = format!("0.0.0.0:{}", config.port);
    let listener = TcpListener::bind(&listen_addr).await?;
    info!("Proxy listening on {}", listen_addr);

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
}
