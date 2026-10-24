//! Combat as the game sends it: who hit whom with what, who healed, and who
//! everyone is. Kiskwatch's own reading of the records; the layouts are the
//! ones A2Tools DPS Meter (GPL-3.0) documents in its stream processor.
//!
//! ```text
//! 04 38  hits, one after another, each after the first led by 01 00:
//!        <target> <switch> <varint> <actor> <skill u32> <u8> <hit type>
//!        <layout bytes> [<power scalar>] <value> <tail>
//! 05 38  a damage-over-time or healing tick:
//!        <target> <effect u8> <actor> <varint> <skill u32 × 100> <amount>
//! 33 36  you:      <id> <mask u32> <mask2 u8> <len u8> <name> <server u16> <class u32>
//! 45 36  a player: <id> <mask u32> <mask2 u8> <len u8> <name>   (44 36 before June 2026)
//! 41 36  an NPC or a summon: <id> <mask u32> …, the NPC code (u24) before
//!        00 40 02 or 00 00 02, and a summon's owner after its legion block
//!        (40 36 before June 2026)
//! 42 36  an entity leaving: <id> <varint> <flag>; 7 is a summon unsummoned
//! ```
//!
//! An Elementalist's spirit and its master trade `04 38` records every second
//! that are neither damage nor healing: 1699xxxx from the spirit to its
//! master, 1677xxxx from the master to the spirit. They tie the spirit to its
//! master even when its spawn went unseen (Daevalog documents the pair).
//!
//! Ids and values are varints unless marked; numbers are little-endian.

use std::collections::HashSet;
use std::sync::OnceLock;

use crate::varint::read_varint;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CombatEvent {
    /// A hit, or a healing spell landing on a player (the `04 38` record is
    /// the same: the meter tells them apart by who the target is).
    Hit { actor: i32, target: i32, skill: i32, value: i64, dot: bool, crit: bool },
    /// A healing tick, or a player healing themselves.
    Heal { actor: i32, target: i32, amount: i64 },
    /// You: your entity, name and class.
    Me { id: i32, name: String, class: Option<Class> },
    Player { id: i32, name: String },
    /// An NPC spawned, with its code.
    Npc { id: i32, code: i32 },
    /// A summon, a spirit or a lingering spell, and the player it is from.
    Summon { id: i32, owner: i32 },
    /// A summon unsummoned: its damage over time stops counting.
    Unsummoned { id: i32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum Class {
    Gladiator,
    Templar,
    Assassin,
    Ranger,
    Sorcerer,
    Elementalist,
    Cleric,
    Chanter,
}

impl Class {
    /// A player skill's class: the first two of its eight digits.
    pub fn of_skill(skill: i32) -> Option<Class> {
        if !(10_000_000..=19_999_999).contains(&skill) || (skill / 10_000) % 100 == 0 {
            return None;
        }
        Some(match skill / 1_000_000 {
            11 => Class::Gladiator,
            12 => Class::Templar,
            13 => Class::Assassin,
            14 => Class::Ranger,
            15 => Class::Sorcerer,
            16 => Class::Elementalist,
            17 => Class::Cleric,
            18 => Class::Chanter,
            _ => return None,
        })
    }

    /// The class field of your own record: four values per class.
    fn of_record(value: u32) -> Option<Class> {
        Some(match value {
            5..=8 => Class::Gladiator,
            9..=12 => Class::Templar,
            13..=16 => Class::Ranger,
            17..=20 => Class::Assassin,
            21..=24 => Class::Elementalist,
            25..=28 => Class::Sorcerer,
            29..=32 => Class::Cleric,
            33..=36 => Class::Chanter,
            _ => return None,
        })
    }
}

/// The skill a code is a version of: a player skill's last four digits are
/// the specializations it was used with (17010230 is 17010000, the id the
/// profile and dbaion2 know it by). Other codes stay as they are.
pub fn base_skill(skill: i32) -> i32 {
    if (10_000_000..=19_999_999).contains(&skill) { skill / 10_000 * 10_000 } else { skill }
}

/// What a skill's ticks are, from the game's data (`data/combat.json`).
#[derive(Debug, Clone, Default)]
pub struct SkillLists {
    /// Skills whose `05 38` damage ticks are their own damage (the others
    /// repeat what a `04 38` already counted).
    pub dots: HashSet<i32>,
    /// Skills that restore MP or another resource, never HP: not healing.
    pub resource: HashSet<i32>,
}

/// `data/combat.json`, built by `scripts/import-a2tools-combat.mjs`.
#[derive(serde::Deserialize)]
struct Bundled {
    dots: Vec<i32>,
    resource: Vec<i32>,
    bosses: Vec<i32>,
}

fn bundled() -> &'static Bundled {
    static DATA: OnceLock<Bundled> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(include_str!("../../../data/combat.json")).expect("data/combat.json"))
}

