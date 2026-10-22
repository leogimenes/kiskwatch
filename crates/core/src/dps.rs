//! The DPS tracker: what each player did over a recording.
//!
//! The meter follows what `combat` reads: who is a player (named, or using a
//! class's skills), whose summons are whose, which monsters are bosses. A
//! recording adds up each player's damage, by target, and healing.
//!
//! A recording starts on the local player's first hit (or by hand) and ends by
//! hand, or, when it started by itself, after a while without damage.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::combat::{Class, CombatEvent, base_skill};

/// An automatic recording ends after this long without new damage.
pub const IDLE_END_MS: i64 = 30_000;
/// The longest name a recording takes.
pub const NAME_MAX: usize = 50;

/// A recording, live or saved.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Fight {
    /// The start time in ms, as text: unique among the saved ones.
    pub id: String,
    pub name: String,
    pub started_ms: i64,
    /// The last damage, or when it was stopped by hand.
    pub ended_ms: i64,
    pub players: Vec<FightPlayer>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FightPlayer {
    pub id: i32,
    pub name: String,
    pub class: Option<Class>,
    pub local: bool,
    pub boss_damage: i64,
    pub mob_damage: i64,
    pub heal: i64,
    /// Damage by skill, biggest first.
    pub skills: Vec<SkillStat>,
}

/// One skill's damage in a recording: on bosses and on everything else.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SkillStat {
    /// The skill's base code (see `combat::base_skill`).
    pub skill: i32,
    /// Its damage-over-time ticks, apart from its hits.
    pub dot: bool,
    pub boss: Tally,
    pub mob: Tally,
}

/// Hits and their damage.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Tally {
    pub damage: i64,
    pub hits: u32,
    pub crits: u32,
    pub max_hit: i64,
}

impl Tally {
    fn add(&mut self, value: i64, crit: bool) {
        self.damage += value;
        self.hits += 1;
        self.crits += u32::from(crit);
        self.max_hit = self.max_hit.max(value);
    }

    fn merge(&mut self, other: &Tally) {
        self.damage += other.damage;
        self.hits += other.hits;
        self.crits += other.crits;
        self.max_hit = self.max_hit.max(other.max_hit);
    }
}

impl SkillStat {
    pub fn damage(&self) -> i64 {
        self.boss.damage + self.mob.damage
    }
}

#[derive(Debug, Clone)]
struct Recording {
    name: String,
    auto: bool,
    started_ms: i64,
    last_gain_ms: i64,
    /// By (target, actor as the game names it).
    damage: HashMap<(i32, i32), i64>,
    /// By (target, actor, base skill, dot).
    skills: HashMap<(i32, i32, i32, bool), Tally>,
    heal: HashMap<i32, i64>,
}

/// Who everyone is, from what the game said so far, and the recording.
#[derive(Debug, Default)]
pub struct Meter {
    /// NPC codes that are bosses.
    boss_codes: HashSet<i32>,
    me: Option<i32>,
    names: HashMap<i32, String>,
    classes: HashMap<i32, Class>,
    /// Summon → owner.
    owners: HashMap<i32, i32>,
    /// Entities that spawned as NPCs or summons: never players.
    npcs: HashSet<i32>,
    bosses: HashSet<i32>,
    rec: Option<Recording>,
}

/// Cut a name to what a recording takes.
pub fn clip_name(name: &str) -> String {
    name.trim().chars().take(NAME_MAX).collect()
}

impl Meter {
    pub fn new(boss_codes: HashSet<i32>) -> Self {
        Self { boss_codes, ..Default::default() }
    }

    pub fn recording(&self) -> bool {
        self.rec.is_some()
    }

    /// Your character's name, once the game said it.
    pub fn my_name(&self) -> Option<&str> {
        self.me.and_then(|id| self.names.get(&id)).map(String::as_str)
    }

    fn owner(&self, actor: i32) -> i32 {
        self.owners.get(&actor).copied().unwrap_or(actor)
    }

    fn is_player(&self, id: i32) -> bool {
        self.me == Some(id) || self.names.contains_key(&id) || (self.classes.contains_key(&id) && !self.npcs.contains(&id))
    }

