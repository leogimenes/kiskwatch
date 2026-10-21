//! From the server's TCP bytes to the records Kiskwatch reads.
//!
//! The bytes arrive in arbitrary chunks, often starting mid-packet; they are
//! kept until whole frames can be walked (`framing::walk`), bundles are opened
//! and walked in turn, and each packet is offered to the decoders.

use serde::Serialize;

use crate::boss_map::{self, BossMap};
use crate::combat::{self, CombatEvent};
use crate::framing::{self, FrameKind, MAX_BUNDLE_DEPTH};
use crate::pets::{self, PetRecord};

/// Bytes kept waiting for the rest of a packet before giving up on them.
const MAX_BUFFER_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GameEvent {
    BossMap(BossMap),
    Pets(PetRecord),
    Combat(CombatEvent),
}

/// Decode one whole packet (length varint included).
pub fn decode(packet: &[u8], now_ms: i64) -> Option<GameEvent> {
    if let Some(record) = pets::parse(packet) {
        return Some(GameEvent::Pets(record));
    }
    boss_map::parse(packet, now_ms).map(GameEvent::BossMap)
}

/// One server-to-client connection's byte stream.
pub struct GameStream {
    buffer: Vec<u8>,
    combat: combat::Reader,
}

impl Default for GameStream {
    fn default() -> Self {
        Self { buffer: Vec::new(), combat: combat::Reader::new(combat::SkillLists::bundled()) }
    }
}

impl GameStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take a chunk of the stream; return the events of every packet it completes.
    pub fn push(&mut self, data: &[u8], now_ms: i64) -> Vec<GameEvent> {
        if self.buffer.len() > MAX_BUFFER_BYTES {
            self.buffer.clear();
        }
        self.buffer.extend_from_slice(data);
        let walked = framing::walk(&self.buffer);
        let mut events = Vec::new();
        for frame in &walked.frames {
            read_frame(&mut self.combat, frame.kind, frame.bytes(&self.buffer), frame.payload(&self.buffer), 1, now_ms, &mut events);
        }
        self.buffer.drain(..walked.consumed);
        events
    }

    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }
}

fn read_frame(reader: &mut combat::Reader, kind: FrameKind, bytes: &[u8], payload: &[u8], depth: usize, now_ms: i64, out: &mut Vec<GameEvent>) {
    match kind {
        FrameKind::Packet => match decode(bytes, now_ms) {
            Some(event) => out.push(event),
            None => out.extend(reader.read(bytes).into_iter().map(GameEvent::Combat)),
        },
        FrameKind::Bundle => {
            if depth > MAX_BUNDLE_DEPTH {
                return;
            }
            let Some(inner) = framing::decompress_bundle(payload) else { return };
            for frame in framing::walk_inner(&inner).frames {
                read_frame(reader, frame.kind, frame.bytes(&inner), frame.payload(&inner), depth + 1, now_ms, out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pets::{OPCODE_LEVEL_UP, SoulGain};

    fn packet(payload: &[u8]) -> Vec<u8> {
        let len = framing::length_value(payload.len());
        let mut v = Vec::new();
        let mut x = len;
        loop {
            let b = (x & 0x7F) as u8;
            x >>= 7;
            if x == 0 {
                v.push(b);
                break;
            }
            v.push(b | 0x80);
        }
        v.extend_from_slice(payload);
        v
    }

    fn level_up(pet: u32, level: u32) -> Vec<u8> {
        let mut p = OPCODE_LEVEL_UP.to_vec();
        p.extend([0, 0]);
        p.extend(pet.to_le_bytes());
        p.extend(level.to_le_bytes());
        packet(&p)
    }

    fn hex(s: &str) -> Vec<u8> {
        let s = s.trim();
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn a_packet_split_across_chunks_is_read_once_whole() {
        let bytes = level_up(1016, 2);
        let mut s = GameStream::new();
        assert!(s.push(&bytes[..5], 0).is_empty());
        assert_eq!(s.push(&bytes[5..], 0), vec![GameEvent::Pets(PetRecord::LevelUp { pet: 1016, level: 2 })]);
        assert_eq!(s.buffered_bytes(), 0);
    }

    #[test]
    fn packets_inside_a_bundle_are_read() {
        let mut inner = level_up(1001, 1);
        let mut souls = pets::OPCODE_SOULS_GAINED.to_vec();
        souls.push(1);
        souls.extend(1002u32.to_le_bytes());
        souls.extend(3u32.to_le_bytes());
        inner.extend(packet(&souls));
        let mut bundle = vec![0xFF, 0xFF];
        bundle.extend((inner.len() as u32).to_le_bytes());
        bundle.extend(lz4_flex::compress(&inner));
        let events = GameStream::new().push(&packet(&bundle), 0);
        assert_eq!(
            events,
            vec![
                GameEvent::Pets(PetRecord::LevelUp { pet: 1001, level: 1 }),
                GameEvent::Pets(PetRecord::SoulsGained(vec![SoulGain { pet: 1002, amount: 3 }])),
            ]
        );
    }

    #[test]
    fn the_boss_map_comes_through_the_stream() {
        let now = 1_791_992_733_074;
        let bytes = hex(include_str!("testdata/boss_map_v1.hex"));
        let events = GameStream::new().push(&bytes, now);
        let [GameEvent::BossMap(map)] = events.as_slice() else { panic!("{events:?}") };
        assert_eq!((map.map_id, map.bosses.len()), (1010, 24));
    }
}
