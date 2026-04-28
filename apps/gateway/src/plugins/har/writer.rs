// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use base64::Engine;
use http::HeaderMap;

use crate::plugin::HttpExchange;

use super::types::*;

/// Headers to redact when includeSensitiveInformation is false.
const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "x-github-token",
    "x-api-key",
    "cookie",
    "set-cookie",
];

/// Convert an HttpExchange into a HarEntry, optionally redacting sensitive headers.
pub fn exchange_to_har_entry(exchange: &HttpExchange, redact: bool) -> HarEntry {
    let req = &exchange.request;
    let resp = &exchange.response;

    let request_headers = headers_to_har(&req.headers, redact);
    let response_headers = headers_to_har(&resp.headers, redact);

    let content_type = resp
        .headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let (resp_text, resp_encoding) = encode_body(&resp.body, &content_type);

    let post_data = if !req.body.is_empty() {
        let req_content_type = req
            .headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream");
        Some(HarPostData {
            mime_type: req_content_type.to_string(),
            text: String::from_utf8_lossy(&req.body).to_string(),
        })
    } else {
        None
    };

    HarEntry {
        started_date_time: exchange.started_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        time: exchange.elapsed_ms as f64,
        request: HarRequest {
            method: req.method.to_string(),
            url: req.uri.to_string(),
            http_version: "HTTP/1.1".into(),
            headers: request_headers,
            query_string: parse_query_string(&req.uri),
            headers_size: -1,
            body_size: req.body.len() as i64,
            post_data,
        },
        response: HarResponse {
            status: resp.status.as_u16(),
            status_text: resp
                .status
                .canonical_reason()
                .unwrap_or("")
                .to_string(),
            http_version: "HTTP/1.1".into(),
            headers: response_headers,
            content: HarContent {
                size: resp.body.len() as i64,
                mime_type: content_type,
                text: resp_text,
                encoding: resp_encoding,
            },
            headers_size: -1,
            body_size: resp.body.len() as i64,
            redirect_url: String::new(),
        },
    }
}

/// Build a full HAR 1.2 envelope from a list of entries.
pub fn build_har(entries: Vec<HarEntry>) -> Har {
    Har {
        log: HarLog {
            version: "1.2".into(),
            creator: HarCreator {
                name: "gateway".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            entries,
        },
    }
}

fn headers_to_har(headers: &HeaderMap, redact: bool) -> Vec<HarHeader> {
    headers
        .iter()
        .map(|(name, value)| {
            let name_str = name.as_str().to_lowercase();
            let value_str = if redact && SENSITIVE_HEADERS.contains(&name_str.as_str()) {
                "[REDACTED]".to_string()
            } else {
                value.to_str().unwrap_or("[non-utf8]").to_string()
            };
            HarHeader {
                name: name_str,
                value: value_str,
            }
        })
        .collect()
}

fn parse_query_string(uri: &http::Uri) -> Vec<HarQueryParam> {
    uri.query()
        .map(|q| {
            q.split('&')
                .filter_map(|pair| {
                    let mut parts = pair.splitn(2, '=');
                    let name = parts.next()?;
                    let value = parts.next().unwrap_or("");
                    Some(HarQueryParam {
                        name: name.to_string(),
                        value: value.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Encode body for HAR: text for small responses, base64 for >1MB or binary.
fn encode_body(body: &[u8], content_type: &str) -> (Option<String>, Option<String>) {
    if body.is_empty() {
        return (None, None);
    }

    // If > 1MB or binary content type, use base64
    let is_text = content_type.contains("json")
        || content_type.contains("text")
        || content_type.contains("xml")
        || content_type.contains("javascript");

    if body.len() > 1_048_576 || !is_text {
        let encoded = base64::engine::general_purpose::STANDARD.encode(body);
        (Some(encoded), Some("base64".into()))
    } else {
        (Some(String::from_utf8_lossy(body).to_string()), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::{ExchangeRequest, ExchangeResponse};
    use bytes::Bytes;
    use http::{Method, StatusCode, Uri};

    fn make_exchange() -> HttpExchange {
        let mut req_headers = HeaderMap::new();
        req_headers.insert("authorization", "Bearer secret123".parse().unwrap());
        req_headers.insert("content-type", "application/json".parse().unwrap());

        let mut resp_headers = HeaderMap::new();
        resp_headers.insert("content-type", "application/json".parse().unwrap());
        resp_headers.insert("set-cookie", "session=abc".parse().unwrap());

        HttpExchange {
            request: ExchangeRequest {
                method: Method::POST,
                uri: Uri::from_static("https://api.github.com/chat?model=gpt4"),
                headers: req_headers,
                body: Bytes::from(r#"{"messages":[]}"#),
            },
            response: ExchangeResponse {
                status: StatusCode::OK,
                headers: resp_headers,
                body: Bytes::from(r#"{"choices":[]}"#),
            },
            started_at: chrono::Utc::now(),
            elapsed_ms: 150,
        }
    }

    #[test]
    fn redacts_sensitive_headers() {
        let exchange = make_exchange();
        let entry = exchange_to_har_entry(&exchange, true);

        let auth_header = entry
            .request
            .headers
            .iter()
            .find(|h| h.name == "authorization")
            .unwrap();
        assert_eq!(auth_header.value, "[REDACTED]");

        let cookie_header = entry
            .response
            .headers
            .iter()
            .find(|h| h.name == "set-cookie")
            .unwrap();
        assert_eq!(cookie_header.value, "[REDACTED]");
    }

    #[test]
    fn preserves_headers_when_not_redacting() {
        let exchange = make_exchange();
        let entry = exchange_to_har_entry(&exchange, false);

        let auth_header = entry
            .request
            .headers
            .iter()
            .find(|h| h.name == "authorization")
            .unwrap();
        assert_eq!(auth_header.value, "Bearer secret123");
    }

    #[test]
    fn parses_query_string() {
        let exchange = make_exchange();
        let entry = exchange_to_har_entry(&exchange, false);
        assert_eq!(entry.request.query_string.len(), 1);
        assert_eq!(entry.request.query_string[0].name, "model");
        assert_eq!(entry.request.query_string[0].value, "gpt4");
    }

    #[test]
    fn large_body_uses_base64() {
        let large_body = vec![0u8; 2_000_000]; // 2MB
        let (text, encoding) = encode_body(&large_body, "application/octet-stream");
        assert_eq!(encoding, Some("base64".into()));
        assert!(text.is_some());
    }

    #[test]
    fn small_text_body_is_plaintext() {
        let body = b"hello world";
        let (text, encoding) = encode_body(body, "text/plain");
        assert_eq!(encoding, None);
        assert_eq!(text, Some("hello world".into()));
    }

    #[test]
    fn empty_body_is_none() {
        let (text, encoding) = encode_body(b"", "text/plain");
        assert!(text.is_none());
        assert!(encoding.is_none());
    }

    #[test]
    fn build_har_envelope() {
        let exchange = make_exchange();
        let entry = exchange_to_har_entry(&exchange, false);
        let har = build_har(vec![entry]);
        assert_eq!(har.log.version, "1.2");
        assert_eq!(har.log.creator.name, "gateway");
        assert_eq!(har.log.entries.len(), 1);
    }
}
