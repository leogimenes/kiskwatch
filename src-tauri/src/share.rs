//! Sharing the codes Kiskwatch couldn't name (monsters, their skills, player
//! skills, buffs and debuffs), when the player agrees, so the name tables in
//! `data/` can be filled in. The panel builds the report from the saved
//! recordings; this sends it to a Cloudflare Worker (see `worker/`), which
//! opens an issue on GitHub. No names, chat, server or raw packets go out.

use std::collections::BTreeSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

/// The Worker that turns a report into an issue; empty while it isn't up,
/// and then nothing is offered.
pub const URL: &str = "https://kiskwatch-codigos.leogimenes1.workers.dev";

/// Whether to send, as the player chose.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Sharing {
    /// "" before asking, "ask" each time, "always" on its own, "never".
    pub mode: String,
    /// The codes already sent, as "npc:2001234", so each goes once.
    pub sent: BTreeSet<String>,
}

/// What the panel needs: the choice, what went, and whether sending is up.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub mode: String,
    pub sent: BTreeSet<String>,
    pub available: bool,
}

fn status(sharing: &Sharing) -> Status {
    Status { mode: sharing.mode.clone(), sent: sharing.sent.clone(), available: !URL.is_empty() }
}

#[tauri::command]
pub fn share_status(state: State<crate::App>) -> Status {
    status(&state.saved.lock().unwrap().sharing)
}

#[tauri::command]
pub fn share_mode(app: AppHandle, state: State<crate::App>, mode: String) -> Result<Status, String> {
    if !["ask", "always", "never"].contains(&mode.as_str()) {
        return Err(format!("modo desconhecido: {mode}"));
    }
    let st = {
        let mut saved = state.saved.lock().unwrap();
        saved.sharing.mode = mode;
        status(&saved.sharing)
    };
    crate::save(&app, &state);
    Ok(st)
}

/// Send one report; on success its codes (`keys`) count as sent.
#[tauri::command]
pub async fn share_send(app: AppHandle, state: State<'_, crate::App>, report: Value, keys: Vec<String>) -> Result<Status, String> {
    if URL.is_empty() {
        return Err("o envio ainda não está disponível nesta versão".into());
    }
    let region = state.saved.lock().unwrap().settings.region();
    let body = json!({ "v": 1, "app": app.package_info().version.to_string(), "region": region, "report": report });
    let res = reqwest::Client::builder()
        .user_agent("Kiskwatch (github.com/leogimenes/kiskwatch)")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .post(URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("sem conexão: {e}"))?;
    if !res.status().is_success() {
        let code = res.status();
        let why: String = res.text().await.unwrap_or_default().chars().take(200).collect();
        return Err(if why.trim().is_empty() { format!("o servidor respondeu {code}") } else { format!("o servidor respondeu {code}: {}", why.trim()) });
    }
    let st = {
        let mut saved = state.saved.lock().unwrap();
        saved.sharing.sent.extend(keys);
        status(&saved.sharing)
    };
    crate::save(&app, &state);
    Ok(st)
}
