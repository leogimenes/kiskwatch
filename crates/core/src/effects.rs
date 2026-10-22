//! Buffs and debuffs: what the game says goes on and comes off each entity,
//! and how long each one stayed on over a recording. Kiskwatch's own reading;
//! the layouts are the ones A2Tools DPS Meter (GPL-3.0) documents in its
//! `abnormal.rs` ("abnormal" is the game's word for a buff or a debuff).
//!
//! ```text
//! 2a 38  on:      <entity> 01 <flags u8> <instance> <abnormal u32> <length i64> <end i64>
//!                 <caster> <level u8> [flags & 2: <skill u32>] <again u8> <x y z f32>
//! 2b 38  renewed: <entity> <flags u8> <instance> … the same from <abnormal> on
//! 2c 38  off:     <entity> <n u8> (<kind u8> <instance> <reason u8>
//!                 [kind & 7 = 7: <by> <skill u32> <skill effect u32>])*
//! ```
//!
//! - `instance` is numbered per entity; a buff that stacks is one instance
//!   per stack. `again` is 2 when a renewal applied it again.
//! - `end` is the server's clock (ms since the epoch); `length` runs from the
//!   instance's start to it, -1 for one that never ends (passives, stances):
//!   those are left out, they would read 100% in every fight.
//!
//! Ids are varints, numbers little-endian.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::varint::read_varint;

const ON: [u8; 2] = [0x2A, 0x38];
const RENEWED: [u8; 2] = [0x2B, 0x38];
const OFF: [u8; 2] = [0x2C, 0x38];
/// `again`, then the caster's position.
const ON_TAIL: usize = 13;
/// An instance whose end passed with no record taking it off (a stack pushed
/// out by a newer one) counts as off this long after.
const GRACE_MS: i64 = 1_500;

/// A buff or debuff put on, or renewed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Applied {
    pub entity: i32,
    pub instance: i32,
    pub abnormal: u32,
    pub length_ms: i64,
    pub end_ms: i64,
    pub caster: i32,
    pub skill: Option<u32>,
    /// Put on just now: an `on` record, or a renewal that applied it again.
    pub fresh: bool,
    /// An `on` record, whose start is the server's now.
    pub new: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum EffectRecord {
    Applied(Applied),
    Removed { entity: i32, instances: Vec<i32> },
}

struct Bytes<'a> {
    b: &'a [u8],
    at: usize,
}

impl Bytes<'_> {
    fn varint(&mut self) -> Option<i32> {
        let v = read_varint(self.b, self.at);
        if v.length <= 0 {
            return None;
        }
        self.at += v.length as usize;
        Some(v.value)
    }
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let out = self.b.get(self.at..self.at + N)?.try_into().ok()?;
        self.at += N;
        Some(out)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take::<1>()?[0])
    }
    fn left(&self) -> usize {
        self.b.len().saturating_sub(self.at)
    }
}

/// Read one framed packet (its length varint included). `None` for any other
/// packet, for a buff that never ends, and for a record that does not end
/// where the layout says.
pub fn parse(packet: &[u8]) -> Option<EffectRecord> {
    let len = read_varint(packet, 0);
    if len.length <= 0 {
        return None;
    }
    let o = len.length as usize;
    let op: [u8; 2] = packet.get(o..o + 2)?.try_into().ok()?;
    let mut r = Bytes { b: packet, at: o + 2 };
    match op {
        ON | RENEWED => {
            let entity = r.varint()?;
            if op == ON && r.u8()? != 1 {
                return None;
            }
            let flags = r.u8()?;
            let instance = r.varint()?;
            let abnormal = u32::from_le_bytes(r.take()?);
            let length_ms = i64::from_le_bytes(r.take()?);
            let end_ms = i64::from_le_bytes(r.take()?);
            let caster = r.varint()?;
            let _level = r.u8()?;
            let skill = if flags & 0x02 != 0 { Some(u32::from_le_bytes(r.take()?)) } else { None };
            let again = r.u8()? == 2;
            if r.left() != ON_TAIL - 1 || length_ms < 0 {
                return None;
            }
            Some(EffectRecord::Applied(Applied { entity, instance, abnormal, length_ms, end_ms, caster, skill, fresh: op == ON || again, new: op == ON }))
        }
        OFF => {
            let entity = r.varint()?;
            let n = r.u8()?;
            let mut instances = Vec::with_capacity(n as usize);
            for _ in 0..n {
                let kind = r.u8()?;
                instances.push(r.varint()?);
                let _reason = r.u8()?;
                if kind & 0x07 == 0x07 {
                    r.varint()?;
                    r.take::<8>()?;
                }
            }
            (r.left() == 0).then_some(EffectRecord::Removed { entity, instances })
        }
        _ => None,
    }
}

