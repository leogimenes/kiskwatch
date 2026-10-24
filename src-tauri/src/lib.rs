//! The desktop app: the panel and overlay windows, the saved state, the
//! alarm clock, and live capture of what the game says (`pcap`, read by
//! `kiskwatch_core::dispatch`).

mod game;
mod gamedata;
mod hotkeys;
mod log;
mod pcap;
mod profile;
mod share;
mod state;
mod updater;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, AtomicU64, Ordering};
use std::time::Duration;

use kiskwatch_core::checklist::{Character, Checklist, Resets, Task};
use kiskwatch_core::dispatch::{DispatchStatus, Dispatcher, Segment};
use kiskwatch_core::dps::{Fight, Meter, Start};
use kiskwatch_core::schedule::{self, Event};
use kiskwatch_core::pets::{self, Pace, PetRecord};
use kiskwatch_core::stream::GameEvent;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use state::{FieldBoss, Hotkeys, Saved, Settings, SoulSeen};

const EVENTS_JSON: &str = include_str!("../../data/events.json");
const FIELD_BOSSES_JSON: &str = include_str!("../../data/field_bosses.json");

pub struct App {
    /// AION2.exe is running.
    game_running: AtomicBool,
    /// The game, or Kiskwatch, is in front (see `watch_focus`).
    game_focused: AtomicBool,
    /// The game's window, the last time it was in front; 0 before.
    game_window: AtomicIsize,
    /// Until when a timer's reminder shows (unix ms; see `remind`).
    reminder_until: AtomicI64,
    saved: Mutex<Saved>,
    capture: std::sync::Arc<Mutex<pcap::CaptureState>>,
    dispatch: Mutex<(DispatchStatus, i64)>,
    events: Vec<Event>,
    field_bosses: std::collections::BTreeMap<u32, FieldBoss>,
    /// The DPS tracker.
    meter: Mutex<Meter>,
    /// Why a global shortcut isn't working, if one isn't.
    hotkey_error: Mutex<Option<String>>,
    /// Item level and combat power of the players on the DPS bars.
    gear: Mutex<kiskwatch_core::gear::Lookups>,
    /// A newer release, and how installing it goes.
    update: Mutex<updater::Status>,
    /// The overlay a step of the panel's guided tour shows, whatever the
    /// settings say (see `tour_overlay`).
    tour_overlay: Mutex<Option<String>>,
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
            game_running: AtomicBool::new(game::running()),
            game_focused: AtomicBool::new(true),
            game_window: AtomicIsize::new(0),
            reminder_until: AtomicI64::new(0),
            saved: Mutex::new(saved),
            capture: Default::default(),
            dispatch: Mutex::new((DispatchStatus { locked: false, server_port: None }, 0)),
            events: serde_json::from_str(EVENTS_JSON).expect("data/events.json"),
            field_bosses: serde_json::from_str::<std::collections::BTreeMap<String, FieldBoss>>(FIELD_BOSSES_JSON)
                .expect("data/field_bosses.json")
                .into_iter()
                .filter_map(|(k, v)| Some((k.parse().ok()?, v)))
                .collect(),
            meter: Mutex::new(Meter::new(kiskwatch_core::combat::boss_codes())),
            hotkey_error: Mutex::new(None),
            gear: Default::default(),
            update: Default::default(),
            tour_overlay: Mutex::new(None),
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

    /// When the daily and weekly resets last came.
    fn resets(&self, now: i64) -> Resets {
        let region = self.saved.lock().unwrap().settings.region();
        let tz = schedule::region_zone(region).unwrap_or(chrono_tz::UTC);
        let last = |id: &str| self.events.iter().find(|e| e.id == id).and_then(|e| e.last_start(tz, now)).unwrap_or(0);
        Resets { daily_ms: last("daily"), weekly_ms: last("weekly") }
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
                saved.pets.entry(server).or_default().apply(&record);
                let collection = saved.pets[&server].clone();
                saved.pet_queue.entry(server).or_default().apply(&record, &collection);
            }
            // The meter's (see `read_capture`).
            GameEvent::Combat(_) | GameEvent::Effect(_) | GameEvent::Zone(_) => return false,
            // The dungeon diagnostic: straight to the log.
            GameEvent::Log(line) => {
                log::line(&line);
                return false;
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
                remind(&app);
            }
        }
        last = now;
    }
}

/// The reminder window, at the top of the game's: hidden but while an alarm
/// rings, for as long as the settings keep an alarm on the screen.
const REMINDER: &str = "overlay";

