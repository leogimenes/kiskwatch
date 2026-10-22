//! A small log file, for what a release build can't show: it has no console.
//! It says when Kiskwatch starts and quits, and why it panicked if it did, in
//! `%LOCALAPPDATA%\Kiskwatch\logs\kiskwatch.log`, next to the installed
//! app. A run that starts and never says it quit crashed outside Rust, or
//! was killed.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// The product name in `tauri.conf.json`, which names the install folder.
const FOLDER: &str = "Kiskwatch";
/// Past this the log starts over, keeping the last one as `kiskwatch.old.log`.
const MAX_BYTES: u64 = 1 << 20;

static WRITING: Mutex<()> = Mutex::new(());

/// The log's folder, found without Tauri so it works before the app is built.
pub fn dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join(FOLDER).join("logs")
}

/// Add a line, with the time. Never fails: a log that can't be written is lost.
pub fn line(text: &str) {
    let _one_at_a_time = WRITING.lock().unwrap_or_else(|p| p.into_inner());
    let dir = dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("kiskwatch.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join("kiskwatch.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "{now} [{}] {text}", std::process::id());
    }
}

/// Write panics to the log too, from any thread, before the default handler.
pub fn catch_panics() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("sem nome");
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        line(&format!("PÂNICO na thread {name} em {at}: {what}"));
        default(info);
    }));
}
