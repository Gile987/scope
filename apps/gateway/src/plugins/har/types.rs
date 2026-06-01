// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! HAR 1.2 data model as Rust structs with serde (de)serialization.
//!
//! Closely follows the spec at <http://www.softwareishard.com/blog/har-12-spec/>.
//! Only includes fields we actually populate — optional HAR fields like `pages`,
//! `pageref`, and `comment` are omitted for simplicity.

use serde::{Deserialize, Serialize};

/// HAR 1.2 data model.
/// Spec: http://www.softwareishard.com/blog/har-12-spec/

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Har {
    pub log: HarLog,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarLog {
    pub version: String,
    pub creator: HarCreator,
    pub entries: Vec<HarEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarCreator {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarEntry {
    #[serde(rename = "startedDateTime")]
    pub started_date_time: String,
    pub time: f64,
    pub request: HarRequest,
    pub response: HarResponse,
    pub cache: HarCache,
    pub timings: HarTimings,
    /// Chrome extension: resource type hint (e.g. "websocket")
    #[serde(rename = "_resourceType", skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    /// Chrome extension: WebSocket messages recorded during the connection
    #[serde(rename = "_webSocketMessages", skip_serializing_if = "Option::is_none")]
    pub websocket_messages: Option<Vec<HarWebSocketMessage>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarRequest {
    pub method: String,
    pub url: String,
    #[serde(rename = "httpVersion")]
    pub http_version: String,
    pub cookies: Vec<HarCookie>,
    pub headers: Vec<HarHeader>,
    #[serde(rename = "queryString")]
    pub query_string: Vec<HarQueryParam>,
    #[serde(rename = "headersSize")]
    pub headers_size: i64,
    #[serde(rename = "bodySize")]
    pub body_size: i64,
    #[serde(rename = "postData", skip_serializing_if = "Option::is_none")]
    pub post_data: Option<HarPostData>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarResponse {
    pub status: u16,
    #[serde(rename = "statusText")]
    pub status_text: String,
    #[serde(rename = "httpVersion")]
    pub http_version: String,
    pub cookies: Vec<HarCookie>,
    pub headers: Vec<HarHeader>,
    pub content: HarContent,
    #[serde(rename = "headersSize")]
    pub headers_size: i64,
    #[serde(rename = "bodySize")]
    pub body_size: i64,
    #[serde(rename = "redirectURL")]
    pub redirect_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarCookie {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarQueryParam {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarPostData {
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarContent {
    pub size: i64,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

// Required by the HAR spec but we don't track cache info — always empty.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct HarCache {}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarTimings {
    // Per HAR spec, -1.0 means "not applicable". We set blocked/dns/connect/ssl
    // to -1 because those phases are opaque to us (handled by the TLS layer).
    pub blocked: f64,
    pub dns: f64,
    pub connect: f64,
    pub send: f64,
    pub wait: f64,
    pub receive: f64,
    pub ssl: f64,
}

/// Chrome-style WebSocket message entry for `_webSocketMessages`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarWebSocketMessage {
    /// Direction: "send" (client→server) or "receive" (server→client)
    #[serde(rename = "type")]
    pub msg_type: String,
    /// Unix timestamp in seconds with millisecond precision
    pub time: f64,
    /// WebSocket frame opcode: 1 = text, 2 = binary
    pub opcode: u8,
    /// Message payload (text for opcode 1, base64 for opcode 2)
    pub data: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn har_serialization_roundtrip() {
        let har = Har {
            log: HarLog {
                version: "1.2".into(),
                creator: HarCreator {
                    name: "gateway".into(),
                    version: "0.1.0".into(),
                },
                entries: vec![HarEntry {
                    started_date_time: "2026-04-27T12:00:00.000Z".into(),
                    time: 42.0,
                    request: HarRequest {
                        method: "POST".into(),
                        url: "https://api.github.com/chat".into(),
                        http_version: "HTTP/1.1".into(),
                        cookies: vec![],
                        headers: vec![HarHeader {
                            name: "content-type".into(),
                            value: "application/json".into(),
                        }],
                        query_string: vec![],
                        headers_size: -1,
                        body_size: 42,
                        post_data: Some(HarPostData {
                            mime_type: "application/json".into(),
                            text: r#"{"messages":[]}"#.into(),
                        }),
                    },
                    response: HarResponse {
                        status: 200,
                        status_text: "OK".into(),
                        http_version: "HTTP/1.1".into(),
                        cookies: vec![],
                        headers: vec![],
                        content: HarContent {
                            size: 10,
                            mime_type: "application/json".into(),
                            text: Some(r#"{"ok":true}"#.into()),
                            encoding: None,
                        },
                        headers_size: -1,
                        body_size: 10,
                        redirect_url: String::new(),
                    },
                    cache: HarCache::default(),
                    timings: HarTimings {
                        blocked: -1.0,
                        dns: -1.0,
                        connect: -1.0,
                        send: 0.0,
                        wait: 42.0,
                        receive: 0.0,
                        ssl: -1.0,
                    },
                    resource_type: None,
                    websocket_messages: None,
                }],
            },
        };

        let json = serde_json::to_string(&har).unwrap();
        let parsed: Har = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.log.entries.len(), 1);
        assert_eq!(parsed.log.entries[0].request.method, "POST");
    }
}