/// Show the reminder for an alarm just rung, at the top of the game's window,
/// and hide it once its time is up.
fn remind(app: &AppHandle) {
    let state = app.state::<App>();
    let (on, seconds) = {
        let saved = state.saved.lock().unwrap();
        (saved.settings.timer_overlay, saved.settings.a11y.alert_seconds.max(1))
    };
    if !on {
        return;
    }
    let until = now_ms() + i64::from(seconds) * 1000;
    state.reminder_until.store(until, Ordering::Relaxed);
    place_reminder(app);
    show_overlays_now(app);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(u64::from(seconds)) + Duration::from_millis(200));
        // A later alarm keeps it up longer.
        if app.state::<App>().reminder_until.load(Ordering::Relaxed) <= now_ms() {
            show_overlays_now(&app);
        }
    });
}

/// Put the reminder at the top middle of the game's window, or of the screen
/// while the game hasn't been in front yet.
fn place_reminder(app: &AppHandle) {
    let Some(w) = app.get_webview_window(REMINDER) else { return };
    let Ok(size) = w.outer_size() else { return };
    place_reminder_sized(app, &w, size.width);
}

/// `place_reminder`, for a window this wide (in pixels) or about to be.
fn place_reminder_sized(app: &AppHandle, w: &tauri::WebviewWindow, width_px: u32) {
    let hwnd = app.state::<App>().game_window.load(Ordering::Relaxed);
    let area = (hwnd != 0).then(|| game::client_area(hwnd)).flatten().or_else(|| {
        let m = w.current_monitor().ok().flatten().or_else(|| w.primary_monitor().ok().flatten())?;
        Some((m.position().x, m.position().y, m.size().width))
    });
    if let Some((left, top, width)) = area {
        let x = left + (i64::from(width) - i64::from(width_px)).max(0) as i32 / 2;
        let _ = w.set_position(tauri::PhysicalPosition::new(x, top + REMINDER_MARGIN));
    }
}

/// How far below the top of the game's window the reminder sits, in pixels.
const REMINDER_MARGIN: i32 = 12;

/// The reminder's whole size (tauri.conf.json), in logical pixels: room for
/// the tour's note.
const REMINDER_SIZE: (f64, f64) = (480.0, 140.0);

#[derive(Debug, Clone, Copy, Deserialize)]
struct ReminderSize {
    width: f64,
    height: f64,
}

/// The reminder as big as what it shows (`None`: its whole size), so it takes
/// no clicks off the game around it, and back at the top middle.
#[tauri::command]
fn reminder_fit(app: AppHandle, size: Option<ReminderSize>) {
    let Some(w) = app.get_webview_window(REMINDER) else { return };
    let (width, height) = size
        .filter(|s| s.width.is_finite() && s.height.is_finite())
        // Up to twice the whole size: the look's zoom makes it bigger.
        .map(|s| (s.width.clamp(40.0, 2.0 * REMINDER_SIZE.0), s.height.clamp(20.0, 2.0 * REMINDER_SIZE.1)))
        .unwrap_or(REMINDER_SIZE);
    let scale = w.scale_factor().unwrap_or(1.0);
    let px = tauri::PhysicalSize::new((width * scale).round() as u32, (height * scale).round() as u32);
    let _ = w.set_size(px);
    place_reminder_sized(&app, &w, px.width);
    // Changing the window hides it (see `show_overlays`).
    show_overlays_now(&app);
}

/// The ×, on the last reminder showing: it goes before its time.
#[tauri::command]
fn reminder_close(app: AppHandle, state: State<App>) {
    state.reminder_until.store(0, Ordering::Relaxed);
    show_overlays_now(&app);
}

