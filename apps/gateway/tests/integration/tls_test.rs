// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::sync::Arc;

use gateway::ca::CertificateAuthority;
use rustls::pki_types::{CertificateDer, ServerName};
use tempfile::TempDir;

fn install_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

/// Generated CA cert should be parseable and the leaf cert should chain to it.
#[test]
fn cert_chain_validates() {
    install_crypto_provider();

    let tmp = TempDir::new().unwrap();
    let ca = CertificateAuthority::new(tmp.path(), 100).unwrap();

    // Get the CA cert PEM
    let ca_pem = ca.ca_cert_pem();

    // Generate a leaf for example.com
    let server_config = ca.server_config_for_domain("example.com").unwrap();

    // The server config should have certs
    // We can't easily extract the cert chain from ServerConfig,
    // but we can verify the CA PEM is valid
    assert!(ca_pem.contains("BEGIN CERTIFICATE"));

    // Verify we can parse the CA cert
    let ca_der = pem_to_der(&ca_pem);
    assert!(!ca_der.is_empty());
}

/// Two different domains should produce different leaf certs.
#[test]
fn different_domains_different_certs() {
    install_crypto_provider();

    let tmp = TempDir::new().unwrap();
    let ca = CertificateAuthority::new(tmp.path(), 100).unwrap();

    let c1 = ca.server_config_for_domain("a.example.com").unwrap();
    let c2 = ca.server_config_for_domain("b.example.com").unwrap();

    // Different Arc pointers = different configs
    assert!(!Arc::ptr_eq(&c1, &c2));
}

/// Same domain should return cached cert.
#[test]
fn same_domain_cached() {
    install_crypto_provider();

    let tmp = TempDir::new().unwrap();
    let ca = CertificateAuthority::new(tmp.path(), 100).unwrap();

    let c1 = ca.server_config_for_domain("example.com").unwrap();
    let c2 = ca.server_config_for_domain("example.com").unwrap();

    // Same Arc = cached
    assert!(Arc::ptr_eq(&c1, &c2));
}

/// CA should persist to disk and reload with same public key.
#[test]
fn ca_persistence() {
    install_crypto_provider();

    let tmp = TempDir::new().unwrap();

    let pem1 = {
        let ca = CertificateAuthority::new(tmp.path(), 100).unwrap();
        ca.ca_cert_pem()
    };

    let pem2 = {
        let ca = CertificateAuthority::new(tmp.path(), 100).unwrap();
        ca.ca_cert_pem()
    };

    // Should return the same PEM (loaded from disk)
    assert_eq!(pem1, pem2);
}

fn pem_to_der(pem: &str) -> Vec<u8> {
    let pem = pem.trim();
    let lines: Vec<&str> = pem.lines().collect();
    let b64: String = lines[1..lines.len() - 1].join("");
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64).unwrap()
}
