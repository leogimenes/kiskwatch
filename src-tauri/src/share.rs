//! Sharing the codes Kiskwatch couldn't name (monsters, their skills, player
//! skills, buffs and debuffs), when the player agrees, so the name tables in
//! `data/` can be filled in. The panel builds the report from the saved
//! recordings; this sends it to a Cloudflare Worker (see `worker/`), which
//! keeps it in a D1 database. No names, chat, server or raw packets go out.
//! The names found for those codes come back the same way: `watch_names`
//! downloads the Worker's table now and then, and the panel uses it where
//! `data/` has no name.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// The Worker that keeps the reports and serves the names; empty while it isn't up,
/// and then nothing is offered.
pub const URL: &str = "https://kiskwatch-codigos.leogimenes1.workers.dev";

/// The names table: downloaded at start, then every few hours.
const NAMES_FIRST: Duration = Duration::from_secs(15);
const NAMES_EVERY: Duration = Duration::from_secs(6 * 3600);
/// The lists in the names table, as in a report.
const KINDS: [&str; 4] = ["npcs", "npc_skills", "skills", "effects"];

/// Whether to send, as the player chose.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Sharing {
    /// "" before the consent term was answered, "always" once accepted,
    /// "never" declined or taken back. ("ask", from the first canaries,
    /// counts as unanswered.)
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
    let mode = if sharing.mode == "ask" { String::new() } else { sharing.mode.clone() };
    Status { mode, sent: sharing.sent.clone(), available: !URL.is_empty() }
}

#[tauri::command]
pub fn share_status(state: State<crate::App>) -> Status {
    status(&state.saved.lock().unwrap().sharing)
}

#[tauri::command]
pub fn share_mode(app: AppHandle, state: State<crate::App>, mode: String) -> Result<Status, String> {
    if !["always", "never"].contains(&mode.as_str()) {
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

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Kiskwatch (github.com/leogimenes/kiskwatch)")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

/// Send one report; on success its codes (`keys`) count as sent.
#[tauri::command]
pub async fn share_send(app: AppHandle, state: State<'_, crate::App>, report: Value, keys: Vec<String>) -> Result<Status, String> {
    if URL.is_empty() {
        return Err("o envio ainda não está disponível nesta versão".into());
    }
    let region = state.saved.lock().unwrap().settings.region();
    let body = json!({ "v": 1, "app": app.package_info().version.to_string(), "region": region, "report": report });
    let res = client()?
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

fn names_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("gamedata").join("shared-names.json"))
}

/// The names table as last downloaded, if any. It reads only the file, so it
/// answers even before the app has finished starting.
#[tauri::command]
pub fn shared_names(app: AppHandle) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(names_path(&app)?).ok()?).ok()
}

/// Only the four lists, each of code to name, with sane sizes.
fn valid_names(v: &Value) -> bool {
    KINDS.iter().all(|k| {
        v.get(k).and_then(Value::as_object).is_some_and(|m| {
            m.len() <= 100_000 && m.iter().all(|(code, name)| code.parse::<u32>().is_ok() && name.as_str().is_some_and(|n| !n.is_empty() && n.len() <= 200))
        })
    })
}

async fn fetch_names() -> Result<Value, String> {
    let res = client()?.get(format!("{URL}/nomes")).send().await.map_err(|e| format!("sem conexão: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("o servidor respondeu {}", res.status()));
    }
    let v: Value = res.json().await.map_err(|e| format!("resposta inesperada: {e}"))?;
    if valid_names(&v) { Ok(v) } else { Err("tabela de nomes fora do formato".into()) }
}

/// Download the names table now and then; when it changed, the panel redraws.
pub async fn watch_names(app: AppHandle) {
    if URL.is_empty() {
        return;
    }
    tokio::time::sleep(NAMES_FIRST).await;
    loop {
        match fetch_names().await {
            Ok(v) if Some(&v) != shared_names(app.clone()).as_ref() => {
                if let Some(path) = names_path(&app) {
                    let saved = path.parent().map(std::fs::create_dir_all).transpose().and_then(|_| std::fs::write(&path, v.to_string()));
                    match saved {
                        Ok(()) => {
                            let _ = app.emit("state-changed", ());
                        }
                        Err(e) => crate::log::line(&format!("não deu para guardar os nomes compartilhados: {e}")),
                    }
                }
            }
            Ok(_) => {}
            Err(e) => crate::log::line(&format!("nomes compartilhados: {e}")),
        }
        tokio::time::sleep(NAMES_EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_table_shape() {
        assert!(valid_names(&json!({ "npcs": { "2001234": "Fulano" }, "npc_skills": {}, "skills": {}, "effects": {} })));
        assert!(!valid_names(&json!({ "npcs": { "abc": "Fulano" }, "npc_skills": {}, "skills": {}, "effects": {} })));
        assert!(!valid_names(&json!({ "npcs": { "1": 5 }, "npc_skills": {}, "skills": {}, "effects": {} })));
        assert!(!valid_names(&json!({ "npcs": {} })));
    }
}
