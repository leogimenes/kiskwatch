//! Where you are: in the open world (on which map) or in a dungeon. And,
//! for the log, what the game sends around a loading screen.
//!
//! Two tries (2026-10-23) showed how it goes. Going into a dungeon or out,
//! the game switches connections and names you again (`33 36`). In the open
//! world it says the map, as `21 36 <u32> <map u32>` before naming you and
//! `02 40 <map u32> 00 00 00 01` right after (1010 is Verteron); also on a
//! teleport within it, which names you again on the same connection. In a
//! dungeon neither comes. So: the map after you are named is the open
//! world; you named with no map within `MAP_WAIT_MS` is a dungeon.
//!
//! The diagnostic that found this stays, for the next places to learn:
//! The game says who you are (`33 36`) on entering the world, and perhaps on
//! every loading screen, a dungeon's included. Each time it does, the log
//! gets your entity, the packets of the seconds around it (each kind once,
//! with how many came and how the first one starts: the place's id should be
//! in one of them) and the codes of the first NPCs that spawn after it.
//! Going into a dungeon and out then shows what marks the way in and out, and
//! which NPC codes are the dungeon's.
//!
//! The first try (2026-10-23) showed the game switching connections on the
//! way in and out, and `21 36 01 00 00 00 <map u32>` (with `01 40` and `02 40`
//! carrying the same map) before you are named on coming back to Verteron
//! (map 1010). Those records go in the log whole, whenever they come, to read
//! the dungeon's map.

use std::collections::VecDeque;

use serde::Serialize;

use crate::combat::CombatEvent;
use crate::varint::read_varint;

/// Packets this long before you are named, and after, go in the log.
const BEFORE_MS: i64 = 3_000;
const AFTER_MS: i64 = 5_000;
/// NPCs spawning this long after you are named count as the place's.
const NPC_MS: i64 = 15_000;
const MAX_NPCS: usize = 40;
/// Packets kept to look back on, and the bytes kept of each.
const KEPT: usize = 400;
const HEAD: usize = 32;
/// Records that seem to carry the map: logged whole (up to `WHOLE` bytes).
const MAP_RECORDS: [[u8; 2]; 3] = [[0x21, 0x36], [0x01, 0x40], [0x02, 0x40]];
const WHOLE: usize = 96;
/// After you are named, the map comes within this, or it's a dungeon.
const MAP_WAIT_MS: i64 = 5_000;

/// Where you are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Zone {
    /// The open world, on a map (the same ids as the field bosses' maps).
    Field { map: u32 },
    /// A dungeon, or any place that came without a map.
    Instance,
}

/// The map in a `21 36` or `02 40` record (a whole packet), if it's one.
fn map_of(bytes: &[u8], opcode: [u8; 2], at: usize) -> Option<u32> {
    let skip = match opcode {
        [0x21, 0x36] => 6,
        [0x02, 0x40] => 2,
        _ => return None,
    };
    let b: [u8; 4] = bytes.get(at + skip..at + skip + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(b)).filter(|&m| (1..1_000_000).contains(&m))
}

#[derive(Debug, Clone)]
struct Seen {
    at: i64,
    opcode: [u8; 2],
    len: usize,
    head: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct ZoneTrace {
    me: Option<i32>,
    since_ms: Option<i64>,
    recent: VecDeque<Seen>,
    after: Vec<Seen>,
    npcs: Vec<i32>,
    lines: Vec<String>,
    /// When you were last named, while the map hasn't come yet.
    named_at: Option<i64>,
    zones: Vec<Zone>,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(" ")
}

/// Each kind of packet once: its opcode, how many came, its size and how the
/// first one starts.
fn summary(list: &[Seen]) -> Vec<String> {
    let mut kinds: Vec<(&Seen, usize)> = Vec::new();
    for s in list {
        match kinds.iter_mut().find(|(k, _)| k.opcode == s.opcode) {
            Some((_, n)) => *n += 1,
            None => kinds.push((s, 1)),
        }
    }
    kinds.iter().map(|(s, n)| format!("  {:02x} {:02x} ×{n} ({} bytes): {}", s.opcode[0], s.opcode[1], s.len, hex(&s.head))).collect()
}

impl ZoneTrace {
    /// A whole packet, length included.
    pub fn packet(&mut self, bytes: &[u8], now: i64) {
        self.flush(now);
        let n = read_varint(bytes, 0);
        let Ok(at) = usize::try_from(n.length) else { return };
        let Some(opcode) = bytes.get(at..at + 2) else { return };
        if let Some(map) = map_of(bytes, [opcode[0], opcode[1]], at) {
            self.found(Zone::Field { map });
        } else if self.named_at.is_some_and(|t| now - t > MAP_WAIT_MS) {
            self.found(Zone::Instance);
        }
        let seen = Seen { at: now, opcode: [opcode[0], opcode[1]], len: bytes.len(), head: bytes[..bytes.len().min(HEAD)].to_vec() };
        if MAP_RECORDS.contains(&seen.opcode) {
            self.lines.push(format!("zona: registro {:02x} {:02x} ({} bytes): {}", seen.opcode[0], seen.opcode[1], bytes.len(), hex(&bytes[..bytes.len().min(WHOLE)])));
        }
        if self.since_ms.is_some_and(|t| now - t <= AFTER_MS) {
            self.after.push(seen.clone());
        }
        if self.recent.len() == KEPT {
            self.recent.pop_front();
        }
        self.recent.push_back(seen);
    }