    /// Take what the game said. With `auto_start`, your first hit (any
    /// player's, while the game hasn't said who you are) starts a recording,
    /// named by `name` from your character's name.
    pub fn apply(&mut self, event: CombatEvent, now: i64, auto_start: bool, name: impl FnOnce(Option<&str>) -> String) -> bool {
        let mut started = false;
        match event {
            CombatEvent::Me { id, name, class } => {
                self.me = Some(id);
                self.names.insert(id, name);
                if let Some(c) = class {
                    self.classes.insert(id, c);
                }
            }
            CombatEvent::Player { id, name } => {
                self.names.insert(id, name);
            }
            CombatEvent::Npc { id, code } => {
                self.npcs.insert(id);
                if self.boss_codes.contains(&code) {
                    self.bosses.insert(id);
                } else {
                    self.bosses.remove(&id);
                }
            }
            CombatEvent::Summon { id, owner } => {
                self.npcs.insert(id);
                self.owners.insert(id, owner);
            }
            CombatEvent::Hit { actor, target, skill, value, dot, crit } => {
                if let Some(c) = Class::of_skill(skill).filter(|_| !self.npcs.contains(&actor)) {
                    self.classes.insert(actor, c);
                }
                let who = self.owner(actor);
                if !self.is_player(who) || value <= 0 {
                    return false;
                }
                // A player's spell on a player: healing (or a buff), not damage.
                if self.is_player(self.owner(target)) {
                    if let Some(rec) = &mut self.rec {
                        *rec.heal.entry(actor).or_default() += value;
                    }
                    return false;
                }
                if self.rec.is_none() && auto_start && self.me.is_none_or(|me| me == who) {
                    let n = name(self.my_name());
                    self.begin(n, true, now);
                    started = true;
                }
                if let Some(rec) = &mut self.rec {
                    *rec.damage.entry((target, actor)).or_default() += value;
                    rec.skills.entry((target, actor, base_skill(skill), dot)).or_default().add(value, crit && !dot);
                    rec.last_gain_ms = now;
                }
            }
            CombatEvent::Heal { actor, amount, .. } => {
                if self.is_player(self.owner(actor))
                    && let Some(rec) = &mut self.rec
                {
                    *rec.heal.entry(actor).or_default() += amount;
                }
            }
        }
        started
    }

    /// An automatic recording that ended: none for a while without damage.
    pub fn tick(&mut self, now: i64) -> Option<Fight> {
        let rec = self.rec.as_ref()?;
        if rec.auto && now - rec.last_gain_ms >= IDLE_END_MS {
            let end = rec.last_gain_ms;
            return self.finish(end);
        }
        None
    }

    fn begin(&mut self, name: String, auto: bool, now: i64) {
        self.rec = Some(Recording { name: clip_name(&name), auto, started_ms: now, last_gain_ms: now, damage: HashMap::new(), skills: HashMap::new(), heal: HashMap::new() });
    }

    /// Start recording by hand.
    pub fn start(&mut self, name: String, now: i64) {
        if self.rec.is_none() {
            self.begin(name, false, now);
        }
    }

    /// Stop recording; the fight, if anyone did anything.
    pub fn stop(&mut self, now: i64) -> Option<Fight> {
        self.finish(now)
    }

    fn finish(&mut self, end: i64) -> Option<Fight> {
        let fight = self.current(end)?;
        self.rec = None;
        Some(fight).filter(|f| !f.players.is_empty())
    }

    pub fn rename(&mut self, name: &str) {
        if let Some(rec) = &mut self.rec {
            rec.name = clip_name(name);
        }
    }