pub(crate) fn save(app: &AppHandle, state: &App) {
    let saved = state.saved.lock().unwrap();
    if let Err(e) = state::store(app, &saved) {
        log::line(&format!("não deu para salvar o estado: {e}"));
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
fn set_settings(app: AppHandle, state: State<App>, mut settings: Settings) {
    show_overlays(&app, &settings);
    {
        let mut saved = state.saved.lock().unwrap();
        // These have their own commands, and a shortcut may have changed
        // them since the window sending these settings last read them.
        settings.click_through = saved.settings.click_through;
        settings.hotkeys = saved.settings.hotkeys.clone();
        // Turning the pets overlay off ends the farming session it follows.
        if saved.settings.pet_overlay && !settings.pet_overlay {
            saved.pet_queue.remove(&settings.server_id);
        }
        saved.settings = settings;
    }
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

/// The overlays one can move (the reminder places itself).
const OVERLAYS: [&str; 2] = ["pets", "dps"];

/// Show or hide each overlay as the settings say, and with the game running
/// and in front.
fn show_overlays(app: &AppHandle, s: &Settings) {
    let state = app.state::<App>();
    let game_ok = state.game_running.load(Ordering::Relaxed) || !s.overlays_with_game;
    let focus_ok = state.game_focused.load(Ordering::Relaxed) || !s.overlays_with_focus;
    let reminding = state.reminder_until.load(Ordering::Relaxed) > now_ms();
    let tour = state.tour_overlay.lock().unwrap().clone();
    let wanted = [(REMINDER, s.timer_overlay && reminding), ("pets", s.pet_overlay), ("dps", s.dps.overlay)]
        .map(|(label, on)| (label, (on && game_ok && focus_ok) || tour.as_deref() == Some(label)));
    // On the main thread, after any change to the windows already asked for,
    // since Tauri hides them again on those (see `game::show_window`).
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        for (label, on) in wanted {
            if let Some(w) = handle.get_webview_window(label) {
                game::show_window(&w, on);
            }
        }
    });
}

/// Bring the panel to the front.
fn show_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("panel") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// An overlay's gear: the panel comes to the front on that overlay's settings.
#[tauri::command]
fn open_settings(app: AppHandle, overlay: String) {
    show_panel(&app);
    let _ = app.emit_to("panel", "open-settings", overlay);
}

/// A step of the panel's guided tour about an overlay: it shows, with a note
/// on it saying what it is. `None` ends that, back to what the settings say.
#[tauri::command]
fn tour_overlay(app: AppHandle, state: State<App>, overlay: Option<String>, note: Option<String>) {
    let overlay = overlay.filter(|o| [REMINDER, "pets", "dps"].contains(&o.as_str()));
    let before = std::mem::replace(&mut *state.tour_overlay.lock().unwrap(), overlay.clone());
    if let Some(label) = before.filter(|b| Some(b) != overlay.as_ref()) {
        let _ = app.emit_to(label.as_str(), "tour-note", None::<String>);
    }
    if let Some(label) = &overlay {
        if label == REMINDER {
            place_reminder(&app);
        }
        let _ = app.emit_to(label.as_str(), "tour-note", note);
    }
    show_overlays_now(&app);
}

/// The help window, on one topic (a panel tab or an overlay); one window,
/// made the first time.
#[tauri::command]
async fn open_help(app: AppHandle, mut topic: String) -> Result<(), String> {
    topic.retain(|c| c.is_ascii_alphanumeric() || c == '-');
    if let Some(w) = app.get_webview_window(HELP) {
        let _ = app.emit_to(HELP, "help-topic", &topic);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, HELP, tauri::WebviewUrl::App(format!("help.html#{topic}").into()))
        .title("Kiskwatch ajuda")
        .inner_size(560.0, 640.0)
        .min_inner_size(380.0, 320.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

const HELP: &str = "help";

/// The help window's "Ver o tour": the panel comes up and runs that tab's tour.
#[tauri::command]
fn open_tour(app: AppHandle, tab: String) {
    show_panel(&app);
    let _ = app.emit_to("panel", "start-tour", tab);
}

fn show_overlays_now(app: &AppHandle) {
    let settings = app.state::<App>().saved.lock().unwrap().settings.clone();
    show_overlays(app, &settings);
}

/// What is kept of each window between runs and new versions: where it is and
/// its size. Not whether it shows, which the settings decide (`show_overlays`).
const WINDOW_FLAGS: StateFlags = StateFlags::POSITION.union(StateFlags::SIZE).union(StateFlags::MAXIMIZED);

/// The DPS overlay's default width (tauri.conf.json), wide enough for a name,
/// its GS and CP, and the numbers on one line.
const DPS_WIDTH: f64 = 460.0;

/// Once: widen a DPS overlay kept narrower than `DPS_WIDTH` from before, when
/// the default was 340 and the bars cut the names short. Its size is saved
/// between runs, so the new default alone never reached it.
fn widen_dps(app: &AppHandle, saved: &mut state::Saved) {
    if saved.dps_widened {
        return;
    }
    saved.dps_widened = true;
    let Some(w) = app.get_webview_window("dps") else { return };
    let (Ok(size), Ok(scale)) = (w.inner_size(), w.scale_factor()) else { return };
    let size = size.to_logical::<f64>(scale);
    if size.width < DPS_WIDTH {
        let _ = w.set_size(tauri::LogicalSize::new(DPS_WIDTH, size.height));
        log::line("overlay de DPS alargado para a nova largura padrão");
    }
}

/// Bumped on every move or resize; a save waits for it to settle.
static WINDOW_MOVES: AtomicU64 = AtomicU64::new(0);

/// Save where the windows are a second after one stops moving. The plugin
/// only saves on a clean exit, and an installer closing the app for a new
/// version doesn't always give it one.
fn save_windows_soon(app: &AppHandle) {
    let ticket = WINDOW_MOVES.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(1));
        if WINDOW_MOVES.load(Ordering::Relaxed) == ticket {
            save_windows(&app);
        }
    });
}