    pub fn event(&mut self, e: &CombatEvent, now: i64) {
        match e {
            CombatEvent::Me { id, .. } => {
                self.flush(i64::MAX);
                self.lines.push(format!("zona: você é a entidade {id} (antes {})", self.me.map_or("nenhuma".into(), |m| m.to_string())));
                let before: Vec<Seen> = self.recent.iter().filter(|s| now - s.at <= BEFORE_MS).cloned().collect();
                self.lines.push(format!("zona: pacotes nos {} s antes:", BEFORE_MS / 1000));
                self.lines.extend(summary(&before));
                self.me = Some(*id);
                self.since_ms = Some(now);
                self.named_at = Some(now);
            }
            CombatEvent::Npc { code, .. } if self.since_ms.is_some_and(|t| now - t <= NPC_MS) && self.npcs.len() < MAX_NPCS && !self.npcs.contains(code) => {
                self.npcs.push(*code);
            }
            _ => {}
        }
    }

    fn found(&mut self, zone: Zone) {
        self.named_at = None;
        if self.zones.last() != Some(&zone) {
            self.lines.push(match zone {
                Zone::Field { map } => format!("zona: área aberta, mapa {map}"),
                Zone::Instance => "zona: dungeon (sem mapa depois de entrar)".into(),
            });
        }
        self.zones.push(zone);
    }

    /// The places found since the last call, oldest first.
    pub fn take_zones(&mut self) -> Vec<Zone> {
        std::mem::take(&mut self.zones)
    }

    /// What's ready for the log.
    pub fn take_lines(&mut self) -> Vec<String> {
        std::mem::take(&mut self.lines)
    }

    /// Close the windows that ended by `now`.
    fn flush(&mut self, now: i64) {
        let Some(since) = self.since_ms else { return };
        if now - since > AFTER_MS && !self.after.is_empty() {
            self.lines.push(format!("zona: pacotes nos {} s depois:", AFTER_MS / 1000));
            let after = std::mem::take(&mut self.after);
            self.lines.extend(summary(&after));
        }
        if now - since > NPC_MS && !self.npcs.is_empty() {
            let codes: Vec<String> = self.npcs.drain(..).map(|c| c.to_string()).collect();
            self.lines.push(format!("zona: NPCs logo depois: {}", codes.join(" ")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me(id: i32) -> CombatEvent {
        CombatEvent::Me { id, name: "Leozin".into(), class: None }
    }

    #[test]
    fn you_with_the_packets_around_and_the_npcs_after() {
        let mut t = ZoneTrace::default();
        t.packet(&[5, 0x10, 0x20, 1, 2], 0);
        t.packet(&[5, 0x7a, 0x36, 9, 9], 9_000);
        t.packet(&[5, 0x7a, 0x36, 8, 8], 9_500);
        t.event(&me(10), 10_000);
        let lines = t.take_lines();
        assert_eq!(lines, ["zona: você é a entidade 10 (antes nenhuma)", "zona: pacotes nos 3 s antes:", "  7a 36 ×2 (5 bytes): 05 7a 36 09 09"]);
        t.packet(&[4, 0x04, 0x38, 0], 11_000);
        t.event(&CombatEvent::Npc { id: 1, code: 500 }, 11_000);
        t.event(&CombatEvent::Npc { id: 2, code: 500 }, 12_000);
        t.event(&CombatEvent::Npc { id: 3, code: 600 }, 13_000);
        t.packet(&[4, 0x04, 0x38, 0], 16_000);
        assert_eq!(t.take_lines(), ["zona: pacotes nos 5 s depois:", "  04 38 ×1 (4 bytes): 04 04 38 00", "zona: dungeon (sem mapa depois de entrar)"]);
        t.packet(&[4, 0x04, 0x38, 0], 26_000);
        assert_eq!(t.take_lines(), ["zona: NPCs logo depois: 500 600"]);
        t.event(&me(11), 30_000);
        assert_eq!(t.take_lines()[0], "zona: você é a entidade 11 (antes 10)");
    }

    fn packet(op: [u8; 2], rest: &[u8]) -> Vec<u8> {
        [&[(rest.len() + 3) as u8], &op[..], rest].concat()
    }

    #[test]
    fn the_map_after_you_are_named_is_the_open_world_none_a_dungeon() {
        let mut t = ZoneTrace::default();
        // Verteron: the map before you are named and after.
        t.packet(&packet([0x21, 0x36], &[1, 0, 0, 0, 0xf2, 3, 0, 0, 9, 9]), 0);
        t.event(&me(10), 1_000);
        t.packet(&packet([0x02, 0x40], &[0xf2, 3, 0, 0, 0, 0, 0, 1]), 1_100);
        t.packet(&packet([0x00, 0x36], &[0; 8]), 9_000);
        assert_eq!(t.take_zones(), [Zone::Field { map: 1010 }, Zone::Field { map: 1010 }]);
        // A dungeon: named, then no map.
        t.event(&me(683), 20_000);
        t.packet(&packet([0x00, 0x36], &[0; 8]), 24_000);
        assert!(t.take_zones().is_empty(), "still waiting for the map");
        t.packet(&packet([0x00, 0x36], &[0; 8]), 25_100);
        t.packet(&packet([0x00, 0x36], &[0; 8]), 40_000);
        assert_eq!(t.take_zones(), [Zone::Instance]);
        assert!(t.take_lines().iter().any(|l| l == "zona: dungeon (sem mapa depois de entrar)"));
    }

    #[test]
    fn map_records_go_whole() {
        let mut t = ZoneTrace::default();
        t.packet(&[0x0b, 0x21, 0x36, 1, 0, 0, 0, 0xf2, 3, 0, 0], 0);
        assert_eq!(t.take_lines(), ["zona: área aberta, mapa 1010", "zona: registro 21 36 (11 bytes): 0b 21 36 01 00 00 00 f2 03 00 00"]);
    }
}