impl SkillLists {
    pub fn bundled() -> Self {
        let b = bundled();
        Self { dots: b.dots.iter().copied().collect(), resource: b.resource.iter().copied().collect() }
    }
}

/// The NPC codes of bosses.
pub fn boss_codes() -> HashSet<i32> {
    bundled().bosses.iter().copied().collect()
}

/// Reads the combat records out of whole packets.
#[derive(Debug, Default)]
pub struct Reader {
    lists: SkillLists,
    /// Entities a spawn or identity record confirmed: their ids may be small.
    known: HashSet<i32>,
}

/// The longest name field: 12 characters of up to 4 bytes.
const NAME_BYTES: std::ops::RangeInclusive<usize> = 1..=48;

fn varint(b: &[u8], pos: &mut usize) -> Option<i32> {
    let v = read_varint(b, *pos);
    (v.length > 0).then(|| {
        *pos += v.length as usize;
        v.value
    })
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// A character name: the whole field, 1 to 12 letters and digits.
fn name(field: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(field).ok()?;
    let n = s.chars().count();
    ((1..=12).contains(&n) && s.chars().all(char::is_alphanumeric) && s.chars().any(char::is_alphabetic)).then(|| s.to_string())
}

/// The opcode of a whole packet, right after its length varint.
fn opcode(packet: &[u8]) -> Option<(usize, [u8; 2])> {
    let len = read_varint(packet, 0);
    let at = usize::try_from(len.length).ok()?;
    Some((at + 2, [*packet.get(at)?, *packet.get(at + 1)?]))
}

/// The `42 36` flag of a summon leaving the world.
const UNSUMMONED: i32 = 7;

/// `(spirit, master)` when a skill is one of the link records between them.
fn spirit_link(skill: i32, actor: i32, target: i32) -> Option<(i32, i32)> {
    match skill {
        16_990_000..=16_999_999 => Some((actor, target)),
        16_770_000..=16_779_999 => Some((target, actor)),
        _ => None,
    }
}

/// A summon's entity id as its spawn states a large one.
fn spawn_id(id: i32) -> i32 {
    if id > 1_000_000 { (id & 0x3FFF) | 0x4000 } else { id }
}

impl Reader {
    pub fn new(lists: SkillLists) -> Self {
        Self { lists, known: HashSet::new() }
    }

    fn plausible(&self, id: i32) -> bool {
        id >= 100 || (id > 0 && self.known.contains(&id))
    }

    /// Everything a whole packet (length varint included) says.
    pub fn read(&mut self, packet: &[u8]) -> Vec<CombatEvent> {
        let mut out = Vec::new();
        match opcode(packet) {
            Some((at, [0x04, 0x38])) => self.hits(packet, at, &mut out),
            Some((at, [0x05, 0x38])) => self.tick(packet, at, &mut out),
            Some((mut at, [0x42, 0x36])) => {
                if let (Some(id), Some(_), Some(UNSUMMONED)) = (varint(packet, &mut at), varint(packet, &mut at), varint(packet, &mut at)) {
                    out.push(CombatEvent::Unsummoned { id });
                }
            }
            _ => {}
        }
        // Identity and spawn records also sit inside other packets.
        self.records(packet, &mut out);
        out
    }

    fn hits(&self, p: &[u8], mut at: usize, out: &mut Vec<CombatEvent>) {
        let mut first = true;
        while at < p.len() {
            if !first {
                if p.get(at..at + 2) != Some(&[0x01, 0x00]) {
                    return;
                }
                at += 2;
            }
            first = false;
            let Some(end) = self.hit(p, at, out) else { return };
            at = end;
        }
    }

    /// One `04 38` hit; where the next one starts, if this one ends cleanly.
    fn hit(&self, p: &[u8], mut at: usize, out: &mut Vec<CombatEvent>) -> Option<usize> {
        let target = varint(p, &mut at).filter(|&t| self.plausible(t))?;
        let switch = varint(p, &mut at)?;
        let layout = switch & 0x0F;
        if !(4..=7).contains(&layout) {
            // 0 and 2: a miss or a resist, with nothing after.
            return None;
        }
        varint(p, &mut at)?;
        let actor = varint(p, &mut at).filter(|&a| self.plausible(a))?;
        let mut skill = u32_at(p, at)? as i64;
        at += 4;
        // Theostones send their item id.
        if (3_000_000..=3_099_999).contains(&skill) {
            skill = skill * 10 + 1;
        }
        if !(1..=299_999_999).contains(&skill) {
            return None;
        }
        let skill = skill as i32;
        at += 1;
        let crit = varint(p, &mut at)? == 3;
        // The layout's fixed bytes; layouts 6 and 7 carry a plotter whose
        // HP field is a varint the fixed count takes as one byte.
        let mut skip = match layout {
            5 => 12,
            6 => 10,
            7 => 14,
            _ => 8,
        };
        if layout & 0x02 != 0 {
            let mut hp = at + 1;
            varint(p, &mut hp)?;
            skip += hp - at - 2;
        }
        at += skip;
        // The actor's power scalar, then the value; since June 2026 a zero
        // comes first.
        let lead = varint(p, &mut at)?;
        let mut value = varint(p, &mut at)?;
        if lead == 0 {
            value = varint(p, &mut at)?;
        }
        if !(0..=99_999_999).contains(&value) {
            return None;
        }
        // A monster's skill (seven digits): damage a player took, not done;
        // the meter tells them apart by who the actor is.
        let npc = (1_000_000..=9_999_999).contains(&skill);
        if let Some((id, owner)) = spirit_link(skill, actor, target).filter(|(id, owner)| id != owner) {
            out.push(CombatEvent::Summon { id, owner });
        } else if npc {
            if actor != target && value > 0 {
                out.push(CombatEvent::Hit { actor, target, skill, value: value.into(), dot: false, crit });
            }
        } else if !self.lists.resource.contains(&skill) {
            if actor != target {
                out.push(CombatEvent::Hit { actor, target, skill, value: value.into(), dot: false, crit });
            } else if value > 1 {
                out.push(CombatEvent::Heal { actor, target, amount: value.into() });
            }
        }
        // The next hit of the packet (a monster's area attack hits several
        // players in one) follows a tail of a known shape only.
        if !(layout == 4 || layout == 6) {
            return None;
        }
        tail(p, at, layout, switch, value).or_else(|| (layout == 4).then(|| tail(p, at, 6, switch, value)).flatten())
    }

    fn tick(&self, p: &[u8], mut at: usize, out: &mut Vec<CombatEvent>) {
        let Some(target) = varint(p, &mut at) else { return };
        let Some(&effect) = p.get(at) else { return };
        at += 1;
        // 02/0A damage (06/0E into a shield), 01/09 heal, 0B heal over time.
        let damage = matches!(effect, 0x02 | 0x0A | 0x06 | 0x0E);
        let heal = matches!(effect, 0x01 | 0x09 | 0x0B);
        if !damage && !heal {
            return;
        }
        let Some(actor) = varint(p, &mut at) else { return };
        if varint(p, &mut at).is_none() {
            return;
        }
        let Some(raw) = u32_at(p, at) else { return };
        at += 4;
        let skill = (raw / 100) as i32;
        let Some(amount) = varint(p, &mut at).filter(|a| (1..=99_999_999).contains(a)) else { return };
        if heal {
            out.push(CombatEvent::Heal { actor, target, amount: amount.into() });
        } else if actor != target && self.lists.dots.contains(&skill) {
            out.push(CombatEvent::Hit { actor, target, skill, value: amount.into(), dot: true, crit: false });
        }
    }

    /// Identity and spawn records anywhere in the packet.
    fn records(&mut self, p: &[u8], out: &mut Vec<CombatEvent>) {
        let mut i = 0;
        while i + 8 < p.len() {
            if p[i + 1] != 0x36 {
                i += 1;
                continue;
            }
            let read = match p[i] {
                0x33 => self.person(p, i, true),
                0x44 | 0x45 => self.person(p, i, false),
                // A spawn opcode after a zero is a value's last bytes.
                0x40 | 0x41 if i == 0 || p[i - 1] != 0x00 => self.spawn(p, i),
                _ => None,
            };
            match read {
                Some((end, events)) => {
                    out.extend(events);
                    i = end.max(i + 2);
                }
                None => i += 1,
            }
        }
    }

    /// `33 36` (you) or `45 36` (another player).
    fn person(&mut self, p: &[u8], i: usize, me: bool) -> Option<(usize, Vec<CombatEvent>)> {
        let mut at = i + 2;
        let id = varint(p, &mut at).filter(|id| (1..=9_999_999).contains(id))?;
        let mask2 = at + 4;
        if p.get(mask2)? & 0x01 == 0 {
            return None;
        }
        let len = *p.get(mask2 + 1)? as usize;
        let field = mask2 + 2..mask2 + 2 + len;
        if !NAME_BYTES.contains(&len) || field.end > p.len() {
            return None;
        }
        let who = name(&p[field.clone()])?;
        let end = field.end;
        let event = if me {
            // Your server (1000 to 2999) and class follow the name; without
            // them this is not your record.
            let server = u16::from_le_bytes(p.get(end..end + 2)?.try_into().ok()?);
            if !(1000..3000).contains(&server) {
                return None;
            }
            let class = u32_at(p, end + 2).and_then(Class::of_record);
            CombatEvent::Me { id, name: who, class }
        } else {
            CombatEvent::Player { id, name: who }
        };
        self.known.insert(id);
        Some((end, vec![event]))
    }

    /// `41 36`: an NPC (its code) or a summon (its owner).
    fn spawn(&mut self, p: &[u8], i: usize) -> Option<(usize, Vec<CombatEvent>)> {
        let mut at = i + 2;
        let raw = varint(p, &mut at).filter(|id| (100..=9_999_999).contains(id))?;
        let id = spawn_id(raw);
        let kind = *p.get(at)?;
        let mask = u32_at(p, at).unwrap_or(0);
        self.known.insert(id);
        let mut events = Vec::new();
        // The NPC code: three bytes before 00 40 02 (or 00 00 02).
        let window = &p[at..p.len().min(at + 63)];
        if let Some(k) = window.windows(3).position(|w| w[0] == 0 && (w[1] == 0x40 || w[1] == 0) && w[2] == 0x02).filter(|&k| k >= 3) {
            let c = at + k;
            let code = p[c - 3] as i32 | (p[c - 2] as i32) << 8 | (p[c - 1] as i32) << 16;
            events.push(CombatEvent::Npc { id, code });
        }
        // A summon (kind 5F) with a parent key: its owner, in the block
        // <owner u32> <legion u32> <00 00> <server u16> <len u8> <legion name>
        // that follows a 06.
        if kind == 0x5F && mask & 0x10 != 0 {
            let end = p.len().min(at + 400);
            if let Some(owner) = (at + 1..end.saturating_sub(12)).find_map(|j| (p[j - 1] == 0x06).then(|| owner_block(p, j, id)).flatten()) {
                self.known.insert(owner);
                events.push(CombatEvent::Summon { id, owner });
            }
        }
        (!events.is_empty()).then_some((at, events))
    }
}

/// The owner block of a summon's spawn at `at`.
fn owner_block(p: &[u8], at: usize, id: i32) -> Option<i32> {
    let owner = u32_at(p, at)? as i32;
    if owner <= 0 || owner > 9_999_999 || owner == id {
        return None;
    }
    if p.get(at + 8..at + 10)? != [0, 0] {
        return None;
    }
    let server = u16::from_le_bytes(p.get(at + 10..at + 12)?.try_into().ok()?);
    let len = *p.get(at + 12)? as usize;
    if server == 0 || server > 9_999 || len > 40 {
        return None;
    }
    std::str::from_utf8(p.get(at + 13..at + 13 + len)?).ok()?;
    Some(owner)
}

/// Where a hit's tail ends, if it ends cleanly: layout 4 has a count field,
/// switch bit 0x20 the extra hits (already in the value), bit 0x40 the
/// shields that absorbed part of it.
fn tail(p: &[u8], mut at: usize, layout: i32, switch: i32, value: i32) -> Option<usize> {
    if layout == 4 && !(1..=25).contains(&varint(p, &mut at)?) {
        return None;
    }
    if switch & 0x20 != 0 {
        let count = varint(p, &mut at)?;
        if !(1..=25).contains(&count) {
            return None;
        }
        let mut sum = 0i64;
        for _ in 0..count {
            let hit = varint(p, &mut at)?;
            if hit < 0 {
                return None;
            }
            sum += i64::from(hit);
        }
        if sum >= i64::from(value) {
            return None;
        }
    }
    if switch & 0x40 != 0 {
        let absorbed = varint(p, &mut at)?;
        if !(1..=8).contains(&absorbed) {
            return None;
        }
        at += 4 * absorbed as usize;
        if at > p.len() {
            return None;
        }
    }
    // Life steal: 03 00 and what it healed.
    if p.get(at..at + 2) == Some(&[0x03, 0x00]) {
        at += 2;
        varint(p, &mut at)?;
    }
    let rest = &p[at.min(p.len())..];
    let clean = rest.is_empty() || rest.starts_with(&[0x01, 0x00]) || (rest.len() >= 2 && rest[1] == 0 && (1..=7).contains(&rest[0]));
    clean.then_some(at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::length_value;

    fn var(mut v: u32) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let b = (v & 0x7F) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return out;
            }
            out.push(b | 0x80);
        }
    }

    fn packet(body: &[u8]) -> Vec<u8> {
        [var(length_value(body.len())), body.to_vec()].concat()
    }

    /// A layout-4 hit, the June 2026 way (zero, scalar, value) with a count field.
    fn hit(target: u32, actor: u32, skill: u32, value: u32) -> Vec<u8> {
        [var(target), var(0x04), var(0), var(actor), skill.to_le_bytes().to_vec(), vec![0], var(1), vec![0; 8], var(0), var(18000), var(value), var(1)].concat()
    }

    #[test]
    fn reads_a_hit() {
        let p = packet(&[&[0x04, 0x38][..], &hit(5000, 4715, 17_010_000, 1234)].concat());
        assert_eq!(Reader::default().read(&p), vec![CombatEvent::Hit { actor: 4715, target: 5000, skill: 17_010_000, value: 1234, dot: false, crit: false }]);
    }

    #[test]
    fn reads_a_critical() {
        let mut body = hit(5000, 4715, 17_010_000, 1234);
        // The hit type follows the skill and its byte.
        let at = var(5000).len() + 2 + var(4715).len() + 4 + 1;
        body[at] = 3;
        let p = packet(&[&[0x04, 0x38][..], &body].concat());
        assert_eq!(Reader::default().read(&p), vec![CombatEvent::Hit { actor: 4715, target: 5000, skill: 17_010_000, value: 1234, dot: false, crit: true }]);
    }

    #[test]
    fn base_skills_drop_the_specializations() {
        assert_eq!(base_skill(17_010_230), 17_010_000);
        assert_eq!(base_skill(30_000_011), 30_000_011, "a theostone");
    }

    #[test]
    fn reads_chained_hits() {
        let body = [&[0x04, 0x38][..], &hit(5000, 4715, 17_010_000, 10), &[0x01, 0x00], &hit(5001, 4715, 17_010_000, 20)].concat();
        let events = Reader::default().read(&packet(&body));
        assert_eq!(events.len(), 2);
        assert_eq!(events[1], CombatEvent::Hit { actor: 4715, target: 5001, skill: 17_010_000, value: 20, dot: false, crit: false });
    }

    #[test]
    fn a_monster_hitting_you_comes_with_its_skill() {
        let p = packet(&[&[0x04, 0x38][..], &hit(4715, 5000, 2_000_100, 99)].concat());
        assert_eq!(Reader::default().read(&p), vec![CombatEvent::Hit { actor: 5000, target: 4715, skill: 2_000_100, value: 99, dot: false, crit: false }]);
    }

    /// Gatekeeper Pinopi (entity 47573) hitting a player (9681) for 1,258
    /// with its skill 1607550, as A2Tools recorded it on 2026-10-15.
    #[test]
    fn reads_a_bosss_hit_on_a_player() {
        let body: Vec<u8> = (0..58).step_by(2).map(|i| u8::from_str_radix(&"D14B0600D5F3027E871800020202000243ED940901000000904EEA090100"[i..i + 2], 16).unwrap()).collect();
        let p = packet(&[&[0x04, 0x38][..], &body].concat());
        assert_eq!(Reader::default().read(&p), vec![CombatEvent::Hit { actor: 47573, target: 9681, skill: 1_607_550, value: 1258, dot: false, crit: false }]);
    }

    #[test]
    fn a_monsters_hits_on_several_players_are_all_read() {
        let body = [&[0x04, 0x38][..], &hit(4715, 5000, 2_000_100, 99), &[0x01, 0x00], &hit(4716, 5000, 2_000_100, 98)].concat();
        let events = Reader::default().read(&packet(&body));
        assert_eq!(
            events,
            vec![
                CombatEvent::Hit { actor: 5000, target: 4715, skill: 2_000_100, value: 99, dot: false, crit: false },
                CombatEvent::Hit { actor: 5000, target: 4716, skill: 2_000_100, value: 98, dot: false, crit: false },
            ]
        );
    }

    #[test]
    fn a_spirits_link_records_tie_it_to_its_master() {
        let from_spirit = packet(&[&[0x04, 0x38][..], &hit(4715, 9100, 16_990_003, 1500)].concat());
        assert_eq!(Reader::default().read(&from_spirit), vec![CombatEvent::Summon { id: 9100, owner: 4715 }]);
        let to_spirit = packet(&[&[0x04, 0x38][..], &hit(9100, 4715, 16_770_001, 200)].concat());
        assert_eq!(Reader::default().read(&to_spirit), vec![CombatEvent::Summon { id: 9100, owner: 4715 }]);
    }

    #[test]
    fn reads_a_summon_leaving() {
        let p = |flag: u32| packet(&[&[0x42, 0x36][..], &var(9100), &var(0), &var(flag)].concat());
        assert_eq!(Reader::default().read(&p(7)), vec![CombatEvent::Unsummoned { id: 9100 }]);
        assert!(Reader::default().read(&p(3)).is_empty(), "killed, not unsummoned");
    }

    #[test]
    fn a_self_cast_is_a_heal() {
        let p = packet(&[&[0x04, 0x38][..], &hit(4715, 4715, 17_020_000, 800)].concat());
        assert_eq!(Reader::default().read(&p), vec![CombatEvent::Heal { actor: 4715, target: 4715, amount: 800 }]);
    }

    #[test]
    fn reads_ticks() {
        let tick = |effect: u8, skill: u32| packet(&[&[0x05, 0x38][..], &var(4800), &[effect], &var(4715), &var(0), &(skill * 100).to_le_bytes(), &var(300)].concat());
        let mut r = Reader::new(SkillLists { dots: [17_030_000].into(), resource: HashSet::new() });
        assert_eq!(r.read(&tick(0x0B, 17_040_000)), vec![CombatEvent::Heal { actor: 4715, target: 4800, amount: 300 }]);
        assert_eq!(r.read(&tick(0x02, 17_030_000)), vec![CombatEvent::Hit { actor: 4715, target: 4800, skill: 17_030_000, value: 300, dot: true, crit: false }]);
        assert!(r.read(&tick(0x02, 17_050_000)).is_empty(), "not a damage-over-time skill");
    }

    #[test]
    fn reads_you_and_other_players_anywhere() {
        let me = [&[0x33, 0x36][..], &var(4715), &[0, 0, 0, 0, 0x01, 6], b"Leozin", &1406u16.to_le_bytes(), &32u32.to_le_bytes()].concat();
        let mate = [&[0x45, 0x36][..], &var(5123), &[0, 0, 0, 0, 0x01, 5], b"Amigo"].concat();
        let p = packet(&[&[0x99, 0x37, 0x11][..], &me, &[0x22], &mate, &[0, 0, 0, 0, 0, 0, 0, 0, 0]].concat());
        assert_eq!(
            Reader::default().read(&p),
            vec![CombatEvent::Me { id: 4715, name: "Leozin".into(), class: Some(Class::Cleric) }, CombatEvent::Player { id: 5123, name: "Amigo".into() }]
        );
    }

    #[test]
    fn reads_npcs_and_summon_owners() {
        let npc = [&[0x41, 0x36][..], &var(9001), &[0x0C, 0, 0, 0, 0, 0x7B, 0x1F, 0x23, 0, 0x40, 0x02], &[0; 8]].concat();
        let events = Reader::default().read(&packet(&[&[0x10, 0x37][..], &npc].concat()));
        assert_eq!(events, vec![CombatEvent::Npc { id: 9001, code: 0x231F7B }]);
        let summon = [&[0x41, 0x36][..], &var(9100), &[0x5F, 0x10, 0, 0, 0, 0x06], &4715u32.to_le_bytes(), &[0; 4], &[0, 0], &1406u16.to_le_bytes(), &[0], &[0; 8]].concat();
        let events = Reader::default().read(&packet(&[&[0x10, 0x37][..], &summon].concat()));
        assert_eq!(events, vec![CombatEvent::Summon { id: 9100, owner: 4715 }]);
    }

    #[test]
    fn classes_come_from_skills() {
        assert_eq!(Class::of_skill(17_010_000), Some(Class::Cleric));
        assert_eq!(Class::of_skill(11_000_000), None, "a monster's copy");
        assert_eq!(Class::of_skill(2_000_100), None);
    }
}
