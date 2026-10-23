//! Host-owned persistent Storage primitive. One worker serializes all calls, so
//! each database has FIFO execution and a transaction cannot be interleaved.
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{
    Connection, OpenFlags, TransactionBehavior,
    config::DbConfig,
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender, TryRecvError},
    },
    thread::JoinHandle,
};

const MAX_VALUE: usize = 1024 * 1024;
const MAX_SQL: usize = 64 * 1024;
const MAX_DATABASES: usize = 16;
const MAX_COMMAND: usize = 2 * 1024 * 1024;
const MAX_ROWS: usize = 1024;
const MAX_COLUMNS: usize = 128;
const MAX_STATEMENTS: usize = 256;
const MAX_DATABASE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PROGRESS_TICKS: usize = 10_000;
const OPERATIONS: &[&str] = &[
    "v1.kv.delete",
    "v1.kv.get",
    "v1.kv.list",
    "v1.kv.set",
    "v1.sqlite.execute",
    "v1.sqlite.query",
    "v1.sqlite.transaction",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageLimits {
    pub max_database_name_bytes: usize,
    pub max_key_bytes: usize,
    pub max_keys_per_list: usize,
    pub max_rows_per_query: usize,
    pub max_sql_bytes: usize,
    pub max_transaction_statements: usize,
    pub max_value_bytes: usize,
    pub max_databases: usize,
    pub max_database_bytes: u64,
    pub max_pending_operations: usize,
    pub max_sql_instructions: usize,
}
impl Default for StorageLimits {
    fn default() -> Self {
        Self {
            max_database_name_bytes: 128,
            max_key_bytes: 1024,
            max_keys_per_list: MAX_ROWS,
            max_rows_per_query: MAX_ROWS,
            max_sql_bytes: MAX_SQL,
            max_transaction_statements: MAX_STATEMENTS,
            max_value_bytes: MAX_VALUE,
            max_databases: MAX_DATABASES,
            max_database_bytes: MAX_DATABASE_BYTES,
            max_pending_operations: 128,
            max_sql_instructions: MAX_PROGRESS_TICKS * 1000,
        }
    }
}
impl StorageLimits {
    fn within(&self, ceiling: &Self) -> bool {
        macro_rules! bounded {
            ($field:ident) => {
                self.$field > 0 && self.$field <= ceiling.$field
            };
        }
        bounded!(max_database_name_bytes)
            && bounded!(max_key_bytes)
            && bounded!(max_keys_per_list)
            && bounded!(max_rows_per_query)
            && bounded!(max_sql_bytes)
            && bounded!(max_transaction_statements)
            && bounded!(max_value_bytes)
            && bounded!(max_databases)
            && bounded!(max_database_bytes)
            && bounded!(max_pending_operations)
            && bounded!(max_sql_instructions)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageLimitOverrides {
    pub max_database_name_bytes: Option<usize>,
    pub max_key_bytes: Option<usize>,
    pub max_keys_per_list: Option<usize>,
    pub max_rows_per_query: Option<usize>,
    pub max_sql_bytes: Option<usize>,
    pub max_transaction_statements: Option<usize>,
    pub max_value_bytes: Option<usize>,
    pub max_databases: Option<usize>,
    pub max_database_bytes: Option<u64>,
    pub max_pending_operations: Option<usize>,
    pub max_sql_instructions: Option<usize>,
}
impl StorageLimitOverrides {
    fn effective(&self) -> Result<StorageLimits, String> {
        let mut limits = StorageLimits::default();
        macro_rules! select {
            ($field:ident) => {
                if let Some(value) = self.$field {
                    limits.$field = value;
                }
            };
        }
        select!(max_database_name_bytes);
        select!(max_key_bytes);
        select!(max_keys_per_list);
        select!(max_rows_per_query);
        select!(max_sql_bytes);
        select!(max_transaction_statements);
        select!(max_value_bytes);
        select!(max_databases);
        select!(max_database_bytes);
        select!(max_pending_operations);
        select!(max_sql_instructions);
        if !limits.within(&StorageLimits::default()) {
            return Err("Invalid Host Storage limits".into());
        }
        Ok(limits)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageInstallation {
    pub directory: PathBuf,
    pub namespace: String,
    pub operations: Vec<String>,
    #[serde(default)]
    pub limits: StorageLimitOverrides,
}
impl StorageInstallation {
    pub fn validate(&self) -> Result<(), String> {
        self.limits.effective()?;
        if !self.directory.is_absolute()
            || self.namespace.is_empty()
            || self.namespace.len() > 128
            || !self
                .namespace
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
            || self.operations.is_empty()
            || self.operations.len() > OPERATIONS.len()
        {
            return Err("Invalid Host Storage installation".into());
        }
        let mut seen = HashSet::new();
        if self
            .operations
            .iter()
            .any(|op| !OPERATIONS.contains(&op.as_str()) || !seen.insert(op))
        {
            return Err("Invalid Host Storage operations".into());
        }
        let meta = fs::symlink_metadata(&self.directory)
            .map_err(|_| "Host Storage directory is unavailable")?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("Host Storage directory must be a real directory".into());
        }
        #[cfg(unix)]
        if meta.uid() != unsafe { libc::geteuid() } || meta.permissions().mode() & 0o077 != 0 {
            return Err("Host Storage directory must be owner-only".into());
        }
        #[cfg(unix)]
        for ancestor in self.directory.ancestors() {
            let meta = fs::symlink_metadata(ancestor)
                .map_err(|_| "Host Storage ancestry is unavailable")?;
            let mode = meta.permissions().mode();
            let uid = meta.uid();
            if !meta.is_dir()
                || meta.file_type().is_symlink()
                || (uid != unsafe { libc::geteuid() } && uid != 0)
                || (mode & 0o022 != 0 && !(uid == 0 && mode & 0o1000 != 0))
            {
                return Err("Host Storage ancestry is not owner-controlled".into());
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Call {
    operation: String,
    args: Value,
    #[serde(default)]
    binary: Vec<Binary>,
    selection: StorageSelection,
    value_byte_length: Option<usize>,
    value_sha256: Option<String>,
    call_token: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StorageSelection {
    namespace_id: String,
    operation: String,
    key_prefixes: Vec<String>,
    databases: Vec<String>,
    limits: StorageLimits,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binary {
    handle: String,
    base64: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyArgs {
    key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    prefix: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SqlArgs {
    database: String,
    statement: Statement,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionArgs {
    database: String,
    statements: Vec<Statement>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Statement {
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
}

struct Job {
    id: u64,
    call: Call,
    cancelled: Arc<AtomicBool>,
}
enum Message {
    Call(Job),
}

pub struct NativeStorage {
    sender: SyncSender<Message>,
    receiver: Receiver<(u64, Value)>,
    pending: HashMap<u64, Arc<AtomicBool>>,
    next_id: u64,
    worker: Option<JoinHandle<()>>,
}
impl NativeStorage {
    pub fn new(installation: StorageInstallation) -> Result<Self, String> {
        installation.validate()?;
        let (sender, jobs) = mpsc::sync_channel(128);
        let (finished, receiver) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("holo-storage".into())
            .spawn(move || run_worker(installation, jobs, finished))
            .map_err(|_| "Host Storage worker could not start")?;
        Ok(Self {
            sender,
            receiver,
            pending: HashMap::new(),
            next_id: 0,
            worker: Some(worker),
        })
    }
    pub fn start(&mut self, encoded: &str) -> Result<u64, &'static str> {
        if encoded.len() > MAX_COMMAND || self.pending.len() >= 128 {
            return Err("storage.limit_exceeded");
        }
        let call: Call = serde_json::from_str(encoded).map_err(|_| "storage.invalid_argument")?;
        if self.pending.len() >= call.selection.limits.max_pending_operations {
            return Err("storage.limit_exceeded");
        }
        if call.call_token.is_empty() || call.call_token.len() > 256 {
            return Err("storage.invalid_argument");
        }
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or("storage.limit_exceeded")?;
        let id = self.next_id;
        let cancelled = Arc::new(AtomicBool::new(false));
        self.sender
            .try_send(Message::Call(Job {
                id,
                call,
                cancelled: cancelled.clone(),
            }))
            .map_err(|_| "storage.limit_exceeded")?;
        self.pending.insert(id, cancelled);
        Ok(id)
    }
    pub fn cancel(&mut self, id: u64) {
        if let Some(flag) = self.pending.get(&id) {
            flag.store(true, Ordering::Release);
        }
    }
    pub fn poll(&mut self) -> Vec<(u64, Value)> {
        let mut out = Vec::new();
        while out.len() < 64 {
            match self.receiver.try_recv() {
                Ok((id, result)) => {
                    self.pending.remove(&id);
                    out.push((id, result));
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        out
    }
    pub fn active(&self) -> bool {
        !self.pending.is_empty()
    }
}
impl Drop for NativeStorage {
    fn drop(&mut self) {
        for flag in self.pending.values() {
            flag.store(true, Ordering::Release);
        }
        let (disconnected, _) = mpsc::sync_channel(0);
        let sender = std::mem::replace(&mut self.sender, disconnected);
        drop(sender);
        // A disconnected queue and cancellation flag let the worker drain
        // or roll back before its owning Host generation is released.
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn failure(code: &'static str) -> Value {
    json!({"value":{"ok":false,"error":{"code":code}}})
}
fn success(value: Value) -> Value {
    json!({"value":{"ok":true,"value":value}})
}
fn binary_success(value: Value, bytes: &[u8]) -> Value {
    json!({"value":{"ok":true,"value":value},"binary":[{"handle":"value","base64":STANDARD.encode(bytes)}]})
}
fn cancelled(job: &Job) -> bool {
    job.cancelled.load(Ordering::Acquire)
}
fn valid_key(key: &str, empty: bool) -> bool {
    (empty || !key.is_empty()) && key.len() <= 1024
}
fn valid_database(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128
}
fn selection_allows(install: &StorageInstallation, call: &Call) -> Result<(), &'static str> {
    let selected = &call.selection;
    let Some(suffix) = call.operation.strip_prefix("v1.") else {
        return Err("storage.authorization_denied");
    };
    if selected.namespace_id != "default"
        || selected.operation != format!("storage.{suffix}")
        || !install.operations.contains(&call.operation)
        || !selected.limits.within(
            &install
                .limits
                .effective()
                .map_err(|_| "storage.authorization_denied")?,
        )
    {
        return Err("storage.authorization_denied");
    }
    if selected.key_prefixes.len() > 64 || selected.databases.len() > 64 {
        return Err("storage.authorization_denied");
    }
    if suffix.starts_with("kv.") {
        let field = if suffix == "kv.list" { "prefix" } else { "key" };
        let Some(value) = call.args.get(field).and_then(Value::as_str) else {
            return Err("storage.invalid_argument");
        };
        if !valid_key(value, suffix == "kv.list") {
            return Err("storage.invalid_argument");
        }
        if value.len() > selected.limits.max_key_bytes {
            return Err("storage.limit_exceeded");
        }
        if !selected
            .key_prefixes
            .iter()
            .any(|prefix| value.starts_with(prefix))
        {
            return Err("storage.authorization_denied");
        }
        if suffix == "kv.set" {
            if call.binary.len() != 1 || call.binary[0].handle != "value" {
                return Err("storage.invalid_argument");
            }
            let bytes = STANDARD
                .decode(&call.binary[0].base64)
                .map_err(|_| "storage.invalid_argument")?;
            if bytes.len() > selected.limits.max_value_bytes {
                return Err("storage.limit_exceeded");
            }
            let digest = format!("{:x}", Sha256::digest(&bytes));
            if call.value_byte_length != Some(bytes.len())
                || call.value_sha256.as_deref() != Some(digest.as_str())
            {
                return Err("storage.authorization_denied");
            }
        }
    } else if suffix.starts_with("sqlite.") {
        let Some(database) = call.args.get("database").and_then(Value::as_str) else {
            return Err("storage.invalid_argument");
        };
        if database.len() > selected.limits.max_database_name_bytes {
            return Err("storage.limit_exceeded");
        }
        if !valid_database(database) {
            return Err("storage.invalid_argument");
        }
        if !selected.databases.iter().any(|allowed| database == allowed) {
            return Err("storage.authorization_denied");
        }
    } else {
        return Err("storage.authorization_denied");
    }
    if suffix != "kv.set" && (call.value_byte_length.is_some() || call.value_sha256.is_some()) {
        return Err("storage.invalid_argument");
    }
    Ok(())
}
#[derive(Clone, Hash, PartialEq, Eq)]
enum DatabaseKey {
    Kv,
    Sql(String),
}
fn namespace_prefix(install: &StorageInstallation) -> String {
    format!("holo-{:x}", Sha256::digest(install.namespace.as_bytes()))
}
fn database_path(install: &StorageInstallation, key: &DatabaseKey) -> PathBuf {
    let identity = match key {
        DatabaseKey::Kv => "kv\0".to_owned(),
        DatabaseKey::Sql(name) => format!("sql\0{name}"),
    };
    let digest = Sha256::digest(identity.as_bytes());
    install.directory.join(format!(
        "{}-{:x}.sqlite3",
        namespace_prefix(install),
        digest
    ))
}
#[cfg(unix)]
struct NamespaceLock(std::fs::File);
#[cfg(unix)]
impl NamespaceLock {
    fn acquire(install: &StorageInstallation) -> Result<Self, &'static str> {
        let path = install
            .directory
            .join(format!("{}.lock", namespace_prefix(install)));
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let file = options
            .open(path)
            .map_err(|_| "storage.authorization_denied")?;
        let meta = file
            .metadata()
            .map_err(|_| "storage.authorization_denied")?;
        if !meta.is_file()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.permissions().mode() & 0o077 != 0
            || meta.nlink() != 1
        {
            return Err("storage.authorization_denied");
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("storage.conflict");
        }
        Ok(Self(file))
    }
}
#[cfg(unix)]
impl Drop for NamespaceLock {
    fn drop(&mut self) {
        let _ = unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}
fn open_database(
    install: &StorageInstallation,
    key: &DatabaseKey,
    limits: &StorageLimits,
) -> Result<Connection, &'static str> {
    open_database_mode(install, key, DatabaseMode::Create, limits)
}
#[derive(PartialEq)]
enum DatabaseMode {
    Create,
    ReadOnly,
    WriteExisting,
}
fn open_database_mode(
    install: &StorageInstallation,
    key: &DatabaseKey,
    mode: DatabaseMode,
    limits: &StorageLimits,
) -> Result<Connection, &'static str> {
    if mode == DatabaseMode::Create && limits.max_database_bytes < 4096 {
        return Err("storage.limit_exceeded");
    }
    #[cfg(unix)]
    let _namespace_lock = if mode == DatabaseMode::Create {
        Some(NamespaceLock::acquire(install)?)
    } else {
        None
    };
    let path = database_path(install, key);
    match fs::symlink_metadata(&path) {
        Ok(meta) => {
            if !meta.is_file()
                || meta.file_type().is_symlink()
                || meta.len() > limits.max_database_bytes
            {
                return Err("storage.authorization_denied");
            }
            #[cfg(unix)]
            if meta.uid() != unsafe { libc::geteuid() }
                || meta.permissions().mode() & 0o077 != 0
                || meta.nlink() != 1
            {
                return Err("storage.authorization_denied");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if mode != DatabaseMode::Create {
                return Err("storage.not_found");
            }
            let prefix = format!("{}-", namespace_prefix(install));
            let mut count = 0;
            for entry in fs::read_dir(&install.directory).map_err(|_| "storage.internal")? {
                let entry = entry.map_err(|_| "storage.internal")?;
                if entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".sqlite3"))
                {
                    count += 1;
                }
            }
            if count >= limits.max_databases {
                return Err("storage.limit_exceeded");
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                options
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
            }
            options
                .open(&path)
                .map_err(|_| "storage.authorization_denied")?;
        }
        Err(_) => return Err("storage.authorization_denied"),
    }
    let conn = Connection::open_with_flags(
        path,
        (if mode == DatabaseMode::ReadOnly {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        }) | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| "storage.internal")?;
    conn.busy_timeout(std::time::Duration::from_millis(50))
        .map_err(|_| "storage.internal")?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(|_| "storage.internal")?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_WRITABLE_SCHEMA, false)
        .map_err(|_| "storage.internal")?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false)
        .map_err(|_| "storage.internal")?;
    conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)
        .map_err(|_| "storage.internal")?;
    conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, MAX_SQL as i32)
        .map_err(|_| "storage.internal")?;
    conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, (MAX_VALUE + 4096) as i32)
        .map_err(|_| "storage.internal")?;
    conn.set_limit(Limit::SQLITE_LIMIT_COLUMN, MAX_COLUMNS as i32)
        .map_err(|_| "storage.internal")?;
    conn.execute_batch(if mode == DatabaseMode::ReadOnly {
        "PRAGMA temp_store=MEMORY; PRAGMA query_only=ON;"
    } else {
        "PRAGMA temp_store=MEMORY; PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;"
    })
    .map_err(|_| "storage.internal")?;
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .map_err(|_| "storage.internal")?;
    if !(1..=4096).contains(&page_size)
        || fs::metadata(database_path(install, key))
            .is_ok_and(|meta| meta.len() > limits.max_database_bytes)
    {
        return Err("storage.limit_exceeded");
    }
    if mode != DatabaseMode::ReadOnly {
        constrain_database(&conn, limits)?;
    }
    Ok(conn)
}
fn constrain_database(conn: &Connection, limits: &StorageLimits) -> Result<(), &'static str> {
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .map_err(|_| "storage.internal")?;
    if !(1..=4096).contains(&page_size) || limits.max_database_bytes / (page_size as u64) < 1 {
        return Err("storage.limit_exceeded");
    }
    conn.pragma_update(
        None,
        "max_page_count",
        (limits.max_database_bytes / (page_size as u64)) as i64,
    )
    .map_err(|_| "storage.internal")?;
    Ok(())
}
fn connection<'a>(
    install: &StorageInstallation,
    connections: &'a mut HashMap<DatabaseKey, Connection>,
    key: DatabaseKey,
    limits: &StorageLimits,
) -> Result<&'a mut Connection, &'static str> {
    if !connections.contains_key(&key) {
        if connections.len() >= limits.max_databases {
            return Err("storage.limit_exceeded");
        }
        connections.insert(key.clone(), open_database(install, &key, limits)?);
    }
    if fs::metadata(database_path(install, &key))
        .is_ok_and(|meta| meta.len() > limits.max_database_bytes)
    {
        return Err("storage.limit_exceeded");
    }
    let conn = connections.get_mut(&key).ok_or("storage.internal")?;
    constrain_database(conn, limits)?;
    Ok(conn)
}
fn run_worker(
    install: StorageInstallation,
    jobs: Receiver<Message>,
    finished: Sender<(u64, Value)>,
) {
    let mut connections = HashMap::new();
    while let Ok(Message::Call(job)) = jobs.recv() {
        let id = job.id;
        let result = match process(&install, &mut connections, &job) {
            Ok(value) => value,
            Err(code) => failure(code),
        };
        if finished.send((id, result)).is_err() {
            break;
        }
    }
}
fn process(
    install: &StorageInstallation,
    connections: &mut HashMap<DatabaseKey, Connection>,
    job: &Job,
) -> Result<Value, &'static str> {
    if cancelled(job) {
        return Err("storage.cancelled");
    }
    selection_allows(install, &job.call)?;
    let limits = &job.call.selection.limits;
    match job.call.operation.as_str() {
        "v1.kv.get" | "v1.kv.list" | "v1.kv.delete" => {
            if !job.call.binary.is_empty() {
                return Err("storage.invalid_argument");
            }
            if job.call.operation == "v1.kv.list" {
                let args: ListArgs = serde_json::from_value(job.call.args.clone())
                    .map_err(|_| "storage.invalid_argument")?;
                if !valid_key(&args.prefix, true) {
                    return Err("storage.invalid_argument");
                }
            } else {
                let args: KeyArgs = serde_json::from_value(job.call.args.clone())
                    .map_err(|_| "storage.invalid_argument")?;
                if !valid_key(&args.key, false) {
                    return Err("storage.invalid_argument");
                }
            }
            let empty = || {
                success(match job.call.operation.as_str() {
                    "v1.kv.get" => Value::Null,
                    "v1.kv.list" => json!([]),
                    _ => json!(false),
                })
            };
            let mode = if job.call.operation == "v1.kv.delete" {
                DatabaseMode::WriteExisting
            } else {
                DatabaseMode::ReadOnly
            };
            let mut conn = match open_database_mode(install, &DatabaseKey::Kv, mode, limits) {
                Ok(conn) => conn,
                Err("storage.not_found") => return Ok(empty()),
                Err(error) => return Err(error),
            };
            let has_table: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='kv')",
                    [],
                    |row| row.get(0),
                )
                .map_err(|_| "storage.internal")?;
            if !has_table {
                return Ok(empty());
            }
            kv(&mut conn, job, limits)
        }
        "v1.kv.set" => {
            let conn = connection(install, connections, DatabaseKey::Kv, limits)?;
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB NOT NULL)",
            )
            .map_err(|_| "storage.internal")?;
            kv(conn, job, limits)
        }
        "v1.sqlite.execute" | "v1.sqlite.query" => {
            if !job.call.binary.is_empty() {
                return Err("storage.invalid_argument");
            }
            let args: SqlArgs = serde_json::from_value(job.call.args.clone())
                .map_err(|_| "storage.invalid_argument")?;
            if !valid_database(&args.database) {
                return Err("storage.invalid_argument");
            }
            params(&args.statement, limits)?;
            if job.call.operation == "v1.sqlite.query" {
                let mut conn = open_database_mode(
                    install,
                    &DatabaseKey::Sql(args.database),
                    DatabaseMode::ReadOnly,
                    limits,
                )?;
                query(&mut conn, job, &args.statement, limits)
            } else {
                let conn = connection(
                    install,
                    connections,
                    DatabaseKey::Sql(args.database),
                    limits,
                )?;
                execute(
                    conn,
                    job,
                    std::slice::from_ref(&args.statement),
                    false,
                    limits,
                )
            }
        }
        "v1.sqlite.transaction" => {
            if !job.call.binary.is_empty() {
                return Err("storage.invalid_argument");
            }
            let args: TransactionArgs = serde_json::from_value(job.call.args.clone())
                .map_err(|_| "storage.invalid_argument")?;
            if args.statements.is_empty()
                || args.statements.len() > limits.max_transaction_statements
            {
                return Err("storage.invalid_argument");
            }
            if !valid_database(&args.database) {
                return Err("storage.invalid_argument");
            }
            for statement in &args.statements {
                params(statement, limits)?;
            }
            let conn = connection(
                install,
                connections,
                DatabaseKey::Sql(args.database),
                limits,
            )?;
            execute(conn, job, &args.statements, true, limits)
        }
        _ => Err("storage.not_supported"),
    }
}
fn kv(conn: &mut Connection, job: &Job, limits: &StorageLimits) -> Result<Value, &'static str> {
    match job.call.operation.as_str() {
        "v1.kv.get" => {
            if !job.call.binary.is_empty() {
                return Err("storage.invalid_argument");
            }
            let args: KeyArgs = serde_json::from_value(job.call.args.clone())
                .map_err(|_| "storage.invalid_argument")?;
            if !valid_key(&args.key, false) || args.key.len() > limits.max_key_bytes {
                return Err("storage.invalid_argument");
            }
            let result = conn.query_row("SELECT value FROM kv WHERE key=?1", [&args.key], |row| {
                row.get::<_, Vec<u8>>(0)
            });
            match result {
                Ok(bytes) if bytes.len() <= limits.max_value_bytes => {
                    Ok(binary_success(json!(true), &bytes))
                }
                Ok(_) => Err("storage.limit_exceeded"),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(success(Value::Null)),
                Err(_) => Err("storage.internal"),
            }
        }
        "v1.kv.list" => {
            if !job.call.binary.is_empty() {
                return Err("storage.invalid_argument");
            }
            let args: ListArgs = serde_json::from_value(job.call.args.clone())
                .map_err(|_| "storage.invalid_argument")?;
            if !valid_key(&args.prefix, true) || args.prefix.len() > limits.max_key_bytes {
                return Err("storage.invalid_argument");
            }
            let mut stmt = conn
                .prepare("SELECT key FROM kv ORDER BY key")
                .map_err(|_| "storage.internal")?;
            let mut rows = stmt.query([]).map_err(|_| "storage.internal")?;
            let mut keys = Vec::new();
            while let Some(row) = rows.next().map_err(|_| "storage.internal")? {
                if cancelled(job) {
                    return Err("storage.cancelled");
                }
                let key: String = row.get(0).map_err(|_| "storage.internal")?;
                if key.starts_with(&args.prefix) {
                    if keys.len() >= limits.max_keys_per_list {
                        return Err("storage.limit_exceeded");
                    }
                    keys.push(key);
                }
            }
            Ok(success(json!(keys)))
        }
        "v1.kv.set" | "v1.kv.delete" => {
            let args: KeyArgs = serde_json::from_value(job.call.args.clone())
                .map_err(|_| "storage.invalid_argument")?;
            if !valid_key(&args.key, false) || args.key.len() > limits.max_key_bytes {
                return Err("storage.invalid_argument");
            }
            let data = if job.call.operation == "v1.kv.set" {
                if job.call.binary.len() != 1
                    || job.call.binary[0].handle != "value"
                    || job.call.binary[0].base64.len() > limits.max_value_bytes.div_ceil(3) * 4 + 4
                {
                    return Err("storage.invalid_argument");
                }
                let bytes = STANDARD
                    .decode(&job.call.binary[0].base64)
                    .map_err(|_| "storage.invalid_argument")?;
                if bytes.len() > limits.max_value_bytes {
                    return Err("storage.limit_exceeded");
                }
                Some(bytes)
            } else {
                if !job.call.binary.is_empty() {
                    return Err("storage.invalid_argument");
                }
                None
            };
            if cancelled(job) {
                return Err("storage.cancelled");
            }
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| "storage.internal")?;
            let changed = if let Some(bytes) = data {
                tx.execute("INSERT INTO kv(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (&args.key, bytes))
            } else {
                tx.execute("DELETE FROM kv WHERE key=?1", [&args.key])
            }.map_err(|_| "storage.internal")?;
            if cancelled(job) {
                return Err("storage.cancelled");
            }
            tx.commit().map_err(|_| "storage.internal")?;
            Ok(success(if job.call.operation == "v1.kv.set" {
                Value::Null
            } else {
                json!(changed > 0)
            }))
        }
        _ => Err("storage.not_supported"),
    }
}

fn allow_sql(context: AuthContext<'_>) -> Authorization {
    if context.database_name.is_some_and(|db| db != "main") {
        return Authorization::Deny;
    }
    match context.action {
        AuthAction::Select | AuthAction::Recursive => Authorization::Allow,
        AuthAction::Read { .. }
        | AuthAction::Insert { .. }
        | AuthAction::Delete { .. }
        | AuthAction::Update { .. } => Authorization::Allow,
        AuthAction::CreateTable { table_name } | AuthAction::DropTable { table_name }
            if !table_name.starts_with("sqlite_") =>
        {
            Authorization::Allow
        }
        AuthAction::CreateIndex { table_name, .. } | AuthAction::DropIndex { table_name, .. }
            if !table_name.starts_with("sqlite_") =>
        {
            Authorization::Allow
        }
        AuthAction::Function { function_name }
            if matches!(
                function_name.to_ascii_lowercase().as_str(),
                "abs"
                    | "avg"
                    | "coalesce"
                    | "count"
                    | "hex"
                    | "ifnull"
                    | "length"
                    | "lower"
                    | "max"
                    | "min"
                    | "round"
                    | "substr"
                    | "sum"
                    | "total"
                    | "trim"
                    | "typeof"
                    | "upper"
            ) =>
        {
            Authorization::Allow
        }
        _ => Authorization::Deny,
    }
}
fn params(statement: &Statement, limits: &StorageLimits) -> Result<Vec<SqlValue>, &'static str> {
    if statement.sql.is_empty()
        || statement.sql.len() > limits.max_sql_bytes
        || statement.params.len() > limits.max_transaction_statements
    {
        return Err("storage.invalid_argument");
    }
    statement
        .params
        .iter()
        .map(|value| match value {
            Value::Null => Ok(SqlValue::Null),
            Value::Bool(value) => Ok(SqlValue::Integer(i64::from(*value))),
            Value::Number(value) if value.as_i64().is_some() => {
                Ok(SqlValue::Integer(value.as_i64().unwrap()))
            }
            Value::Number(value) if value.as_f64().is_some_and(f64::is_finite) => {
                Ok(SqlValue::Real(value.as_f64().unwrap()))
            }
            Value::String(value) if value.len() <= limits.max_value_bytes => {
                Ok(SqlValue::Text(value.clone()))
            }
            _ => Err("storage.invalid_argument"),
        })
        .collect()
}
fn execute(
    conn: &mut Connection,
    job: &Job,
    statements: &[Statement],
    multiple: bool,
    limits: &StorageLimits,
) -> Result<Value, &'static str> {
    if cancelled(job) {
        return Err("storage.cancelled");
    }
    let cancel = job.cancelled.clone();
    let ticks = Arc::new(AtomicUsize::new(0));
    let progress = ticks.clone();
    let progress_interval = limits.max_sql_instructions.min(1000);
    let progress_ticks = limits.max_sql_instructions.div_ceil(progress_interval);
    conn.progress_handler(
        progress_interval as i32,
        Some(move || {
            cancel.load(Ordering::Acquire)
                || progress.fetch_add(1, Ordering::Relaxed) + 1 >= progress_ticks
        }),
    )
    .map_err(|_| "storage.internal")?;
    let result = (|| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "storage.sqlite_failed")?;
        tx.authorizer(Some(allow_sql))
            .map_err(|_| "storage.internal")?;
        let operation = (|| {
            let mut output = Vec::with_capacity(statements.len());
            for statement in statements {
                if cancelled(job) {
                    return Err("storage.cancelled");
                }
                let values = params(statement, limits)?;
                let mut prepared = tx
                    .prepare(&statement.sql)
                    .map_err(|_| "storage.sqlite_failed")?;
                let changes = prepared
                    .execute(params_from_iter(values))
                    .map_err(|_| "storage.sqlite_failed")?;
                output.push(json!({"changes":changes}));
            }
            Ok(output)
        })();
        tx.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
            .map_err(|_| "storage.internal")?;
        let output = operation?;
        if cancelled(job) {
            return Err("storage.cancelled");
        }
        tx.commit().map_err(|_| "storage.sqlite_failed")?;
        Ok(success(if multiple {
            json!(output)
        } else {
            output.into_iter().next().unwrap_or(Value::Null)
        }))
    })();
    let _ = conn.progress_handler(0, None::<fn() -> bool>);
    if result.is_err() && cancelled(job) {
        return Err("storage.cancelled");
    }
    if ticks.load(Ordering::Relaxed) >= progress_ticks {
        return Err("storage.limit_exceeded");
    }
    result
}