    /// A player's row, made on first use; none for anyone else.
    fn row<'a>(&self, players: &'a mut HashMap<i32, FightPlayer>, id: i32) -> Option<&'a mut FightPlayer> {
        if !self.is_player(id) {
            return None;
        }
        Some(players.entry(id).or_insert_with(|| FightPlayer {
            id,
            name: self.names.get(&id).cloned().unwrap_or_else(|| format!("Jogador {id}")),
            class: self.classes.get(&id).copied(),
            local: self.me == Some(id),
            ..Default::default()
        }))
    }

    /// The recording so far, players by damage.
    pub fn current(&self, now: i64) -> Option<Fight> {
        let rec = self.rec.as_ref()?;
        let mut players: HashMap<i32, FightPlayer> = HashMap::new();
        for (&(target, actor), &n) in &rec.damage {
            if let Some(p) = self.row(&mut players, self.owner(actor)) {
                if self.bosses.contains(&target) {
                    p.boss_damage += n;
                } else {
                    p.mob_damage += n;
                }
            }
        }
        let mut skills: HashMap<(i32, i32, bool), SkillStat> = HashMap::new();
        for (&(target, actor, skill, dot), t) in &rec.skills {
            let who = self.owner(actor);
            if !self.is_player(who) {
                continue;
            }
            let s = skills.entry((who, skill, dot)).or_insert_with(|| SkillStat { skill, dot, ..Default::default() });
            if self.bosses.contains(&target) { &mut s.boss } else { &mut s.mob }.merge(t);
        }
        for ((who, ..), s) in skills {
            if let Some(p) = self.row(&mut players, who) {
                p.skills.push(s);
            }
        }
        for p in players.values_mut() {
            p.skills.sort_by_key(|s| (std::cmp::Reverse(s.damage()), s.skill, s.dot));
        }
        for (&actor, &n) in &rec.heal {
            if let Some(p) = self.row(&mut players, self.owner(actor)) {
                p.heal += n;
            }
        }
        let mut players: Vec<FightPlayer> = players.into_values().collect();
        players.sort_by_key(|p| (std::cmp::Reverse(p.boss_damage + p.mob_damage), std::cmp::Reverse(p.heal), p.id));
        Some(Fight { id: rec.started_ms.to_string(), name: rec.name.clone(), started_ms: rec.started_ms, ended_ms: now, players })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: i32 = 100;
    const MATE: i32 = 200;
    const MOB: i32 = 9000;
    const BOSS: i32 = 9100;
    const BOSS_CODE: i32 = 2_301_208;
    const CLERIC: i32 = 17_010_000;
    const GLADIATOR: i32 = 11_010_000;

    fn meter() -> Meter {
        let mut m = Meter::new([BOSS_CODE].into());
        for e in [
            CombatEvent::Me { id: ME, name: "Leozin".into(), class: Some(Class::Cleric) },
            CombatEvent::Player { id: MATE, name: "Amigo".into() },
            CombatEvent::Npc { id: MOB, code: 2_000_002 },
            CombatEvent::Npc { id: BOSS, code: BOSS_CODE },
        ] {
            m.apply(e, 0, false, named);
        }
        m
    }

    fn hit(actor: i32, target: i32, skill: i32, value: i64) -> CombatEvent {
        CombatEvent::Hit { actor, target, skill, value, dot: false, crit: false }
    }

    fn named(n: Option<&str>) -> String {
        format!("{} luta", n.unwrap_or("?"))
    }

    #[test]
    fn your_first_hit_starts_and_counts() {
        let mut m = meter();
        assert!(!m.apply(hit(MATE, MOB, GLADIATOR, 500), 0, true, named), "a mate's hit");
        assert!(m.apply(hit(ME, MOB, CLERIC, 40), 500, true, named));
        let f = m.current(1_000).unwrap();
        assert_eq!(f.name, "Leozin luta");
        assert_eq!(f.players.len(), 1);
        assert_eq!((f.players[0].id, f.players[0].mob_damage, f.players[0].local, f.players[0].class), (ME, 40, true, Some(Class::Cleric)));
    }

    #[test]
    fn boss_mob_and_heal_are_apart() {
        let mut m = meter();
        m.start("x".into(), 0);
        for e in [
            hit(ME, MOB, CLERIC, 30),
            hit(ME, BOSS, CLERIC, 70),
            hit(MATE, BOSS, GLADIATOR, 200),
            // A heal on a mate comes as a hit on a player.
            hit(ME, MATE, CLERIC, 25),
            CombatEvent::Heal { actor: ME, target: ME, amount: 25 },
        ] {
            m.apply(e, 500, false, named);
        }
        let f = m.stop(1_000).unwrap();
        assert_eq!((f.players[0].name.as_str(), f.players[0].class), ("Amigo", Some(Class::Gladiator)));
        let me = f.players.iter().find(|p| p.id == ME).unwrap();
        assert_eq!((me.mob_damage, me.boss_damage, me.heal), (30, 70, 50));
        assert_eq!(f.ended_ms, 1_000);
    }

    #[test]
    fn summons_count_for_their_owner() {
        let mut m = meter();
        m.start("x".into(), 0);
        m.apply(CombatEvent::Summon { id: 555, owner: ME }, 0, false, named);
        m.apply(hit(ME, MOB, CLERIC, 10), 0, false, named);
        m.apply(hit(555, MOB, 2_100_000, 90), 0, false, named);
        let f = m.current(1_000).unwrap();
        assert_eq!(f.players.len(), 1);
        assert_eq!(f.players[0].mob_damage, 100);
    }

    #[test]
    fn monsters_are_not_players() {
        let mut m = meter();
        m.start("x".into(), 0);
        m.apply(hit(MOB, ME, 2_000_100, 99), 0, false, named);
        assert_eq!(m.stop(1_000), None);
    }

    #[test]
    fn an_automatic_recording_ends_when_the_fighting_does() {
        let mut m = meter();
        m.apply(hit(ME, MOB, CLERIC, 10), 1_000, true, named);
        assert_eq!(m.tick(1_000 + IDLE_END_MS - 1), None);
        let ended = m.tick(1_000 + IDLE_END_MS).unwrap();
        assert_eq!((ended.started_ms, ended.ended_ms), (1_000, 1_000));
        assert!(!m.recording());
    }

    #[test]
    fn a_recording_by_hand_waits_for_the_button() {
        let mut m = meter();
        m.start("x".into(), 0);
        m.apply(hit(ME, MOB, CLERIC, 10), 1_000, false, named);
        assert_eq!(m.tick(10 * IDLE_END_MS), None);
        assert!(m.recording());
    }

    #[test]
    fn hits_add_up_by_skill() {
        let mut m = meter();
        m.start("x".into(), 0);
        let crit = |actor, target, skill, value| CombatEvent::Hit { actor, target, skill, value, dot: false, crit: true };
        for e in [
            hit(ME, MOB, 17_010_230, 100),
            crit(ME, BOSS, 17_010_000, 300),
            hit(ME, BOSS, 17_020_000, 50),
            CombatEvent::Hit { actor: ME, target: BOSS, skill: 17_010_000, value: 20, dot: true, crit: false },
        ] {
            m.apply(e, 0, false, named);
        }
        let f = m.current(1_000).unwrap();
        let s = &f.players[0].skills;
        assert_eq!(s.len(), 3);
        assert_eq!((s[0].skill, s[0].dot), (17_010_000, false), "both versions of the skill, biggest first");
        assert_eq!(s[0].mob, Tally { damage: 100, hits: 1, crits: 0, max_hit: 100 });
        assert_eq!(s[0].boss, Tally { damage: 300, hits: 1, crits: 1, max_hit: 300 });
        assert_eq!((s[1].skill, s[1].damage()), (17_020_000, 50));
        assert_eq!((s[2].skill, s[2].dot, s[2].boss.hits), (17_010_000, true, 1));
    }

    #[test]
    fn a_summons_skills_are_its_owners() {
        let mut m = meter();
        m.start("x".into(), 0);
        m.apply(CombatEvent::Summon { id: 555, owner: ME }, 0, false, named);
        m.apply(hit(555, MOB, 16_990_001, 90), 0, false, named);
        m.apply(hit(555, MOB, 16_990_001, 60), 0, false, named);
        let f = m.current(1_000).unwrap();
        assert_eq!(f.players[0].skills, vec![SkillStat { skill: 16_990_000, dot: false, mob: Tally { damage: 150, hits: 2, crits: 0, max_hit: 90 }, ..Default::default() }]);
    }

    #[test]
    fn names_are_cut_at_fifty() {
        let mut m = meter();
        m.start("a".repeat(80), 0);
        m.rename(&"é".repeat(60));
        assert_eq!(m.current(0).unwrap().name.chars().count(), NAME_MAX);
    }
}