/// On the main thread: the plugin holds its lock while asking each window
/// where it is, and from another thread that question waits for the main
/// thread, which waits for the same lock on any move or resize there. The two
/// froze each other.
pub(crate) fn save_windows(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = handle.save_window_state(WINDOW_FLAGS) {
            log::line(&format!("não deu para salvar a posição das janelas: {e}"));
        }
    });
}

/// Follow the game starting and quitting, and the overlays with it.
fn watch_game(app: AppHandle) {
    let mut watcher = game::Watcher::new();
    loop {
        std::thread::sleep(Duration::from_secs(3));
        let running = watcher.running();
        let state = app.state::<App>();
        if state.game_running.swap(running, Ordering::Relaxed) != running {
            show_overlays_now(&app);
            let _ = app.emit("state-changed", ());
        }
    }
}

/// Follow the window in front: the overlays show over the game and while
/// using Kiskwatch (to move them, or from the panel), not over other programs.
fn watch_focus(app: AppHandle) {
    let mut fg = game::Foreground::new();
    loop {
        std::thread::sleep(Duration::from_millis(250));
        // No window in front, as while switching: keep what we had.
        let Some(front) = fg.front() else { continue };
        let focused = front != game::Front::Other;
        let state = app.state::<App>();
        if let Some(hwnd) = fg.game_window() {
            // The game moved to another window or screen: the reminder follows.
            if state.game_window.swap(hwnd, Ordering::Relaxed) != hwnd && state.reminder_until.load(Ordering::Relaxed) > now_ms() {
                place_reminder(&app);
                show_overlays_now(&app);
            }
        }
        if state.game_focused.swap(focused, Ordering::Relaxed) != focused {
            show_overlays_now(&app);
        }
    }
}

/// Whether the game is running, for the panel.
#[tauri::command]
fn game_running(state: State<App>) -> bool {
    state.game_running.load(Ordering::Relaxed)
}

/// Let clicks pass through the overlays to the game, or take them to move them.
fn click_through(app: &AppHandle, state: &App, on: bool) -> Result<(), String> {
    for label in OVERLAYS {
        if let Some(w) = app.get_webview_window(label) {
            w.set_ignore_cursor_events(on).map_err(|e| e.to_string())?;
        }
    }
    state.saved.lock().unwrap().settings.click_through = on;
    // Changing the windows hides them (see `show_overlays`).
    show_overlays_now(app);
    save(app, state);
    let _ = app.emit("state-changed", ());
    Ok(())
}

#[tauri::command]
fn set_click_through(app: AppHandle, state: State<App>, on: bool) -> Result<(), String> {
    click_through(&app, &state, on)
}

/// Change the global shortcuts. Nothing changes if one can't be used.
#[tauri::command]
fn set_hotkeys(app: AppHandle, state: State<App>, hotkeys: Hotkeys) -> Result<(), String> {
    let before = state.saved.lock().unwrap().settings.hotkeys.clone();
    if let Err(e) = hotkeys::register(&app, &hotkeys) {
        *state.hotkey_error.lock().unwrap() = hotkeys::register(&app, &before).err();
        return Err(e);
    }
    *state.hotkey_error.lock().unwrap() = None;
    state.saved.lock().unwrap().settings.hotkeys = hotkeys;
    save(&app, &state);
    let _ = app.emit("state-changed", ());
    Ok(())
}

/// Let go of the shortcuts while the panel waits for a new key, so pressing
/// one there doesn't set it off; then take them back.
#[tauri::command]
fn pause_hotkeys(app: AppHandle, state: State<App>, paused: bool) -> Result<(), String> {
    if paused {
        hotkeys::release(&app);
        Ok(())
    } else {
        let keys = state.saved.lock().unwrap().settings.hotkeys.clone();
        let result = hotkeys::register(&app, &keys);
        *state.hotkey_error.lock().unwrap() = result.clone().err();
        result
    }
}

/// Why a global shortcut isn't working, if one isn't.
#[tauri::command]
fn hotkeys_status(state: State<App>) -> Option<String> {
    state.hotkey_error.lock().unwrap().clone()
}

/// A short note for what a shortcut just did, on one overlay: the first of
/// `windows` that is showing.
fn toast(app: &AppHandle, windows: &[&str], text: &str) {
    let shown = windows.iter().find(|l| app.get_webview_window(l).is_some_and(|w| w.is_visible().unwrap_or(false)));
    if let Some(label) = shown {
        let _ = app.emit_to(*label, "toast", text);
    }
}

