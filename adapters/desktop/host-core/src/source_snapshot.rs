//! Private, source-only JSONL helper. No V8 isolate or Guest capability is installed here.
use crate::{
    SourceAdmission, SourceStore,
    source::{
        PrivatePackage, PrivateResourceBudget, PrivateSourceRoot, SourceReadPurpose, open_confined,
    },
};
use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, Visitor},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{File, Metadata},
    io::{BufRead, Read, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const MAX_FRAME_BYTES: u64 = 64 * 1024;
const MAX_PRIVATE_MODULE_BYTES: u64 = crate::MAX_MODULE_BYTES;
const MAX_PRIVATE_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_PRIVATE_PACKAGE_LEASES: usize = 128;
const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;

struct Session {
    admission: SourceAdmission,
    guest: SourceStore,
    package_roots: HashMap<PathBuf, File>,
    packages: HashMap<String, Arc<PrivatePackage>>,
    package_hashes: HashMap<String, HashMap<PathBuf, String>>,
    package_keys: HashMap<(u64, u64, PathBuf, PathBuf), String>,
    package_bytes: usize,
    package_sizes: HashMap<(String, PathBuf), usize>,
    source_roots: HashMap<String, PrivateSourceRoot>,
    source_root_keys: HashMap<(PathBuf, String, u64, u64, Option<String>), String>,
    source_budget: Arc<Mutex<PrivateResourceBudget>>,
    sealed: bool,
}

impl Session {
    fn new(root: &str) -> Result<Self, &'static str> {
        let root = workspace_path(root)?;
        let admission = SourceAdmission::default();
        let guest = SourceStore::with_workspace_root(&root, admission.clone())
            .map_err(|_| "source_unavailable")?;
        let mut package_roots = HashMap::new();
        package_roots.insert(
            guest.pinned_root().0.to_path_buf(),
            guest
                .pinned_root()
                .1
                .try_clone()
                .map_err(|_| "source_unavailable")?,
        );
        Ok(Self {
            admission,
            guest,
            package_roots,
            packages: HashMap::new(),
            package_hashes: HashMap::new(),
            package_keys: HashMap::new(),
            package_bytes: 0,
            package_sizes: HashMap::new(),
            source_roots: HashMap::new(),
            source_root_keys: HashMap::new(),
            source_budget: Arc::new(Mutex::new(PrivateResourceBudget::default())),
            sealed: false,
        })
    }

    fn open_private(&self, path: &Path) -> Result<Option<(File, Metadata)>, &'static str> {
        let root = File::open("/").map_err(|_| "source_unavailable")?;
        let relative = path.strip_prefix("/").map_err(|_| "invalid_path")?;
        let file = match open_confined(&root, relative) {
            Ok(file) => file,
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
                self.admission
                    .reserve_private_path(path)
                    .map_err(map_admission_error)?;
                return Ok(None);
            }
            Err(_) => return Err("source_rejected"),
        };
        let metadata = file.metadata().map_err(|_| "source_unavailable")?;
        Ok(Some((file, metadata)))
    }

    fn reserve_private_directory(&self, path: &str) -> Result<Value, &'static str> {
        if self.sealed {
            return Err("invalid_state");
        }
        let path = private_path(path)?;
        self.admission
            .reserve_private_directory(&path)
            .map_err(map_admission_error)?;
        Ok(json!(true))
    }

    fn stat_private(&self, path: &str, require_file: bool) -> Result<Value, &'static str> {
        let path = workspace_path(path)?;
        if path == Path::new("/") {
            if require_file {
                return Err("source_rejected");
            }
            let metadata = File::open("/")
                .and_then(|root| root.metadata())
                .map_err(|_| "source_unavailable")?;
            return Ok(metadata_value("directory", &metadata));
        }
        let Some((file, metadata)) = self.open_private(&path)? else {
            return Ok(if require_file {
                Value::Null
            } else {
                json!({"kind":"missing"})
            });
        };
        if metadata.is_file() {
            self.admission
                .capture(&path, &file)
                .map_err(map_admission_error)?;
            return Ok(metadata_value("file", &metadata));
        }
        if metadata.is_dir() && !require_file {
            return Ok(metadata_value("directory", &metadata));
        }
        Err("source_rejected")
    }

    fn read_private(&self, path: &str, kind: &str) -> Result<Value, &'static str> {
        let maximum = match kind {
            "module" | "manifest" => MAX_PRIVATE_MODULE_BYTES,
            "config" | "schema" => MAX_PRIVATE_CONFIG_BYTES,
            _ => return Err("invalid_request"),
        };
        let path = private_path(path)?;
        let Some((mut file, before)) = self.open_private(&path)? else {
            return Ok(Value::Null);
        };
        if !before.is_file() {
            return Err("source_rejected");
        }
        self.admission
            .capture(&path, &file)
            .map_err(map_admission_error)?;
        if before.len() > maximum {
            return Err("source_limit");
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(maximum + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "source_unavailable")?;
        if bytes.len() as u64 > maximum {
            return Err("source_limit");
        }
        let after = file.metadata().map_err(|_| "source_unavailable")?;
        if !same_file_version(&before, &after) {
            return Err("source_changed");
        }
        std::str::from_utf8(&bytes).map_err(|_| "invalid_utf8")?;
        Ok(json!({
            "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "sha256": format!("{:x}", Sha256::digest(&bytes)),
        }))
    }

    fn open_private_package(&mut self, root: &str, path: &str) -> Result<Value, &'static str> {
        let root = workspace_path(root)?;
        let path = private_path(path)?;
        if !self.package_roots.contains_key(&root) {
            if self.package_roots.len() + self.source_roots.len() >= MAX_PRIVATE_PACKAGE_LEASES {
                return Err("source_limit");
            }
            let selected = PrivatePackage::open_selected_root(&root).map_err(map_package_error)?;
            self.package_roots.insert(root.clone(), selected);
        }
        let Some((package, mut manifest)) = PrivatePackage::open_in(
            self.package_roots.get(&root).ok_or("source_unavailable")?,
            &root,
            &path,
            &self.admission,
        )
        .map_err(map_package_error)?
        else {
            return Ok(Value::Null);
        };
        let identity = package
            .directory()
            .metadata()
            .map_err(|_| "source_unavailable")?;
        let key = (
            identity.dev(),
            identity.ino(),
            package.requested_root().to_path_buf(),
            package.root_path().to_path_buf(),
        );
        if !self.package_keys.contains_key(&key) {
            let budget = self
                .source_budget
                .lock()
                .map_err(|_| "source_unavailable")?;
            if self.packages.len() >= MAX_PRIVATE_PACKAGE_LEASES
                || budget.package_leases + budget.external_package_leases
                    >= MAX_PRIVATE_PACKAGE_LEASES
            {
                return Err("source_limit");
            }
        }
        let bytes = read_package_bytes(&mut manifest, MAX_PRIVATE_CONFIG_BYTES)?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let previous_id = self.package_keys.get(&key).cloned();
        let package_id = match &previous_id {
            Some(id) => id.clone(),
            None => package_id(&self.packages)?,
        };
        self.account_package_bytes(&package_id, Path::new("package.json"), bytes.len())?;
        if previous_id.is_none() {
            self.package_keys.insert(key, package_id.clone());
            self.packages.insert(package_id.clone(), Arc::new(package));
            self.source_budget
                .lock()
                .map_err(|_| "source_unavailable")?
                .external_package_leases += 1;
        }
        self.package_hashes
            .entry(package_id.clone())
            .or_default()
            .insert(PathBuf::from("package.json"), digest.clone());
        let root_path = self
            .packages
            .get(&package_id)
            .ok_or("source_unavailable")?
            .root_path()
            .to_str()
            .ok_or("invalid_path")?;
        Ok(json!({
            "packageId": package_id,
            "rootPath": root_path,
            "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "sha256": digest,
        }))
    }

    fn read_private_package(
        &mut self,
        package_id: &str,
        relative_path: &str,
        kind: &str,
    ) -> Result<Value, &'static str> {
        let maximum = match kind {
            "module" => MAX_PRIVATE_MODULE_BYTES,
            "schema" => MAX_PRIVATE_CONFIG_BYTES,
            _ => return Err("invalid_request"),
        };
        let relative = package_relative_path(relative_path)?;
        let package = self.packages.get(package_id).ok_or("invalid_request")?;
        let Some(mut file) = package
            .read(&relative, &self.admission)
            .map_err(map_package_error)?
        else {
            return Ok(Value::Null);
        };
        let bytes = read_package_bytes(&mut file, maximum)?;
        self.account_package_bytes(package_id, &relative, bytes.len())?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        self.package_hashes
            .entry(package_id.to_owned())
            .or_default()
            .insert(relative.clone(), digest.clone());
        Ok(json!({
            "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "sha256": digest,
        }))
    }

    fn open_private_source_root(
        &mut self,
        root: &str,
        root_url: &str,
        package_id: Option<&str>,
    ) -> Result<Value, &'static str> {
        let root = workspace_path(root)?;
        let mut selected = PrivateSourceRoot::open_with_budget(
            &root,
            root_url,
            self.admission.clone(),
            self.source_budget.clone(),
        )
        .map_err(map_package_error)?;
        if let Some(package_id) = package_id {
            let package = self.packages.get(package_id).ok_or("invalid_request")?;
            let hashes = self
                .package_hashes
                .get(package_id)
                .ok_or("invalid_request")?;
            selected
                .seed_package(package.clone(), hashes)
                .map_err(map_package_error)?;
        }
        let (device, inode) = selected.identity().map_err(map_package_error)?;
        let key = (
            root.clone(),
            root_url.to_owned(),
            device,
            inode,
            package_id.map(str::to_owned),
        );
        if let Some(id) = self.source_root_keys.get(&key) {
            return Ok(json!({"sourceRootId": id, "rootPath": root}));
        }
        if self.source_roots.len() + self.package_roots.len() >= MAX_PRIVATE_PACKAGE_LEASES {
            return Err("source_limit");
        }
        let id = format!("src-{}", self.source_roots.len() + 1);
        self.source_root_keys.insert(key, id.clone());
        self.source_roots.insert(id.clone(), selected);
        Ok(json!({"sourceRootId": id, "rootPath": root}))
    }

    fn read_private_source_resource_with_purpose(
        &mut self,
        id: &str,
        url: &str,
        purpose: SourceReadPurpose,
    ) -> Result<Value, &'static str> {
        let root = self.source_roots.get_mut(id).ok_or("invalid_request")?;
        let Some(resource) = root
            .read_resource_with_purpose(url, purpose)
            .map_err(map_package_error)?
        else {
            return Ok(Value::Null);
        };
        Ok(json!({
            "base64": base64::engine::general_purpose::STANDARD.encode(&resource.bytes),
            "sha256": resource.sha256,
            "canonicalUrl": resource.canonical_url,
        }))
    }

    fn account_package_bytes(
        &mut self,
        package_id: &str,
        relative: &Path,
        length: usize,
    ) -> Result<(), &'static str> {
        let key = (package_id.to_owned(), relative.to_path_buf());
        let previous = self.package_sizes.get(&key).copied();
        let increase = length.saturating_sub(previous.unwrap_or(0));
        let mut budget = self
            .source_budget
            .lock()
            .map_err(|_| "source_unavailable")?;
        if previous.is_none()
            && self.package_sizes.len() + budget.canonical.len() >= crate::MAX_MODULES
        {
            return Err("source_limit");
        }
        if self
            .package_bytes
            .saturating_add(budget.total_bytes)
            .saturating_add(increase)
            > crate::MAX_GRAPH_BYTES
        {
            return Err("source_limit");
        }
        self.package_sizes
            .insert(key, previous.unwrap_or(0).max(length));
        self.package_bytes += increase;
        budget.external_bytes += increase;
        if previous.is_none() {
            budget.external_read_count += 1;
        }
        Ok(())
    }

    #[cfg(test)]
    fn read_guest(&mut self, url: &str) -> Result<Value, &'static str> {
        self.read_guest_with_purpose(url, SourceReadPurpose::Module)
    }
    fn read_guest_with_purpose(
        &mut self,
        url: &str,
        purpose: SourceReadPurpose,
    ) -> Result<Value, &'static str> {
        if !self.sealed {
            return Err("invalid_state");
        }
        validate_guest_url(url)?;
        let snapshot = self
            .guest
            .read_with_purpose(url, purpose)
            .map_err(map_guest_error)?;
        let Some(snapshot) = snapshot else {
            return Ok(Value::Null);
        };
        let snapshot: GuestSnapshot =
            serde_json::from_str(&snapshot).map_err(|_| "source_unavailable")?;
        let mut result = json!({
            "base64": base64::engine::general_purpose::STANDARD.encode(&snapshot.bytes),
            "sha256": snapshot.sha256,
        });
        if snapshot.metadata_only {
            result["metadataOnly"] = json!(true);
        }
        Ok(result)
    }

    #[cfg(test)]
    fn read_guest_resource(&mut self, url: &str) -> Result<Value, &'static str> {
        self.read_guest_resource_with_purpose(url, SourceReadPurpose::Module)
    }
    fn read_guest_resource_with_purpose(
        &mut self,
        url: &str,
        purpose: SourceReadPurpose,
    ) -> Result<Value, &'static str> {
        if !self.sealed {
            return Err("invalid_state");
        }
        validate_guest_url(url)?;
        let Some(resource) = self
            .guest
            .read_resource_with_purpose(url, purpose)
            .map_err(map_guest_error)?
        else {
            return Ok(Value::Null);
        };
        let mut result = json!({
            "base64": base64::engine::general_purpose::STANDARD.encode(&resource.bytes),
            "sha256": resource.sha256,
            "canonicalUrl": resource.canonical_url,
        });
        if resource.metadata_only {
            result["metadataOnly"] = json!(true);
        }
        Ok(result)
    }
}

