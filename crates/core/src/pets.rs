//! The player's pets as the game sends them, and the souls each still needs.
//!
//! Three records, as A2Tools' Pet Soul Tracker plugin reads them
//! (A2Tools-Plugins `plugins/pet-souls/manifest.json`):
//!
//! ```text
//! 00 90  pet list, once per entry into the world:
//!        <skip 4> <count varint> count x (<pet u32> <skip 4> <level u32>)
//!                 <count varint> count x (<pet u32> <points u32>)
//! 0D 90  souls picked up: <count u8> count x (<pet u32> <amount u32>)
//! 14 90  a pet levelled up: <skip 2> <pet u32> <level u32>
//! ```
//!
//! The opcode sits right after the frame's length varint; the numbers are
//! little-endian. A pet's points count from 0 again at each level, as the
//! game's do.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::varint::{read_varint, take_varint};

pub const OPCODE_PET_LIST: [u8; 2] = [0x00, 0x90];
pub const OPCODE_SOULS_GAINED: [u8; 2] = [0x0D, 0x90];
pub const OPCODE_LEVEL_UP: [u8; 2] = [0x14, 0x90];

/// Souls each level takes: 0 to 1, 1 to 2, 2 to 3.
pub const SOULS_PER_LEVEL: [u32; 3] = [5, 25, 75];
pub const MAX_LEVEL: u32 = SOULS_PER_LEVEL.len() as u32;

/// A list longer than this is a misread, not a pet collection.
const MAX_PETS: u64 = 2_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SoulGain {
    pub pet: u32,
    pub amount: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PetRecord {
    /// Every pet's level, and the points of the ones that have some.
    List { levels: Vec<(u32, u32)>, points: Vec<(u32, u32)> },
    SoulsGained(Vec<SoulGain>),
    LevelUp { pet: u32, level: u32 },
}

fn u32_at(b: &[u8], pos: &mut usize) -> Option<u32> {
    let bytes: [u8; 4] = b.get(*pos..*pos + 4)?.try_into().ok()?;
    *pos += 4;
    Some(u32::from_le_bytes(bytes))
}

fn skip(b: &[u8], pos: &mut usize, n: usize) -> Option<()> {
    (*pos + n <= b.len()).then(|| *pos += n)
}

/// The pet record in a whole frame (length varint included), or None when it
/// isn't one or doesn't read cleanly.
pub fn parse(packet: &[u8]) -> Option<PetRecord> {
    let len = read_varint(packet, 0).length;
    if len <= 0 {
        return None;
    }
    let at = len as usize;
    let opcode: [u8; 2] = packet.get(at..at + 2)?.try_into().ok()?;
    let body = &packet[at + 2..];
    let mut pos = 0;
    match opcode {
        OPCODE_PET_LIST => {
            skip(body, &mut pos, 4)?;
            let count = take_varint(body, &mut pos)?;
            if count > MAX_PETS {
                return None;
            }
            let mut levels = Vec::with_capacity(count as usize);
            for _ in 0..count {
                let pet = u32_at(body, &mut pos)?;
                skip(body, &mut pos, 4)?;
                levels.push((pet, u32_at(body, &mut pos)?));
            }
            let count = take_varint(body, &mut pos)?;
            if count > MAX_PETS {
                return None;
            }
            let mut points = Vec::with_capacity(count as usize);
            for _ in 0..count {
                let pet = u32_at(body, &mut pos)?;
                points.push((pet, u32_at(body, &mut pos)?));
            }
            Some(PetRecord::List { levels, points })
        }
        OPCODE_SOULS_GAINED => {
            let count = *body.first()?;
            pos = 1;
            let mut souls = Vec::with_capacity(count as usize);
            for _ in 0..count {
                let pet = u32_at(body, &mut pos)?;
                souls.push(SoulGain { pet, amount: u32_at(body, &mut pos)? });
            }
            Some(PetRecord::SoulsGained(souls))
        }
        OPCODE_LEVEL_UP => {
            skip(body, &mut pos, 2)?;
            let pet = u32_at(body, &mut pos)?;
            Some(PetRecord::LevelUp { pet, level: u32_at(body, &mut pos)? })
        }
        _ => None,
    }
}

/// One pet's progress: its level, and the souls it has toward the next.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PetProgress {
    pub level: u32,
    pub points: u32,
}

