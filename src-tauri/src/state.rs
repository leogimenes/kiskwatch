//! What Kiskwatch keeps between runs, in `state.json` in the app's data folder.

use std::collections::BTreeMap;
use std::path::PathBuf;

use kiskwatch_core::boss_map::{BossMap, BossOnMap};
use kiskwatch_core::pets::PetCollection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Ariel, South America (Elyos).
pub const DEFAULT_SERVER: u32 = 1406;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// The game's server id: first digit the side, second the region.
    pub server_id: u32,
    /// Alarm lead times (minutes) by timer id.
    pub alarms: BTreeMap<String, Vec<u32>>,
    pub click_through: bool,
    /// Show the timers overlay, and the pets overlay.
    pub timer_overlay: bool,
    pub pet_overlay: bool,
    /// The pets kept on the pets overlay, in the order pinned.
    pub pinned_pets: Vec<u32>,
    pub a11y: Accessibility,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server_id: DEFAULT_SERVER,
            alarms: BTreeMap::new(),
            click_through: false,
            timer_overlay: true,
            pet_overlay: false,
            pinned_pets: Vec::new(),
            a11y: Accessibility::default(),
        }
    }
}

/// How the panel and the overlays look and sound.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Accessibility {
    /// Text size, percent.
    pub font_scale: u32,
    pub high_contrast: bool,
    pub reduce_motion: bool,
    /// Tell pet types apart by letter and pattern too, not only by color.
    pub colorblind: bool,
    /// The overlays' background, percent opaque.
    pub overlay_opacity: u32,
    pub sound: bool,
    /// Alarm volume, percent.
    pub volume: u32,
    /// How long an alarm stays on the overlay, seconds.
    pub alert_seconds: u32,
}

impl Default for Accessibility {
    fn default() -> Self {
        Self {
            font_scale: 100,
            high_contrast: false,
            reduce_motion: false,
            colorblind: false,
            overlay_opacity: 72,
            sound: true,
            volume: 60,
            alert_seconds: 60,
        }
    }
}

impl Settings {
    pub fn region(&self) -> u32 {
        (self.server_id / 100) % 10
    }

    pub fn side(&self) -> &'static str {
        if self.server_id / 1000 == 2 { "asmodian" } else { "elyos" }
    }
}

/// A field boss, from `data/field_bosses.json`.
#[derive(Debug, Clone, Deserialize)]
pub struct FieldBoss {
    pub level: u32,
    pub name: String,
    pub side: Option<String>,
    pub r#where: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Saved {
    pub settings: Settings,
    /// Pets by server: the game keeps one collection per server.
    pub pets: BTreeMap<u32, PetCollection>,
    /// The last boss map seen, by server and map id.
    pub boss_maps: BTreeMap<u32, BTreeMap<u32, BossMap>>,
    /// The last souls picked up, by server, newest last.
    pub souls: BTreeMap<u32, Vec<SoulSeen>>,
}

/// A soul the game said the player picked up.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoulSeen {
    pub pet: u32,
    pub amount: u32,
    pub at_ms: i64,
}

pub const SOULS_KEPT: usize = 100;

impl Saved {
    pub fn boss(&self, server: u32, boss: u32) -> Option<&BossOnMap> {
        self.boss_maps.get(&server)?.values().flat_map(|m| &m.bosses).find(|b| b.id == boss)
    }
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("state.json"))
}

pub fn load(app: &AppHandle) -> Saved {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn store(app: &AppHandle, saved: &Saved) -> std::io::Result<()> {
    let p = path(app).ok_or_else(|| std::io::Error::other("no app data folder"))?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(saved)?)?;
    std::fs::rename(tmp, p)
}