/// How long one buff or debuff stayed on one entity over a recording.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Uptime {
    /// Who had it on.
    pub entity: i32,
    pub abnormal: u32,
    /// The skill that put it on, when the game says.
    pub skill: Option<u32>,
    /// Who put it on last.
    pub caster: i32,
    pub uptime_ms: i64,
    /// Times it was put on during the recording.
    pub applied: u32,
    /// The most stacks it had at once.
    pub stacks: u32,
}

#[derive(Debug, Clone)]
struct Instance {
    abnormal: u32,
    /// Local time it runs out, once the server's clock is known.
    expires: Option<i64>,
}

/// One abnormal on one entity, as it stands.
#[derive(Debug, Clone, Default)]
struct On {
    stacks: u32,
    since: i64,
    skill: Option<u32>,
    caster: i32,
}

#[derive(Debug, Clone, Default)]
struct Totals {
    closed_ms: i64,
    applied: u32,
    stacks: u32,
    skill: Option<u32>,
    caster: i32,
}

/// What is on everyone now, and, while recording, the time each thing was on.
#[derive(Debug, Default)]
pub struct Effects {
    instances: HashMap<(i32, i32), Instance>,
    on: HashMap<(i32, u32), On>,
    /// The server's clock minus ours, from the last `on` record.
    offset: Option<i64>,
    rec: Option<Recording>,
}

/// Since when, and the totals so far.
#[derive(Debug)]
struct Recording {
    start: i64,
    totals: HashMap<(i32, u32), Totals>,
}

impl Effects {
    /// Start counting from `now` (what is on already counts from here).
    pub fn start(&mut self, now: i64) {
        let totals = self.on.iter().map(|(&k, o)| (k, Totals { stacks: o.stacks, skill: o.skill, caster: o.caster, ..Default::default() })).collect();
        self.rec = Some(Recording { start: now, totals });
    }

    pub fn stop(&mut self) {
        self.rec = None;
    }

    pub fn apply(&mut self, record: EffectRecord, now: i64) {
        self.expire(now);
        match record {
            EffectRecord::Applied(a) => {
                if a.new {
                    self.offset = Some(a.end_ms - a.length_ms - now);
                }
                let expires = self.offset.map(|o| a.end_ms - o);
                let key = (a.entity, a.instance);
                // The same instance as something else: the old one is gone.
                if self.instances.get(&key).is_some_and(|i| i.abnormal != a.abnormal) {
                    self.drop_instance(key, now);
                }
                let known = self.instances.contains_key(&key);
                self.instances.insert(key, Instance { abnormal: a.abnormal, expires });
                let on = self.on.entry((a.entity, a.abnormal)).or_insert_with(|| On { since: now, ..Default::default() });
                if !known {
                    on.stacks += 1;
                }
                on.caster = a.caster;
                on.skill = a.skill.or(on.skill);
                let (stacks, skill, caster) = (on.stacks, on.skill, on.caster);
                if let Some(rec) = &mut self.rec {
                    let t = rec.totals.entry((a.entity, a.abnormal)).or_default();
                    t.stacks = t.stacks.max(stacks);
                    (t.skill, t.caster) = (skill, caster);
                    if a.fresh || !known {
                        t.applied += 1;
                    }
                }
            }
            EffectRecord::Removed { entity, instances } => {
                for i in instances {
                    self.drop_instance((entity, i), now);
                }
            }
        }
    }

