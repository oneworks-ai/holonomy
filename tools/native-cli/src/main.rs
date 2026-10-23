use holonomy_desktop_host::{HostConfiguration, RuntimeLaunch};
mod source_root;
mod supervision;
mod test_run;
use std::{path::PathBuf, sync::mpsc, time::Duration};

fn main() {
    std::process::exit(match cli() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("holo: {error}");
            1
        }
    });
}

fn cli() -> Result<i32, String> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.as_slice() == ["__plugin_validator_v1"] {
        holonomy_desktop_v8::plugin_validator_helper_entry();
    }
    if args.as_slice() == ["__observer_executor_v1"] {
        holonomy_desktop_v8::observer_executor_helper_entry();
    }
    if args.as_slice() == ["__source_snapshot_v1"] {
        holonomy_desktop_host::serve_source_snapshot(
            std::io::stdin().lock(),
            std::io::stdout().lock(),
        )?;
        return Ok(0);
    }
    #[cfg(target_os = "macos")]
    if args.as_slice() == ["__process_io_v1"] {
        holonomy_desktop_host::darwin_process::serve_process_io()?;
        return Ok(0);
    }
    if args.first().is_some_and(|arg| arg == "__runtime") {
        return runtime();
    }
    if args.is_empty() || args[0] == "--help" || args[0] == "-h" {
        println!(
            "Usage: holo [run] [options] <file.js> [arguments...]\n       holo test [options] <file.test.mjs> [more-test-files...]\n       holo engine info [--json]\n       holo --version\n\nOptions:\n  --timeout <milliseconds>  Execution deadline (1..86400000; total for test files)\n  --module-root <directory> Explicit module-source root (not an FS grant)\n  --host-config <file.json> Host Policy, roots and projections\n  --inspector-socket <path> Owner-private Unix Inspector socket (requires --host-config)\n  --process-profiles <file.json> Owner-private Process profile manifest\n  --process-backends <file.json> Owner-private Process Backend manifest\n  --experimental-v86-process Private experimental Process gate\n  --watch                  Reload plugins from --host-config (run only)"
        );
        return Ok(0);
    }
    if args[0] == "--version" || args[0] == "-v" {
        println!(
            "holo {} (V8 {})",
            env!("CARGO_PKG_VERSION"),
            holonomy_desktop_v8::engine_version()
        );
        return Ok(0);
    }
    if args[0] == "engine" && args.get(1).is_some_and(|s| s == "info") {
        println!(
            "{}",
            serde_json::json!({"engine":"embedded-v8", "rustyV8":"152.2.0", "v8":holonomy_desktop_v8::engine_version(), "runtimeAssetSha256":holonomy_desktop_v8::RUNTIME_ASSET_SHA256, "hostControlAssetSha256":holonomy_desktop_v8::CONTROL_ASSET_SHA256, "pluginValidatorAssetSha256":holonomy_desktop_v8::PLUGIN_VALIDATOR_ASSET_SHA256, "modulePlannerAssetSha256":holonomy_desktop_v8::MODULE_PLANNER_ASSET_SHA256, "v86BackendCompiled":holonomy_desktop_v8::V86_BACKEND_COMPILED, "nodeInstalledRequired":false, "platform":std::env::consts::OS, "arch":std::env::consts::ARCH})
        );
        return Ok(0);
    }
    let test_mode = args[0] == "test";
    if args[0] == "run" || test_mode {
        args.remove(0);
    }
    let mut timeout = None;
    let mut module_root = None;
    let mut host_config = None;
    let mut host_config_path = None;
    let mut process_profiles = None;
    let mut process_backends = None;
    let mut experimental_v86_process = false;
    let mut watch = false;
    let mut inspector_socket = None;
    while let Some(option) = args.first().map(String::as_str) {
        match option {
            "--watch" => {
                if watch {
                    return Err("Duplicate watch option".into());
                }
                watch = true;
                args.remove(0);
            }
            "--" => {
                args.remove(0);
                break;
            }
            "--timeout" => {
                if timeout.is_some() {
                    return Err("Duplicate timeout".into());
                }
                timeout = Some(
                    args.get(1)
                        .ok_or("Missing timeout")?
                        .parse::<u64>()
                        .map_err(|_| "Timeout must be an integer")?,
                );
                args.drain(..2);
            }
            "--module-root" => {
                if module_root.is_some() {
                    return Err("Duplicate module root".into());
                }
                module_root = Some(source_root::select(
                    args.get(1).ok_or("Missing module root directory")?,
                )?);
                args.drain(..2);
            }
            "--host-config" => {
                if host_config.is_some() {
                    return Err("Duplicate Host configuration".into());
                }
                let path = PathBuf::from(args.get(1).ok_or("Missing Host configuration path")?);
                host_config = Some(HostConfiguration::read(&path)?);
                host_config_path = Some(
                    path.canonicalize()
                        .map_err(|_| "Host configuration is unavailable")?,
                );
                args.drain(..2);
            }
            "--inspector-socket" => {
                if inspector_socket.is_some() {
                    return Err("Duplicate Inspector socket".into());
                }
                inspector_socket = Some(PathBuf::from(
                    args.get(1).ok_or("Missing Inspector socket path")?,
                ));
                args.drain(..2);
            }
            "--process-profiles" => {
                if process_profiles.is_some() {
                    return Err("Duplicate Process manifest".into());
                }
                process_profiles = Some(PathBuf::from(
                    args.get(1).ok_or("Missing Process manifest path")?,
                ));
                args.drain(..2);
            }
            "--process-backends" => {
                if process_backends.is_some() {
                    return Err("Duplicate Process Backend manifest".into());
                }
                process_backends = Some(PathBuf::from(
                    args.get(1).ok_or("Missing Process Backend manifest path")?,
                ));
                args.drain(..2);
            }
            "--experimental-v86-process" => {
                if experimental_v86_process {
                    return Err("Duplicate experimental v86 option".into());
                }
                experimental_v86_process = true;
                args.remove(0);
            }
            value if value.starts_with('-') => return Err("Unknown option".into()),
            _ => break,
        }
    }
    if watch && (host_config_path.is_none() || test_mode) {
        return Err("--watch requires --host-config and is available only for run".into());
    }
    if inspector_socket.is_some() && host_config.is_none() {
        return Err("--inspector-socket requires --host-config".into());
    }
    match (host_config.as_mut(), process_profiles.as_ref()) {
        (Some(config), Some(path)) => config.install_process_profile(path)?,
        (Some(config), None) if config.process_profile_id.is_some() => {
            return Err("Selected Process profile requires --process-profiles".into());
        }
        (None, Some(_)) => {
            return Err("--process-profiles requires a selected Host Process profile".into());
        }
        _ => {}
    }
    match (host_config.as_mut(), process_backends.as_ref()) {
        (Some(config), Some(path)) => config.install_process_backend(path)?,
        (Some(config), None)
            if config.process_profile.as_ref().is_some_and(|profile| {
                profile
                    .pointer("/backend/backendId")
                    .and_then(serde_json::Value::as_str)
                    == Some("experimental.v86-v1")
            }) =>
        {
            return Err("Selected v86 Backend requires --process-backends".into());
        }
        (None, Some(_)) => {
            return Err("--process-backends requires a selected Host Process profile".into());
        }
        _ => {}
    }
    if experimental_v86_process {
        host_config
            .as_mut()
            .ok_or("Experimental v86 requires Host configuration")?
            .enable_experimental_v86_process()?;
    }
    let entry = PathBuf::from(args.first().ok_or("Missing entry file")?)
        .canonicalize()
        .map_err(|_| "Entry file is unavailable")?;
    let entries = test_mode.then(|| test_run::entries(&args)).transpose()?;
    source_root::validate_entries(
        entries
            .as_deref()
            .unwrap_or_else(|| std::slice::from_ref(&entry)),
        module_root.as_deref(),
    )?;
    let schema_version = if module_root.is_some() { 2 } else { 1 };
    let launch = RuntimeLaunch {
        workspace_root: module_root,
        module_allowlist: None,
        module_aliases: None,
        module_metadata_only: vec![],
        schema_version,
        generation: 1,
        entry,
        argv: if test_mode {
            vec![]
        } else {
            args[1..].to_vec()
        },
        timeout,
        test_mode,
        host_config,
        watch_config: if watch { host_config_path } else { None },
        service_plugin_config: None,
        process_profiles_manifest: None,
        service_plugin_revision: None,
        inspector_socket,
        inspector_wait_for_debugger: false,
    };
    if let Some(entries) = entries {
        return test_run::run(launch, entries);
    }
    let launch = launch.encode()?;
    supervision::run(&launch)
}

fn runtime() -> Result<i32, String> {
    let input = RuntimeLaunch::read(std::io::stdin().lock())?;
    let service_plugin_ack = input.service_plugin_config.is_some() && !input.test_mode;
    let timeout = input.timeout.map(Duration::from_millis);
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut byte = [0];
        let _ = std::io::stdin().read(&mut byte);
        let _ = send.send(());
    });
    holonomy_desktop_v8::run(
        holonomy_desktop_v8::RunOptions {
            workspace_root: input.workspace_root,
            module_allowlist: input.module_allowlist,
            module_aliases: input.module_aliases,
            module_metadata_only: input.module_metadata_only,
            entry: input.entry,
            argv: input.argv,
            timeout,
            test_mode: input.test_mode,
            host_config: input.host_config,
            watch_config: input.watch_config,
            service_plugin_ack,
            inspector_socket: input.inspector_socket,
            inspector_wait_for_debugger: input.inspector_wait_for_debugger,
        },
        receive,
    )
}