impl PetProgress {
    /// Souls still needed to reach the highest level.
    pub fn souls_to_max(&self) -> u32 {
        let level = self.level.min(MAX_LEVEL) as usize;
        let left: u32 = SOULS_PER_LEVEL[level..].iter().sum();
        left.saturating_sub(self.points)
    }

    /// Add souls, levelling up as each level fills.
    pub fn add_souls(&mut self, mut amount: u32) {
        while amount > 0 && self.level < MAX_LEVEL {
            let need = SOULS_PER_LEVEL[self.level as usize] - self.points.min(SOULS_PER_LEVEL[self.level as usize]);
            if amount < need {
                self.points += amount;
                return;
            }
            amount -= need;
            self.level += 1;
            self.points = 0;
        }
    }
}

/// Every pet's progress, by pet id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PetCollection {
    pub pets: BTreeMap<u32, PetProgress>,
}

impl PetCollection {
    /// Fold a record from the game into the collection.
    pub fn apply(&mut self, record: &PetRecord) {
        match record {
            PetRecord::List { levels, points } => {
                // The list is the whole truth: pets missing from it have nothing.
                self.pets.clear();
                for &(pet, level) in levels {
                    self.pets.entry(pet).or_default().level = level;
                }
                for &(pet, pts) in points {
                    self.pets.entry(pet).or_default().points = pts;
                }
            }
            PetRecord::SoulsGained(souls) => {
                for s in souls {
                    self.pets.entry(s.pet).or_default().add_souls(s.amount);
                }
            }
            PetRecord::LevelUp { pet, level } => {
                let p = self.pets.entry(*pet).or_default();
                if *level > p.level {
                    *p = PetProgress { level: *level, points: 0 };
                }
            }
        }
    }

    pub fn get(&self, pet: u32) -> PetProgress {
        self.pets.get(&pet).copied().unwrap_or_default()
    }
}

/// Souls this far apart belong to different farming runs.
pub const RUN_GAP_MS: i64 = 30 * 60_000;
/// Fewer pickups than this, or a shorter run, is too little to time.
const PACE_MIN_PICKUPS: usize = 3;
const PACE_MIN_SPAN_MS: i64 = 5 * 60_000;

/// How fast a pet's souls came in its latest run.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Pace {
    pub pet: u32,
    /// Souls in the run, the first pickup's included.
    pub souls: u32,
    /// From the run's first pickup to its last.
    pub span_ms: i64,
    pub last_ms: i64,
    pub per_hour: f64,
    /// Time to the highest level at this pace; None once there.
    pub to_max_ms: Option<i64>,
}

/// The pet's pace from its pickups (`(at_ms, amount)`, oldest first): the
/// run is the pickups back from the newest with no gap over `RUN_GAP_MS`.
/// The first pickup only starts the clock, so it is left out of the rate.
pub fn pace(pet: u32, pickups: &[(i64, u32)], progress: PetProgress) -> Option<Pace> {
    let &(last_ms, _) = pickups.last()?;
    let mut start = pickups.len() - 1;
    while start > 0 && pickups[start].0 - pickups[start - 1].0 <= RUN_GAP_MS {
        start -= 1;
    }
    let run = &pickups[start..];
    let span_ms = last_ms - run[0].0;
    if run.len() < PACE_MIN_PICKUPS || span_ms < PACE_MIN_SPAN_MS {
        return None;
    }
    let timed: u32 = run[1..].iter().map(|&(_, n)| n).sum();
    let per_hour = f64::from(timed) * 3_600_000.0 / span_ms as f64;
    let left = progress.souls_to_max();
    let to_max_ms = (left > 0).then(|| (f64::from(left) * 3_600_000.0 / per_hour).round() as i64);
    Some(Pace { pet, souls: run.iter().map(|&(_, n)| n).sum(), span_ms, last_ms, per_hour, to_max_ms })
}

/// How many pets the queue holds.
pub const QUEUE_LEN: usize = 5;

