use serde::Deserialize;
use std::net::IpAddr;
use url::Url;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub max_chunk_bytes: usize,
    pub max_concurrent_connections: usize,
    pub max_header_bytes: usize,
    pub max_headers: usize,
    pub max_redirects: usize,
    pub max_request_body_bytes: usize,
    pub max_response_body_bytes: usize,
    pub max_url_bytes: usize,
    pub socket_timeout_ms: u64,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    #[serde(skip)]
    pub tls_roots: Vec<reqwest::Certificate>,
    pub access: String,
    pub allowed_origins: Vec<String>,
    pub allowed_schemes: Vec<String>,
    pub allow_private_network: bool,
    pub limits: Limits,
    pub request_body_inspection: serde_json::Value,
}
impl Policy {
    pub fn check(&self, input: &str) -> super::Result<Url> {
        if self.access != "restricted" || input.len() > self.limits.max_url_bytes {
            return Err("policy.denied");
        }
        let url = Url::parse(input).map_err(|_| "argument.invalid")?;
        if !matches!(url.scheme(), "http" | "https")
            || !self.allowed_schemes.iter().any(|s| s == url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !self
                .allowed_origins
                .contains(&url.origin().ascii_serialization())
        {
            return Err("policy.denied");
        }
        Ok(url)
    }
    pub fn validate(&self) -> super::Result<()> {
        let l = &self.limits;
        if !matches!(self.access.as_str(), "restricted" | "mockOnly")
            || self.allowed_origins.len() > 64
            || l.max_concurrent_connections == 0
            || l.max_concurrent_connections > 128
            || l.max_chunk_bytes == 0
            || l.max_chunk_bytes > 1024 * 1024
            || l.max_headers == 0
            || l.max_headers > 1024
            || l.max_header_bytes == 0
            || l.max_header_bytes > 1024 * 1024
            || l.max_url_bytes == 0
            || l.max_url_bytes > 1024 * 1024
            || l.max_redirects > 32
            || l.max_request_body_bytes == 0
            || l.max_response_body_bytes == 0
            || l.socket_timeout_ms == 0
            || l.socket_timeout_ms > 120000
            || !valid_request_body_inspection(&self.request_body_inspection)
        {
            return Err("argument.invalid");
        }
        for origin in &self.allowed_origins {
            let url = Url::parse(origin).map_err(|_| "argument.invalid")?;
            if url.origin().ascii_serialization() != *origin
                || !matches!(url.scheme(), "http" | "https")
            {
                return Err("argument.invalid");
            }
        }
        Ok(())
    }
}

fn valid_request_body_inspection(value: &serde_json::Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    match fields.get("access").and_then(serde_json::Value::as_str) {
        Some("none") => fields.len() == 1,
        Some("bounded") => {
            fields.len() == 3
                && fields
                    .get("maxBytes")
                    .and_then(serde_json::Value::as_u64)
                    .is_some_and(|limit| (1..=1024 * 1024).contains(&limit))
                && fields
                    .get("maxReadsPerRuntime")
                    .and_then(serde_json::Value::as_u64)
                    .is_some_and(|limit| (1..=1024).contains(&limit))
        }
        _ => false,
    }
}
pub fn is_private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let value = u32::from(address);
            [
                (0x00000000, 8),
                (0x0a000000, 8),
                (0x64400000, 10),
                (0x7f000000, 8),
                (0xa9fe0000, 16),
                (0xac100000, 12),
                (0xc0000000, 24),
                (0xc0000200, 24),
                (0xc0586300, 24),
                (0xc0a80000, 16),
                (0xc6120000, 15),
                (0xc6336400, 24),
                (0xcb007100, 24),
                (0xe0000000, 4),
                (0xf0000000, 4),
            ]
            .iter()
            .any(|(base, bits)| value >> (32 - bits) == base >> (32 - bits))
        }
        IpAddr::V6(address) => {
            let value = u128::from(address);
            value >> 125 != 1
                || [
                    ("2001::", 23),
                    ("2001:db8::", 32),
                    ("2002::", 16),
                    ("2620:4f:8000::", 48),
                    ("3fff::", 20),
                ]
                .iter()
                .any(|(base, bits)| {
                    value >> (128 - bits)
                        == u128::from(base.parse::<std::net::Ipv6Addr>().expect("Static prefix"))
                            >> (128 - bits)
                })
        }
    }
}