fn query(
    conn: &mut Connection,
    job: &Job,
    statement: &Statement,
    limits: &StorageLimits,
) -> Result<Value, &'static str> {
    let values = params(statement, limits)?;
    let cancel = job.cancelled.clone();
    let ticks = Arc::new(AtomicUsize::new(0));
    let progress = ticks.clone();
    let progress_interval = limits.max_sql_instructions.min(1000);
    let progress_ticks = limits.max_sql_instructions.div_ceil(progress_interval);
    conn.progress_handler(
        progress_interval as i32,
        Some(move || {
            cancel.load(Ordering::Acquire)
                || progress.fetch_add(1, Ordering::Relaxed) + 1 >= progress_ticks
        }),
    )
    .map_err(|_| "storage.internal")?;
    conn.authorizer(Some(allow_sql))
        .map_err(|_| "storage.internal")?;
    let result = (|| {
        let mut prepared = conn
            .prepare(&statement.sql)
            .map_err(|_| "storage.sqlite_failed")?;
        if !prepared.readonly() || prepared.column_count() > MAX_COLUMNS {
            return Err("storage.authorization_denied");
        }
        let names = prepared
            .column_names()
            .iter()
            .map(|name| (*name).to_owned())
            .collect::<Vec<_>>();
        if names
            .iter()
            .any(|name| name.is_empty() || name.len() > 1024)
            || names.iter().collect::<HashSet<_>>().len() != names.len()
        {
            return Err("storage.limit_exceeded");
        }
        let mut rows = prepared
            .query(params_from_iter(values))
            .map_err(|_| "storage.sqlite_failed")?;
        let mut output = Vec::new();
        let mut bytes = 0usize;
        while let Some(row) = rows.next().map_err(|_| "storage.sqlite_failed")? {
            if cancelled(job) {
                return Err("storage.cancelled");
            }
            if output.len() >= limits.max_rows_per_query {
                return Err("storage.limit_exceeded");
            }
            let mut pairs = Vec::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index).map_err(|_| "storage.sqlite_failed")? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(number) if number.unsigned_abs() <= 9_007_199_254_740_991 => {
                        json!(number)
                    }
                    ValueRef::Real(number) if number.is_finite() => json!(number),
                    ValueRef::Text(text) if text.len() <= limits.max_value_bytes => {
                        json!(std::str::from_utf8(text).map_err(|_| "storage.sqlite_failed")?)
                    }
                    _ => return Err("storage.limit_exceeded"),
                };
                bytes = bytes.saturating_add(name.len() + value.to_string().len());
                if bytes > limits.max_value_bytes {
                    return Err("storage.limit_exceeded");
                }
                pairs.push(json!([name, value]));
            }
            output.push(json!(pairs));
        }
        Ok(success(json!(output)))
    })();
    let _ = conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    let _ = conn.progress_handler(0, None::<fn() -> bool>);
    if result.is_err() && cancelled(job) {
        return Err("storage.cancelled");
    }
    if ticks.load(Ordering::Relaxed) >= progress_ticks {
        return Err("storage.limit_exceeded");
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn kv_and_sql_database_identities_and_rights_are_separate() {
        let root = std::env::temp_dir().join(format!(
            "holo-storage-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let install = StorageInstallation {
            directory: root.canonicalize().unwrap(),
            namespace: "private".into(),
            operations: vec!["v1.kv.set".into(), "v1.sqlite.query".into()],
            limits: StorageLimitOverrides::default(),
        };
        assert_ne!(
            database_path(&install, &DatabaseKey::Kv),
            database_path(&install, &DatabaseKey::Sql("#kv".into()))
        );
        let mut connections = HashMap::new();
        let make_job = |operation: &str, args: Value, binary: Vec<Binary>| Job {
            id: 1,
            call: Call {
                operation: operation.into(),
                args,
                binary,
                selection: StorageSelection {
                    namespace_id: "default".into(),
                    operation: format!("storage.{}", operation.strip_prefix("v1.").unwrap()),
                    key_prefixes: vec![String::new()],
                    databases: vec!["#kv".into()],
                    limits: StorageLimits::default(),
                },
                value_byte_length: if operation == "v1.kv.set" {
                    Some(1)
                } else {
                    None
                },
                value_sha256: if operation == "v1.kv.set" {
                    Some(format!("{:x}", Sha256::digest([42])))
                } else {
                    None
                },
                call_token: "unit-call".into(),
            },
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let write = make_job(
            "v1.kv.set",
            json!({"key":"secret"}),
            vec![Binary {
                handle: "value".into(),
                base64: STANDARD.encode([42]),
            }],
        );
        assert_eq!(
            process(&install, &mut connections, &write).unwrap()["value"]["ok"],
            true
        );
        let read_as_sql = make_job(
            "v1.sqlite.query",
            json!({"database":"#kv","statement":{"sql":"SELECT hex(value) FROM kv"}}),
            vec![],
        );
        assert_eq!(
            process(&install, &mut connections, &read_as_sql),
            Err("storage.not_found")
        );
        let denied = make_job("v1.kv.get", json!({"key":"secret"}), vec![]);
        assert_eq!(
            process(&install, &mut connections, &denied),
            Err("storage.authorization_denied")
        );
        drop(connections);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn namespace_database_count_persists_across_reopens() {
        let root = std::env::temp_dir().join(format!(
            "holo-storage-quota-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let install = StorageInstallation {
            directory: root.canonicalize().unwrap(),
            namespace: "quota".into(),
            operations: vec!["v1.sqlite.execute".into()],
            limits: StorageLimitOverrides::default(),
        };
        for index in 0..MAX_DATABASES {
            let key = DatabaseKey::Sql(format!("db-{index}"));
            drop(open_database(&install, &key, &StorageLimits::default()).unwrap());
        }
        assert!(matches!(
            open_database(
                &install,
                &DatabaseKey::Sql("seventeenth".into()),
                &StorageLimits::default()
            ),
            Err("storage.limit_exceeded")
        ));
        drop(
            open_database(
                &install,
                &DatabaseKey::Sql("db-0".into()),
                &StorageLimits::default(),
            )
            .unwrap(),
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_scope_and_limits_are_checked_before_any_storage_file() {
        let root = std::env::temp_dir().join(format!(
            "holo-storage-selected-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let install = StorageInstallation {
            directory: root.canonicalize().unwrap(),
            namespace: "private".into(),
            operations: vec!["v1.kv.set".into()],
            limits: StorageLimitOverrides {
                max_value_bytes: Some(2),
                ..Default::default()
            },
        };
        let make = |namespace: &str, operation: &str, key: &str, limit: usize| Job {
            id: 1,
            call: Call {
                operation: "v1.kv.set".into(),
                args: json!({"key":key}),
                binary: vec![Binary {
                    handle: "value".into(),
                    base64: STANDARD.encode([1, 2, 3]),
                }],
                selection: StorageSelection {
                    namespace_id: namespace.into(),
                    operation: operation.into(),
                    key_prefixes: vec!["allowed/".into()],
                    databases: vec![],
                    limits: StorageLimits {
                        max_value_bytes: limit,
                        ..Default::default()
                    },
                },
                value_byte_length: Some(3),
                value_sha256: Some(format!("{:x}", Sha256::digest([1, 2, 3]))),
                call_token: "selected-test".into(),
            },
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let mut connections = HashMap::new();
        for (namespace, operation, key, limit, code) in [
            (
                "physical",
                "storage.kv.set",
                "allowed/key",
                2,
                "storage.authorization_denied",
            ),
            (
                "default",
                "storage.kv.get",
                "allowed/key",
                2,
                "storage.authorization_denied",
            ),
            (
                "default",
                "storage.kv.set",
                "outside/key",
                2,
                "storage.authorization_denied",
            ),
            (
                "default",
                "storage.kv.set",
                "allowed/key",
                3,
                "storage.authorization_denied",
            ),
        ] {
            assert_eq!(
                process(
                    &install,
                    &mut connections,
                    &make(namespace, operation, key, limit)
                ),
                Err(code)
            );
        }
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        assert_eq!(
            process(
                &install,
                &mut connections,
                &make("default", "storage.kv.set", "allowed/key", 2)
            ),
            Err("storage.limit_exceeded")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
