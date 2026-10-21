//! The desktop app: the panel and overlay windows, the saved state, the
//! alarm clock, and live capture of what the game says (`pcap`, read by
//! `kiskwatch_core::dispatch`).

mod gamedata;
mod pcap;
mod profile;
mod state;

use std::sync::Mutex;
use std::time::Duration;

use kiskwatch_core::dispatch::{DispatchStatus, Dispatcher, Segment};
use kiskwatch_core::schedule::{self, Event};
use kiskwatch_core::pets::PetRecord;
use kiskwatch_core::stream::GameEvent;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use state::{FieldBoss, Saved, Settings, SoulSeen};

const EVENTS_JSON: &str = include_str!("../../data/events.json");
const FIELD_BOSSES_JSON: &str = include_str!("../../data/field_bosses.json");

pub struct App {
    saved: Mutex<Saved>,
    capture: std::sync::Arc<Mutex<pcap::CaptureState>>,
    dispatch: Mutex<(DispatchStatus, i64)>,
    events: Vec<Event>,
    field_bosses: std::collections::BTreeMap<u32, FieldBoss>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A row of the timers list: a scheduled event or a field boss.
#[derive(Debug, Clone, Serialize)]
pub struct TimerRow {
    /// The event's id, or `boss:<world-map boss id>`.
    pub id: String,
    /// "event", "boss", "reset" or "field-boss".
    pub kind: String,
    /// Keys into `data/text.json`.
    pub name: String,
    pub also: Vec<String>,
    pub r#where: Vec<String>,
    pub level: Option<u32>,
    /// Field bosses: up now.
    pub up: bool,
    /// When it starts (or a field boss returns), unix ms; None when unknown.
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// The alarm's lead times, in minutes; empty when off.
    pub leads: Vec<u32>,
}

impl App {
    fn new(saved: Saved) -> Self {
        Self {
            saved: Mutex::new(saved),
            capture: Default::default(),
            dispatch: Mutex::new((DispatchStatus { locked: false, server_port: None }, 0)),
            events: serde_json::from_str(EVENTS_JSON).expect("data/events.json"),
            field_bosses: serde_json::from_str::<std::collections::BTreeMap<String, FieldBoss>>(FIELD_BOSSES_JSON)
                .expect("data/field_bosses.json")
                .into_iter()
                .filter_map(|(k, v)| Some((k.parse().ok()?, v)))
                .collect(),
        }
    }

    fn timers(&self, now: i64) -> Vec<TimerRow> {
        let saved = self.saved.lock().unwrap();
        let s = &saved.settings;
        let tz = schedule::region_zone(s.region()).unwrap_or(chrono_tz::UTC);
        let side = s.side();
        let leads = |id: &str| s.alarms.get(id).cloned().unwrap_or_default();
        let mut rows: Vec<TimerRow> = self
            .events
            .iter()
            .filter(|e| e.for_side(side))
            .map(|e| {
                let next = e.next(tz, now);
                TimerRow {
                    id: e.id.clone(),
                    kind: e.kind.clone(),
                    name: e.name.clone(),
                    also: e.also.clone(),
                    r#where: e.r#where.clone(),
                    level: None,
                    up: false,
                    start_ms: next.map(|n| n.start_ms),
                    end_ms: next.map(|n| n.end_ms),
                    leads: leads(&e.id),
                }
            })
            .collect();
        for (&id, boss) in self.field_bosses.iter().filter(|(_, b)| b.side.as_deref().is_none_or(|x| x == side)) {
            let key = format!("boss:{id}");
            let seen = saved.boss(s.server_id, id);
            rows.push(TimerRow {
                id: key.clone(),
                kind: "field-boss".into(),
                name: boss.name.clone(),
                also: vec![],
                r#where: vec![boss.r#where.clone()],
                level: Some(boss.level),
                up: seen.is_some_and(|b| b.up),
                start_ms: seen.filter(|b| !b.up && b.time_ms > 0).map(|b| b.time_ms),
                end_ms: None,
                leads: leads(&key),
            });
        }
        rows.sort_by_key(|r| (r.start_ms.is_none(), r.start_ms.unwrap_or(i64::MAX)));
        rows
    }