/// The pets being farmed, for the overlay: newest first. A pet already on it
/// keeps its place when it gets another soul; a new one goes on top and the
/// oldest drops off. A login (the pet list) starts it over, and a pet leaves
/// at the highest level.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PetQueue {
    pub pets: Vec<u32>,
    /// The pet that got the last soul.
    pub last: Option<u32>,
}

impl PetQueue {
    /// Take a record already applied to `collection`.
    pub fn apply(&mut self, record: &PetRecord, collection: &PetCollection) {
        match record {
            PetRecord::List { .. } => *self = Self::default(),
            PetRecord::SoulsGained(souls) => {
                for s in souls {
                    if !self.pets.contains(&s.pet) {
                        self.pets.insert(0, s.pet);
                    }
                    self.last = Some(s.pet);
                }
            }
            PetRecord::LevelUp { .. } => {}
        }
        self.pets.retain(|&p| collection.get(p).level < MAX_LEVEL);
        self.pets.truncate(QUEUE_LEN);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `<varint len> <opcode> <body>`, len = opcode + body + 4.
    fn frame(opcode: [u8; 2], body: &[u8]) -> Vec<u8> {
        let len = (body.len() + 2 + 4) as u8;
        assert!(len < 0x80);
        let mut v = vec![len];
        v.extend(opcode);
        v.extend(body);
        v
    }

    #[test]
    fn reads_the_pet_list_with_its_two_lists() {
        // From A2Tools' decoder test of the same record.
        let mut body = vec![0xFE, 0x04, 0, 0, 1];
        for v in [1097u32, 1097, 2] {
            body.extend(v.to_le_bytes());
        }
        body.push(2);
        for v in [1034u32, 28, 1016, 1] {
            body.extend(v.to_le_bytes());
        }
        body.extend([9, 9, 9]);
        assert_eq!(
            parse(&frame(OPCODE_PET_LIST, &body)),
            Some(PetRecord::List { levels: vec![(1097, 2)], points: vec![(1034, 28), (1016, 1)] })
        );
    }

    #[test]
    fn a_pet_list_past_127_counts_its_length_as_a_varint() {
        let mut body = vec![0x13, 0x05, 0, 0, 0x87, 0x01];
        for i in 0..135u32 {
            body.extend((1001 + i).to_le_bytes());
            body.extend((1001 + i).to_le_bytes());
            body.extend((1 + i % 3).to_le_bytes());
        }
        body.push(0);
        // Too long for a one-byte length: frame it by hand.
        let len = body.len() + 2 + 4;
        let mut packet = vec![(len as u8) | 0x80, (len >> 7) as u8];
        packet.extend(OPCODE_PET_LIST);
        packet.extend(&body);
        let Some(PetRecord::List { levels, points }) = parse(&packet) else { panic!() };
        assert_eq!((levels.len(), levels[134], points.len()), (135, (1135, 3), 0));
    }

    #[test]
    fn reads_a_soul_pickup_for_two_pets() {
        let body = [0x02, 0xF7, 0x03, 0, 0, 1, 0, 0, 0, 0x60, 0x04, 0, 0, 1, 0, 0, 0];
        assert_eq!(
            parse(&frame(OPCODE_SOULS_GAINED, &body)),
            Some(PetRecord::SoulsGained(vec![SoulGain { pet: 1015, amount: 1 }, SoulGain { pet: 1120, amount: 1 }]))
        );
    }

    #[test]
    fn reads_a_level_up() {
        let mut body = vec![0, 0];
        body.extend(1016u32.to_le_bytes());
        body.extend(2u32.to_le_bytes());
        assert_eq!(parse(&frame(OPCODE_LEVEL_UP, &body)), Some(PetRecord::LevelUp { pet: 1016, level: 2 }));
    }

    #[test]
    fn other_and_short_records_are_not_pets() {
        assert_eq!(parse(&frame([0x01, 0x91], &[0; 8])), None);
        assert_eq!(parse(&frame(OPCODE_LEVEL_UP, &[0, 0, 1])), None);
    }

    #[test]
    fn souls_to_max_and_levelling() {
        assert_eq!(PetProgress::default().souls_to_max(), 105);
        assert_eq!(PetProgress { level: 1, points: 10 }.souls_to_max(), 90);
        assert_eq!(PetProgress { level: 3, points: 0 }.souls_to_max(), 0);
        let mut p = PetProgress { level: 0, points: 4 };
        p.add_souls(3);
        assert_eq!(p, PetProgress { level: 1, points: 2 });
        p.add_souls(500);
        assert_eq!(p, PetProgress { level: 3, points: 0 });
    }

    #[test]
    fn the_collection_follows_the_game() {
        let mut c = PetCollection::default();
        c.apply(&PetRecord::List { levels: vec![(1001, 1)], points: vec![(1001, 20), (1002, 3)] });
        c.apply(&PetRecord::SoulsGained(vec![SoulGain { pet: 1001, amount: 5 }, SoulGain { pet: 1002, amount: 1 }]));
        assert_eq!(c.get(1001), PetProgress { level: 2, points: 0 });
        assert_eq!(c.get(1002), PetProgress { level: 0, points: 4 });
        c.apply(&PetRecord::LevelUp { pet: 1002, level: 1 });
        assert_eq!(c.get(1002), PetProgress { level: 1, points: 0 });
        // A fresh list replaces everything.
        c.apply(&PetRecord::List { levels: vec![], points: vec![] });
        assert!(c.pets.is_empty());
    }

    fn soul(pet: u32) -> PetRecord {
        PetRecord::SoulsGained(vec![SoulGain { pet, amount: 1 }])
    }

    fn feed(q: &mut PetQueue, c: &mut PetCollection, r: PetRecord) {
        c.apply(&r);
        q.apply(&r, c);
    }

    #[test]
    fn queue_puts_new_pets_on_top_and_keeps_known_ones_in_place() {
        let (mut q, mut c) = (PetQueue::default(), PetCollection::default());
        feed(&mut q, &mut c, soul(1));
        feed(&mut q, &mut c, soul(2));
        assert_eq!(q.pets, vec![2, 1]);
        feed(&mut q, &mut c, soul(1));
        assert_eq!(q.pets, vec![2, 1]);
        assert_eq!(q.last, Some(1));
        for p in 3..=6 {
            feed(&mut q, &mut c, soul(p));
        }
        assert_eq!(q.pets, vec![6, 5, 4, 3, 2]);
    }

    #[test]
    fn queue_starts_over_at_login_and_drops_maxed_pets() {
        let (mut q, mut c) = (PetQueue::default(), PetCollection::default());
        feed(&mut q, &mut c, soul(1));
        feed(&mut q, &mut c, soul(2));
        feed(&mut q, &mut c, PetRecord::LevelUp { pet: 2, level: MAX_LEVEL });
        assert_eq!(q.pets, vec![1]);
        feed(&mut q, &mut c, PetRecord::List { levels: vec![(1, 0)], points: vec![] });
        assert!(q.pets.is_empty());
    }

    #[test]
    fn pace_times_the_latest_run_from_its_first_pickup() {
        const MIN: i64 = 60_000;
        // An old run, a gap of over 30 min, then 1 + 6 souls in 30 min.
        let mut pickups = vec![(0, 5), (2 * MIN, 5)];
        pickups.extend((0..7).map(|i| (100 * MIN + i * 5 * MIN, 1)));
        let p = pace(7, &pickups, PetProgress { level: 1, points: 10 }).unwrap();
        assert_eq!((p.souls, p.span_ms, p.last_ms), (7, 30 * MIN, 130 * MIN));
        assert_eq!(p.per_hour, 12.0);
        // 90 souls left at 12 an hour.
        assert_eq!(p.to_max_ms, Some(450 * MIN));
        assert_eq!(pace(7, &pickups, PetProgress { level: 3, points: 0 }).unwrap().to_max_ms, None);
    }

    #[test]
    fn pace_needs_a_few_pickups_over_a_few_minutes() {
        const MIN: i64 = 60_000;
        let none = PetProgress::default();
        assert_eq!(pace(1, &[], none), None);
        assert_eq!(pace(1, &[(0, 1), (10 * MIN, 1)], none), None);
        assert_eq!(pace(1, &[(0, 1), (MIN, 1), (2 * MIN, 1)], none), None);
        assert!(pace(1, &[(0, 1), (3 * MIN, 1), (6 * MIN, 1)], none).is_some());
    }
}
