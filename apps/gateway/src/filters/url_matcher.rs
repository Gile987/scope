// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Glob-based URL filter for deciding which requests to intercept.
//!
//! Patterns from config (e.g., `https://*.github.com/*`) are compiled once at
//! startup. Supports full-URL matching (plain HTTP) and host-only matching
//! (CONNECT tunnels where only `host:port` is available before TLS handshake).

use glob::Pattern;

/// Matches URLs against glob patterns (urlsToWatch config).
pub struct UrlFilter {
    patterns: Vec<Pattern>,
}

impl UrlFilter {
    /// Compile glob patterns at startup. Returns error on invalid patterns.
    pub fn new(patterns: &[String]) -> Result<Self, glob::PatternError> {
        let compiled = patterns
            .iter()
            .map(|p| Pattern::new(p))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { patterns: compiled })
    }

    /// Check if a URL matches any of the watch patterns.
    pub fn matches(&self, url: &str) -> bool {
        self.patterns.iter().any(|p| p.matches(url))
    }

    /// Check if a host:port matches any pattern's host portion.
    /// Used during CONNECT to decide intercept vs passthrough before
    /// we have the full URL.
    pub fn matches_host(&self, host: &str) -> bool {
        // CONNECT requests only carry `host:port`, not a full URL. We extract
        // the host portion from each glob pattern (stripping scheme + path) and
        // match just the hostname. This means `https://api.github.com/*` will
        // intercept CONNECT to `api.github.com:443`.
        self.patterns.iter().any(|p| {
            let pattern_str = p.as_str();
            // Extract host from pattern like "https://api.github.com/*"
            if let Some(rest) = pattern_str.strip_prefix("https://") {
                let pattern_host_port = rest.split('/').next().unwrap_or("");
                // Strip port from both pattern and connect host so that
                // "https://localhost:*" matches CONNECT to "localhost:12345"
                let pattern_host = pattern_host_port
                    .split(':')
                    .next()
                    .unwrap_or(pattern_host_port);
                let connect_host = host.split(':').next().unwrap_or(host);
                Pattern::new(pattern_host)
                    .map(|hp| hp.matches(connect_host))
                    .unwrap_or(false)
            } else if let Some(rest) = pattern_str.strip_prefix("http://") {
                let pattern_host_port = rest.split('/').next().unwrap_or("");
                let pattern_host = pattern_host_port
                    .split(':')
                    .next()
                    .unwrap_or(pattern_host_port);
                let connect_host = host.split(':').next().unwrap_or(host);
                Pattern::new(pattern_host)
                    .map(|hp| hp.matches(connect_host))
                    .unwrap_or(false)
            } else {
                false
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_url_match() {
        let filter = UrlFilter::new(&["https://api.github.com/*".into()]).unwrap();
        assert!(filter.matches("https://api.github.com/foo"));
        assert!(filter.matches("https://api.github.com/bar/baz"));
        assert!(!filter.matches("https://other.com/foo"));
    }

    #[test]
    fn wildcard_subdomain() {
        let filter = UrlFilter::new(&["https://*.githubcopilot.com/*".into()]).unwrap();
        assert!(filter.matches("https://api.githubcopilot.com/v1/chat"));
        assert!(filter.matches("https://copilot-proxy.githubcopilot.com/v1"));
        assert!(!filter.matches("https://api.anthropic.com/v1"));
    }

    #[test]
    fn multiple_patterns() {
        let filter = UrlFilter::new(&[
            "https://api.github.com/*".into(),
            "https://api.anthropic.com/*".into(),
        ])
        .unwrap();
        assert!(filter.matches("https://api.github.com/foo"));
        assert!(filter.matches("https://api.anthropic.com/v1/messages"));
        assert!(!filter.matches("https://api.openai.com/v1"));
    }

    #[test]
    fn host_matching_for_connect() {
        let filter = UrlFilter::new(&[
            "https://api.github.com/*".into(),
            "https://*.githubcopilot.com/*".into(),
        ])
        .unwrap();
        assert!(filter.matches_host("api.github.com:443"));
        assert!(filter.matches_host("api.githubcopilot.com:443"));
        assert!(filter.matches_host("proxy.githubcopilot.com:443"));
        assert!(!filter.matches_host("api.openai.com:443"));
    }

    #[test]
    fn host_matching_with_port_wildcard() {
        // Pattern like "https://localhost:*" should match CONNECT to any port
        let filter = UrlFilter::new(&["https://localhost:*/*".into()]).unwrap();
        assert!(filter.matches_host("localhost:12345"));
        assert!(filter.matches_host("localhost:443"));
        assert!(!filter.matches_host("other.com:443"));

        // Also works with just "https://localhost:*"
        let filter2 = UrlFilter::new(&["https://localhost:*".into()]).unwrap();
        assert!(filter2.matches_host("localhost:9999"));
    }

    #[test]
    fn empty_patterns_match_nothing() {
        let filter = UrlFilter::new(&[]).unwrap();
        assert!(!filter.matches("https://any.com/path"));
        assert!(!filter.matches_host("any.com:443"));
    }

    #[test]
    fn catch_all_pattern() {
        let filter = UrlFilter::new(&["https://*/*".into()]).unwrap();
        assert!(filter.matches("https://any.com/path"));
        assert!(filter.matches_host("any.com:443"));
    }

    #[test]
    fn invalid_pattern_returns_error() {
        let result = UrlFilter::new(&["[invalid".into()]);
        assert!(result.is_err());
    }
}