    /// Fold what the game said into the saved state; true when it changed.
    fn apply(&self, event: GameEvent) -> bool {
        let mut saved = self.saved.lock().unwrap();
        let server = saved.settings.server_id;
        match event {
            GameEvent::Pets(record) => {
                if let PetRecord::SoulsGained(gains) = &record {
                    let at_ms = now_ms();
                    let souls = saved.souls.entry(server).or_default();
                    souls.extend(gains.iter().map(|g| SoulSeen { pet: g.pet, amount: g.amount, at_ms }));
                    let extra = souls.len().saturating_sub(state::SOULS_KEPT);
                    souls.drain(..extra);
                }
                saved.pets.entry(server).or_default().apply(&record)
            }
            GameEvent::BossMap(map) => {
                // Only the player's own server's maps (the header is 0 there).
                if map.header != 0 {
                    return false;
                }
                saved.boss_maps.entry(server).or_default().insert(map.map_id, map);
            }
        }
        true
    }
}

#[derive(Debug, Clone, Serialize)]
struct Alarm {
    id: String,
    name: String,
    lead: u32,
    start_ms: i64,
}

/// Ring the alarms due since the last tick, once a second.
async fn alarm_clock(app: AppHandle) {
    let mut last = now_ms();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tick.tick().await;
        let now = now_ms();
        let state = app.state::<App>();
        let rows = state.timers(last);
        let tz = {
            let saved = state.saved.lock().unwrap();
            schedule::region_zone(saved.settings.region()).unwrap_or(chrono_tz::UTC)
        };
        for row in rows.iter().filter(|r| !r.leads.is_empty()) {
            let due: Vec<(u32, i64)> = match state.events.iter().find(|e| e.id == row.id) {
                Some(e) => schedule::alarms_due(e, tz, &row.leads, last, now).into_iter().map(|(l, s)| (l, s.start_ms)).collect(),
                // A field boss: its return time, if the map told us.
                None => row
                    .start_ms
                    .map(|start| {
                        row.leads.iter().filter(|&&l| (last + 1..=now).contains(&(start - i64::from(l) * 60_000))).map(|&l| (l, start)).collect()
                    })
                    .unwrap_or_default(),
            };
            for (lead, start_ms) in due {
                let _ = app.emit("alarm", Alarm { id: row.id.clone(), name: row.name.clone(), lead, start_ms });
            }
        }
        last = now;
    }
}

fn save(app: &AppHandle, state: &App) {
    let saved = state.saved.lock().unwrap();
    if let Err(e) = state::store(app, &saved) {
        eprintln!("kiskwatch: could not save state: {e}");
    }
}

#[tauri::command]
fn get_timers(state: State<App>) -> Vec<TimerRow> {
    state.timers(now_ms())
}

#[tauri::command]
fn get_saved(state: State<App>) -> Saved {
    state.saved.lock().unwrap().clone()
}

#[tauri::command]
fn set_settings(app: AppHandle, state: State<App>, settings: Settings) {
    show_overlays(&app, &settings);
    state.saved.lock().unwrap().settings = settings;
    save(&app, &state);
    let _ = app.emit("state-changed", ());
}

#[tauri::command]
fn set_alarm(app: AppHandle, state: State<App>, id: String, leads: Vec<u32>) {
    {
        let mut saved = state.saved.lock().unwrap();
        let leads: Vec<u32> = leads.into_iter().filter(|l| schedule::ALARM_LEADS.contains(l)).collect();
        if leads.is_empty() {
            saved.settings.alarms.remove(&id);
        } else {
            saved.settings.alarms.insert(id, leads);
        }
    }
    save(&app, &state);
    let _ = app.emit("state-changed", ());
}

/// Correct a pet by hand.
#[tauri::command]
fn set_pet(app: AppHandle, state: State<App>, pet: u32, level: u32, points: u32) {
    {
        let mut saved = state.saved.lock().unwrap();
        let server = saved.settings.server_id;
        let p = saved.pets.entry(server).or_default().pets.entry(pet).or_default();
        p.level = level.min(kiskwatch_core::pets::MAX_LEVEL);
        p.points = points;
    }
    save(&app, &state);
    let _ = app.emit("state-changed", ());
}

const OVERLAYS: [&str; 2] = ["overlay", "pets"];

/// Show or hide each overlay as the settings say.
fn show_overlays(app: &AppHandle, s: &Settings) {
    for (label, on) in [("overlay", s.timer_overlay), ("pets", s.pet_overlay)] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = if on { w.show() } else { w.hide() };
        }
    }
}

