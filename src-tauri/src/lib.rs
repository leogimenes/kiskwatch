//! The desktop app: the panel and overlay windows, the saved state, and the
//! alarm clock. What the game says comes in through `ingest` (live capture
//! with Npcap is the next step; until then a recorded stream can be fed in).

mod state;

use std::sync::Mutex;
use std::time::Duration;

use kiskwatch_core::schedule::{self, Event};
use kiskwatch_core::stream::{GameEvent, GameStream};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use state::{FieldBoss, Saved, Settings};

const EVENTS_JSON: &str = include_str!("../../data/events.json");
const FIELD_BOSSES_JSON: &str = include_str!("../../data/field_bosses.json");

pub struct App {
    saved: Mutex<Saved>,
    stream: Mutex<GameStream>,
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
            stream: Mutex::new(GameStream::new()),
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
            GameEvent::Pets(record) => saved.pets.entry(server).or_default().apply(&record),
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

/// Let clicks pass through the overlay to the game, or take them to move it.
#[tauri::command]
fn set_click_through(app: AppHandle, state: State<App>, on: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("overlay") {
        w.set_ignore_cursor_events(on).map_err(|e| e.to_string())?;
    }
    state.saved.lock().unwrap().settings.click_through = on;
    save(&app, &state);
    let _ = app.emit("state-changed", ());
    Ok(())
}

/// Feed server-to-client bytes (hex) as if captured: for recorded streams
/// and testing, until live capture lands.
#[tauri::command]
fn ingest_hex(app: AppHandle, state: State<App>, hex: String) -> Result<usize, String> {
    let clean: String = hex.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if clean.len() % 2 != 0 {
        return Err("odd number of hex digits".into());
    }
    let bytes: Vec<u8> = (0..clean.len()).step_by(2).map(|i| u8::from_str_radix(&clean[i..i + 2], 16).unwrap()).collect();
    let events = state.stream.lock().unwrap().push(&bytes, now_ms());
    let n = events.len();
    let changed = events.into_iter().fold(false, |acc, e| state.apply(e) | acc);
    if changed {
        save(&app, &state);
        let _ = app.emit("state-changed", ());
    }
    Ok(n)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let saved = state::load(app.handle());
            let click_through = saved.settings.click_through;
            app.manage(App::new(saved));
            if let Some(w) = app.get_webview_window("overlay") {
                let _ = w.set_ignore_cursor_events(click_through);
            }
            tauri::async_runtime::spawn(alarm_clock(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_timers, get_saved, set_settings, set_alarm, set_pet, set_click_through, ingest_hex])
        .run(tauri::generate_context!())
        .expect("error while running Kiskwatch");
}
