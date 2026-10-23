//! Explicit test files share one CLI deadline and signal owner, not a JS registry.
use crate::supervision;
use holonomy_desktop_host::RuntimeLaunch;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

pub fn entries(arguments: &[String]) -> Result<Vec<PathBuf>, String> {
    if arguments.is_empty() || arguments.len() > 256 {
        return Err("Test requires between 1 and 256 explicit files".into());
    }
    arguments
        .iter()
        .map(|argument| {
            if argument.starts_with('-') {
                return Err("Test options must precede test files".into());
            }
            let path = PathBuf::from(argument)
                .canonicalize()
                .map_err(|_| "Test file is unavailable")?;
            if !path.is_file() {
                return Err("Test entry must be a regular file".into());
            }
            Ok(path)
        })
        .collect()
}

pub fn run(mut launch: RuntimeLaunch, entries: Vec<PathBuf>) -> Result<i32, String> {
    launch.validate()?;
    let deadline = launch
        .timeout
        .map(|ms| Instant::now() + Duration::from_millis(ms));
    let _signals = supervision::Signals::install()?;
    let mut outcome = 0;
    for entry in entries {
        launch.entry = entry;
        if let Some(deadline) = deadline {
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis();
            if remaining == 0 {
                return Err("Test execution deadline exceeded".into());
            }
            launch.timeout = Some(remaining as u64);
        }
        let code = supervision::run_owned(&launch.encode()?)?;
        if let Some(interrupted) = supervision::interrupted_code() {
            return Ok(interrupted);
        }
        if code != 0 && outcome == 0 {
            outcome = code;
        }
    }
    Ok(supervision::interrupted_code().unwrap_or(outcome))
}