fn package_relative_path(input: &str) -> Result<PathBuf, &'static str> {
    if input.is_empty()
        || input.len() > 4096
        || input.contains(['\\', '\0', '%', '?', '#'])
        || input
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("invalid_path");
    }
    Ok(PathBuf::from(input))
}

fn read_package_bytes(file: &mut File, maximum: u64) -> Result<Vec<u8>, &'static str> {
    let before = file.metadata().map_err(|_| "source_unavailable")?;
    if !before.is_file() {
        return Err("source_rejected");
    }
    if before.len() > maximum {
        return Err("source_limit");
    }
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "source_unavailable")?;
    if bytes.len() as u64 > maximum {
        return Err("source_limit");
    }
    let after = file.metadata().map_err(|_| "source_unavailable")?;
    if !same_file_version(&before, &after) {
        return Err("source_changed");
    }
    std::str::from_utf8(&bytes).map_err(|_| "invalid_utf8")?;
    Ok(bytes)
}

fn package_id(packages: &HashMap<String, Arc<PrivatePackage>>) -> Result<String, &'static str> {
    let rng = SystemRandom::new();
    for _ in 0..4 {
        let mut bytes = [0_u8; 16];
        rng.fill(&mut bytes).map_err(|_| "source_unavailable")?;
        let mut id = String::from("pkg-");
        for byte in bytes {
            use std::fmt::Write as _;
            write!(&mut id, "{byte:02x}").map_err(|_| "source_unavailable")?;
        }
        if !packages.contains_key(&id) {
            return Ok(id);
        }
    }
    Err("source_unavailable")
}