/// A global shortcut was pressed.
fn on_hotkey(app: &AppHandle, action: hotkeys::Action) {
    let state = app.state::<App>();
    match action {
        hotkeys::Action::ClickThrough => {
            let on = !state.saved.lock().unwrap().settings.click_through;
            match click_through(app, &state, on) {
                Ok(()) => toast(app, &["dps", "pets"], if on { "Cliques passam para o jogo" } else { "Overlays podem ser movidos" }),
                Err(e) => toast(app, &["dps", "pets"], &format!("Não deu para mudar os cliques: {e}")),
            }
        }
        hotkeys::Action::Dps => {
            let recording = state.meter.lock().unwrap().current(now_ms()).is_some();
            if recording {
                dps_end(app, &state);
                toast(app, &["dps", "pets"], "DPS: gravação parada");
            } else {
                dps_begin(app, &state);
                toast(app, &["dps", "pets"], "DPS: gravando");
            }
        }
        hotkeys::Action::DpsOverlay => {
            // The same setting as the panel's checkbox, so the rules on when
            // the overlays show (game open, in front) still hold.
            let on = {
                let mut saved = state.saved.lock().unwrap();
                saved.settings.dps.overlay = !saved.settings.dps.overlay;
                saved.settings.dps.overlay
            };
            show_overlays_now(app);
            save(app, &state);
            let _ = app.emit("state-changed", ());
            if on {
                // It shows a moment from now, on the main thread.
                let _ = app.emit_to("dps", "toast", "Overlay de DPS visível");
            } else {
                toast(app, &["pets"], "Overlay de DPS escondido");
            }
        }
    }
}

/// The souls gained on the current server, newest last.
#[tauri::command]
fn get_souls(state: State<App>) -> Vec<SoulSeen> {
    let saved = state.saved.lock().unwrap();
    saved.souls.get(&saved.settings.server_id).cloned().unwrap_or_default()
}

/// The farming pace of each pet with a timed run on the current server.
#[tauri::command]
fn get_paces(state: State<App>) -> Vec<Pace> {
    let saved = state.saved.lock().unwrap();
    let server = saved.settings.server_id;
    let mut by_pet: std::collections::BTreeMap<u32, Vec<(i64, u32)>> = Default::default();
    for s in saved.souls.get(&server).into_iter().flatten() {
        by_pet.entry(s.pet).or_default().push((s.at_ms, s.amount));
    }
    let collection = saved.pets.get(&server).cloned().unwrap_or_default();
    by_pet.iter().filter_map(|(&pet, pickups)| pets::pace(pet, pickups, collection.get(pet))).collect()
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
    let mut fetched = profile::fetch(region, server_id, &character_id, now_ms()).await?;
    let mut saved = state.saved.lock().unwrap();
    fetched.file_preset(saved.profile.as_ref());
    saved.profile = Some(fetched);
    drop(saved);
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

/// The user says the profile's read is skill preset `n`.
#[tauri::command]
fn move_preset(app: AppHandle, state: State<App>, n: u8) {
    if let Some(p) = state.saved.lock().unwrap().profile.as_mut() {
        p.presets.move_to(n);
    }
    save(&app, &state);
    let _ = app.emit("state-changed", ());
}

/// Drops a skill preset kept from an earlier read.
#[tauri::command]
fn forget_preset(app: AppHandle, state: State<App>, n: u8) {
    if let Some(p) = state.saved.lock().unwrap().profile.as_mut() {
        p.presets.forget(n);
    }
    save(&app, &state);
    let _ = app.emit("state-changed", ());
}

/// The players the game named around you in the last half hour.
#[tauri::command]
fn nearby_players(state: State<App>) -> Vec<kiskwatch_core::dps::SeenPlayer> {
    state.meter.lock().unwrap().roster(now_ms() - 30 * 60_000)
}

/// A player by name on the official site, anywhere in your region.
#[tauri::command]
async fn find_player(state: State<'_, App>, name: String) -> Result<Vec<profile::Hit>, String> {
    let (region, server) = {
        let s = &state.saved.lock().unwrap().settings;
        (s.region(), s.server_id)
    };
    profile::find(region, server, name.trim()).await
}

/// Someone's public profile, to look at and compare; not followed.
#[tauri::command]
async fn inspect_profile(server_id: u32, character_id: String) -> Result<profile::Profile, String> {
    profile::fetch((server_id / 100) % 10, server_id, &character_id, now_ms()).await
}

/// Item level and combat power of these players, as far as known; the ones
/// not known yet are looked up on the official site, and `gear-changed` says
/// when an answer changes what a bar shows.
#[tauri::command]
fn player_gear(app: AppHandle, state: State<App>, names: Vec<String>) -> Vec<kiskwatch_core::gear::Gear> {
    let (region, server) = {
        let s = &state.saved.lock().unwrap().settings;
        (s.region(), s.server_id)
    };
    if profile::shard(region).is_none() {
        return Vec::new();
    }
    let (known, start) = state.gear.lock().unwrap().ask(&names, now_ms());
    for name in start {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let found = profile::gear(region, server, &name).await;
            if app.state::<App>().gear.lock().unwrap().done(&name, found, now_ms()) {
                let _ = app.emit("gear-changed", ());
            }
        });
    }
    known
}

