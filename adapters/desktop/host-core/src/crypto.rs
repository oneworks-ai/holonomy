//! Synchronous engine intrinsics, not a NativePort or an I/O authority.
mod context;
#[cfg(test)]
mod tests;

use context::{Context, Record};
use ring::{
    digest, hmac,
    rand::{SecureRandom, SystemRandom},
};
use std::collections::HashMap;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

pub type Bytes = Zeroizing<Vec<u8>>;
pub type CryptoResult<T> = Result<T, &'static str>;
pub const MAX_AAD: usize = 64 * 1024;
pub const MAX_KEY: usize = 64 * 1024;
pub const MAX_UPDATE: usize = 1024 * 1024;
pub const MAX_COMPARE: usize = 1024 * 1024;
pub const MAX_RANDOM: usize = 64 * 1024;
const MAX_DATA: usize = 64 * 1024 * 1024;
const MAX_TOTAL: usize = 128 * 1024 * 1024;
const MAX_CONTEXTS: usize = 64;
pub const INVALID: &str = "Invalid native crypto operation";
const LIMIT: &str = "Native crypto limit exceeded";

pub struct FinalResult {
    pub output: Bytes,
    pub auth_tag: Option<Bytes>,
    pub authenticated: Option<bool>,
}

#[derive(Default)]
pub struct NativeCrypto {
    contexts: HashMap<u32, Record>,
    next_id: u32,
    retained: usize,
    disposed: bool,
}

impl NativeCrypto {
    fn active(&self) -> CryptoResult<()> {
        if self.disposed { Err(INVALID) } else { Ok(()) }
    }

    /// Numeric algorithm tags are private adapter protocol, never Guest handles.
    pub fn create(&mut self, kind: u32, key: &[u8], iv: &[u8]) -> CryptoResult<u32> {
        self.active()?;
        if iv.len() > 12 {
            return Err(INVALID);
        }
        if self.contexts.len() >= MAX_CONTEXTS {
            return Err(LIMIT);
        }
        if key.len() > MAX_KEY || key.len() + iv.len() > MAX_TOTAL - self.retained {
            return Err(LIMIT);
        }
        let context = match kind {
            0 | 1 if key.is_empty() && iv.is_empty() => {
                Context::Hash(digest::Context::new(if kind == 0 {
                    &digest::SHA1_FOR_LEGACY_USE_ONLY
                } else {
                    &digest::SHA256
                }))
            }
            2 if iv.is_empty() => Context::Hmac(hmac::Context::with_key(&hmac::Key::new(
                hmac::HMAC_SHA256,
                key,
            ))),
            3 | 4 if key.len() == 32 && iv.len() == 12 => {
                Context::Aead(Box::new(context::AeadContext::new(kind == 4, key, iv)))
            }
            _ => return Err(INVALID),
        };
        let id = self.next_id.checked_add(1).ok_or(LIMIT)?;
        self.next_id = id;
        let retained = key.len() + iv.len();
        self.retained += retained;
        self.contexts.insert(
            id,
            Record {
                context,
                retained,
                data_bytes: 0,
                data_started: false,
            },
        );
        Ok(id)
    }

    fn reserve(&mut self, id: u32, size: usize) -> CryptoResult<&mut Record> {
        self.active()?;
        let record = self.contexts.get_mut(&id).ok_or(INVALID)?;
        if size > MAX_TOTAL - self.retained {
            return Err(LIMIT);
        }
        self.retained += size;
        record.retained += size;
        Ok(record)
    }

    pub fn update(&mut self, id: u32, data: &[u8]) -> CryptoResult<()> {
        let record = self.contexts.get(&id).ok_or(INVALID)?;
        if data.len() > MAX_UPDATE || data.len() > MAX_DATA - record.data_bytes {
            return Err(LIMIT);
        }
        let record = self.reserve(id, data.len())?;
        record.data_bytes += data.len();
        record.data_started = true;
        match &mut record.context {
            Context::Hash(context) => context.update(data),
            Context::Hmac(context) => context.update(data),
            Context::Aead(context) => context::append(&mut context.data, data, MAX_DATA),
        }
        Ok(())
    }

    pub fn set_aad(&mut self, id: u32, data: &[u8]) -> CryptoResult<()> {
        let record = self.contexts.get(&id).ok_or(INVALID)?;
        let Context::Aead(context) = &record.context else {
            return Err(INVALID);
        };
        if record.data_started {
            return Err(INVALID);
        }
        if data.len() > MAX_AAD - context.aad.len() {
            return Err(LIMIT);
        }
        let record = self.reserve(id, data.len())?;
        let Context::Aead(context) = &mut record.context else {
            unreachable!()
        };
        context::append(&mut context.aad, data, MAX_AAD);
        Ok(())
    }

    pub fn set_auth_tag(&mut self, id: u32, data: &[u8]) -> CryptoResult<()> {
        let record = self.contexts.get(&id).ok_or(INVALID)?;
        let Context::Aead(context) = &record.context else {
            return Err(INVALID);
        };
        if !context.decrypt || context.tag.is_some() || data.len() != 16 {
            return Err(INVALID);
        }
        let record = self.reserve(id, data.len())?;
        let Context::Aead(context) = &mut record.context else {
            unreachable!()
        };
        context.tag = Some(Zeroizing::new(data.to_vec()));
        Ok(())
    }

    fn take(&mut self, id: u32) -> CryptoResult<Record> {
        self.active()?;
        let record = self.contexts.remove(&id).ok_or(INVALID)?;
        self.retained -= record.retained;
        Ok(record)
    }

    pub fn digest(&mut self, id: u32) -> CryptoResult<Bytes> {
        match self.take(id)?.context {
            Context::Hash(context) => Ok(Zeroizing::new(context.finish().as_ref().to_vec())),
            Context::Hmac(context) => Ok(Zeroizing::new(context.sign().as_ref().to_vec())),
            _ => Err(INVALID),
        }
    }

    pub fn final_context(&mut self, id: u32) -> CryptoResult<FinalResult> {
        let Context::Aead(context) = self.take(id)?.context else {
            return Err(INVALID);
        };
        context.finish()
    }

    pub fn random(&self, size: usize) -> CryptoResult<Bytes> {
        self.active()?;
        if size > MAX_RANDOM || size > MAX_TOTAL - self.retained {
            return Err(LIMIT);
        }
        let mut output = Zeroizing::new(vec![0; size]);
        SystemRandom::new().fill(&mut output).map_err(|_| INVALID)?;
        Ok(output)
    }

    pub fn equal(&self, left: &[u8], right: &[u8]) -> CryptoResult<bool> {
        self.active()?;
        if left.len() != right.len() {
            return Err(INVALID);
        }
        if left.len() > MAX_COMPARE || left.len() * 2 > MAX_TOTAL - self.retained {
            return Err(LIMIT);
        }
        Ok(bool::from(left.ct_eq(right)))
    }

    pub fn dispose_context(&mut self, id: u32) {
        if let Some(record) = self.contexts.remove(&id) {
            self.retained -= record.retained;
        }
    }

    pub fn dispose(&mut self) {
        self.disposed = true;
        self.contexts.clear();
        self.retained = 0;
    }
}

impl Drop for NativeCrypto {
    fn drop(&mut self) {
        self.dispose();
    }
}
