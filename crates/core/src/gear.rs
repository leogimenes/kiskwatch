//! Item level and combat power of the players on the DPS bars, read from
//! their public profile by name and kept for a while, so that a bar asks the
//! official site once per player and not on every redraw.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

/// A profile found is read again after two hours: gear changes slowly, and
/// the official site is asked as little as possible.
pub const FRESH_MS: i64 = 2 * 60 * 60_000;
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

/// Where the game says a player is from, so that the lookup finds them and
/// not someone else with the same name on another server.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Origin {
    /// From the party list, most likely first.
    pub servers: Vec<u32>,
    /// 1 Elyos (servers 1xxx), 2 Asmodian (2xxx).
    pub side: Option<u32>,
}

impl Origin {
    /// Whether a character on this server can be the one the game named.
    pub fn fits(&self, server: u32) -> bool {
        if !self.servers.is_empty() {
            return self.servers.contains(&server);
        }
        self.side.is_none_or(|side| server / 1000 == side)
    }
}

#[derive(Debug, Default)]
struct Entry {
    gear: Option<Gear>,
    /// When the last lookup started or ended.
    at_ms: i64,
    busy: bool,
    /// What was known of where they're from when it started.
    asked: Origin,
}

/// The players looked up, by name (any case).
#[derive(Debug, Default)]
pub struct Lookups {
    by_name: HashMap<String, Entry>,
    origins: HashMap<String, Origin>,
}

impl Lookups {
    /// The game said where a player is from: the servers replace the ones
    /// known, the side too. A name looked up before learning it is looked
    /// up again.
    pub fn origin(&mut self, name: &str, servers: Vec<u32>, side: Option<u32>) {
        let o = self.origins.entry(name.to_lowercase()).or_default();
        if !servers.is_empty() {
            o.servers = servers;
        }
        if side.is_some() {
            o.side = side;
        }
    }

    /// What's known of these names, and which of them to look up now, with
    /// where they're from (each one marked as under way until `done`).
    pub fn ask(&mut self, names: &[String], now_ms: i64) -> (Vec<Gear>, Vec<(String, Origin)>) {
        let mut busy = self.by_name.values().filter(|e| e.busy && now_ms - e.at_ms < STUCK_MS).count();
        let (mut known, mut start) = (Vec::new(), Vec::new());
        for name in names {
            if !named(name) {
                continue;
            }
            let origin = self.origins.get(&name.to_lowercase()).cloned().unwrap_or_default();
            let e = self.by_name.entry(name.to_lowercase()).or_default();
            if let Some(g) = &e.gear {
                known.push(Gear { name: name.clone(), ..g.clone() });
            }
            let due = if e.busy {
                now_ms - e.at_ms >= STUCK_MS
            } else if e.at_ms == 0 || e.asked != origin {
                true
            } else {
                now_ms - e.at_ms >= if e.gear.is_some() { FRESH_MS } else { RETRY_MS }
            };
            if due && busy < AT_ONCE && !start.iter().any(|(n, _)| n == name) {
                busy += 1;
                e.busy = true;
                e.at_ms = now_ms;
                e.asked = origin.clone();
                start.push((name.clone(), origin));
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
        assert_eq!(start, [("Amigo".to_string(), Origin::default())]);
        // Under way: not asked again.
        assert!(l.ask(&names(&["amigo"]), 2_000).1.is_empty());
        assert!(l.done("Amigo", Ok(Some(gear("Amigo", 2000))), 3_000));
        let (known, start) = l.ask(&names(&["AMIGO"]), 4_000);
        assert_eq!(known, [gear("AMIGO", 2000)], "named as the bar names them");
        assert!(start.is_empty());
        // Half an hour later, read again, still showing the old one meanwhile.
        let (known, start) = l.ask(&names(&["Amigo"]), 3_000 + FRESH_MS);
        assert_eq!(known.len(), 1);
        assert_eq!(start, [("Amigo".to_string(), Origin::default())]);
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
        assert_eq!(l.ask(&names(&["Sumido"]), RETRY_MS + 1).1, [("Sumido".to_string(), Origin::default())]);
    }

    fn started(l: &mut Lookups, list: &[&str], now_ms: i64) -> Vec<String> {
        l.ask(&names(list), now_ms).1.into_iter().map(|(n, _)| n).collect()
    }

    #[test]
    fn a_few_at_a_time() {
        let mut l = Lookups::default();
        assert_eq!(started(&mut l, &["A", "B", "C", "D", "E"], 0), ["A", "B", "C"]);
        l.done("A", Ok(None), 10);
        assert_eq!(started(&mut l, &["A", "B", "C", "D", "E"], 20), ["D"]);
        // A lookup that never answered stops holding a place.
        assert_eq!(started(&mut l, &["E"], STUCK_MS + 1), ["E"]);
    }

    #[test]
    fn looks_up_where_the_game_says_they_are_from() {
        let mut l = Lookups::default();
        l.origin("Amigo", Vec::new(), Some(2));
        assert_eq!(l.ask(&names(&["amigo"]), 0).1, [("amigo".to_string(), Origin { servers: Vec::new(), side: Some(2) })]);
        l.done("amigo", Ok(Some(gear("Amigo", 62))), 1);
        assert!(started(&mut l, &["Amigo"], 2).is_empty());
        // The party list says the server: looked up again, the old one shown meanwhile.
        l.origin("Amigo", vec![2406, 2405], None);
        let (known, start) = l.ask(&names(&["Amigo"]), 3);
        assert_eq!(known.len(), 1);
        assert_eq!(start, [("Amigo".to_string(), Origin { servers: vec![2406, 2405], side: Some(2) })]);
        l.done("Amigo", Ok(Some(gear("Amigo", 2000))), 4);
        assert!(started(&mut l, &["Amigo"], 5).is_empty());
    }

    #[test]
    fn an_origin_rules_out_namesakes() {
        let party = Origin { servers: vec![2406, 2405], side: Some(2) };
        assert!(party.fits(2406) && party.fits(2405));
        assert!(!party.fits(1406) && !party.fits(2403));
        let asmodian = Origin { servers: Vec::new(), side: Some(2) };
        assert!(asmodian.fits(2403) && !asmodian.fits(1406));
        assert!(Origin::default().fits(1406));
    }
}