fn map_package_error(error: String) -> &'static str {
    match error.as_str() {
        "Source identity limit exceeded; restart required" => "source_limit",
        "Invalid private package path"
        | "Invalid private package root"
        | "Invalid private package relative path"
        | "Private package is outside selected root" => "invalid_path",
        _ => "source_rejected",
    }
}

fn validate_guest_url(url: &str) -> Result<(), &'static str> {
    if url.len() > 4096 {
        return Err("invalid_path");
    }
    let parsed = url::Url::parse(url).map_err(|_| "invalid_path")?;
    if parsed.as_str() != url
        || parsed.scheme() != "app"
        || parsed.host_str() != Some("workspace")
        || parsed
            .fragment()
            .is_some_and(|fragment| !fragment.is_empty())
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return Err("invalid_path");
    }
    Ok(())
}

#[derive(Deserialize)]
struct GuestSnapshot {
    bytes: Vec<u8>,
    sha256: String,
    #[serde(default, rename = "metadataOnly")]
    metadata_only: bool,
}

fn map_admission_error(error: String) -> &'static str {
    match error.as_str() {
        "Source identity limit exceeded; restart required" | "Private source limit exceeded" => {
            "source_limit"
        }
        _ => "source_rejected",
    }
}

fn map_guest_error(error: String) -> &'static str {
    match error.as_str() {
        "Module graph limit exceeded" | "Source identity limit exceeded; restart required" => {
            "source_limit"
        }
        "Module must be valid UTF-8" => "invalid_utf8",
        "Invalid module URL"
        | "Module is outside the workspace"
        | "Invalid module path"
        | "Invalid module path encoding"
        | "Module path is not canonically encoded" => "invalid_path",
        _ => "source_rejected",
    }
}

struct RequestObject(Value);

impl<'de> Deserialize<'de> for RequestObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = RequestObject;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a source snapshot request object")
            }

            fn visit_map<M: MapAccess<'de>>(self, mut access: M) -> Result<Self::Value, M::Error> {
                let mut object = serde_json::Map::new();
                while let Some((key, value)) = access.next_entry::<String, Value>()? {
                    if object.insert(key, value).is_some() {
                        return Err(de::Error::custom("duplicate request field"));
                    }
                }
                Ok(RequestObject(Value::Object(object)))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}

fn private_path(input: &str) -> Result<PathBuf, &'static str> {
    let path = workspace_path(input)?;
    if path == Path::new("/") {
        return Err("invalid_path");
    }
    Ok(path)
}

fn workspace_path(input: &str) -> Result<PathBuf, &'static str> {
    let path = PathBuf::from(input);
    if input.len() > 4096 || !path.is_absolute() || path.components().collect::<PathBuf>() != path {
        return Err("invalid_path");
    }
    Ok(path)
}

#[cfg(unix)]
fn metadata_value(kind: &str, metadata: &Metadata) -> Value {
    use std::os::unix::fs::MetadataExt;
    let mtime_ms = metadata
        .mtime()
        .saturating_mul(1000)
        .saturating_add(metadata.mtime_nsec() / 1_000_000);
    json!({"kind":kind,"size":metadata.len(),"mtimeMs":mtime_ms})
}

#[cfg(unix)]
fn same_file_version(before: &Metadata, after: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

fn exact_fields(value: &Value, fields: &[&str]) -> Result<(), &'static str> {
    let object = value.as_object().ok_or("invalid_request")?;
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err("invalid_request");
    }
    Ok(())
}

fn string_field<'a>(value: &'a Value, field: &str) -> Result<&'a str, &'static str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or("invalid_request")
}

fn read_purpose(value: &Value) -> Result<SourceReadPurpose, &'static str> {
    match value.get("purpose") {
        None => Ok(SourceReadPurpose::Module),
        Some(Value::String(text)) => SourceReadPurpose::parse(text).map_err(|_| "invalid_request"),
        _ => Err("invalid_request"),
    }
}

