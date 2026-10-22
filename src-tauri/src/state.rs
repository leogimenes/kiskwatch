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
    /// Show the overlays only while the game is running.
    pub overlays_with_game: bool,
    /// The pets kept on the pets overlay, in the order pinned.
    pub pinned_pets: Vec<u32>,
    /// The farm route, in order: each pet and the monster to farm it on.
    pub route: Vec<RouteStop>,
    pub a11y: Accessibility,
    pub dps: DpsSettings,
    pub hotkeys: Hotkeys,
}

/// The global keyboard shortcuts (see `hotkeys`); empty is off.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Hotkeys {
    /// Start or stop a DPS recording.
    pub dps: String,
    /// Turn letting clicks pass through the overlays on or off.
    pub click_through: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self { dps: "Ctrl+Alt+D".into(), click_through: "Ctrl+Alt+X".into() }
    }
}

impl Hotkeys {
    /// The first defaults held Shift, which makes the character dash: move
    /// them, unless the user picked their own.
    pub fn migrate(&mut self) {
        if self.dps == "Ctrl+Shift+D" && self.click_through == "Ctrl+Shift+X" {
            *self = Self::default();
        }
    }
}

/// The DPS tracker overlay.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DpsSettings {
    pub overlay: bool,
    /// "hit": start recording on your first hit; "button": only by hand.
    pub start: String,
    /// Damage counted: "all", "mob" or "boss".
    pub target: String,
    /// The bars: "damage", "heal" or "both" (stacked).
    pub bars: String,
}

impl Default for DpsSettings {
    fn default() -> Self {
        Self { overlay: false, start: "hit".into(), target: "all".into(), bars: "damage".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteStop {
    pub pet: u32,
    /// The monster's npc id.
    pub npc: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server_id: DEFAULT_SERVER,
            alarms: BTreeMap::new(),
            click_through: false,
            timer_overlay: true,
            pet_overlay: false,
            overlays_with_game: true,
            pinned_pets: Vec::new(),
            route: Vec::new(),
            a11y: Accessibility::default(),
            dps: DpsSettings::default(),
            hotkeys: Hotkeys::default(),
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
    /// The pets overlay's queue, by server.
    pub pet_queue: BTreeMap<u32, kiskwatch_core::pets::PetQueue>,
    /// The character followed on the Build tab, from the official profile.
    pub profile: Option<crate::profile::Profile>,
    /// The DPS tracker's recordings, newest first.
    pub fights: Vec<kiskwatch_core::dps::Fight>,
    /// Builds kept to compare against, newest first.
    pub references: Vec<Reference>,
    /// The daily and weekly checklist, per character.
    pub checklist: kiskwatch_core::checklist::Checklist,
}

/// A character's build as it was when saved, to compare against later.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reference {
    /// When it was saved, in ms, as text: unique among the saved ones.
    pub id: String,
    pub label: String,
    pub profile: crate::profile::Profile,
}

/// A soul the game said the player picked up.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoulSeen {
    pub pet: u32,
    pub amount: u32,
    pub at_ms: i64,
}

pub const SOULS_KEPT: usize = 100;
/// Recordings kept; the oldest go first.
pub const FIGHTS_KEPT: usize = 200;
/// Builds kept to compare against; the oldest go first.
pub const REFERENCES_KEPT: usize = 50;
/// The longest name a saved build takes.
pub const LABEL_MAX: usize = 50;

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