    /// Take off what ran out a while ago with no record saying so, as of
    /// when it ran out.
    pub fn expire(&mut self, now: i64) {
        let gone: Vec<_> = self.instances.iter().filter(|(_, i)| i.expires.is_some_and(|e| e + GRACE_MS <= now)).map(|(&k, i)| (k, i.expires.unwrap())).collect();
        for (key, at) in gone {
            self.drop_instance(key, at);
        }
    }

    fn drop_instance(&mut self, key: (i32, i32), now: i64) {
        let Some(instance) = self.instances.remove(&key) else { return };
        let k = (key.0, instance.abnormal);
        let Some(on) = self.on.get_mut(&k) else { return };
        on.stacks = on.stacks.saturating_sub(1);
        if on.stacks > 0 {
            return;
        }
        let since = on.since;
        self.on.remove(&k);
        if let Some(rec) = &mut self.rec {
            rec.totals.entry(k).or_default().closed_ms += (now - since.max(rec.start)).max(0);
        }
    }

    /// The recording so far, for the entities `keep` picks, longest first.
    pub fn uptimes(&self, now: i64, keep: impl Fn(i32) -> bool) -> Vec<Uptime> {
        let Some(Recording { start, totals }) = &self.rec else { return Vec::new() };
        let mut out: Vec<Uptime> = totals
            .iter()
            .filter(|((entity, _), _)| keep(*entity))
            .map(|(&(entity, abnormal), t)| {
                let on = self.on.get(&(entity, abnormal));
                let open = on.map_or(0, |o| (now - o.since.max(*start)).max(0));
                Uptime {
                    entity,
                    abnormal,
                    skill: t.skill,
                    caster: t.caster,
                    uptime_ms: (t.closed_ms + open).min(now - start),
                    applied: t.applied,
                    stacks: t.stacks,
                }
            })
            .filter(|u| u.uptime_ms > 0)
            .collect();
        out.sort_by_key(|u| (u.entity, std::cmp::Reverse(u.uptime_ms), u.abnormal));
        out
    }
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

    const SERVER: i64 = 1_790_000_000_000;

    #[allow(clippy::too_many_arguments)]
    fn on(op: u8, entity: u32, instance: u32, abnormal: u32, length: i64, end: i64, caster: u32, skill: Option<u32>, again: u8) -> Vec<u8> {
        let flags = if skill.is_some() { 0x13 } else { 0x11 };
        packet(&[
            vec![op, 0x38],
            var(entity),
            if op == 0x2A { vec![1] } else { vec![] },
            vec![flags],
            var(instance),
            abnormal.to_le_bytes().to_vec(),
            length.to_le_bytes().to_vec(),
            end.to_le_bytes().to_vec(),
            var(caster),
            vec![3],
            skill.map(|s| s.to_le_bytes().to_vec()).unwrap_or_default(),
            vec![again],
            vec![0; 12],
        ]
        .concat())
    }

    fn off(entity: u32, instances: &[u32]) -> Vec<u8> {
        let mut body = [vec![0x2C, 0x38], var(entity), vec![instances.len() as u8]].concat();
        for &i in instances {
            body.extend([vec![0x01], var(i), vec![1]].concat());
        }
        packet(&body)
    }

    fn read(p: &[u8]) -> EffectRecord {
        parse(p).expect("reads")
    }