fn handle(value: &Value, session: &mut Option<Session>) -> Result<(Value, bool), &'static str> {
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("invalid_request");
    }
    match string_field(value, "op")? {
        "init" => {
            exact_fields(value, &["schemaVersion", "id", "op", "workspaceRoot"])?;
            if session.is_some() {
                return Err("invalid_state");
            }
            *session = Some(Session::new(string_field(value, "workspaceRoot")?)?);
            Ok((json!({"rootUrl":"app://workspace/"}), false))
        }
        "statPrivate" => {
            exact_fields(value, &["schemaVersion", "id", "op", "path"])?;
            let session = session.as_ref().ok_or("invalid_state")?;
            Ok((
                session.stat_private(string_field(value, "path")?, false)?,
                false,
            ))
        }
        "capturePrivate" => {
            exact_fields(value, &["schemaVersion", "id", "op", "path"])?;
            let session = session.as_ref().ok_or("invalid_state")?;
            Ok((
                session.stat_private(string_field(value, "path")?, true)?,
                false,
            ))
        }
        "readPrivate" => {
            exact_fields(value, &["schemaVersion", "id", "op", "path", "kind"])?;
            let session = session.as_ref().ok_or("invalid_state")?;
            Ok((
                session.read_private(string_field(value, "path")?, string_field(value, "kind")?)?,
                false,
            ))
        }
        "openPrivatePackage" => {
            exact_fields(value, &["schemaVersion", "id", "op", "root", "path"])?;
            let session = session.as_mut().ok_or("invalid_state")?;
            Ok((
                session.open_private_package(
                    string_field(value, "root")?,
                    string_field(value, "path")?,
                )?,
                false,
            ))
        }
        "readPrivatePackage" => {
            exact_fields(
                value,
                &[
                    "schemaVersion",
                    "id",
                    "op",
                    "packageId",
                    "relativePath",
                    "kind",
                ],
            )?;
            let session = session.as_mut().ok_or("invalid_state")?;
            Ok((
                session.read_private_package(
                    string_field(value, "packageId")?,
                    string_field(value, "relativePath")?,
                    string_field(value, "kind")?,
                )?,
                false,
            ))
        }
        "openPrivateSourceRoot" => {
            if value.get("packageId").is_some() {
                exact_fields(
                    value,
                    &[
                        "schemaVersion",
                        "id",
                        "op",
                        "rootPath",
                        "rootUrl",
                        "packageId",
                    ],
                )?;
            } else {
                exact_fields(value, &["schemaVersion", "id", "op", "rootPath", "rootUrl"])?;
            }
            let session = session.as_mut().ok_or("invalid_state")?;
            Ok((
                session.open_private_source_root(
                    string_field(value, "rootPath")?,
                    string_field(value, "rootUrl")?,
                    value
                        .get("packageId")
                        .map(|_| string_field(value, "packageId"))
                        .transpose()?,
                )?,
                false,
            ))
        }
        "readPrivateSourceResource" => {
            if value.get("purpose").is_some() {
                exact_fields(
                    value,
                    &[
                        "schemaVersion",
                        "id",
                        "op",
                        "sourceRootId",
                        "url",
                        "purpose",
                    ],
                )?;
            } else {
                exact_fields(value, &["schemaVersion", "id", "op", "sourceRootId", "url"])?;
            }
            let session = session.as_mut().ok_or("invalid_state")?;
            Ok((
                session.read_private_source_resource_with_purpose(
                    string_field(value, "sourceRootId")?,
                    string_field(value, "url")?,
                    read_purpose(value)?,
                )?,
                false,
            ))
        }
        "reservePrivateDirectory" => {
            exact_fields(value, &["schemaVersion", "id", "op", "path"])?;
            let session = session.as_ref().ok_or("invalid_state")?;
            Ok((
                session.reserve_private_directory(string_field(value, "path")?)?,
                false,
            ))
        }
        "seal" => {
            exact_fields(value, &["schemaVersion", "id", "op"])?;
            let session = session.as_mut().ok_or("invalid_state")?;
            if session.sealed {
                return Err("invalid_state");
            }
            session.sealed = true;
            Ok((json!(true), false))
        }
        "readGuest" => {
            if value.get("purpose").is_some() {
                exact_fields(value, &["schemaVersion", "id", "op", "url", "purpose"])?;
            } else {
                exact_fields(value, &["schemaVersion", "id", "op", "url"])?;
            }
            let session = session.as_mut().ok_or("invalid_state")?;
            Ok((
                session
                    .read_guest_with_purpose(string_field(value, "url")?, read_purpose(value)?)?,
                false,
            ))
        }
        "readGuestResource" => {
            if value.get("purpose").is_some() {
                exact_fields(value, &["schemaVersion", "id", "op", "url", "purpose"])?;
            } else {
                exact_fields(value, &["schemaVersion", "id", "op", "url"])?;
            }
            let session = session.as_mut().ok_or("invalid_state")?;
            Ok((
                session.read_guest_resource_with_purpose(
                    string_field(value, "url")?,
                    read_purpose(value)?,
                )?,
                false,
            ))
        }
        "close" => {
            exact_fields(value, &["schemaVersion", "id", "op"])?;
            *session = None;
            Ok((json!(true), true))
        }
        _ => Err("invalid_request"),
    }
}

/// Processes one bounded request at a time. EOF drops all pinned descriptors.
pub fn serve_source_snapshot(
    mut input: impl BufRead,
    mut output: impl Write,
) -> Result<(), String> {
    let mut session = None;
    loop {
        let mut frame = Vec::new();
        let count = input
            .by_ref()
            .take(MAX_FRAME_BYTES + 1)
            .read_until(b'\n', &mut frame)
            .map_err(|_| "Source snapshot transport unavailable")?;
        if count == 0 {
            return Ok(());
        }
        if count as u64 > MAX_FRAME_BYTES {
            write_response(&mut output, 0, Err("frame_too_large"))?;
            return Ok(());
        }
        if frame.last() != Some(&b'\n') {
            // An incomplete request at EOF is cancellation, not a runnable body.
            return Ok(());
        }
        let value: Value = match serde_json::from_slice(&frame) {
            Ok(RequestObject(value)) => value,
            Err(_) => {
                write_response(&mut output, 0, Err("invalid_request"))?;
                continue;
            }
        };
        let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
        if id == 0 || id > MAX_SAFE_ID {
            write_response(&mut output, 0, Err("invalid_request"))?;
            continue;
        }
        let result = handle(&value, &mut session);
        let close = result.as_ref().is_ok_and(|(_, close)| *close);
        write_response(&mut output, id, result.map(|(value, _)| value))?;
        if close {
            return Ok(());
        }
    }
}

