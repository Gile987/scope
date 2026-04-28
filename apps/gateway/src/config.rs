// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::collections::HashMap;
use std::path::PathBuf;

use clap::Parser;
use serde::{Deserialize, Serialize};

#[derive(Parser, Debug)]
#[command(name = "gateway", about = "TLS-intercepting HTTP proxy with plugin architecture")]
pub struct Cli {
    /// Path to YAML config file
    #[arg(long, short)]
    pub config: Option<PathBuf>,

    /// Proxy listen port
    #[arg(long)]
    pub port: Option<u16>,

    /// API listen port
    #[arg(long, name = "api-port")]
    pub api_port: Option<u16>,

    /// HAR output directory
    #[arg(long, name = "har-dir")]
    pub har_dir: Option<PathBuf>,

    /// Certificate directory
    #[arg(long, name = "cert-dir")]
    pub cert_dir: Option<PathBuf>,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, name = "log-level")]
    pub log_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_urls_to_watch")]
    pub urls_to_watch: Vec<String>,

    #[serde(default = "default_port")]
    pub port: u16,

    #[serde(default = "default_api_port")]
    pub api_port: u16,

    #[serde(default = "default_har_output_dir")]
    pub har_output_dir: PathBuf,

    #[serde(default = "default_cert_dir")]
    pub cert_dir: PathBuf,

    #[serde(default = "default_log_level")]
    pub log_level: String,

    #[serde(default)]
    pub default_plugin_settings: HashMap<String, serde_json::Value>,
}

fn default_urls_to_watch() -> Vec<String> {
    vec!["https://*/*".to_string()]
}

fn default_port() -> u16 {
    18000
}

fn default_api_port() -> u16 {
    18897
}

fn default_har_output_dir() -> PathBuf {
    PathBuf::from("/har-output")
}

fn default_cert_dir() -> PathBuf {
    PathBuf::from("/certs")
}

fn default_log_level() -> String {
    "info".to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            urls_to_watch: default_urls_to_watch(),
            port: default_port(),
            api_port: default_api_port(),
            har_output_dir: default_har_output_dir(),
            cert_dir: default_cert_dir(),
            log_level: default_log_level(),
            default_plugin_settings: HashMap::new(),
        }
    }
}

impl Config {
    /// Load config from YAML file, then apply CLI overrides.
    pub fn load(cli: &Cli) -> anyhow::Result<Self> {
        let mut config = if let Some(path) = &cli.config {
            let contents = std::fs::read_to_string(path)
                .map_err(|e| anyhow::anyhow!("Failed to read config file {:?}: {}", path, e))?;
            serde_yaml::from_str(&contents)
                .map_err(|e| anyhow::anyhow!("Failed to parse config file {:?}: {}", path, e))?
        } else {
            Config::default()
        };

        // CLI flags override file values
        if let Some(port) = cli.port {
            config.port = port;
        }
        if let Some(api_port) = cli.api_port {
            config.api_port = api_port;
        }
        if let Some(har_dir) = &cli.har_dir {
            config.har_output_dir = har_dir.clone();
        }
        if let Some(cert_dir) = &cli.cert_dir {
            config.cert_dir = cert_dir.clone();
        }
        if let Some(log_level) = &cli.log_level {
            config.log_level = log_level.clone();
        }

        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_expected_values() {
        let config = Config::default();
        assert_eq!(config.port, 18000);
        assert_eq!(config.api_port, 18897);
        assert_eq!(config.log_level, "info");
        assert!(!config.urls_to_watch.is_empty());
    }

    #[test]
    fn parse_yaml_config() {
        let yaml = r#"
urlsToWatch:
  - "https://api.github.com/*"
  - "https://api.anthropic.com/*"
port: 9000
apiPort: 9001
harOutputDir: /tmp/har
certDir: /tmp/certs
logLevel: debug
defaultPluginSettings:
  har:
    includeSensitiveInformation: true
"#;
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.port, 9000);
        assert_eq!(config.api_port, 9001);
        assert_eq!(config.urls_to_watch.len(), 2);
        assert_eq!(config.har_output_dir, PathBuf::from("/tmp/har"));
        assert_eq!(config.cert_dir, PathBuf::from("/tmp/certs"));
        assert_eq!(config.log_level, "debug");
        assert_eq!(
            config.default_plugin_settings["har"]["includeSensitiveInformation"],
            true
        );
    }

    #[test]
    fn cli_overrides_file_values() {
        let cli = Cli {
            config: None,
            port: Some(7777),
            api_port: Some(7778),
            har_dir: Some(PathBuf::from("/custom/har")),
            cert_dir: None,
            log_level: Some("debug".to_string()),
        };
        let config = Config::load(&cli).unwrap();
        assert_eq!(config.port, 7777);
        assert_eq!(config.api_port, 7778);
        assert_eq!(config.har_output_dir, PathBuf::from("/custom/har"));
        assert_eq!(config.cert_dir, default_cert_dir()); // not overridden
        assert_eq!(config.log_level, "debug");
    }

    #[test]
    fn missing_fields_use_defaults() {
        let yaml = "port: 5555\n";
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.port, 5555);
        assert_eq!(config.api_port, 18897); // default
        assert_eq!(config.log_level, "info"); // default
    }

    #[test]
    fn invalid_yaml_returns_error() {
        let cli = Cli {
            config: Some(PathBuf::from("/nonexistent/config.yaml")),
            port: None,
            api_port: None,
            har_dir: None,
            cert_dir: None,
            log_level: None,
        };
        assert!(Config::load(&cli).is_err());
    }
}
