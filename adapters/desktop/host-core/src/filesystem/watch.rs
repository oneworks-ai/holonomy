#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod snapshot;
#[cfg(target_os = "macos")]
pub use macos::Watchers;

#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct Watchers;
#[cfg(not(target_os = "macos"))]
impl Watchers {
    pub fn open(
        &mut self,
        _: std::fs::File,
        _: bool,
        _: usize,
        _: usize,
        _: Option<String>,
    ) -> super::Result<serde_json::Value> {
        Err("provider.unavailable")
    }
    pub fn close(&mut self, _: &str) {}
    pub fn poll(&mut self) -> super::Result<serde_json::Value> {
        Ok(serde_json::json!([]))
    }
    pub fn referenced(&self) -> bool {
        false
    }
}
