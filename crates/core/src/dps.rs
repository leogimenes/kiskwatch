//! The DPS tracker: what each player did over a recording.
//!
//! The meter follows what `combat` reads: who is a player (named, or using a
//! class's skills), whose summons are whose, which monsters are bosses. A
//! recording adds up each player's damage, by target, and healing, and the
//! damage each player took from monsters, by monster and skill.
//!
//! A recording starts on the local player's first hit (or by hand) and ends by
//! hand, or, when it started by itself, after a while without damage.
//!
//! Each player's row also has the fight's timeline: damage second by second,
//! and the stretches the player stood without hitting (their own hits and
//! healing spells; summons and damage over time don't count as acting).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::casts::{Casts, SkillCasts};
use crate::combat::{Class, CombatEvent, base_skill};
use crate::effects::{EffectRecord, Effects, Uptime};

/// An automatic recording ends after this long without new damage.
pub const IDLE_END_MS: i64 = 30_000;
/// The longest name a recording takes.
pub const NAME_MAX: usize = 50;
/// This long or more without one of your own hits is time stood still.
pub const IDLE_GAP_MS: i64 = 3_000;

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
    /// Each boss hit, most damaged first: what the boss history goes by.
    pub bosses: Vec<FightBoss>,
    pub effects: FightEffects,
}

/// A boss in a recording (every one with the same NPC code counts as one).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FightBoss {
    pub code: i32,
    /// The first and last hit any player landed on it.
    pub first_ms: i64,
    pub last_ms: i64,
    /// Everyone's damage on it, and yours.
    pub damage: i64,
    pub my_damage: i64,
    /// Your damage on it by skill (summons' under their own skill), most first.
    pub my_skills: Vec<SkillDamage>,
    /// Each player's damage on it, most first (none in recordings from before).
    pub players: Vec<BossPlayer>,
}

/// A player's damage on one boss, summons included.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BossPlayer {
    pub id: i32,
    pub damage: i64,
    /// By skill, biggest first; the hits are under `boss`.
    pub skills: Vec<SkillStat>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SkillDamage {
    /// The skill without its level: a player skill's code to the ten thousand.
    pub skill: i32,
    pub damage: i64,
    pub hits: u32,
}

/// The buffs and debuffs over a recording: on each player, and on the
/// enemy that took the most damage.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FightEffects {
    pub target: Option<i32>,
    pub target_boss: bool,
    /// Casters are their summons' owners.
    pub list: Vec<Uptime>,
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
    /// Damage in each second of the recording, summons included.
    pub timeline: Vec<i64>,
    /// Stretches of `IDLE_GAP_MS` or more without acting, as [from, to] in
    /// ms from the start.
    pub idle: Vec<[i64; 2]>,
    /// All of them added up.
    pub idle_ms: i64,
    /// Damage by skill, biggest first.
    pub skills: Vec<SkillStat>,
    /// When each skill was used, to set against its cooldown.
    pub casts: Vec<SkillCasts>,
    /// What monsters did to this player, most damage first.
    pub taken: Vec<Taken>,
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

/// The damage a player took from one monster's skill.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Taken {
    /// The monster's NPC code; 0 when its spawn was missed.
    pub npc: i32,
    pub boss: bool,
    pub skill: i32,
    pub damage: i64,
    pub hits: u32,
    pub max_hit: i64,
}

#[derive(Debug, Clone)]
struct Recording {
    name: String,
    auto: bool,
    started_ms: i64,
    last_gain_ms: i64,
    /// By (target, actor as the game names it, the target was a boss).
    damage: HashMap<(i32, i32, bool), i64>,
    /// By (on a boss, actor, base skill, dot).
    skills: HashMap<(bool, i32, i32, bool), Tally>,
    heal: HashMap<i32, i64>,
    casts: Casts,
    /// By (actor, second from the start).
    per_second: HashMap<(i32, i64), i64>,
    /// When each actor hit or cast a healing spell, oldest first.
    acted: HashMap<i32, Vec<i64>>,
    /// By (player hit, NPC code, skill): damage, hits, the biggest.
    taken: HashMap<(i32, i32, i32), (i64, u32, i64)>,
    /// By boss code.
    bosses: HashMap<i32, BossTally>,
}