fn clip_label(label: &str) -> String {
    label.trim().chars().take(state::LABEL_MAX).collect()
}

/// Keep a build to compare against.
#[tauri::command]
fn save_reference(app: AppHandle, state: State<App>, profile: profile::Profile, label: String) -> String {
    let id = now_ms().to_string();
    let label = Some(clip_label(&label)).filter(|l| !l.is_empty()).unwrap_or_else(|| profile.name.clone());
    {
        let mut saved = state.saved.lock().unwrap();
        saved.references.insert(0, state::Reference { id: id.clone(), label, profile });
        saved.references.truncate(state::REFERENCES_KEPT);
    }
    save(&app, &state);
    let _ = app.emit("state-changed", ());
    id
}

#[tauri::command]
fn rename_reference(app: AppHandle, state: State<App>, id: String, label: String) {
    let label = clip_label(&label);
    if label.is_empty() {
        return;
    }
    if let Some(r) = state.saved.lock().unwrap().references.iter_mut().find(|r| r.id == id) {
        r.label = label;
    }
    save(&app, &state);
    let _ = app.emit("state-changed", ());
}

#[tauri::command]
fn delete_reference(app: AppHandle, state: State<App>, id: String) {
    state.saved.lock().unwrap().references.retain(|r| r.id != id);
    save(&app, &state);
    let _ = app.emit("state-changed", ());
}

/// A recording's default name: your character, the date and a random tag.
fn fight_name(state: &App, me: Option<&str>) -> String {
    use std::hash::{BuildHasher, Hasher};
    let who = me.map(str::to_string).or_else(|| state.saved.lock().unwrap().profile.as_ref().map(|p| p.name.clone())).filter(|n| !n.is_empty());
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_i64(now_ms());
    let tag: String = (0..3).map(|i| b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[((h.finish() >> (i * 5)) & 31) as usize] as char).collect();
    let when = chrono::Local::now().format("%d/%m %H:%M");
    format!("{} {when} #{tag}", who.as_deref().unwrap_or("Luta"))
}

/// Keep a finished recording.
fn keep_fight(app: &AppHandle, state: &App, fight: Fight) {
    {
        let mut saved = state.saved.lock().unwrap();
        saved.fights.retain(|f| f.id != fight.id);
        saved.fights.insert(0, fight);
        saved.fights.truncate(state::FIGHTS_KEPT);
    }
    save(app, state);
    let _ = app.emit("dps-changed", ());
}

/// End automatic recordings once the fighting stops.
fn dps_clock(app: AppHandle) {
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let state = app.state::<App>();
        let ended = state.meter.lock().unwrap().tick(now_ms());
        if let Some(fight) = ended {
            keep_fight(&app, &state, fight);
        }
    }
}

/// The recording under way, if any.
#[tauri::command]
fn dps_live(state: State<App>) -> Option<Fight> {
    state.meter.lock().unwrap().current(now_ms())
}

fn dps_begin(app: &AppHandle, state: &App) {
    let me = state.meter.lock().unwrap().my_name().map(str::to_string);
    let name = fight_name(state, me.as_deref());
    state.meter.lock().unwrap().start(name, now_ms());
    let _ = app.emit("dps-changed", ());
}

fn dps_end(app: &AppHandle, state: &App) {
    let fight = state.meter.lock().unwrap().stop(now_ms());
    match fight {
        Some(fight) => keep_fight(app, state, fight),
        None => {
            let _ = app.emit("dps-changed", ());
        }
    }
}

#[tauri::command]
fn dps_start(app: AppHandle, state: State<App>) {
    dps_begin(&app, &state);
}

#[tauri::command]
fn dps_stop(app: AppHandle, state: State<App>) {
    dps_end(&app, &state);
}

/// Clear the DPS overlay: the recording under way starts over, unsaved, and
/// the last saved one stops showing (it stays in the panel).
#[tauri::command]
fn dps_clear(app: AppHandle, state: State<App>) {
    let now = now_ms();
    state.meter.lock().unwrap().clear(now);
    state.saved.lock().unwrap().dps_cleared_ms = now;
    save(&app, &state);
    let _ = app.emit("dps-changed", ());
}