/// Let clicks pass through the overlays to the game, or take them to move them.
#[tauri::command]
fn set_click_through(app: AppHandle, state: State<App>, on: bool) -> Result<(), String> {
    for label in OVERLAYS {
        if let Some(w) = app.get_webview_window(label) {
            w.set_ignore_cursor_events(on).map_err(|e| e.to_string())?;
        }
    }
    state.saved.lock().unwrap().settings.click_through = on;
    save(&app, &state);
    let _ = app.emit("state-changed", ());
    Ok(())
}

/// The souls gained on the current server, newest last.
#[tauri::command]
fn get_souls(state: State<App>) -> Vec<SoulSeen> {
    let saved = state.saved.lock().unwrap();
    saved.souls.get(&saved.settings.server_id).cloned().unwrap_or_default()
}

/// Characters by name on the official site, on the selected server.
#[tauri::command]
async fn search_characters(state: State<'_, App>, name: String) -> Result<Vec<profile::Hit>, String> {
    let (region, server) = {
        let s = &state.saved.lock().unwrap().settings;
        (s.region(), s.server_id)
    };
    profile::search(region, server, name.trim()).await
}

/// Read a character's public profile and follow it on the Build tab. With no
/// character given, read the followed one again.
#[tauri::command]
async fn load_profile(app: AppHandle, state: State<'_, App>, server_id: Option<u32>, character_id: Option<String>) -> Result<(), String> {
    let (region, server_id, character_id) = {
        let saved = state.saved.lock().unwrap();
        let current = saved.profile.as_ref();
        let server_id = server_id.or(current.map(|p| p.server_id)).ok_or("nenhum personagem escolhido")?;
        let character_id = character_id.or(current.map(|p| p.character_id.clone())).ok_or("nenhum personagem escolhido")?;
        ((server_id / 100) % 10, server_id, character_id)
    };
    let fetched = profile::fetch(region, server_id, &character_id, now_ms()).await?;
    state.saved.lock().unwrap().profile = Some(fetched);
    save(&app, &state);
    let _ = app.emit("state-changed", ());
    Ok(())
}

/// A game data file for the Build tab (see `gamedata`).
#[tauri::command]
async fn game_data(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    gamedata::get(&app, &name).await
}

/// Stop following the character.
#[tauri::command]
fn clear_profile(app: AppHandle, state: State<App>) {
    state.saved.lock().unwrap().profile = None;
    save(&app, &state);
    let _ = app.emit("state-changed", ());
}

#[derive(Debug, Clone, Serialize)]
struct CaptureStatus {
    #[serde(flatten)]
    capture: pcap::CaptureState,
    /// The game's connection has been found.
    locked: bool,
    /// When the game last said something Kiskwatch reads (unix ms; 0: never).
    last_event_ms: i64,
}

#[tauri::command]
fn capture_status(state: State<App>) -> CaptureStatus {
    let capture = state.capture.lock().unwrap().clone();
    let (dispatch, last_event_ms) = *state.dispatch.lock().unwrap();
    CaptureStatus { capture, locked: dispatch.locked, last_event_ms }
}

/// Read captured segments, find the game's connection, and fold in what it says.
fn read_capture(app: AppHandle, segments: std::sync::mpsc::Receiver<Segment>) {
    let mut dispatcher = Dispatcher::new();
    for seg in segments {
        let now = now_ms();
        let events = dispatcher.offer(seg, now);
        let state = app.state::<App>();
        let changed_lock = {
            let mut d = state.dispatch.lock().unwrap();
            let changed = d.0 != dispatcher.status();
            d.0 = dispatcher.status();
            if !events.is_empty() {
                d.1 = now;
            }
            changed
        };
        let changed = events.into_iter().fold(false, |acc, e| state.apply(e) | acc);
        if changed {
            save(&app, &state);
        }
        if changed || changed_lock {
            let _ = app.emit("state-changed", ());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let saved = state::load(app.handle());
            let click_through = saved.settings.click_through;
            show_overlays(app.handle(), &saved.settings);
            app.manage(App::new(saved));
            for label in OVERLAYS {
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.set_ignore_cursor_events(click_through);
                }
            }
            tauri::async_runtime::spawn(alarm_clock(app.handle().clone()));
            let (tx, rx) = std::sync::mpsc::sync_channel(8192);
            pcap::start(tx, app.state::<App>().capture.clone());
            let handle = app.handle().clone();
            std::thread::spawn(move || read_capture(handle, rx));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_timers, get_saved, set_settings, set_alarm, set_pet, set_click_through, get_souls, capture_status, search_characters, load_profile, clear_profile, game_data])
        .run(tauri::generate_context!())
        .expect("error while running Kiskwatch");
}
