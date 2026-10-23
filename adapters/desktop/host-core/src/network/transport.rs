use super::{Resolution, Result, policy::Policy};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{
    Client, Method,
    header::{HeaderName, HeaderValue},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{net::SocketAddr, time::Instant};

pub struct ResponseHead {
    pub value: Value,
    pub stream: Option<ResponseStream>,
}

pub struct ResponseStream {
    response: reqwest::Response,
    maximum: usize,
    max_chunk_bytes: usize,
    received: usize,
    pending: Vec<u8>,
    pending_offset: usize,
}

pub struct PullResult {
    pub value: Value,
    pub stream: Option<ResponseStream>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub binding_id: String,
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}
pub fn error(error: reqwest::Error) -> &'static str {
    #[cfg(test)]
    eprintln!("native network test transport error: {error:?}");
    if error.is_timeout() {
        "provider.timeout"
    } else if error.is_connect() {
        "provider.connection_refused"
    } else if error.is_body() || error.is_decode() {
        "provider.protocol_error"
    } else {
        "provider.unavailable"
    }
}
pub async fn request(
    policy: Policy,
    resolution: Resolution,
    request: Request,
    stream_id: String,
) -> Result<ResponseHead> {
    let url = policy.check(&request.url)?;
    if resolution.expires <= Instant::now()
        || resolution.origin != url.origin().ascii_serialization()
    {
        return Err("resource.stale");
    }
    let body = STANDARD
        .decode(&request.body)
        .map_err(|_| "argument.invalid")?;
    if body.len() > policy.limits.max_request_body_bytes.min(8 * 1024 * 1024)
        || request.headers.len() > policy.limits.max_headers
    {
        return Err("resource.byte_limit");
    }
    let header_bytes = request
        .headers
        .iter()
        .map(|(name, value)| name.len() + value.len() + 4)
        .sum::<usize>();
    if header_bytes > policy.limits.max_header_bytes {
        return Err("resource.byte_limit");
    }
    let method = Method::from_bytes(request.method.as_bytes()).map_err(|_| "argument.invalid")?;
    if method.as_str() != request.method
        || request.method.len() > 32
        || matches!(request.method.as_str(), "CONNECT" | "TRACE" | "TRACK")
    {
        return Err("argument.invalid");
    }
    let addresses = resolution
        .addresses
        .iter()
        .map(|ip| SocketAddr::new(*ip, url.port_or_known_default().unwrap()))
        .collect::<Vec<_>>();
    let mut builder = Client::builder()
        .http1_only()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(0)
        .referer(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd();
    if let Some(url::Host::Domain(host)) = url.host() {
        builder = builder.resolve_to_addrs(host, &addresses);
    }
    for certificate in &policy.tls_roots {
        builder = builder.add_root_certificate(certificate.clone());
    }
    let client = builder.build().map_err(error)?;
    let mut call = client.request(method, url.clone());
    for (name, value) in request.headers {
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "host"
                | "connection"
                | "content-length"
                | "transfer-encoding"
                | "proxy-authorization"
                | "proxy-connection"
        ) {
            return Err("argument.invalid");
        }
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| "argument.invalid")?;
        let value = HeaderValue::from_str(&value).map_err(|_| "argument.invalid")?;
        call = call.header(name, value);
    }
    if resolution.expires <= Instant::now() {
        return Err("resource.stale");
    }
    let response = call.body(body).send().await.map_err(error)?;
    if response
        .remote_addr()
        .is_none_or(|address| !resolution.addresses.contains(&address.ip()))
    {
        return Err("provider.protocol_error");
    }
    let status = response.status();
    let mut headers = Vec::new();
    let mut size = 0;
    for (name, value) in response.headers() {
        let value = value.to_str().map_err(|_| "provider.protocol_error")?;
        size += name.as_str().len() + value.len() + 4;
        if headers.len() >= policy.limits.max_headers || size > policy.limits.max_header_bytes {
            return Err("resource.byte_limit");
        }
        headers.push((name.as_str().to_string(), value.to_string()));
    }
    let maximum = policy.limits.max_response_body_bytes.min(8 * 1024 * 1024);
    if response
        .content_length()
        .is_some_and(|n| n > maximum as u64)
    {
        return Err("resource.byte_limit");
    }
    let has_body = request.method != "HEAD"
        && !status.is_informational()
        && status.as_u16() != 204
        && status.as_u16() != 304
        && response.content_length() != Some(0);
    let value = json!({
        "status": status.as_u16(),
        "statusText": status.canonical_reason().unwrap_or(""),
        "headers": headers,
        "url": request.url,
        "hasBody": has_body,
        "streamId": has_body.then_some(&stream_id),
    });
    Ok(ResponseHead {
        value,
        stream: has_body.then_some(ResponseStream {
            response,
            maximum,
            max_chunk_bytes: policy.limits.max_chunk_bytes,
            received: 0,
            pending: Vec::new(),
            pending_offset: 0,
        }),
    })
}

impl ResponseStream {
    pub async fn pull(mut self) -> Result<PullResult> {
        if self.pending_offset == self.pending.len() {
            self.pending.clear();
            self.pending_offset = 0;
            let Some(chunk) = self.response.chunk().await.map_err(error)? else {
                return Ok(PullResult {
                    value: json!({ "done": true }),
                    stream: None,
                });
            };
            self.received = self
                .received
                .checked_add(chunk.len())
                .ok_or("resource.byte_limit")?;
            if self.received > self.maximum {
                return Err("resource.byte_limit");
            }
            self.pending = chunk.to_vec();
        }
        let end = self
            .pending_offset
            .saturating_add(self.max_chunk_bytes)
            .min(self.pending.len());
        let bytes = &self.pending[self.pending_offset..end];
        self.pending_offset = end;
        Ok(PullResult {
            value: json!({ "done": false, "body": STANDARD.encode(bytes) }),
            stream: Some(self),
        })
    }
}