/// Rename a recording: the one under way, or a saved one by id.
#[tauri::command]
fn dps_rename(app: AppHandle, state: State<App>, id: Option<String>, name: String) {
    let name = kiskwatch_core::dps::clip_name(&name);
    if name.is_empty() {
        return;
    }
    match id {
        None => state.meter.lock().unwrap().rename(&name),
        Some(id) => {
            if let Some(f) = state.saved.lock().unwrap().fights.iter_mut().find(|f| f.id == id) {
                f.name = name;
            }
            save(&app, &state);
        }
    }
    let _ = app.emit("dps-changed", ());
}

#[tauri::command]
fn dps_delete(app: AppHandle, state: State<App>, id: String) {
    state.saved.lock().unwrap().fights.retain(|f| f.id != id);
    save(&app, &state);
    let _ = app.emit("dps-changed", ());
}

/// Every saved recording, grouped by the boss each was against.
#[tauri::command]
fn boss_history(state: State<App>) -> Vec<kiskwatch_core::history::BossHistory> {
    kiskwatch_core::history::by_boss(&state.saved.lock().unwrap().fights)
}

/// A saved recording against your best one against the same boss.
#[tauri::command]
fn dps_compare(state: State<App>, id: String) -> Option<kiskwatch_core::history::Comparison> {
    let saved = state.saved.lock().unwrap();
    let fight = saved.fights.iter().find(|f| f.id == id)?;
    kiskwatch_core::history::compare(fight, &saved.fights)
}

/// Save a recording's image (drawn by the panel) to Pictures/Kiskwatch, under
/// the recording's name; returns where it went.
#[tauri::command]
fn dps_save_image(app: AppHandle, name: String, png: Vec<u8>) -> Result<String, String> {
    let dir = app.path().picture_dir().or_else(|_| app.path().download_dir()).map_err(|e| e.to_string())?.join("Kiskwatch");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.png", kiskwatch_core::dps::file_name(&name)));
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// The checklist with what counts this period.
#[derive(Debug, Clone, Serialize)]
struct ChecklistView {
    #[serde(flatten)]
    list: Checklist,
    /// Times done by character id, then task id; only those above 0.
    counts: std::collections::BTreeMap<String, std::collections::BTreeMap<String, u32>>,
    resets: Resets,
    /// Names to offer for a new character: the Build tab's and yours in the
    /// DPS meter.
    known: Vec<String>,
}

#[tauri::command]
fn get_checklist(state: State<App>) -> ChecklistView {
    let resets = state.resets(now_ms());
    let me = state.meter.lock().unwrap().my_name().map(str::to_string);
    let saved = state.saved.lock().unwrap();
    let list = saved.checklist.clone();
    let counts = list
        .characters
        .iter()
        .map(|c| {
            let done = list.tasks.iter().map(|t| (t.id.clone(), list.count(&c.id, &t.id, resets))).filter(|(_, n)| *n > 0).collect();
            (c.id.clone(), done)
        })
        .collect();
    let mut known: Vec<String> = saved.profile.as_ref().map(|p| p.name.clone()).into_iter().chain(me).filter(|n| !n.is_empty()).collect();
    known.dedup();
    known.retain(|n| !list.characters.iter().any(|c| &c.name == n));
    ChecklistView { list, counts, resets, known }
}

/// Set how many times a character did a task this period.
#[tauri::command]
fn checklist_mark(app: AppHandle, state: State<App>, character: String, task: String, count: u32) {
    let now = now_ms();
    let resets = state.resets(now);
    state.saved.lock().unwrap().checklist.mark(&character, &task, count, now, resets);
    save(&app, &state);
    let _ = app.emit("checklist-changed", ());
}

/// Change the tasks and characters.
#[tauri::command]
fn checklist_edit(app: AppHandle, state: State<App>, tasks: Vec<Task>, characters: Vec<Character>) {
    let resets = state.resets(now_ms());
    state.saved.lock().unwrap().checklist.edit(tasks, characters, resets);
    save(&app, &state);
    let _ = app.emit("checklist-changed", ());
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
        let (combat, events): (Vec<_>, Vec<_>) = events.into_iter().partition(|e| matches!(e, GameEvent::Combat(_) | GameEvent::Effect(_) | GameEvent::Zone(_)));
        if !combat.is_empty() {
            let start = Start::from_setting(&state.saved.lock().unwrap().settings.dps.start);
            let mut ended = Vec::new();
            let mut started = false;
            {
                let mut meter = state.meter.lock().unwrap();
                for e in combat {
                    match e {
                        GameEvent::Combat(e) => started |= meter.apply(e, now, start, |me| fight_name(&state, me)),
                        GameEvent::Effect(e) => meter.apply_effect(e, now),
                        GameEvent::Zone(z) => {
                            ended.extend(meter.enter(z, now, start, |me| fight_name(&state, me)));
                            started |= meter.recording();
                        }
                        _ => {}
                    }
                }
            }
            for fight in ended {
                keep_fight(&app, &state, fight);
            }
            if started {
                let _ = app.emit("dps-changed", ());
            }
        }
        let changed = events.into_iter().fold(false, |acc, e| state.apply(e) | acc);
        if changed {
            save(&app, &state);
        }
        if changed || changed_lock {
            let _ = app.emit("state-changed", ());
        }
    }
}

