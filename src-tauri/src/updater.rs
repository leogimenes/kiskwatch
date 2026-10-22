//! The automatic updater: looks for a newer GitHub Release now and then, and
//! on the player's word downloads its installer, checks it against the
//! release's SHA-256 (`kiskwatch_core::update`) and runs it. The installer
//! closes Kiskwatch, installs over it and opens it again; settings and window
//! positions live in AppData, which it leaves alone.

use std::path::PathBuf;
use std::time::Duration;

use kiskwatch_core::update::{self, Latest};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Written by the release workflow; GitHub sends it from the newest release
/// that isn't a draft or a pre-release.
const LATEST_URL: &str = "https://github.com/leogimenes/kiskwatch/releases/latest/download/latest.json";
/// The first look waits for the app to settle; then one every few hours.
const FIRST_CHECK: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_secs(6 * 3600);

/// What the panel shows about updates.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Status {
    /// The version running.
    pub current: String,
    /// A newer release, if there is one.
    pub available: Option<Latest>,
    /// Last look, unix ms; 0 before the first.
    pub checked_ms: i64,
    /// Why the last look or install failed.
    pub error: Option<String>,
    /// Downloading or starting the installer.
    pub installing: bool,
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Kiskwatch (github.com/leogimenes/kiskwatch)")
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

/// The latest release, or None while there's none published.
async fn fetch_latest() -> Result<Option<Latest>, String> {
    let res = client(Duration::from_secs(20))?.get(LATEST_URL).send().await.map_err(|e| format!("sem conexão com o GitHub: {e}"))?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("o GitHub respondeu {}", res.status()));
    }
    res.json().await.map(Some).map_err(|e| format!("latest.json inesperado: {e}"))
}

fn set(app: &AppHandle, change: impl FnOnce(&mut Status)) -> Status {
    let state = app.state::<crate::App>();
    let mut status = state.update.lock().unwrap();
    change(&mut status);
    status.clone()
}

pub fn status(app: &AppHandle) -> Status {
    set(app, |_| {})
}

/// Look for a newer release now. The panel hears `update-changed`.
pub async fn check(app: &AppHandle) -> Status {
    let current = app.package_info().version.to_string();
    let found = fetch_latest().await;
    let status = set(app, |s| {
        s.current = current.clone();
        s.checked_ms = crate::now_ms();
        match found {
            Ok(latest) => {
                s.available = latest.and_then(|l| update::newer(&current, l));
                s.error = None;
            }
            Err(e) => s.error = Some(e),
        }
    });
    let _ = app.emit("update-changed", ());
    status
}

/// Checks in the background for as long as the app runs. Dev builds don't,
/// so `tauri dev` never offers to install over itself.
pub async fn watch(app: AppHandle) {
    set(&app, |s| s.current = app.package_info().version.to_string());
    if cfg!(debug_assertions) {
        return;
    }
    tokio::time::sleep(FIRST_CHECK).await;
    loop {
        check(&app).await;
        tokio::time::sleep(EVERY).await;
    }
}

/// Download the installer to the temp folder and check it. Nothing is kept
/// when the checksum doesn't match.
async fn download(latest: &Latest) -> Result<PathBuf, String> {
    let installer = &latest.installer;
    let res = client(Duration::from_secs(600))?.get(&installer.url).send().await.map_err(|e| format!("não deu para baixar o instalador: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("o GitHub respondeu {} ao baixar o instalador", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("o download parou no meio: {e}"))?;
    update::verify(installer, &bytes)?;
    let dir = std::env::temp_dir().join("kiskwatch-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&installer.name);
    std::fs::write(&path, &bytes).map_err(|e| format!("não deu para salvar o instalador: {e}"))?;
    Ok(path)
}

/// Run the installer: passive (a progress bar, no questions), as an update,
/// and opening Kiskwatch again when it's done (the /P /UPDATE /R flags of
/// Tauri's NSIS installer). Kiskwatch quits so it can be replaced.
fn launch(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("o atualizador só instala no Windows".into());
    }
    std::process::Command::new(path).args(["/P", "/UPDATE", "/R"]).spawn().map_err(|e| format!("não deu para abrir o instalador: {e}"))?;
    crate::save_windows(app);
    app.exit(0);
    Ok(())
}

/// Install the newer release, if there is one.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let latest = {
        let state = app.state::<crate::App>();
        let mut status = state.update.lock().unwrap();
        if status.installing {
            return Ok(());
        }
        let latest = status.available.clone().ok_or("nenhuma versão nova para instalar")?;
        status.installing = true;
        status.error = None;
        latest
    };
    let _ = app.emit("update-changed", ());
    let result = match download(&latest).await {
        Ok(path) => launch(app, &path),
        Err(e) => Err(e),
    };
    if let Err(e) = &result {
        set(app, |s| {
            s.installing = false;
            s.error = Some(e.clone());
        });
        let _ = app.emit("update-changed", ());
    }
    result
}