#[derive(Debug, Clone, Default)]
struct BossTally {
    first_ms: i64,
    last_ms: i64,
    damage: i64,
    my_damage: i64,
    my_skills: HashMap<i32, (i64, u32)>,
    /// By (actor, base skill, dot).
    skills: HashMap<(i32, i32, bool), Tally>,
}

impl Recording {
    fn act(&mut self, actor: i32, now: i64) {
        self.acted.entry(actor).or_default().push(now);
    }
}

/// The stretches of `IDLE_GAP_MS` or more between `from`, each time in
/// `acted` and `to`, from the start.
fn idle(from: i64, acted: &[i64], to: i64) -> Vec<[i64; 2]> {
    let mut out = Vec::new();
    let mut last = from;
    for &t in acted.iter().chain([&to]) {
        let t = t.clamp(last, to.max(last));
        if t - last >= IDLE_GAP_MS {
            out.push([last - from, t - from]);
        }
        last = t;
    }
    out
}

/// A player the game named around you, for the panel's group tab.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SeenPlayer {
    pub name: String,
    pub class: Option<Class>,
    /// When the game last named them or they last fought.
    pub seen_ms: i64,
    /// They hit or healed in the recording under way.
    pub fighting: bool,
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
    /// NPC → its code.
    codes: HashMap<i32, i32>,
    /// Boss entity → its NPC code.
    bosses: HashMap<i32, i32>,
    effects: Effects,
    /// When each player was last named or last fought.
    seen: HashMap<i32, i64>,
    rec: Option<Recording>,
}

/// Cut a name to what a recording takes.
pub fn clip_name(name: &str) -> String {
    name.trim().chars().take(NAME_MAX).collect()
}

