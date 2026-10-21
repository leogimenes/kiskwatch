//! Game data the Build tab compares the profile against (every skill point
//! source, every Daevanion node and what it costs), from dbaion2.ru, a fan
//! database read from the Global client. Downloaded on first use and cached
//! in the app's data folder; nothing of it ships with Kiskwatch.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

const SOURCE: &str = "https://dbaion2.ru/data-en";
/// The files the Build tab reads.
const FILES: [&str; 2] = ["skill-points", "daevanion"];
/// A cached copy older than this is downloaded again.
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

fn cache_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("gamedata").join(format!("{name}.json")))
}

fn read_cache(path: &PathBuf) -> Option<(Value, bool)> {
    let fresh = std::fs::metadata(path).ok()?.modified().ok()?.elapsed().map(|age| age < MAX_AGE).unwrap_or(false);
    let value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    Some((value, fresh))
}

async fn download(name: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("Kiskwatch (github.com/leogimenes/kiskwatch)")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(format!("{SOURCE}/{name}.json")).send().await.map_err(|e| format!("sem conexão com a dbaion2: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("a dbaion2 respondeu {}", res.status()));
    }
    res.json().await.map_err(|e| format!("resposta inesperada da dbaion2: {e}"))
}

/// One game data file: the cached copy while fresh, else a new download, else
/// the stale copy if the download fails.
pub async fn get(app: &AppHandle, name: &str) -> Result<Value, String> {
    if !FILES.contains(&name) {
        return Err(format!("arquivo de dados desconhecido: {name}"));
    }
    let path = cache_path(app, name).ok_or("sem pasta de dados do app")?;
    let cached = read_cache(&path);
    if let Some((value, true)) = &cached {
        return Ok(value.clone());
    }
    match download(name).await {
        Ok(value) => {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&path, serde_json::to_vec(&value).unwrap_or_default());
            Ok(value)
        }
        Err(e) => cached.map(|(value, _)| value).ok_or(e),
    }
}

