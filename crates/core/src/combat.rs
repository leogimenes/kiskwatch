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
//! 00 8D  an entity's HP: <id> <groups u8>, then per group bit (01: four-byte
//!        values, 02: eight-byte) <n u8> and n × <kind u8> <value>; the
//!        current HP is the eight-byte kind 0
//! 1B 92  a party member's HP, at any distance: <id> <hp> <max hp> …
//! 21 8D  into or out of combat: <id> 00 01 / 00 00, or 01 01 <u64 ms> into
//!        combat with the boss's enrage deadline (unix ms)
//! ```
//!
//! A hit's switch says its layout (low nibble): 0 and 2 carry no value (a
//! miss, hit type 1, or a resist, hit type 6), 4 to 7 one; 6 and 7 carry a
//! plotter after the hit type: <flags u8> <hp> <angle u8>, the flags how it
//! was taken (01 shield block, 02 parry, 04 perfect, 08 double, 10 iron wall,
//! 20 regeneration, 40 perfect block) and the angle where from (01 back, 02
//! front). A spawn has its HP, `01 <hp> <max hp>`, after the NPC code.
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
    Hit { actor: i32, target: i32, skill: i32, value: i64, dot: bool, crit: bool, marks: u16 },
    /// A miss or a resist: no damage.
    NoDamage { actor: i32, target: i32, skill: i32, resist: bool },
    /// An entity's HP now, and its most when the record says.
    Hp { id: i32, hp: Option<i64>, max: Option<i64> },
    /// An entity going into combat (a boss with a timed enrage gets the
    /// deadline, unix ms) or out of it.
    Combat { id: i32, on: bool, enrage_ms: Option<i64> },
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

/// How a hit landed (`CombatEvent::Hit::marks`).
pub mod mark {
    pub const BACK: u16 = 1;
    pub const FRONT: u16 = 1 << 1;
    pub const SHIELD_BLOCK: u16 = 1 << 2;
    pub const PARRY: u16 = 1 << 3;
    pub const PERFECT: u16 = 1 << 4;
    pub const DOUBLE: u16 = 1 << 5;
    pub const IRON_WALL: u16 = 1 << 6;
    pub const REGENERATION: u16 = 1 << 7;
    pub const PERFECT_BLOCK: u16 = 1 << 8;

    /// From a plotter's flags and angle bytes.
    pub fn of(flags: u8, angle: u8) -> u16 {
        let taken = [SHIELD_BLOCK, PARRY, PERFECT, DOUBLE, IRON_WALL, REGENERATION, PERFECT_BLOCK];
        let mut marks = taken.iter().enumerate().filter(|(i, _)| flags & (1 << i) != 0).fold(0, |m, (_, b)| m | b);
        match angle {
            0x01 => marks |= BACK,
            0x02 => marks |= FRONT,
            _ => {}
        }
        marks
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
    /// The actor and skill of the bundle's compact record, for the summed
    /// hit that may follow it in the same bundle.
    compact: Option<(i32, i32)>,
}

/// The skill code of a hit that sums several of one cast: its real skill
/// is in a compact record before it in the same bundle,
/// `08 3B 38 00 00` (or `08 3D 38 00 00`), then `38 <actor> <u8> <skill>`,
/// the skill four bytes or three (Daevalog documents both).
const SUMMED_SKILL: i32 = 99_745_942;
const COMPACT_MARKERS: [[u8; 5]; 2] = [[0x08, 0x3B, 0x38, 0x00, 0x00], [0x08, 0x3D, 0x38, 0x00, 0x00]];

/// A player's skill or a theostone's: what a compact record can name.
fn player_skill(code: i32) -> bool {
    Class::of_skill(code).is_some() || (30_000_000..=30_999_999).contains(&code)
}

/// The actor and skill of a compact record in a packet, if it has one.
fn compact_record(p: &[u8]) -> Option<(i32, i32)> {
    let marker = p.windows(5).position(|w| COMPACT_MARKERS.iter().any(|m| w == m))? + 5;
    let mut at = marker + p[marker..].iter().position(|&b| b == 0x38)? + 1;
    let actor = varint(p, &mut at).filter(|&a| a >= 100)?;
    let skill = p.get(at + 1..)?;
    let four = u32_at(skill, 0).map(|c| c as i32);
    let three = (skill.len() >= 3).then(|| i32::from(skill[0]) | i32::from(skill[1]) << 8 | i32::from(skill[2]) << 16);
    four.into_iter().chain(three).find(|&c| player_skill(c)).map(|c| (actor, c))
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
        Self { lists, known: HashSet::new(), compact: None }
    }