fn write_response(
    output: &mut impl Write,
    id: u64,
    result: Result<Value, &'static str>,
) -> Result<(), String> {
    let value = match result {
        Ok(value) => json!({"schemaVersion":1,"id":id,"ok":true,"value":value}),
        Err(code) => json!({"schemaVersion":1,"id":id,"ok":false,"code":code}),
    };
    serde_json::to_writer(&mut *output, &value)
        .map_err(|_| "Source snapshot transport unavailable")?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|_| "Source snapshot transport unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::Cursor,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "holo-source-snapshot-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
        fn session(&self) -> Session {
            Session::new(self.0.to_str().unwrap()).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn protocol_is_bounded_and_retains_one_session_after_seal() {
        let fixture = Fixture::new();
        fs::write(fixture.path("host.json"), "{\"version\":1}").unwrap();
        fs::write(fixture.path("guest.mjs"), "export default 42;").unwrap();
        let path = fixture.path("host.json").to_string_lossy().into_owned();
        let requests = [
            json!({"schemaVersion":1,"id":1,"op":"init","workspaceRoot":fixture.0}),
            json!({"schemaVersion":1,"id":2,"op":"statPrivate","path":path}),
            json!({"schemaVersion":1,"id":3,"op":"readPrivate","path":path,"kind":"config"}),
            json!({"schemaVersion":1,"id":4,"op":"readGuest","url":"app://workspace/guest.mjs"}),
            json!({"schemaVersion":1,"id":5,"op":"seal"}),
            json!({"schemaVersion":1,"id":6,"op":"readGuest","url":"app://workspace/guest.mjs"}),
            json!({"schemaVersion":1,"id":7,"op":"readGuest","url":"app://workspace/host.json"}),
            json!({"schemaVersion":1,"id":8,"op":"readPrivate","path":path,"kind":"config"}),
            json!({"schemaVersion":1,"id":9,"op":"close"}),
        ];
        let input = requests
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let mut output = Vec::new();
        serve_source_snapshot(Cursor::new(input), &mut output).unwrap();
        let replies = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(replies.len(), 9);
        assert_eq!(replies[0]["value"]["rootUrl"], "app://workspace/");
        assert_eq!(replies[1]["value"]["kind"], "file");
        assert_eq!(replies[2]["value"]["base64"], "eyJ2ZXJzaW9uIjoxfQ==");
        assert_eq!(replies[3]["code"], "invalid_state");
        assert_eq!(replies[5]["value"]["base64"], "ZXhwb3J0IGRlZmF1bHQgNDI7");
        assert_eq!(replies[6]["code"], "source_rejected");
        assert_eq!(replies[7]["value"], replies[2]["value"]);
        assert_eq!(replies[8]["value"], true);
        assert!(
            !String::from_utf8_lossy(&serde_json::to_vec(&replies[6]).unwrap())
                .contains(&fixture.0.to_string_lossy().to_string())
        );
    }

    #[test]
    fn guest_identity_path_and_parent_slot_cannot_be_promoted_to_private() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.path("directory")).unwrap();
        fs::write(fixture.path("directory/guest.mjs"), "export default 1;").unwrap();
        fs::hard_link(
            fixture.path("directory/guest.mjs"),
            fixture.path("hardlink.mjs"),
        )
        .unwrap();
        let mut session = fixture.session();
        session.sealed = true;
        session
            .read_guest("app://workspace/directory/guest.mjs")
            .unwrap();
        assert_eq!(
            session.read_private(fixture.path("hardlink.mjs").to_str().unwrap(), "module"),
            Err("source_rejected")
        );
        assert_eq!(
            session.stat_private(fixture.path("directory/guest.mjs").to_str().unwrap(), true),
            Err("source_rejected")
        );
        fs::rename(fixture.path("directory"), fixture.path("moved")).unwrap();
        fs::remove_file(fixture.path("moved/guest.mjs")).unwrap();
        fs::write(fixture.path("moved/guest.mjs"), "export default 2;").unwrap();
        assert_eq!(
            session.read_private(fixture.path("moved/guest.mjs").to_str().unwrap(), "module"),
            Err("source_rejected")
        );
        fs::create_dir(fixture.path("directory")).unwrap();
        fs::write(fixture.path("directory/guest.mjs"), "export default 3;").unwrap();
        assert_eq!(
            session.read_private(
                fixture.path("directory/guest.mjs").to_str().unwrap(),
                "module"
            ),
            Err("source_rejected")
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            session.read_private(
                fixture.path("DIRECTORY/GUEST.MJS").to_str().unwrap(),
                "module"
            ),
            Err("source_rejected")
        );
    }

    #[test]
    fn private_watch_reads_new_bytes_but_keeps_original_guest_exclusion() {
        let fixture = Fixture::new();
        fs::write(fixture.path("host.json"), "{\"version\":1}").unwrap();
        fs::write(fixture.path("public.mjs"), "export default 1;").unwrap();
        let mut session = fixture.session();
        let path = fixture.path("host.json");
        let first = session
            .read_private(path.to_str().unwrap(), "config")
            .unwrap();
        session.sealed = true;
        fs::rename(&path, fixture.path("old.json")).unwrap();
        fs::write(&path, "{\"version\":2}").unwrap();
        let second = session
            .read_private(path.to_str().unwrap(), "config")
            .unwrap();
        assert_ne!(first, second);
        assert!(session.read_guest("app://workspace/host.json").is_err());
        assert!(session.read_guest("app://workspace/old.json").is_err());
        assert!(
            session
                .read_guest("app://workspace/public.mjs")
                .unwrap()
                .is_object()
        );
    }

    #[test]
    fn directory_metadata_does_not_mark_descendant_guest_sources_private() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.path("node_modules")).unwrap();
        fs::write(
            fixture.path("node_modules/dependency.mjs"),
            "export default 1;",
        )
        .unwrap();
        let mut session = fixture.session();
        let metadata = session
            .stat_private(fixture.path("node_modules").to_str().unwrap(), false)
            .unwrap();
        assert_eq!(metadata["kind"], "directory");
        assert_eq!(
            session.stat_private("/", false).unwrap()["kind"],
            "directory"
        );
        session.sealed = true;
        assert!(
            session
                .read_guest("app://workspace/node_modules/dependency.mjs")
                .unwrap()
                .is_object()
        );
    }

    #[test]
    fn resource_op_returns_pnpm_canonical_identity_without_changing_legacy_read() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.path("node_modules/.pnpm/pkg@1/node_modules/pkg")).unwrap();
        fs::write(
            fixture.path("node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs"),
            "export default 9;",
        )
        .unwrap();
        symlink(
            ".pnpm/pkg@1/node_modules/pkg",
            fixture.path("node_modules/pkg"),
        )
        .unwrap();
        let mut session = fixture.session();
        session.sealed = true;
        assert_eq!(
            session
                .read_guest("app://workspace/node_modules/pkg/index.mjs")
                .unwrap(),
            Value::Null
        );
        let resource = session
            .read_guest_resource("app://workspace/node_modules/pkg/index.mjs?query=1#")
            .unwrap();
        assert_eq!(
            resource["canonicalUrl"],
            "app://workspace/node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs?query=1#"
        );
        assert_eq!(resource["base64"], "ZXhwb3J0IGRlZmF1bHQgOTs=");
        assert_eq!(
            session.read_guest_resource("app://workspace/node_modules/pkg/index.mjs#blocked"),
            Err("invalid_path")
        );
        let requests = [
            json!({"schemaVersion":1,"id":1,"op":"init","workspaceRoot":fixture.0}),
            json!({"schemaVersion":1,"id":2,"op":"seal"}),
            json!({"schemaVersion":1,"id":3,"op":"readGuestResource","url":"app://workspace/node_modules/pkg/index.mjs"}),
            json!({"schemaVersion":1,"id":4,"op":"readGuestResource","url":"app://workspace/node_modules/pkg/index.mjs","extra":true}),
        ];
        let input = requests
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let mut output = Vec::new();
        serve_source_snapshot(Cursor::new(input), &mut output).unwrap();
        let replies = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            replies[2]["value"]["canonicalUrl"],
            "app://workspace/node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs"
        );
        assert_eq!(replies[3]["code"], "invalid_request");
    }

    #[test]
    fn private_package_lease_pins_root_and_blocks_aliases_after_rebind() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let physical = fixture.path("node_modules/.pnpm/pkg@1/node_modules/pkg");
        fs::create_dir_all(&physical).unwrap();
        fs::write(physical.join("package.json"), "{\"name\":\"pkg\"}").unwrap();
        fs::write(physical.join("index.mjs"), "export default 1;").unwrap();
        symlink(
            ".pnpm/pkg@1/node_modules/pkg",
            fixture.path("node_modules/pkg"),
        )
        .unwrap();
        let mut session = fixture.session();
        let opened = session
            .open_private_package(
                fixture.0.to_str().unwrap(),
                fixture
                    .path("node_modules/pkg/package.json")
                    .to_str()
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(opened["rootPath"], physical.to_str().unwrap());
        assert_eq!(opened["base64"], "eyJuYW1lIjoicGtnIn0=");
        let id = opened["packageId"].as_str().unwrap();
        assert!(id.starts_with("pkg-") && id.len() == 36);
        let module = session
            .read_private_package(id, "index.mjs", "module")
            .unwrap();
        assert_eq!(module["base64"], "ZXhwb3J0IGRlZmF1bHQgMTs=");
        session.sealed = true;
        for url in [
            "app://workspace/node_modules/pkg/index.mjs",
            "app://workspace/node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs",
        ] {
            assert!(session.read_guest_resource(url).is_err());
        }
        fs::rename(&physical, fixture.path("retired")).unwrap();
        fs::create_dir(&physical).unwrap();
        fs::write(physical.join("index.mjs"), "export default 2;").unwrap();
        assert_eq!(
            session
                .read_private_package(id, "index.mjs", "module")
                .unwrap()["base64"],
            module["base64"]
        );
        assert!(
            session
                .read_guest_resource("app://workspace/node_modules/pkg/index.mjs")
                .is_err()
        );
    }

    #[test]
    fn private_package_missing_names_and_hardlink_roles_are_conservative() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let physical = fixture.path("node_modules/.pnpm/pkg@1/node_modules/pkg");
        fs::create_dir_all(&physical).unwrap();
        fs::write(physical.join("package.json"), "{}").unwrap();
        fs::write(physical.join("module.mjs"), "export default 1;").unwrap();
        symlink(
            ".pnpm/pkg@1/node_modules/pkg",
            fixture.path("node_modules/pkg"),
        )
        .unwrap();
        let mut session = fixture.session();
        session.sealed = true;
        fs::hard_link(physical.join("module.mjs"), fixture.path("guest-first.mjs")).unwrap();
        session
            .read_guest_resource("app://workspace/guest-first.mjs")
            .unwrap();
        let opened = session
            .open_private_package(
                fixture.0.to_str().unwrap(),
                fixture
                    .path("node_modules/pkg/package.json")
                    .to_str()
                    .unwrap(),
            )
            .unwrap();
        let id = opened["packageId"].as_str().unwrap();
        assert_eq!(
            session.read_private_package(id, "module.mjs", "module"),
            Err("source_rejected")
        );
        assert_eq!(
            session
                .read_private_package(id, "later.mjs", "module")
                .unwrap(),
            Value::Null
        );
        fs::write(physical.join("later.mjs"), "export default 2;").unwrap();
        assert!(
            session
                .read_guest_resource("app://workspace/node_modules/pkg/later.mjs")
                .is_err()
        );
        assert!(
            session
                .read_guest_resource(
                    "app://workspace/node_modules/.pnpm/pkg@1/node_modules/pkg/later.mjs"
                )
                .is_err()
        );
        assert!(
            session
                .read_private_package(id, "later.mjs", "module")
                .unwrap()
                .is_object()
        );
        fs::hard_link(
            physical.join("later.mjs"),
            fixture.path("host-first-alias.mjs"),
        )
        .unwrap();
        assert!(
            session
                .read_guest_resource("app://workspace/host-first-alias.mjs")
                .is_err()
        );
    }

    #[test]
    fn package_protocol_rejects_invalid_fields_paths_links_and_limits() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let package = fixture.path("node_modules/pkg");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("package.json"), "{}").unwrap();
        fs::write(package.join("module.mjs"), "export default 1;").unwrap();
        symlink("module.mjs", package.join("linked.mjs")).unwrap();
        let mut session = fixture.session();
        let opened = session
            .open_private_package(
                fixture.0.to_str().unwrap(),
                package.join("package.json").to_str().unwrap(),
            )
            .unwrap();
        let id = opened["packageId"].as_str().unwrap().to_owned();
        for relative in [
            "",
            "../module.mjs",
            "./module.mjs",
            "/module.mjs",
            "a//b",
            "a\\b",
            "a%2fb",
        ] {
            assert_eq!(
                session.read_private_package(&id, relative, "module"),
                Err("invalid_path")
            );
        }
        assert_eq!(
            session.read_private_package(&id, "linked.mjs", "module"),
            Err("source_rejected")
        );
        assert_eq!(
            session.read_private_package(&id, "module.mjs", "manifest"),
            Err("invalid_request")
        );
        assert_eq!(
            session.read_private_package("unknown", "module.mjs", "module"),
            Err("invalid_request")
        );
        for _ in 0..600 {
            let again = session
                .open_private_package(
                    fixture.0.to_str().unwrap(),
                    package.join("package.json").to_str().unwrap(),
                )
                .unwrap();
            assert_eq!(again["packageId"], id);
        }
        assert_eq!(session.packages.len(), 1);
        assert_eq!(session.package_sizes.len(), 1);
        session
            .read_private_package(&id, "module.mjs", "module")
            .unwrap();
        let high_water = session.package_bytes;
        fs::write(package.join("module.mjs"), "export default 2;").unwrap();
        for _ in 0..600 {
            session
                .read_private_package(&id, "module.mjs", "module")
                .unwrap();
        }
        assert_eq!(session.package_sizes.len(), 2);
        assert_eq!(session.package_bytes, high_water);
        let mut request_session = Some(session);
        for request in [
            json!({"schemaVersion":1,"id":1,"op":"openPrivatePackage","root":fixture.0,"path":package.join("package.json"),"extra":true}),
            json!({"schemaVersion":1,"id":2,"op":"readPrivatePackage","packageId":id,"relativePath":"module.mjs"}),
            json!({"schemaVersion":1,"id":3,"op":"readPrivatePackage","packageId":id,"relativePath":"module.mjs","kind":"module","extra":true}),
        ] {
            assert_eq!(
                handle(&request, &mut request_session),
                Err("invalid_request")
            );
        }
        let oversized = package.join("oversized.json");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_PRIVATE_CONFIG_BYTES + 1)
            .unwrap();
        assert_eq!(
            request_session
                .as_mut()
                .unwrap()
                .read_private_package(&id, "oversized.json", "schema"),
            Err("source_limit")
        );
        File::create(package.join("package.json"))
            .unwrap()
            .set_len(MAX_PRIVATE_CONFIG_BYTES + 1)
            .unwrap();
        assert_eq!(
            request_session.as_mut().unwrap().open_private_package(
                fixture.0.to_str().unwrap(),
                package.join("package.json").to_str().unwrap(),
            ),
            Err("source_limit")
        );
    }

    #[test]
    fn package_root_selection_and_watch_rebind_keep_distinct_pinned_leases() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let project = fixture.path("project");
        let old = project.join("node_modules/.pnpm/pkg@1/node_modules/pkg");
        let next = project.join("node_modules/.pnpm/pkg@2/node_modules/pkg");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&next).unwrap();
        fs::write(old.join("package.json"), "{\"version\":1}").unwrap();
        fs::write(next.join("package.json"), "{\"version\":2}").unwrap();
        symlink(
            ".pnpm/pkg@1/node_modules/pkg",
            project.join("node_modules/pkg"),
        )
        .unwrap();
        let mut session = Session::new(project.to_str().unwrap()).unwrap();
        let manifest = project.join("node_modules/pkg/package.json");
        let first = session
            .open_private_package(project.to_str().unwrap(), manifest.to_str().unwrap())
            .unwrap();
        let same = session
            .open_private_package(project.to_str().unwrap(), manifest.to_str().unwrap())
            .unwrap();
        assert_eq!(first["packageId"], same["packageId"]);
        fs::remove_file(project.join("node_modules/pkg")).unwrap();
        symlink(
            ".pnpm/pkg@2/node_modules/pkg",
            project.join("node_modules/pkg"),
        )
        .unwrap();
        let second = session
            .open_private_package(project.to_str().unwrap(), manifest.to_str().unwrap())
            .unwrap();
        assert_ne!(first["packageId"], second["packageId"]);
        assert_eq!(second["rootPath"], next.to_str().unwrap());
        let moved = project.join("node_modules/.pnpm/pkg@3/node_modules/pkg");
        fs::create_dir_all(moved.parent().unwrap()).unwrap();
        fs::rename(&next, &moved).unwrap();
        fs::remove_file(project.join("node_modules/pkg")).unwrap();
        symlink(
            ".pnpm/pkg@3/node_modules/pkg",
            project.join("node_modules/pkg"),
        )
        .unwrap();
        let renamed = session
            .open_private_package(project.to_str().unwrap(), manifest.to_str().unwrap())
            .unwrap();
        assert_ne!(renamed["packageId"], second["packageId"]);
        assert_eq!(renamed["rootPath"], moved.to_str().unwrap());
        assert_eq!(second["rootPath"], next.to_str().unwrap());
        assert_eq!(
            session
                .read_private_package(
                    second["packageId"].as_str().unwrap(),
                    "package.json",
                    "schema"
                )
                .unwrap()["base64"],
            second["base64"]
        );
        fs::rename(&project, fixture.path("retired-project")).unwrap();
        fs::create_dir(&project).unwrap();
        fs::create_dir_all(project.join("node_modules/pkg")).unwrap();
        fs::write(
            project.join("node_modules/pkg/package.json"),
            "{\"evil\":true}",
        )
        .unwrap();
        let pinned = session
            .open_private_package(project.to_str().unwrap(), manifest.to_str().unwrap())
            .unwrap();
        assert_eq!(pinned["packageId"], renamed["packageId"]);
        assert_eq!(pinned["base64"], renamed["base64"]);
    }

    #[test]
    fn package_lease_count_is_bounded() {
        let fixture = Fixture::new();
        let mut session = fixture.session();
        for index in 0..MAX_PRIVATE_PACKAGE_LEASES + 1 {
            let path = fixture.path(&format!("packages/pkg-{index}/package.json"));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "{}").unwrap();
            let result =
                session.open_private_package(fixture.0.to_str().unwrap(), path.to_str().unwrap());
            if index == MAX_PRIVATE_PACKAGE_LEASES {
                assert_eq!(result, Err("source_limit"));
            } else {
                assert!(result.unwrap().is_object());
            }
        }
        assert_eq!(session.packages.len(), MAX_PRIVATE_PACKAGE_LEASES);
    }

    #[test]
    fn private_package_graph_byte_budget_is_shared_across_modules() {
        let fixture = Fixture::new();
        let package = fixture.path("package");
        fs::create_dir(&package).unwrap();
        fs::write(package.join("package.json"), "{}").unwrap();
        let mut session = fixture.session();
        let opened = session
            .open_private_package(
                fixture.0.to_str().unwrap(),
                package.join("package.json").to_str().unwrap(),
            )
            .unwrap();
        let id = opened["packageId"].as_str().unwrap();
        for index in 0..4 {
            let name = format!("module-{index}.mjs");
            File::create(package.join(&name))
                .unwrap()
                .set_len(crate::MAX_MODULE_BYTES)
                .unwrap();
            let result = session.read_private_package(id, &name, "module");
            if index == 3 {
                assert_eq!(result, Err("source_limit"));
            } else {
                assert!(result.unwrap().is_object());
            }
        }
    }

    #[test]
    fn guest_workspace_root_is_pinned_across_rebinding() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.path("workspace")).unwrap();
        fs::write(fixture.path("workspace/entry.mjs"), "export default 1;").unwrap();
        let mut session = Session::new(fixture.path("workspace").to_str().unwrap()).unwrap();
        session.sealed = true;
        fs::rename(fixture.path("workspace"), fixture.path("moved")).unwrap();
        fs::create_dir(fixture.path("workspace")).unwrap();
        fs::write(fixture.path("workspace/entry.mjs"), "export default 2;").unwrap();
        let read = session.read_guest("app://workspace/entry.mjs").unwrap();
        assert_eq!(read["base64"], "ZXhwb3J0IGRlZmF1bHQgMTs=");
    }

    #[test]
    fn duplicate_fields_and_extra_fields_are_rejected() {
        let input = concat!(
            "{\"schemaVersion\":1,\"id\":1,\"op\":\"close\",\"op\":\"init\"}\n",
            "{\"schemaVersion\":1,\"id\":2,\"op\":\"close\",\"path\":\"/tmp/x\"}\n",
            "{\"schemaVersion\":1,\"id\":3,\"op\":\"close\"}\n"
        );
        let mut output = Vec::new();
        serve_source_snapshot(Cursor::new(input), &mut output).unwrap();
        let replies = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(replies.len(), 3);
        assert_eq!(replies[0]["code"], "invalid_request");
        assert_eq!(replies[1]["id"], 2);
        assert_eq!(replies[1]["code"], "invalid_request");
        assert_eq!(replies[2]["value"], true);
    }

    #[test]
    fn symlink_fifo_size_utf8_and_frame_boundaries_fail_closed() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let fixture = Fixture::new();
        fs::write(fixture.path("source.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(fixture.path("source.txt"), fixture.path("link.txt")).unwrap();
        let fifo = fixture.path("fifo");
        let fifo_name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
        fs::write(fixture.path("invalid.txt"), [0xff]).unwrap();
        fs::write(fixture.path("large.json"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
        let session = fixture.session();
        for name in ["link.txt", "fifo"] {
            assert_eq!(
                session.read_private(fixture.path(name).to_str().unwrap(), "module"),
                Err("source_rejected")
            );
        }
        assert_eq!(
            session.read_private(fixture.path("invalid.txt").to_str().unwrap(), "module"),
            Err("invalid_utf8")
        );
        assert_eq!(
            session.read_private(fixture.path("large.json").to_str().unwrap(), "config"),
            Err("source_limit")
        );
        let mut output = Vec::new();
        serve_source_snapshot(
            Cursor::new(vec![b'X'; MAX_FRAME_BYTES as usize + 1]),
            &mut output,
        )
        .unwrap();
        let reply: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(reply["code"], "frame_too_large");
    }

    #[test]
    fn guest_utf8_and_canonical_url_errors_use_closed_codes() {
        let fixture = Fixture::new();
        fs::write(fixture.path("invalid.mjs"), [0xff]).unwrap();
        fs::write(fixture.path("valid.mjs"), "export default 1;").unwrap();
        let mut session = fixture.session();
        session.sealed = true;
        assert_eq!(
            session.read_guest("app://workspace/invalid.mjs"),
            Err("invalid_utf8")
        );
        assert_eq!(
            session.read_guest("app://workspace/invalid.mjs#fragment"),
            Err("invalid_path")
        );
        assert!(
            session
                .read_guest("app://workspace/valid.mjs#")
                .unwrap()
                .is_object()
        );
    }

    #[test]
    fn guest_query_urls_keep_distinct_immutable_source_identities() {
        let fixture = Fixture::new();
        let path = fixture.path("module.mjs");
        fs::write(&path, "export default 1;").unwrap();
        let mut session = fixture.session();
        session.sealed = true;
        let one = session
            .read_guest("app://workspace/module.mjs?revision=one")
            .unwrap();
        fs::write(&path, "export default 2;").unwrap();
        let two = session
            .read_guest("app://workspace/module.mjs?revision=two")
            .unwrap();
        let one_again = session
            .read_guest("app://workspace/module.mjs?revision=one")
            .unwrap();
        assert_ne!(one, two);
        assert_eq!(one, one_again);
    }

    #[test]
    fn query_alias_cannot_bypass_private_source_role() {
        let fixture = Fixture::new();
        fs::write(fixture.path("host.json"), "{\"private\":true}").unwrap();
        let mut session = fixture.session();
        session
            .read_private(fixture.path("host.json").to_str().unwrap(), "config")
            .unwrap();
        session.sealed = true;
        assert_eq!(
            session.read_guest("app://workspace/host.json?revision=one"),
            Err("source_rejected")
        );
        assert_eq!(
            session.read_guest("app://workspace/host.json?revision=two"),
            Err("source_rejected")
        );
    }

    #[test]
    fn helper_purpose_shares_only_metadata_and_reserves_private_home_before_seal() {
        let fixture = Fixture::new();
        fs::write(fixture.path("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::create_dir_all(fixture.path("private/holo-service/state")).unwrap();
        fs::write(fixture.path("private/holo-service/state/state.json"), "{}").unwrap();
        let mut session = fixture.session();
        session
            .reserve_private_directory(fixture.path("private/holo-service").to_str().unwrap())
            .unwrap();
        let root = session
            .open_private_source_root(fixture.0.to_str().unwrap(), "holo-plugins:///gate/", None)
            .unwrap();
        let id = root["sourceRootId"].as_str().unwrap();
        assert!(
            session
                .read_private_source_resource_with_purpose(
                    id,
                    "holo-plugins:///gate/package.json",
                    SourceReadPurpose::PackageMetadata,
                )
                .unwrap()
                .is_object()
        );
        session.sealed = true;
        assert_eq!(
            session.read_guest_resource("app://workspace/private/holo-service/state/state.json",),
            Err("source_rejected")
        );
        let shared = session
            .read_guest_resource_with_purpose(
                "app://workspace/package.json",
                SourceReadPurpose::PackageMetadata,
            )
            .unwrap();
        assert_eq!(shared["metadataOnly"], true);
        let legacy_shared = session
            .read_guest_with_purpose(
                "app://workspace/package.json",
                SourceReadPurpose::PackageMetadata,
            )
            .unwrap();
        assert_eq!(legacy_shared["metadataOnly"], true);
        assert_eq!(
            session.read_guest_resource("app://workspace/package.json"),
            Err("source_rejected")
        );
        assert_eq!(
            session.reserve_private_directory(fixture.path("later").to_str().unwrap()),
            Err("invalid_state")
        );
    }
}