#[tauri::command]
fn update_status(app: AppHandle) -> updater::Status {
    updater::status(&app)
}

#[tauri::command]
async fn update_check(app: AppHandle) -> Result<updater::Status, String> {
    Ok(updater::check(&app).await)
}

/// Download the newer release, check its SHA-256 and install it; Kiskwatch
/// quits for the installer and comes back on the new version.
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    updater::install(&app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log::catch_panics();
    log::line(&format!("Kiskwatch {} abrindo", env!("CARGO_PKG_VERSION")));
    let app = tauri::Builder::default()
        // One Kiskwatch at a time: opening it again brings the panel up instead
        // of a second set of overlays over the first.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            log::line("aberto de novo: o painel vem para a frente");
            show_panel(app);
        }))
        .plugin(tauri_plugin_opener::init())
        // Windows go back where they were, from the app's config folder in
        // AppData, which installing a new version leaves alone.
        .plugin(tauri_plugin_window_state::Builder::new().with_state_flags(WINDOW_FLAGS).with_denylist(&[REMINDER]).build())
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => save_windows_soon(window.app_handle()),
            // Closing the panel quits Kiskwatch. Tauri only quits once every
            // window is closed, and the hidden overlays kept it running with
            // nothing on the screen; opening it again then only reached that
            // one (see the single instance plugin) and nothing showed.
            WindowEvent::CloseRequested { .. } if window.label() == "panel" => {
                log::line("painel fechado");
                window.app_handle().exit(0);
            }
            _ => {}
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    let keys = app.state::<App>().saved.lock().unwrap().settings.hotkeys.clone();
                    if let Some(action) = hotkeys::action(&keys, shortcut) {
                        on_hotkey(app, action);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let mut saved = state::load(app.handle());
            saved.settings.hotkeys.migrate();
            let widen = !saved.dps_widened;
            widen_dps(app.handle(), &mut saved);
            let click_through = saved.settings.click_through;
            let keys = saved.settings.hotkeys.clone();
            app.manage(App::new(saved));
            if widen {
                save(app.handle(), &app.state::<App>());
            }
            for label in OVERLAYS {
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.set_ignore_cursor_events(click_through);
                }
            }
            show_overlays_now(app.handle());
            let handle = app.handle().clone();
            std::thread::spawn(move || watch_game(handle));
            let handle = app.handle().clone();
            std::thread::spawn(move || watch_focus(handle));
            // A shortcut taken by another program leaves the others working;
            // the panel says which (see `hotkeys_status`).
            *app.state::<App>().hotkey_error.lock().unwrap() = hotkeys::register(app.handle(), &keys).err();
            tauri::async_runtime::spawn(alarm_clock(app.handle().clone()));
            let (tx, rx) = std::sync::mpsc::sync_channel(8192);
            pcap::start(tx, app.state::<App>().capture.clone());
            let handle = app.handle().clone();
            std::thread::spawn(move || read_capture(handle, rx));
            let handle = app.handle().clone();
            std::thread::spawn(move || dps_clock(handle));
            tauri::async_runtime::spawn(updater::watch(app.handle().clone()));
            log::line("pronto");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_timers, get_saved, set_settings, set_alarm, set_pet, set_click_through, set_hotkeys, pause_hotkeys, hotkeys_status, get_souls, get_paces, capture_status, game_running, search_characters, load_profile, clear_profile, move_preset, forget_preset, game_data, dps_live, dps_start, dps_stop, dps_clear, dps_rename, dps_delete, boss_history, dps_compare, dps_save_image, nearby_players, find_player, inspect_profile, player_gear, save_reference, rename_reference, delete_reference, get_checklist, checklist_mark, checklist_edit, update_status, update_check, update_install, open_settings, tour_overlay, reminder_fit, reminder_close, open_help, open_tour, share::share_status, share::share_mode, share::share_send])
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            log::line(&format!("não abriu: {e}"));
            panic!("error while building Kiskwatch: {e}");
        }
    };
    app.run(|_, event| {
        if let tauri::RunEvent::Exit = event {
            log::line("fechando");
        }
    });
}