    fn plausible(&self, id: i32) -> bool {
        id >= 100 || (id > 0 && self.known.contains(&id))
    }

    /// Everything a whole packet (length varint included) says.
    pub fn read(&mut self, packet: &[u8]) -> Vec<CombatEvent> {
        let mut out = Vec::new();
        if let Some(found) = compact_record(packet) {
            self.compact = Some(found);
        }
        match opcode(packet) {
            Some((at, [0x04, 0x38])) => self.hits(packet, at, &mut out),
            Some((at, [0x05, 0x38])) => self.tick(packet, at, &mut out),
            Some((at, [0x00, 0x8D])) => out.extend(hp_record(packet, at)),
            Some((mut at, [0x1B, 0x92])) => {
                if let (Some(id), Some(hp), Some(max)) = (varint(packet, &mut at), varint(packet, &mut at), varint(packet, &mut at))
                    && ENTITY_IDS.contains(&id)
                    && (1..=50_000_000).contains(&max)
                    && (0..=max).contains(&hp)
                {
                    out.push(CombatEvent::Hp { id, hp: Some(hp.into()), max: Some(max.into()) });
                }
            }
            Some((mut at, [0x21, 0x8D])) => {
                if let Some(id) = varint(packet, &mut at).filter(|id| ENTITY_IDS.contains(id)) {
                    match &packet[at..] {
                        [0, on @ (0 | 1)] => out.push(CombatEvent::Combat { id, on: *on == 1, enrage_ms: None }),
                        [1, 1, deadline @ ..] if deadline.len() == 8 => {
                            let deadline = i64::from_le_bytes(deadline.try_into().expect("8 bytes"));
                            out.push(CombatEvent::Combat { id, on: true, enrage_ms: Some(deadline) });
                        }
                        _ => {}
                    }
                }
            }
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

    fn hits(&mut self, p: &[u8], mut at: usize, out: &mut Vec<CombatEvent>) {
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

    /// A bundle opens or closes: a compact record counts only inside its own.
    pub fn bundle_edge(&mut self) {
        self.compact = None;
    }

    /// One `04 38` hit; where the next one starts, if this one ends cleanly.
    fn hit(&mut self, p: &[u8], mut at: usize, out: &mut Vec<CombatEvent>) -> Option<usize> {
        let target = varint(p, &mut at).filter(|&t| self.plausible(t))?;
        let switch = varint(p, &mut at)?;
        let layout = switch & 0x0F;
        if !matches!(layout, 0 | 2 | 4..=7) {
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
        let mut skill = skill as i32;
        if skill == SUMMED_SKILL
            && let Some((_, real)) = self.compact.filter(|&(by, _)| by == actor)
        {
            skill = real;
            // Once: the context goes with it.
            self.compact = None;
        }
        at += 1;
        let hit_type = varint(p, &mut at)?;
        if layout < 4 {
            // A miss or a resist, with nothing after.
            let resist = match hit_type {
                1 => false,
                6 => true,
                _ => return None,
            };
            if actor != target && !self.lists.resource.contains(&skill) && spirit_link(skill, actor, target).is_none() {
                out.push(CombatEvent::NoDamage { actor, target, skill, resist });
            }
            return None;
        }
        let crit = hit_type == 3;
        let mut marks = 0;
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
            marks = mark::of(p[at], p.get(hp).copied().unwrap_or(0));
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
                out.push(CombatEvent::Hit { actor, target, skill, value: value.into(), dot: false, crit, marks });
            }
        } else if !self.lists.resource.contains(&skill) {
            if actor != target {
                out.push(CombatEvent::Hit { actor, target, skill, value: value.into(), dot: false, crit, marks });
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
            out.push(CombatEvent::Hit { actor, target, skill, value: amount.into(), dot: true, crit: false, marks: 0 });
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
            if let Some(max) = spawn_hp(p, c + 3) {
                events.push(CombatEvent::Hp { id, hp: None, max: Some(max) });
            }
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

/// Entity ids the HP and combat records are believed for.
const ENTITY_IDS: std::ops::RangeInclusive<i32> = 100..=9_999_999;

/// A `00 8D` record's current HP, from after its opcode.
fn hp_record(p: &[u8], mut at: usize) -> Option<CombatEvent> {
    let id = varint(p, &mut at).filter(|id| ENTITY_IDS.contains(id))?;
    let groups = *p.get(at)?;
    if groups == 0 || groups > 3 {
        return None;
    }
    at += 1;
    let mut hp = None;
    for (bit, width) in [(0x01, 4usize), (0x02, 8usize)] {
        if groups & bit == 0 {
            continue;
        }
        let n = *p.get(at)? as usize;
        at += 1;
        for _ in 0..n {
            let kind = *p.get(at)?;
            let value = p.get(at + 1..at + 1 + width)?;
            if width == 8 && kind == 0 {
                let v = u64::from_le_bytes(value.try_into().ok()?);
                hp = Some(i64::try_from(v).ok().filter(|&v| v <= i64::from(i32::MAX))?);
            }
            at += 1 + width;
        }
    }
    hp.map(|hp| CombatEvent::Hp { id, hp: Some(hp), max: None })
}

/// A spawn's max HP: the first `01 <hp> <max hp>` within 64 bytes of `from`
/// that reads as a live entity's (0 < hp <= max, both within 31 bits).
fn spawn_hp(p: &[u8], from: usize) -> Option<i64> {
    let stop = p.len().saturating_sub(2).min(from + 64);
    (from..stop).filter(|&h| p[h] == 0x01).find_map(|h| {
        let now = read_varint(p, h + 1);
        if now.length <= 0 || now.value <= 0 {
            return None;
        }
        let max = read_varint(p, h + 1 + now.length as usize);
        (max.length > 0 && max.value >= now.value).then_some(i64::from(max.value))
    })
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
        assert_eq!(Reader::default().read(&p), vec![CombatEvent::Hit { actor: 4715, target: 5000, skill: 17_010_000, value: 1234, dot: false, crit: false, marks: 0 }]);
    }

    #[test]
    fn reads_a_critical() {
        let mut body = hit(5000, 4715, 17_010_000, 1234);
        // The hit type follows the skill and its byte.
        let at = var(5000).len() + 2 + var(4715).len() + 4 + 1;
        body[at] = 3;
        let p = packet(&[&[0x04, 0x38][..], &body].concat());
        assert_eq!(Reader::default().read(&p), vec![CombatEvent::Hit { actor: 4715, target: 5000, skill: 17_010_000, value: 1234, dot: false, crit: true, marks: 0 }]);
    }

    #[test]
    fn a_hit_from_behind_and_doubled() {
        // Layout 6: <flags 08 double> <hp 00> <angle 01 back> after the hit type.
        let body = [var(5000), var(0x06), var(0), var(4715), 17_010_000u32.to_le_bytes().to_vec(), vec![0], var(2), vec![0x08, 0x00, 0x01], vec![0; 7], var(0), var(18000), var(900), var(1)].concat();
        let events = Reader::default().read(&packet(&[&[0x04, 0x38][..], &body].concat()));
        assert_eq!(events, vec![CombatEvent::Hit { actor: 4715, target: 5000, skill: 17_010_000, value: 900, dot: false, crit: false, marks: mark::DOUBLE | mark::BACK }]);
    }

    #[test]
    fn misses_and_resists_carry_no_value() {
        let miss = |switch: u32, hit_type: u32| packet(&[&[0x04, 0x38][..], &var(5000), &var(switch), &var(0), &var(4715), &17_010_000u32.to_le_bytes(), &[0], &var(hit_type)].concat());
        assert_eq!(Reader::default().read(&miss(0, 1)), vec![CombatEvent::NoDamage { actor: 4715, target: 5000, skill: 17_010_000, resist: false }]);
        assert_eq!(Reader::default().read(&miss(2, 6)), vec![CombatEvent::NoDamage { actor: 4715, target: 5000, skill: 17_010_000, resist: true }]);
        assert!(Reader::default().read(&miss(0, 2)).is_empty(), "no value, but no miss either");
    }

    #[test]
    fn reads_hp_and_combat_records() {
        let hp = packet(&[&[0x00, 0x8D][..], &var(47573), &[0x02, 1, 0], &123_456u64.to_le_bytes()].concat());
        assert_eq!(Reader::default().read(&hp), vec![CombatEvent::Hp { id: 47573, hp: Some(123_456), max: None }]);
        let party = packet(&[&[0x1B, 0x92][..], &var(4715), &var(0), &var(8000), &[0; 20]].concat());
        assert_eq!(Reader::default().read(&party), vec![CombatEvent::Hp { id: 4715, hp: Some(0), max: Some(8000) }]);
        let into = packet(&[&[0x21, 0x8D][..], &var(47573), &[0, 1]].concat());
        assert_eq!(Reader::default().read(&into), vec![CombatEvent::Combat { id: 47573, on: true, enrage_ms: None }]);
        let enrage = packet(&[&[0x21, 0x8D][..], &var(47573), &[1, 1], &1_792_000_000_000i64.to_le_bytes()].concat());
        assert_eq!(Reader::default().read(&enrage), vec![CombatEvent::Combat { id: 47573, on: true, enrage_ms: Some(1_792_000_000_000) }]);
        let out = packet(&[&[0x21, 0x8D][..], &var(47573), &[0, 0]].concat());
        assert_eq!(Reader::default().read(&out), vec![CombatEvent::Combat { id: 47573, on: false, enrage_ms: None }]);
    }

    #[test]
    fn a_spawn_gives_its_max_hp() {
        let npc = [&[0x41, 0x36][..], &var(9001), &[0x0C, 0, 0, 0, 0, 0x7B, 0x1F, 0x23, 0, 0x40, 0x02, 0x05], &[0x01], &var(0), &[0x01], &var(90_000), &var(90_000), &[0; 8]].concat();
        let events = Reader::default().read(&packet(&[&[0x10, 0x37][..], &npc].concat()));
        assert_eq!(events, vec![CombatEvent::Npc { id: 9001, code: 0x231F7B }, CombatEvent::Hp { id: 9001, hp: None, max: Some(90_000) }]);
    }

    #[test]
    fn a_summed_hit_takes_the_skill_of_its_compact_record() {
        let compact = |actor: u32| packet(&[&[0x7E, 0x7E, 0x08, 0x3B, 0x38, 0x00, 0x00, 0x38][..], &var(actor), &[0x05], &16_010_230u32.to_le_bytes(), &[0; 4]].concat());
        let summed = |actor: u32| packet(&[&[0x04, 0x38][..], &hit(5000, actor, 99_745_942, 3000)].concat());
        let mut r = Reader::default();
        assert!(r.read(&compact(4715)).is_empty());
        assert_eq!(r.read(&summed(4715)), vec![CombatEvent::Hit { actor: 4715, target: 5000, skill: 16_010_230, value: 3000, dot: false, crit: false, marks: 0 }]);
        let CombatEvent::Hit { skill, .. } = r.read(&summed(4715))[0] else { panic!() };
        assert_eq!(skill, 99_745_942, "used once");
        r.read(&compact(4716));
        let CombatEvent::Hit { skill, .. } = r.read(&summed(4715))[0] else { panic!() };
        assert_eq!(skill, 99_745_942, "another player's record");
        r.read(&compact(4715));
        r.bundle_edge();
        let CombatEvent::Hit { skill, .. } = r.read(&summed(4715))[0] else { panic!() };
        assert_eq!(skill, 99_745_942, "another bundle's record");
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
        assert_eq!(events[1], CombatEvent::Hit { actor: 4715, target: 5001, skill: 17_010_000, value: 20, dot: false, crit: false, marks: 0 });
    }

    #[test]
    fn a_monster_hitting_you_comes_with_its_skill() {
        let p = packet(&[&[0x04, 0x38][..], &hit(4715, 5000, 2_000_100, 99)].concat());
        assert_eq!(Reader::default().read(&p), vec![CombatEvent::Hit { actor: 5000, target: 4715, skill: 2_000_100, value: 99, dot: false, crit: false, marks: 0 }]);
    }

    /// Gatekeeper Pinopi (entity 47573) hitting a player (9681) for 1,258
    /// with its skill 1607550, as A2Tools recorded it on 2026-10-15: from
    /// the front, and parried (its plotter is `02 00 02`).
    #[test]
    fn reads_a_bosss_hit_on_a_player() {
        let body: Vec<u8> = (0..58).step_by(2).map(|i| u8::from_str_radix(&"D14B0600D5F3027E871800020202000243ED940901000000904EEA090100"[i..i + 2], 16).unwrap()).collect();
        let p = packet(&[&[0x04, 0x38][..], &body].concat());
        assert_eq!(Reader::default().read(&p), vec![CombatEvent::Hit { actor: 47573, target: 9681, skill: 1_607_550, value: 1258, dot: false, crit: false, marks: mark::PARRY | mark::FRONT }]);
    }

    #[test]
    fn a_monsters_hits_on_several_players_are_all_read() {
        let body = [&[0x04, 0x38][..], &hit(4715, 5000, 2_000_100, 99), &[0x01, 0x00], &hit(4716, 5000, 2_000_100, 98)].concat();
        let events = Reader::default().read(&packet(&body));
        assert_eq!(
            events,
            vec![
                CombatEvent::Hit { actor: 5000, target: 4715, skill: 2_000_100, value: 99, dot: false, crit: false, marks: 0 },
                CombatEvent::Hit { actor: 5000, target: 4716, skill: 2_000_100, value: 98, dot: false, crit: false, marks: 0 },
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
        assert_eq!(r.read(&tick(0x02, 17_030_000)), vec![CombatEvent::Hit { actor: 4715, target: 4800, skill: 17_030_000, value: 300, dot: true, crit: false, marks: 0 }]);
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
