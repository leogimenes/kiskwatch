//! Item level and combat power of the players on the DPS bars, read from
//! their public profile by name and kept for a while, so that a bar asks the
//! official site once per player and not on every redraw.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

/// A profile found is read again after half an hour (gear changes).
pub const FRESH_MS: i64 = 30 * 60_000;
/// A name not found (or the site down) is tried again after ten minutes.
pub const RETRY_MS: i64 = 10 * 60_000;
/// A lookup that never answered is given up after a minute.
pub const STUCK_MS: i64 = 60_000;
/// At most this many lookups at once.
pub const AT_ONCE: usize = 3;

/// What a DPS bar shows of a player.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Gear {
    /// As the game named them on the bar.
    pub name: String,
    pub item_level: Option<u32>,
    pub combat_power: Option<u64>,
}

impl Gear {
    /// From `/api/character/info`: `profile.combatPower`, and the
    /// `ItemLevel` attribute in `stat.statList`.
    pub fn from_info(name: &str, info: &Value) -> Gear {
        let item_level = info
            .pointer("/stat/statList")
            .and_then(Value::as_array)
            .and_then(|l| l.iter().find(|s| s.get("type").and_then(Value::as_str) == Some("ItemLevel")))
            .and_then(|s| s.get("value")?.as_u64())
            .map(|v| v as u32);
        let combat_power = info.pointer("/profile/combatPower").and_then(Value::as_u64);
        Gear { name: name.to_string(), item_level, combat_power }
    }
}

/// A name the game really gave: not the stand-in for a player whose name
/// hasn't been seen yet ("Jogador 123").
pub fn named(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty() && !name.strip_prefix("Jogador ").is_some_and(|id| id.chars().all(|c| c.is_ascii_digit()))
}

#[derive(Debug, Default)]
struct Entry {
    gear: Option<Gear>,
    /// When the last lookup started or ended.
    at_ms: i64,
    busy: bool,
}

/// The players looked up, by name (any case).
#[derive(Debug, Default)]
pub struct Lookups {
    by_name: HashMap<String, Entry>,
}

impl Lookups {
    /// What's known of these names, and which of them to look up now (each
    /// one marked as under way until `done`).
    pub fn ask(&mut self, names: &[String], now_ms: i64) -> (Vec<Gear>, Vec<String>) {
        let mut busy = self.by_name.values().filter(|e| e.busy && now_ms - e.at_ms < STUCK_MS).count();
        let (mut known, mut start) = (Vec::new(), Vec::new());
        for name in names {
            if !named(name) {
                continue;
            }
            let e = self.by_name.entry(name.to_lowercase()).or_default();
            if let Some(g) = &e.gear {
                known.push(Gear { name: name.clone(), ..g.clone() });
            }
            let due = if e.busy {
                now_ms - e.at_ms >= STUCK_MS
            } else if e.at_ms == 0 {
                true
            } else {
                now_ms - e.at_ms >= if e.gear.is_some() { FRESH_MS } else { RETRY_MS }
            };
            if due && busy < AT_ONCE && !start.contains(name) {
                busy += 1;
                e.busy = true;
                e.at_ms = now_ms;
                start.push(name.clone());
            }
        }
        (known, start)
    }

    /// A lookup ended: found, not on the site (`Ok(None)`), or failed. A
    /// failure keeps what was known. True when what the bar shows changed.
    pub fn done(&mut self, name: &str, found: Result<Option<Gear>, String>, now_ms: i64) -> bool {
        let e = self.by_name.entry(name.to_lowercase()).or_default();
        e.busy = false;
        e.at_ms = now_ms;
        let before = e.gear.clone();
        match found {
            Ok(g) => e.gear = g,
            Err(_) if e.gear.is_some() => {}
            Err(_) => e.gear = None,
        }
        e.gear != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn gear(name: &str, il: u32) -> Gear {
        Gear { name: name.into(), item_level: Some(il), combat_power: Some(1000) }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_the_profile() {
        let info = json!({
            "profile": { "characterName": "Amigo", "combatPower": 123456 },
            "stat": { "statList": [{ "type": "Str", "value": 90 }, { "type": "ItemLevel", "value": 2345 }] },
        });
        assert_eq!(Gear::from_info("Amigo", &info), Gear { name: "Amigo".into(), item_level: Some(2345), combat_power: Some(123456) });
        assert_eq!(Gear::from_info("X", &json!({})), Gear { name: "X".into(), item_level: None, combat_power: None });
    }

    #[test]
    fn skips_stand_in_names() {
        assert!(named("Amigo"));
        assert!(named("Jogador Bom"));
        assert!(!named("Jogador 4021"));
        assert!(!named(" "));
    }

    #[test]
    fn looks_each_name_up_once() {
        let mut l = Lookups::default();
        let (known, start) = l.ask(&names(&["Amigo", "Jogador 7"]), 1_000);
        assert!(known.is_empty());
        assert_eq!(start, ["Amigo"]);
        // Under way: not asked again.
        assert!(l.ask(&names(&["amigo"]), 2_000).1.is_empty());
        assert!(l.done("Amigo", Ok(Some(gear("Amigo", 2000))), 3_000));
        let (known, start) = l.ask(&names(&["AMIGO"]), 4_000);
        assert_eq!(known, [gear("AMIGO", 2000)], "named as the bar names them");
        assert!(start.is_empty());
        // Half an hour later, read again, still showing the old one meanwhile.
        let (known, start) = l.ask(&names(&["Amigo"]), 3_000 + FRESH_MS);
        assert_eq!(known.len(), 1);
        assert_eq!(start, ["Amigo"]);
    }

    #[test]
    fn a_failure_keeps_what_was_known_and_waits_to_retry() {
        let mut l = Lookups::default();
        l.ask(&names(&["Amigo", "Sumido"]), 0);
        l.done("Amigo", Ok(Some(gear("Amigo", 2000))), 1);
        assert!(!l.done("Sumido", Ok(None), 1), "not found: nothing to show, as before");
        l.ask(&names(&["Amigo"]), FRESH_MS + 1);
        assert!(!l.done("Amigo", Err("o site oficial respondeu 503".into()), FRESH_MS + 2));
        assert_eq!(l.ask(&names(&["Amigo"]), FRESH_MS + 3).0, [gear("Amigo", 2000)]);
        assert!(l.ask(&names(&["Sumido"]), RETRY_MS).1.is_empty());
        assert_eq!(l.ask(&names(&["Sumido"]), RETRY_MS + 1).1, ["Sumido"]);
    }

    #[test]
    fn a_few_at_a_time() {
        let mut l = Lookups::default();
        let (_, start) = l.ask(&names(&["A", "B", "C", "D", "E"]), 0);
        assert_eq!(start, ["A", "B", "C"]);
        l.done("A", Ok(None), 10);
        assert_eq!(l.ask(&names(&["A", "B", "C", "D", "E"]), 20).1, ["D"]);
        // A lookup that never answered stops holding a place.
        assert_eq!(l.ask(&names(&["E"]), STUCK_MS + 1).1, ["E"]);
    }
}
