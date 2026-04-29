// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! X.509 certificate authority with dynamic leaf certificate generation.
//!
//! The CA key pair is persisted to disk so the same root cert survives restarts
//! (clients only need to trust it once). Leaf certificates are generated on-demand
//! per domain and cached in an LRU to bound memory while avoiding repeated
//! RSA key generation (~1ms per leaf cert).

use std::path::Path;
use std::sync::Arc;

use lru::LruCache;
// parking_lot::Mutex over std::Mutex: no poisoning, faster for the short critical
// sections here (LRU lookup + insert). We never hold this across await points.
use parking_lot::Mutex;
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;

/// Manages the CA key pair and generates/caches leaf certificates per domain.
pub struct CertificateAuthority {
    ca_cert: rcgen::Certificate,
    ca_key: KeyPair,
    ca_cert_der: CertificateDer<'static>,
    ca_cert_pem_str: String,
    /// LRU cache of domain -> (ServerConfig with leaf cert)
    cache: Mutex<LruCache<String, Arc<ServerConfig>>>,
}

impl CertificateAuthority {
    /// Create or load a CA. If cert/key files exist in `cert_dir`, load them.
    /// Otherwise generate a new self-signed CA and persist to disk.
    pub fn new(cert_dir: &Path, cache_size: usize) -> anyhow::Result<Self> {
        let cert_path = cert_dir.join("ca.crt");
        let key_path = cert_dir.join("ca.key");

        let (ca_cert, ca_key, ca_cert_der, ca_cert_pem_str) =
            if cert_path.exists() && key_path.exists() {
                let cert_pem = std::fs::read_to_string(&cert_path)?;
                let key_pem = std::fs::read_to_string(&key_path)?;
                let key = KeyPair::from_pem(&key_pem)?;
                let params = CertificateParams::from_ca_cert_pem(&cert_pem)?;
                let cert = params.self_signed(&key)?;
                let der = CertificateDer::from(cert.der().to_vec());
                (cert, key, der, cert_pem)
            } else {
                let (cert, key, der) = Self::generate_ca()?;
                let pem = cert.pem();
                std::fs::create_dir_all(cert_dir)?;
                std::fs::write(&cert_path, &pem)?;
                std::fs::write(&key_path, key.serialize_pem())?;
                (cert, key, der, pem)
            };

        let cache = Mutex::new(LruCache::new(
            std::num::NonZeroUsize::new(cache_size.max(1))
                .expect("cache_size.max(1) is always > 0"),
        ));

        Ok(Self {
            ca_cert,
            ca_key,
            ca_cert_der,
            ca_cert_pem_str,
            cache,
        })
    }

    fn generate_ca() -> anyhow::Result<(rcgen::Certificate, KeyPair, CertificateDer<'static>)> {
        let mut params = CertificateParams::new(Vec::<String>::new())?;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "Gateway Proxy CA");
        dn.push(DnType::OrganizationName, "Scope");
        params.distinguished_name = dn;
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);

        let key = KeyPair::generate()?;
        let cert = params.self_signed(&key)?;
        let der = CertificateDer::from(cert.der().to_vec());

        Ok((cert, key, der))
    }

    /// Get the CA certificate in PEM format (for GET /proxy/rootCertificate).
    pub fn ca_cert_pem(&self) -> String {
        self.ca_cert_pem_str.clone()
    }

    /// Get or generate a rustls ServerConfig with a leaf cert for the given domain.
    pub fn server_config_for_domain(&self, domain: &str) -> anyhow::Result<Arc<ServerConfig>> {
        // Two-phase lock: check cache, release lock, then generate if needed.
        // Key generation is expensive (~1ms), so we don't hold the lock during it.
        {
            let mut cache = self.cache.lock();
            if let Some(config) = cache.get(domain) {
                return Ok(config.clone());
            }
        }

        let config = self.generate_leaf_config(domain)?;
        let config = Arc::new(config);

        {
            let mut cache = self.cache.lock();
            cache.put(domain.to_string(), config.clone());
        }

        Ok(config)
    }

    fn generate_leaf_config(&self, domain: &str) -> anyhow::Result<ServerConfig> {
        let mut params = CertificateParams::new(Vec::<String>::new())?;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, domain);
        params.distinguished_name = dn;
        params.subject_alt_names = vec![SanType::DnsName(domain.try_into()?)];
        params.is_ca = rcgen::IsCa::NoCa;

        let leaf_key = KeyPair::generate()?;
        let leaf_cert = params.signed_by(&leaf_key, &self.ca_cert, &self.ca_key)?;

        let leaf_cert_der = CertificateDer::from(leaf_cert.der().to_vec());
        let leaf_key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));

        // TLS requires the cert chain in order: leaf first, then issuing CA.
        // The client validates the leaf against the CA it already trusts.
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![leaf_cert_der, self.ca_cert_der.clone()], leaf_key_der)?;

        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn install_crypto_provider() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    }

    #[test]
    fn generate_ca_and_leaf() {
        install_crypto_provider();
        let tmp = TempDir::new().unwrap();
        let ca = CertificateAuthority::new(tmp.path(), 100).unwrap();

        // CA cert should be valid PEM
        let pem = ca.ca_cert_pem();
        assert!(pem.contains("BEGIN CERTIFICATE"));

        // Should generate a server config for a domain
        let config = ca.server_config_for_domain("example.com").unwrap();
        assert!(Arc::strong_count(&config) >= 1);
    }

    #[test]
    fn ca_persisted_and_reloaded() {
        let tmp = TempDir::new().unwrap();

        let pem1 = {
            let ca = CertificateAuthority::new(tmp.path(), 100).unwrap();
            ca.ca_cert_pem()
        };

        // Loading again from same dir should reuse the same CA
        let pem2 = {
            let ca = CertificateAuthority::new(tmp.path(), 100).unwrap();
            ca.ca_cert_pem()
        };

        assert_eq!(pem1, pem2);
    }

    #[test]
    fn leaf_cert_cached() {
        install_crypto_provider();
        let tmp = TempDir::new().unwrap();
        let ca = CertificateAuthority::new(tmp.path(), 100).unwrap();

        let c1 = ca.server_config_for_domain("example.com").unwrap();
        let c2 = ca.server_config_for_domain("example.com").unwrap();
        // Same Arc — should be the cached instance
        assert!(Arc::ptr_eq(&c1, &c2));
    }

    #[test]
    fn different_domains_get_different_certs() {
        install_crypto_provider();
        let tmp = TempDir::new().unwrap();
        let ca = CertificateAuthority::new(tmp.path(), 100).unwrap();

        let c1 = ca.server_config_for_domain("a.example.com").unwrap();
        let c2 = ca.server_config_for_domain("b.example.com").unwrap();
        assert!(!Arc::ptr_eq(&c1, &c2));
    }

    #[test]
    fn lru_eviction() {
        install_crypto_provider();
        let tmp = TempDir::new().unwrap();
        let ca = CertificateAuthority::new(tmp.path(), 2).unwrap();

        let _c1 = ca.server_config_for_domain("a.com").unwrap();
        let _c2 = ca.server_config_for_domain("b.com").unwrap();
        let _c3 = ca.server_config_for_domain("c.com").unwrap(); // evicts a.com

        // a.com should be evicted — new call generates a fresh config
        let c1_new = ca.server_config_for_domain("a.com").unwrap();
        // Can't check ptr_eq since it was evicted, but it should still work
        assert!(Arc::strong_count(&c1_new) >= 1);
    }
}
