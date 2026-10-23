use super::{Bytes, CryptoResult, FinalResult, INVALID};
use ring::{aead, digest, hmac};
use zeroize::Zeroizing;

// Vec's normal realloc frees its old allocation without wiping it. Grow into a
// separate allocation so the previous plaintext/AAD storage is zeroed on drop.
pub(super) fn append(bytes: &mut Bytes, input: &[u8], capacity_limit: usize) {
    let size = bytes.len() + input.len();
    if size > bytes.capacity() {
        let mut replacement = Zeroizing::new(Vec::with_capacity(
            size.max((bytes.capacity() * 2).min(capacity_limit)),
        ));
        replacement.extend_from_slice(bytes);
        *bytes = replacement;
    }
    bytes.extend_from_slice(input);
}

pub(super) enum Context {
    Hash(digest::Context),
    Hmac(hmac::Context),
    Aead(Box<AeadContext>),
}

pub(super) struct Record {
    pub context: Context,
    pub retained: usize,
    pub data_bytes: usize,
    pub data_started: bool,
}

pub(super) struct AeadContext {
    pub decrypt: bool,
    key: Bytes,
    iv: Zeroizing<[u8; 12]>,
    pub data: Bytes,
    pub aad: Bytes,
    pub tag: Option<Bytes>,
}

impl AeadContext {
    pub fn new(decrypt: bool, key: &[u8], iv: &[u8]) -> Self {
        Self {
            decrypt,
            key: Zeroizing::new(key.to_vec()),
            iv: Zeroizing::new(iv.try_into().expect("validated IV length")),
            data: Zeroizing::new(Vec::new()),
            aad: Zeroizing::new(Vec::new()),
            tag: None,
        }
    }

    pub fn finish(mut self) -> CryptoResult<FinalResult> {
        // Each context is consumed exactly once. Caller-provided IV uniqueness is
        // the Node API caller's responsibility, not an implicit nonce generator.
        let key = aead::LessSafeKey::new(
            aead::UnboundKey::new(&aead::AES_256_GCM, &self.key).map_err(|_| INVALID)?,
        );
        let nonce = aead::Nonce::assume_unique_for_key(*self.iv);
        let aad = aead::Aad::from(self.aad.as_slice());
        if self.decrypt {
            let tag = self.tag.as_ref().ok_or(INVALID)?;
            let tag = aead::Tag::try_from(tag.as_slice()).map_err(|_| INVALID)?;
            let authenticated = key
                .open_in_place_separate_tag(nonce, aad, tag, &mut self.data, 0..)
                .is_ok();
            // Even on authentication failure ring may have touched plaintext.
            // Do not expose it; the Zeroizing buffer wipes it on drop.
            let output = if authenticated {
                self.data
            } else {
                Zeroizing::new(Vec::new())
            };
            Ok(FinalResult {
                output,
                auth_tag: None,
                authenticated: Some(authenticated),
            })
        } else {
            let tag = key
                .seal_in_place_separate_tag(nonce, aad, &mut self.data)
                .map_err(|_| INVALID)?;
            Ok(FinalResult {
                output: self.data,
                auth_tag: Some(Zeroizing::new(tag.as_ref().to_vec())),
                authenticated: None,
            })
        }
    }
}
