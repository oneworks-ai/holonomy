//! Plugin schema admission runs locked Ajv in a disposable private process.
pub(crate) mod transport;
use holonomy_desktop_host::RuntimePluginInstallation;
use std::{
    io::{Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

const BOOTSTRAP: &str = include_str!("../generated/plugin-validator.js");
const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const HEAP_LIMIT_BYTES: usize = 32 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_millis(750);
const HELPER_ARGUMENT: &str = "__plugin_validator_v1";
const FAILED: &str = "Native plugin config Schema validation failed";

pub(crate) fn validate(installations: &[RuntimePluginInstallation]) -> Result<(), &'static str> {
    let Some(input) = encode(installations)? else {
        return Ok(());
    };
    execute(&input, &AtomicBool::new(false))
}

fn execute(input: &[u8], cancelled: &AtomicBool) -> Result<(), &'static str> {
    let executable = std::env::current_exe().map_err(|_| FAILED)?;
    transport::run(
        &executable,
        &[HELPER_ARGUMENT],
        input,
        DEADLINE,
        256 * 1024 * 1024,
        cancelled,
    )
}

pub(crate) struct PendingValidation {
    receive: mpsc::Receiver<Result<(), &'static str>>,
    cancelled: Arc<AtomicBool>,
}
impl PendingValidation {
    pub(crate) fn poll(&self) -> Option<Result<(), &'static str>> {
        match self.receive.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => Some(Err(FAILED)),
        }
    }
}
impl Drop for PendingValidation {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

pub(crate) fn begin(
    installations: &[RuntimePluginInstallation],
) -> Result<PendingValidation, &'static str> {
    let input = encode(installations)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let (send, receive) = mpsc::sync_channel(1);
    if let Some(input) = input {
        let token = cancelled.clone();
        std::thread::Builder::new()
            .name("schema-helper-control".into())
            .spawn(move || {
                let _ = send.send(execute(&input, &token));
            })
            .map_err(|_| FAILED)?;
    } else {
        let _ = send.send(Ok(()));
    }
    Ok(PendingValidation { receive, cancelled })
}

fn encode(installations: &[RuntimePluginInstallation]) -> Result<Option<Vec<u8>>, &'static str> {
    #[derive(serde::Serialize)]
    struct Candidate<'a> {
        schema: &'a serde_json::Value,
        config: &'a serde_json::Value,
    }
    let candidates = installations
        .iter()
        .filter_map(|item| {
            item.config_schema.as_ref().map(|schema| Candidate {
                schema,
                config: &item.config,
            })
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(None);
    }
    struct Bounded(Vec<u8>);
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_INPUT_BYTES.saturating_sub(self.0.len()) {
                return Err(std::io::Error::other(FAILED));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Bounded(Vec::new());
    serde_json::to_writer(&mut output, &candidates).map_err(|_| FAILED)?;
    Ok(Some(output.0))
}

/// Private executable mode only: never call in a live Host or Guest process.
/// It exits without returning and receives only bounded schema/config JSON.
#[doc(hidden)]
pub fn helper_entry() -> ! {
    let no_core = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &no_core) } != 0 {
        unsafe { libc::_exit(2) }
    }
    // A helper also terminates if its parent disappears during native compilation.
    // _exit skips V8/allocator teardown; it cannot join a stuck V8 thread.
    if std::thread::Builder::new()
        .name("schema-process-deadline".into())
        .spawn(|| {
            std::thread::sleep(DEADLINE);
            unsafe { libc::_exit(2) }
        })
        .is_err()
    {
        unsafe { libc::_exit(2) }
    }
    let mut input = Vec::new();
    let valid_input = std::io::stdin()
        .lock()
        .take(MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut input)
        .is_ok()
        && input.len() <= MAX_INPUT_BYTES;
    let accepted = valid_input && std::str::from_utf8(&input).ok().is_some_and(evaluate);
    let output = [u8::from(accepted)];
    let mut stdout = std::io::stdout().lock();
    let written = stdout
        .write_all(&output)
        .and_then(|_| stdout.flush())
        .is_ok();
    unsafe { libc::_exit(if written { 0 } else { 2 }) }
}

fn evaluate(input: &str) -> bool {
    crate::driver::initialize_engine();
    let mut isolate =
        v8::Isolate::new(v8::CreateParams::default().heap_limits(0, HEAP_LIMIT_BYTES));
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    v8::scope!(let scope, &mut isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    // No Runtime bootstrap, Host objects, loader, native APIs or plugins.
    context.set_allow_generation_from_strings(true);
    v8::tc_scope!(let tc, scope);
    (|| {
        let source = v8::String::new(tc, BOOTSTRAP)?;
        let script = v8::Script::compile(tc, source, None)?;
        let validator = v8::Local::<v8::Function>::try_from(script.run(tc)?).ok()?;
        let input = v8::String::new(tc, input)?;
        validator
            .call(tc, v8::undefined(tc).into(), &[input.into()])?
            .is_true()
            .then_some(())
    })()
    .is_some()
}