/// A recording's name as a file name Windows accepts: "Leozin 21/10 22:05 #K3P"
/// becomes "Leozin 21-10 22-05 K3P".
pub fn file_name(name: &str) -> String {
    let mut out = String::new();
    for c in clip_name(name).chars() {
        match c {
            '/' | '\\' | ':' | '|' => out.push('-'),
            '#' | '<' | '>' | '"' | '?' | '*' => {}
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let out = out.trim_matches(|c: char| c == '.' || c == ' ');
    if out.is_empty() { "Luta".into() } else { out.into() }
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
                self.seen.insert(id, now);
                if let Some(c) = class {
                    self.classes.insert(id, c);
                }
            }
            CombatEvent::Player { id, name } => {
                self.names.insert(id, name);
                self.seen.insert(id, now);
            }
            CombatEvent::Npc { id, code } => {
                self.npcs.insert(id);
                self.codes.insert(id, code);
                if self.boss_codes.contains(&code) {
                    self.bosses.insert(id, code);
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
                if value <= 0 {
                    return false;
                }
                if !self.is_player(who) {
                    // A monster's hit on a player: damage taken.
                    if self.is_player(target)
                        && let Some(rec) = &mut self.rec
                    {
                        let code = self.codes.get(&actor).copied().unwrap_or(0);
                        let t = rec.taken.entry((target, code, skill)).or_default();
                        t.0 += value;
                        t.1 += 1;
                        t.2 = t.2.max(value);
                    }
                    return false;
                }
                self.seen.insert(who, now);
                // A player's spell on a player: healing (or a buff), not damage.
                if self.is_player(self.owner(target)) {
                    if let Some(rec) = &mut self.rec {
                        *rec.heal.entry(actor).or_default() += value;
                        rec.casts.hit(actor, skill, dot, now, rec.started_ms);
                        if !dot {
                            rec.act(actor, now);
                        }
                    }
                    return false;
                }
                if self.rec.is_none() && auto_start && self.me.is_none_or(|me| me == who) {
                    let n = name(self.my_name());
                    self.begin(n, true, now);
                    started = true;
                }
                let boss = self.bosses.get(&target).copied();
                let mine = self.me == Some(who);
                if let Some(rec) = &mut self.rec {
                    // Boss or not as it was when hit: the game hands a dead
                    // boss's entity to the next NPC that spawns.
                    *rec.damage.entry((target, actor, boss.is_some())).or_default() += value;
                    rec.skills.entry((boss.is_some(), actor, base_skill(skill), dot)).or_default().add(value, crit && !dot);
                    rec.casts.hit(actor, skill, dot, now, rec.started_ms);
                    let second = (now - rec.started_ms).max(0) / 1000;
                    *rec.per_second.entry((actor, second)).or_default() += value;
                    if !dot {
                        rec.act(actor, now);
                    }
                    rec.last_gain_ms = now;
                    if let Some(code) = boss {
                        let t = rec.bosses.entry(code).or_insert_with(|| BossTally { first_ms: now, ..Default::default() });
                        t.last_ms = now;
                        t.damage += value;
                        t.skills.entry((actor, base_skill(skill), dot)).or_default().add(value, crit && !dot);
                        if mine {
                            t.my_damage += value;
                            let s = t.my_skills.entry(base_skill(skill)).or_default();
                            s.0 += value;
                            s.1 += 1;
                        }
                    }
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

    /// A buff or debuff going on or off.
    pub fn apply_effect(&mut self, record: EffectRecord, now: i64) {
        self.effects.apply(record, now);
    }

    /// An automatic recording that ended: none for a while without damage.
    pub fn tick(&mut self, now: i64) -> Option<Fight> {
        self.effects.expire(now);
        let rec = self.rec.as_ref()?;
        if rec.auto && now - rec.last_gain_ms >= IDLE_END_MS {
            let end = rec.last_gain_ms;
            return self.finish(end);
        }
        None
    }

    fn begin(&mut self, name: String, auto: bool, now: i64) {
        self.effects.start(now);
        self.rec = Some(Recording { name: clip_name(&name), auto, started_ms: now, last_gain_ms: now, damage: HashMap::new(), skills: HashMap::new(), heal: HashMap::new(), casts: Casts::default(), per_second: HashMap::new(), acted: HashMap::new(), taken: HashMap::new(), bosses: HashMap::new() });
    }

    /// Start recording by hand.
    pub fn start(&mut self, name: String, now: i64) {
        if self.rec.is_none() {
            self.begin(name, false, now);
        }
    }

    /// Stop recording; the fight, if anyone did damage or healed.
    pub fn stop(&mut self, now: i64) -> Option<Fight> {
        self.finish(now)
    }

    fn finish(&mut self, end: i64) -> Option<Fight> {
        let fight = self.current(end)?;
        self.rec = None;
        self.effects.stop();
        Some(fight).filter(|f| f.players.iter().any(|p| p.boss_damage + p.mob_damage + p.heal > 0))
    }

    /// Throw away what the recording under way counted, unsaved. One started
    /// by hand starts over from zero; an automatic one waits for the next hit.
    pub fn clear(&mut self, now: i64) {
        let Some(rec) = self.rec.take() else { return };
        self.effects.stop();
        if !rec.auto {
            self.begin(rec.name, false, now);
        }
    }

    pub fn rename(&mut self, name: &str) {
        if let Some(rec) = &mut self.rec {
            rec.name = clip_name(name);
        }
    }

    /// The other players the game named, seen since `since`: those in the
    /// recording first, then the most recently seen.
    pub fn roster(&self, since: i64) -> Vec<SeenPlayer> {
        let fighting: HashSet<i32> = self
            .rec
            .iter()
            .flat_map(|r| r.damage.keys().map(|&(_, a, _)| a).chain(r.heal.keys().copied()))
            .map(|a| self.owner(a))
            .collect();
        let mut list: Vec<SeenPlayer> = self
            .names
            .iter()
            .filter(|&(&id, _)| self.me != Some(id))
            .filter_map(|(&id, name)| {
                let seen_ms = self.seen.get(&id).copied().unwrap_or(0);
                (seen_ms >= since).then(|| SeenPlayer { name: name.clone(), class: self.classes.get(&id).copied(), seen_ms, fighting: fighting.contains(&id) })
            })
            .collect();
        list.sort_by(|a, b| b.fighting.cmp(&a.fighting).then(b.seen_ms.cmp(&a.seen_ms)).then_with(|| a.name.cmp(&b.name)));
        // The game hands out a new entity when someone comes back in view.
        let mut names = HashSet::new();
        list.retain(|p| names.insert(p.name.clone()));
        list
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
        for (&(_, actor, boss), &n) in &rec.damage {
            if let Some(p) = self.row(&mut players, self.owner(actor)) {
                if boss {
                    p.boss_damage += n;
                } else {
                    p.mob_damage += n;
                }
            }
        }
        let mut skills: HashMap<(i32, i32, bool), SkillStat> = HashMap::new();
        for (&(boss, actor, skill, dot), t) in &rec.skills {
            let who = self.owner(actor);
            if !self.is_player(who) {
                continue;
            }
            let s = skills.entry((who, skill, dot)).or_insert_with(|| SkillStat { skill, dot, ..Default::default() });
            if boss { &mut s.boss } else { &mut s.mob }.merge(t);
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
        // The second a hit lands in, up to the last one's.
        let seconds = (now - rec.started_ms).max(0) / 1000 + 1;
        for p in players.values_mut() {
            p.timeline = vec![0; seconds as usize];
            let none = Vec::new();
            let acted = rec.acted.get(&p.id).unwrap_or(&none);
            p.idle = idle(rec.started_ms, acted, now);
            p.idle_ms = p.idle.iter().map(|[a, b]| b - a).sum();
        }
        for (&(actor, second), &n) in &rec.per_second {
            if let Some(p) = players.get_mut(&self.owner(actor))
                && let Some(slot) = p.timeline.get_mut(second as usize)
            {
                *slot += n;
            }
        }
        // After the timelines: a player who only took damage has none.
        for (&(target, npc, skill), &(damage, hits, max_hit)) in &rec.taken {
            if let Some(p) = self.row(&mut players, target) {
                p.taken.push(Taken { npc, boss: self.boss_codes.contains(&npc), skill, damage, hits, max_hit });
            }
        }
        let mut players: Vec<FightPlayer> = players.into_values().collect();
        for p in &mut players {
            p.casts = rec.casts.of(p.id);
            p.taken.sort_by_key(|t| (std::cmp::Reverse(t.damage), t.npc, t.skill));
        }
        players.sort_by_key(|p| (std::cmp::Reverse(p.boss_damage + p.mob_damage), std::cmp::Reverse(p.heal), p.id));
        let mut bosses: Vec<FightBoss> = rec
            .bosses
            .iter()
            .map(|(&code, t)| {
                let mut my_skills: Vec<SkillDamage> = t.my_skills.iter().map(|(&skill, &(damage, hits))| SkillDamage { skill, damage, hits }).collect();
                my_skills.sort_by_key(|s| (std::cmp::Reverse(s.damage), s.skill));
                let mut by: HashMap<i32, BossPlayer> = HashMap::new();
                for (&(actor, skill, dot), tally) in &t.skills {
                    let who = self.owner(actor);
                    if !self.is_player(who) {
                        continue;
                    }
                    let p = by.entry(who).or_insert_with(|| BossPlayer { id: who, ..Default::default() });
                    p.damage += tally.damage;
                    match p.skills.iter_mut().find(|s| s.skill == skill && s.dot == dot) {
                        Some(s) => s.boss.merge(tally),
                        None => p.skills.push(SkillStat { skill, dot, boss: *tally, ..Default::default() }),
                    }
                }
                let mut players: Vec<BossPlayer> = by.into_values().collect();
                for p in &mut players {
                    p.skills.sort_by_key(|s| (std::cmp::Reverse(s.boss.damage), s.skill, s.dot));
                }
                players.sort_by_key(|p| (std::cmp::Reverse(p.damage), p.id));
                FightBoss { code, first_ms: t.first_ms, last_ms: t.last_ms, damage: t.damage, my_damage: t.my_damage, my_skills, players }
            })
            .collect();
        bosses.sort_by_key(|b| (std::cmp::Reverse(b.damage), b.code));
        let effects = self.fight_effects(rec, &players, now);
        Some(Fight { id: rec.started_ms.to_string(), name: rec.name.clone(), started_ms: rec.started_ms, ended_ms: now, players, bosses, effects })
    }

    fn fight_effects(&self, rec: &Recording, players: &[FightPlayer], now: i64) -> FightEffects {
        let mut taken: HashMap<i32, (i64, bool)> = HashMap::new();
        for (&(target, _, boss), &n) in &rec.damage {
            let t = taken.entry(target).or_default();
            t.0 += n;
            t.1 |= boss;
        }
        let target = taken.into_iter().max_by_key(|&(id, (n, _))| (n, std::cmp::Reverse(id))).map(|(id, (_, boss))| (id, boss));
        let mut list = self.effects.uptimes(now, |id| target.is_some_and(|(t, _)| t == id) || players.iter().any(|p| p.id == id));
        for u in &mut list {
            u.caster = self.owner(u.caster);
        }
        FightEffects { target: target.map(|(t, _)| t), target_boss: target.is_some_and(|(_, boss)| boss), list }
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
    fn bosses_keep_their_time_and_your_skills() {
        let mut m = meter();
        m.start("x".into(), 0);
        for (e, at) in [
            (hit(ME, MOB, CLERIC, 30), 500),
            (hit(ME, BOSS, CLERIC + 3, 70), 1_000),
            (hit(MATE, BOSS, GLADIATOR, 200), 2_000),
            (hit(ME, BOSS, CLERIC + 7, 30), 4_000),
        ] {
            m.apply(e, at, false, named);
        }
        let f = m.stop(9_000).unwrap();
        assert_eq!(f.bosses.len(), 1);
        let b = &f.bosses[0];
        assert_eq!((b.code, b.first_ms, b.last_ms, b.damage, b.my_damage), (BOSS_CODE, 1_000, 4_000, 300, 100));
        assert_eq!(b.my_skills, vec![SkillDamage { skill: CLERIC, damage: 100, hits: 2 }]);
        let players: Vec<_> = b.players.iter().map(|p| (p.id, p.damage, p.skills.len())).collect();
        assert_eq!(players, [(MATE, 200, 1), (ME, 100, 1)]);
        assert_eq!(b.players[1].skills[0].boss, Tally { damage: 100, hits: 2, crits: 0, max_hit: 70 });
    }

    #[test]
    fn a_boss_entity_handed_to_another_npc_keeps_its_damage_as_boss() {
        let mut m = meter();
        m.start("x".into(), 0);
        m.apply(hit(ME, BOSS, CLERIC, 70), 500, false, named);
        // The boss died and the game gave its entity to a plain monster.
        m.apply(CombatEvent::Npc { id: BOSS, code: 2_000_002 }, 600, false, named);
        m.apply(hit(ME, BOSS, CLERIC, 30), 700, false, named);
        let f = m.stop(1_000).unwrap();
        let me = &f.players[0];
        assert_eq!((me.boss_damage, me.mob_damage), (70, 30));
        assert_eq!((me.skills[0].boss.damage, me.skills[0].mob.damage), (70, 30));
        assert_eq!((f.bosses[0].damage, f.bosses[0].my_damage), (70, 70));
        assert_eq!((f.effects.target, f.effects.target_boss), (Some(BOSS), true));
    }

    #[test]
    fn each_boss_keeps_everyones_damage_apart() {
        const OTHER: i32 = 9200;
        let mut m = Meter::new([BOSS_CODE, 2_301_300].into());
        for e in [
            CombatEvent::Me { id: ME, name: "Leozin".into(), class: Some(Class::Cleric) },
            CombatEvent::Player { id: MATE, name: "Amigo".into() },
            CombatEvent::Npc { id: BOSS, code: BOSS_CODE },
            CombatEvent::Npc { id: OTHER, code: 2_301_300 },
            CombatEvent::Summon { id: 555, owner: MATE },
        ] {
            m.apply(e, 0, false, named);
        }
        m.start("x".into(), 0);
        for e in [hit(ME, BOSS, CLERIC, 50), hit(555, BOSS, 2_100_000, 30), hit(MATE, OTHER, GLADIATOR, 500), hit(ME, OTHER, CLERIC, 10)] {
            m.apply(e, 500, false, named);
        }
        let f = m.stop(1_000).unwrap();
        let by = |code| f.bosses.iter().find(|b| b.code == code).unwrap().players.iter().map(|p| (p.id, p.damage)).collect::<Vec<_>>();
        assert_eq!(by(BOSS_CODE), [(ME, 50), (MATE, 30)], "a summon's damage is its owner's");
        assert_eq!(by(2_301_300), [(MATE, 500), (ME, 10)]);
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
    fn damage_taken_by_monster_and_skill() {
        let mut m = meter();
        m.start("x".into(), 0);
        for e in [
            hit(ME, BOSS, CLERIC, 70),
            hit(BOSS, ME, 2_301_001, 400),
            hit(BOSS, ME, 2_301_001, 600),
            hit(BOSS, ME, 2_301_002, 2_000),
            hit(MOB, ME, 2_000_100, 30),
            hit(BOSS, MATE, 2_301_001, 900),
            // A spawn the meter missed: code 0.
            hit(7777, ME, 2_000_100, 5),
        ] {
            m.apply(e, 500, false, named);
        }
        let f = m.stop(1_000).unwrap();
        let me = f.players.iter().find(|p| p.id == ME).unwrap();
        let rows: Vec<_> = me.taken.iter().map(|t| (t.npc, t.boss, t.skill, t.damage, t.hits, t.max_hit)).collect();
        assert_eq!(rows, vec![
            (BOSS_CODE, true, 2_301_002, 2_000, 1, 2_000),
            (BOSS_CODE, true, 2_301_001, 1_000, 2, 600),
            (2_000_002, false, 2_000_100, 30, 1, 30),
            (0, false, 2_000_100, 5, 1, 5),
        ]);
        // Taking damage is not dealing it.
        assert_eq!((me.boss_damage, me.mob_damage), (70, 0));
        let mate = f.players.iter().find(|p| p.id == MATE).unwrap();
        assert_eq!((mate.taken.len(), mate.taken[0].damage), (1, 900));
    }

    #[test]
    fn damage_taken_does_not_start_a_recording() {
        let mut m = meter();
        assert!(!m.apply(hit(BOSS, ME, 2_301_001, 400), 0, true, named));
        assert!(!m.recording());
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
    fn skill_uses_are_kept_per_player() {
        let mut m = meter();
        m.start("x".into(), 1_000);
        for (e, now) in [
            (hit(ME, MOB, CLERIC, 10), 1_000),
            (hit(ME, BOSS, CLERIC, 10), 1_000),
            // A heal on a mate is a use too.
            (hit(ME, MATE, CLERIC, 10), 9_000),
            (CombatEvent::Hit { actor: ME, target: MOB, skill: 17_030_000, value: 5, dot: true, crit: false }, 9_000),
            (hit(MATE, BOSS, GLADIATOR, 10), 2_000),
        ] {
            m.apply(e, now, false, named);
        }
        let f = m.current(10_000).unwrap();
        let me = f.players.iter().find(|p| p.id == ME).unwrap();
        assert_eq!(me.casts, vec![SkillCasts { skill: CLERIC, at: vec![0, 8_000] }]);
        assert_eq!(f.players.iter().find(|p| p.id == MATE).unwrap().casts[0].at, vec![1_000]);
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
    fn buffs_on_players_and_debuffs_on_the_main_target() {
        use crate::effects::Applied;
        let on = |entity, abnormal, caster| EffectRecord::Applied(Applied { entity, instance: 1, abnormal, length_ms: 60_000, end_ms: 60_000, caster, skill: None, fresh: true, new: true });
        let mut m = meter();
        m.apply_effect(on(ME, 1, ME), 0);
        m.start("x".into(), 1_000);
        m.apply(CombatEvent::Summon { id: 555, owner: ME }, 1_000, false, named);
        m.apply(hit(ME, MOB, CLERIC, 10), 1_000, false, named);
        m.apply(hit(MATE, BOSS, GLADIATOR, 500), 1_000, false, named);
        m.apply_effect(on(BOSS, 2, 555), 2_000);
        m.apply_effect(on(MOB, 3, ME), 2_000);
        let f = m.stop(5_000).unwrap();
        assert_eq!((f.effects.target, f.effects.target_boss), (Some(BOSS), true));
        let got: Vec<_> = f.effects.list.iter().map(|u| (u.entity, u.abnormal, u.caster, u.uptime_ms)).collect();
        assert_eq!(got, vec![(ME, 1, ME, 4_000), (BOSS, 2, ME, 3_000)]);
        m.start("y".into(), 6_000);
        m.apply(hit(ME, MOB, CLERIC, 10), 6_000, false, named);
        let got: Vec<_> = m.current(7_000).unwrap().effects.list.iter().map(|u| (u.entity, u.abnormal, u.uptime_ms)).collect();
        assert_eq!(got, vec![(ME, 1, 1_000), (MOB, 3, 1_000)], "a new recording counts from its start");
    }

    #[test]
    fn the_roster_puts_fighters_first_and_leaves_you_out() {
        let mut m = meter();
        m.apply(CombatEvent::Player { id: 300, name: "Passante".into() }, 5_000, false, named);
        m.apply(CombatEvent::Player { id: 301, name: "Antigo".into() }, 0, false, named);
        m.start("x".into(), 6_000);
        m.apply(hit(MATE, MOB, GLADIATOR, 50), 6_000, false, named);
        let names: Vec<_> = m.roster(1).into_iter().map(|p| (p.name, p.fighting)).collect();
        assert_eq!(names, [("Amigo".to_string(), true), ("Passante".to_string(), false)]);
        assert_eq!(m.roster(1)[0].class, Some(Class::Gladiator));
    }

    #[test]
    fn the_roster_lists_a_name_once() {
        let mut m = meter();
        m.apply(CombatEvent::Player { id: 400, name: "Amigo".into() }, 9_000, false, named);
        let list = m.roster(0);
        assert_eq!(list.iter().filter(|p| p.name == "Amigo").count(), 1);
        assert_eq!(list[0].seen_ms, 9_000);
    }

    #[test]
    fn names_are_cut_at_fifty() {
        let mut m = meter();
        m.start("a".repeat(80), 0);
        m.rename(&"é".repeat(60));
        assert_eq!(m.current(0).unwrap().name.chars().count(), NAME_MAX);
    }

    fn dot(actor: i32, target: i32, value: i64) -> CombatEvent {
        CombatEvent::Hit { actor, target, skill: CLERIC, value, dot: true, crit: false }
    }

    #[test]
    fn the_timeline_has_damage_by_second() {
        let mut m = meter();
        m.start("x".into(), 0);
        m.apply(CombatEvent::Summon { id: 555, owner: ME }, 0, false, named);
        m.apply(hit(ME, MOB, CLERIC, 10), 200, false, named);
        m.apply(hit(555, BOSS, 2_100_000, 5), 900, false, named);
        m.apply(hit(ME, MOB, CLERIC, 7), 2_500, false, named);
        let f = m.current(3_000).unwrap();
        assert_eq!(f.players[0].timeline, vec![15, 0, 7, 0]);
    }

    #[test]
    fn standing_still_is_three_seconds_without_your_own_hits() {
        let mut m = meter();
        m.start("x".into(), 0);
        m.apply(CombatEvent::Summon { id: 555, owner: ME }, 0, false, named);
        for (at, e) in [
            // 0..4 s: the button, then nothing.
            (4_000, hit(ME, MOB, CLERIC, 10)),
            (6_000, hit(ME, MOB, CLERIC, 10)),
            // Your summon and your damage over time don't make you act.
            (7_000, hit(555, MOB, 2_100_000, 10)),
            (8_000, dot(ME, MOB, 10)),
            // A heal on a mate does.
            (10_000, hit(ME, MATE, CLERIC, 10)),
            (11_000, hit(ME, MOB, CLERIC, 10)),
        ] {
            m.apply(e, at, false, named);
        }
        let me = m.stop(20_000).unwrap().players.into_iter().find(|p| p.id == ME).unwrap();
        assert_eq!(me.idle, vec![[0, 4_000], [6_000, 10_000], [11_000, 20_000]]);
        assert_eq!(me.idle_ms, 17_000);
    }

    #[test]
    fn an_automatic_recording_starts_and_ends_on_a_hit() {
        let mut m = meter();
        m.apply(hit(ME, MOB, CLERIC, 10), 1_000, true, named);
        m.apply(hit(ME, MOB, CLERIC, 10), 3_000, true, named);
        let f = m.tick(3_000 + IDLE_END_MS).unwrap();
        assert_eq!((f.players[0].idle_ms, f.players[0].timeline.len()), (0, 3));
    }

    #[test]
    fn clearing_starts_a_recording_by_hand_over() {
        let mut m = meter();
        m.start("Treino".into(), 0);
        m.apply(hit(ME, MOB, CLERIC, 10), 1_000, false, named);
        m.clear(2_000);
        let f = m.current(2_000).unwrap();
        assert_eq!((f.name.as_str(), f.started_ms, f.players.len()), ("Treino", 2_000, 0));
        m.apply(hit(ME, MOB, CLERIC, 7), 3_000, false, named);
        assert_eq!(m.stop(4_000).unwrap().players[0].mob_damage, 7);
    }

    #[test]
    fn clearing_an_automatic_recording_waits_for_the_next_hit() {
        let mut m = meter();
        m.apply(hit(ME, MOB, CLERIC, 10), 1_000, true, named);
        m.clear(2_000);
        assert!(!m.recording() && m.tick(2_000 + IDLE_END_MS).is_none());
        m.apply(hit(ME, MOB, CLERIC, 4), 3_000, true, named);
        assert_eq!(m.current(3_000).unwrap().players[0].mob_damage, 4);
    }

    #[test]
    fn old_recordings_read_without_a_timeline() {
        let p: FightPlayer = serde_json::from_str(r#"{"id":1,"name":"a","boss_damage":5}"#).unwrap();
        assert!(p.timeline.is_empty() && p.idle.is_empty());
    }

    #[test]
    fn file_names_windows_accepts() {
        assert_eq!(file_name("Leozin 21/10 22:05 #K3P"), "Leozin 21-10 22-05 K3P");
        assert_eq!(file_name(" a<b>\"c\"?* . "), "abc");
        assert_eq!(file_name("..."), "Luta");
        assert_eq!(file_name("Ação com Ñ"), "Ação com Ñ");
    }
}