    #[test]
    fn reads_on_renewed_and_off() {
        let EffectRecord::Applied(a) = read(&on(0x2A, 4715, 7, 1_170_001, 10_000, SERVER, 4715, Some(17_010_000), 0)) else { panic!() };
        assert_eq!((a.entity, a.instance, a.abnormal, a.length_ms, a.caster, a.skill, a.fresh, a.new), (4715, 7, 1_170_001, 10_000, 4715, Some(17_010_000), true, true));
        let EffectRecord::Applied(a) = read(&on(0x2B, 4715, 7, 1_170_001, 20_000, SERVER, 5000, None, 2)) else { panic!() };
        assert_eq!((a.caster, a.skill, a.fresh, a.new), (5000, None, true, false));
        assert_eq!(read(&off(4715, &[7, 300])), EffectRecord::Removed { entity: 4715, instances: vec![7, 300] });
        let taken = packet(&[vec![0x2C, 0x38], var(9), vec![1, 0x07], var(4), vec![11], var(4715), vec![0; 8]].concat());
        assert_eq!(read(&taken), EffectRecord::Removed { entity: 9, instances: vec![4] });
    }

    #[test]
    fn skips_what_never_ends_and_what_does_not_fit() {
        assert_eq!(parse(&on(0x2A, 1, 1, 5, -1, SERVER, 1, None, 0)), None);
        let mut long = on(0x2A, 1, 1, 5, 1_000, SERVER, 1, None, 0);
        long.push(0);
        assert_eq!(parse(&long), None);
        assert_eq!(parse(&packet(&[0x04, 0x38, 1, 2, 3])), None);
    }

    fn applied(p: Vec<u8>) -> EffectRecord {
        read(&p)
    }

    #[test]
    fn uptime_counts_while_on_and_only_while_recording() {
        let mut e = Effects::default();
        // On before the recording: counts from its start.
        e.apply(applied(on(0x2A, 1, 1, 100, 60_000, SERVER + 60_000, 1, None, 0)), 0);
        e.start(10_000);
        e.apply(applied(on(0x2A, 1, 2, 200, 5_000, SERVER + 25_000, 1, None, 0)), 20_000);
        e.apply(EffectRecord::Removed { entity: 1, instances: vec![2] }, 25_000);
        e.apply(applied(on(0x2A, 1, 3, 200, 5_000, SERVER + 35_000, 1, None, 0)), 30_000);
        e.expire(40_000);
        let u = e.uptimes(40_000, |_| true);
        let of = |a: u32| u.iter().find(|x| x.abnormal == a).unwrap();
        assert_eq!((of(100).uptime_ms, of(100).applied), (30_000, 0));
        // 5 s, then 5 s more: the second ran out with no record saying so.
        assert_eq!((of(200).uptime_ms, of(200).applied), (10_000, 2));
        e.stop();
        assert!(e.uptimes(50_000, |_| true).is_empty());
    }

    #[test]
    fn stacks_are_one_uptime() {
        let mut e = Effects::default();
        e.start(0);
        e.apply(applied(on(0x2A, 1, 1, 300, 10_000, SERVER + 10_000, 2, None, 0)), 0);
        e.apply(applied(on(0x2A, 1, 2, 300, 10_000, SERVER + 12_000, 2, None, 0)), 2_000);
        e.apply(EffectRecord::Removed { entity: 1, instances: vec![1] }, 4_000);
        // A renewal of a live stack is not a new one.
        e.apply(applied(on(0x2B, 1, 2, 300, 12_000, SERVER + 12_000, 2, None, 0)), 5_000);
        e.apply(EffectRecord::Removed { entity: 1, instances: vec![2] }, 6_000);
        let u = e.uptimes(8_000, |_| true);
        assert_eq!(u.len(), 1);
        assert_eq!((u[0].uptime_ms, u[0].applied, u[0].stacks, u[0].caster), (6_000, 2, 2, 2));
    }

    #[test]
    fn picks_entities() {
        let mut e = Effects::default();
        e.start(0);
        e.apply(applied(on(0x2A, 1, 1, 300, 10_000, SERVER + 10_000, 2, None, 0)), 0);
        e.apply(applied(on(0x2A, 9, 1, 400, 10_000, SERVER + 10_000, 1, Some(17_020_000), 0)), 0);
        let u = e.uptimes(1_000, |id| id == 9);
        assert_eq!(u.len(), 1);
        assert_eq!((u[0].entity, u[0].caster, u[0].skill), (9, 1, Some(17_020_000)));
    }
}
