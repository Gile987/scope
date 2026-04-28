// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use serde::{Deserialize, Serialize};

/// HAR 1.2 data model (subset needed for our recording).
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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HarRequest {
    pub method: String,
    pub url: String,
    #[serde(rename = "httpVersion")]
    pub http_version: String,
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
                }],
            },
        };

        let json = serde_json::to_string(&har).unwrap();
        let parsed: Har = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.log.entries.len(), 1);
        assert_eq!(parsed.log.entries[0].request.method, "POST");
    }
}
