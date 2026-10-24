//! Picks the game's connection out of everything captured, and reads it.
//!
//! The game's server sends a record terminator (`0E 00 36`, before June 2026
//! `06 00 36`) many times a second, even while idle, and nothing else on a
//! PC does at that rate: a connection that carries it often enough within a
//! short window is the game (A2Tools' `capture_dispatcher.rs` locks onto the
//! game's port the same way). Until then each connection's bytes are kept, so
//! what the game sends right after connecting (the pet list, once per entry
//! into the world) is still read once the connection proves to be the game.
//!
//! Only one connection is read at a time: a ping reducer or VPN repeats the
//! game's stream on a second device, and reading both would count every soul
//! twice. Another connection takes over only once the one being read has gone
//! quiet (a server switch opens a new connection).

use std::collections::HashMap;
use std::net::Ipv4Addr;

use crate::stream::{GameEvent, GameStream};

const SIGNATURES: [&[u8]; 2] = [&[0x0E, 0x00, 0x36], &[0x06, 0x00, 0x36]];
/// Signature-bearing segments a connection must send within the window.
const LOCK_THRESHOLD: u32 = 12;
const LOCK_WINDOW_MS: i64 = 3_000;
/// The connection being read counts as gone after this long without a segment.
const QUIET_MS: i64 = 5_000;
/// Connections followed before one proves to be the game, and the bytes kept
/// for each.
const MAX_CANDIDATES: usize = 16;
const MAX_PENDING_BYTES: usize = 4 * 1024 * 1024;
/// A segment that arrives ahead of a missing one waits for it this long, or
/// until this many bytes wait behind the gap. A segment lost on the network
/// comes again well within that (the server resends it); one the capture
/// missed never does, and the stream goes on without it.
const GAP_WAIT_MS: i64 = 5_000;
const GAP_WAIT_BYTES: usize = 256 * 1024;
/// A segment this far from where the stream stands belongs to a new
/// connection on the same ports, not to this one.
const RESYNC_BYTES: u32 = 1 << 20;

/// A TCP segment's payload, server to client or the other way round.
#[derive(Debug, Clone)]
pub struct Segment {
    pub src_ip: Ipv4Addr,
    pub src_port: u16,
    pub dst_ip: Ipv4Addr,
    pub dst_port: u16,
    pub seq: u32,
    pub data: Vec<u8>,
}

/// One direction of one connection: the sender's address, then the receiver's.
pub type FlowKey = (Ipv4Addr, u16, Ipv4Addr, u16);

impl Segment {
    fn key(&self) -> FlowKey {
        (self.src_ip, self.src_port, self.dst_ip, self.dst_port)
    }
}

#[derive(Default)]
struct Flow {
    /// Signature hits in the current window, and the last one.
    hits: u32,
    last_hit_ms: i64,
    last_seen_ms: i64,
    /// The sequence number the next new byte will carry, once one is seen.
    next_seq: Option<u32>,
    /// Segments that came ahead of a missing one, and since when.
    ahead: Vec<(u32, Vec<u8>)>,
    ahead_since_ms: i64,
    /// Bytes kept until the flow proves to be the game.
    pending: Vec<u8>,
    stream: Option<GameStream>,
}

/// How far `seq` lies past `from`, across the wrap at 2^32: negative for
/// bytes already behind it.
fn distance(from: u32, seq: u32) -> i32 {
    seq.wrapping_sub(from) as i32
}

impl Flow {
    /// The bytes of `seg` not read yet, in the order the server sent them,
    /// with any held segments it makes whole. A retransmission (or the same
    /// segment captured twice) gives nothing; a segment past a gap is held
    /// until the gap fills, or given up on (`GAP_WAIT_MS`), and the framing
    /// resynchronises on its own.
    fn accept(&mut self, seg: &Segment, now_ms: i64) -> Vec<u8> {
        if seg.data.is_empty() {
            return Vec::new();
        }
        let Some(next) = self.next_seq else {
            self.next_seq = Some(seg.seq.wrapping_add(seg.data.len() as u32));
            return seg.data.clone();
        };
        let at = distance(next, seg.seq);
        if at.unsigned_abs() > RESYNC_BYTES {
            let mut out = self.give_up_gap();
            out.extend_from_slice(&seg.data);
            self.next_seq = Some(seg.seq.wrapping_add(seg.data.len() as u32));
            return out;
        }
        if at > 0 {
            if self.ahead.is_empty() {
                self.ahead_since_ms = now_ms;
            }
            self.ahead.push((seg.seq, seg.data.clone()));
            let waiting: usize = self.ahead.iter().map(|(_, d)| d.len()).sum();
            if now_ms - self.ahead_since_ms >= GAP_WAIT_MS || waiting >= GAP_WAIT_BYTES {
                return self.give_up_gap();
            }
            return Vec::new();
        }
        let mut out = Vec::new();
        self.take(seg.seq, &seg.data, &mut out);
        self.take_held(&mut out);
        out
    }

    /// The part of a segment that starts at or before `next_seq` and is not
    /// read yet.
    fn take(&mut self, seq: u32, data: &[u8], out: &mut Vec<u8>) {
        let Some(next) = self.next_seq else { return };
        let skip = (-distance(next, seq)) as usize;
        if skip < data.len() {
            out.extend_from_slice(&data[skip..]);
            self.next_seq = Some(seq.wrapping_add(data.len() as u32));
        }
    }

    /// The held segments the stream has reached, in order.
    fn take_held(&mut self, out: &mut Vec<u8>) {
        while let Some(next) = self.next_seq {
            let Some(i) = self.ahead.iter().position(|(seq, _)| distance(next, *seq) <= 0) else { break };
            let (seq, data) = self.ahead.swap_remove(i);
            self.take(seq, &data, out);
        }
    }

    /// Go on past the gap: the held segments, in order, each gap skipped.
    fn give_up_gap(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        while let Some(next) = self.next_seq {
            let Some(first) = self.ahead.iter().map(|(seq, _)| *seq).min_by_key(|&seq| distance(next, seq)) else { break };
            if distance(next, first) > 0 {
                self.next_seq = Some(first);
            }
            self.take_held(&mut out);
        }
        self.ahead.clear();
        out
    }
}

#[derive(Default)]
pub struct Dispatcher {
    flows: HashMap<FlowKey, Flow>,
    active: Option<FlowKey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct DispatchStatus {
    /// The game's connection has been found.
    pub locked: bool,
    pub server_port: Option<u16>,
}

fn has_signature(data: &[u8]) -> bool {
    SIGNATURES.iter().any(|sig| data.windows(sig.len()).any(|w| w == *sig))
}

impl Dispatcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> DispatchStatus {
        DispatchStatus { locked: self.active.is_some(), server_port: self.active.map(|k| k.1) }
    }

    /// Take a captured segment; return what the game said in it, if anything.
    pub fn offer(&mut self, seg: Segment, now_ms: i64) -> Vec<GameEvent> {
        let key = seg.key();
        if self.active == Some(key) {
            let flow = self.flows.get_mut(&key).expect("the active flow is kept");
            flow.last_seen_ms = now_ms;
            let data = flow.accept(&seg, now_ms);
            return flow.stream.get_or_insert_default().push(&data, now_ms);
        }
        // The other direction of the game's connection, or something else
        // while the game's is live: not read.
        let active_live = self.active.and_then(|k| self.flows.get(&k)).is_some_and(|f| now_ms - f.last_seen_ms < QUIET_MS);
        if active_live && !has_signature(&seg.data) {
            return Vec::new();
        }
        if !self.flows.contains_key(&key) {
            if self.flows.len() >= MAX_CANDIDATES {
                self.forget_quiet(now_ms);
                if self.flows.len() >= MAX_CANDIDATES {
                    return Vec::new();
                }
            }
            self.flows.insert(key, Flow::default());
        }
        let flow = self.flows.get_mut(&key).unwrap();
        flow.last_seen_ms = now_ms;
        let signed = has_signature(&seg.data);
        let data = flow.accept(&seg, now_ms);
        if flow.pending.len() + data.len() <= MAX_PENDING_BYTES {
            flow.pending.extend_from_slice(&data);
        }
        if signed {
            if now_ms - flow.last_hit_ms > LOCK_WINDOW_MS {
                flow.hits = 0;
            }
            flow.hits += 1;
            flow.last_hit_ms = now_ms;
        }
        if flow.hits < LOCK_THRESHOLD || active_live {
            return Vec::new();
        }
        // This is the game now: read everything it sent so far.
        let pending = std::mem::take(&mut flow.pending);
        let mut stream = GameStream::new();
        let events = stream.push(&pending, now_ms);
        flow.stream = Some(stream);
        if let Some(old) = self.active.replace(key) {
            self.flows.remove(&old);
        }
        events
    }

    fn forget_quiet(&mut self, now_ms: i64) {
        let active = self.active;
        self.flows.retain(|k, f| Some(*k) == active || now_ms - f.last_seen_ms < QUIET_MS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::length_value;
    use crate::pets::{OPCODE_LEVEL_UP, PetRecord};

    const SERVER: Ipv4Addr = Ipv4Addr::new(193, 202, 112, 99);
    const ME: Ipv4Addr = Ipv4Addr::new(10, 0, 0, 2);

    fn packet(payload: &[u8]) -> Vec<u8> {
        let len = length_value(payload.len()) as u8;
        assert!(len < 0x80);
        [&[len][..], payload].concat()
    }

    /// An idle game record carrying the terminator.
    fn heartbeat() -> Vec<u8> {
        packet(&[0x23, 0x36, 0x01, 0x0E, 0x00, 0x36])
    }

    fn level_up(pet: u32, level: u32) -> Vec<u8> {
        let mut p = OPCODE_LEVEL_UP.to_vec();
        p.extend([0, 0]);
        p.extend(pet.to_le_bytes());
        p.extend(level.to_le_bytes());
        packet(&p)
    }

    struct Conn {
        src_ip: Ipv4Addr,
        src_port: u16,
        seq: u32,
    }

    impl Conn {
        fn new(src_ip: Ipv4Addr, src_port: u16) -> Self {
            Self { src_ip, src_port, seq: 1000 }
        }
        fn send(&mut self, data: Vec<u8>) -> Segment {
            let seg = Segment { src_ip: self.src_ip, src_port: self.src_port, dst_ip: ME, dst_port: 50000, seq: self.seq, data };
            self.seq = self.seq.wrapping_add(seg.data.len() as u32);
            seg
        }
    }

    fn lock(d: &mut Dispatcher, c: &mut Conn, now: i64) -> Vec<GameEvent> {
        (0..LOCK_THRESHOLD).flat_map(|i| d.offer(c.send(heartbeat()), now + i as i64 * 50)).collect()
    }

    #[test]
    fn what_the_game_sent_before_it_was_found_is_still_read() {
        let mut d = Dispatcher::new();
        let mut game = Conn::new(SERVER, 13328);
        // The pet record comes first, at login, before any heartbeat.
        assert!(d.offer(game.send(level_up(1016, 2)), 0).is_empty());
        assert!(!d.status().locked);
        let events = lock(&mut d, &mut game, 100);
        assert_eq!(events, vec![GameEvent::Pets(PetRecord::LevelUp { pet: 1016, level: 2 })]);
        assert_eq!(d.status(), DispatchStatus { locked: true, server_port: Some(13328) });
        assert_eq!(d.offer(game.send(level_up(1017, 1)), 2_000), vec![GameEvent::Pets(PetRecord::LevelUp { pet: 1017, level: 1 })]);
    }

    #[test]
    fn other_traffic_never_locks() {
        let mut d = Dispatcher::new();
        let mut web = Conn::new(Ipv4Addr::new(1, 1, 1, 1), 8080);
        for i in 0..100 {
            d.offer(web.send(level_up(1016, 2)), i * 10);
        }
        assert!(!d.status().locked);
    }

    #[test]
    fn a_retransmitted_segment_is_read_once() {
        let mut d = Dispatcher::new();
        let mut game = Conn::new(SERVER, 13328);
        lock(&mut d, &mut game, 0);
        let seg = game.send(level_up(1016, 2));
        assert_eq!(d.offer(seg.clone(), 1_000).len(), 1);
        assert!(d.offer(seg, 1_001).is_empty(), "the same bytes again");
    }

    #[test]
    fn segments_out_of_order_are_read_in_order() {
        let mut d = Dispatcher::new();
        let mut game = Conn::new(SERVER, 13328);
        lock(&mut d, &mut game, 0);
        let first = game.send(level_up(1016, 2));
        let second = game.send(level_up(1017, 3));
        assert!(d.offer(second.clone(), 1_000).is_empty(), "held until the one before it comes");
        assert_eq!(
            d.offer(first.clone(), 1_200),
            vec![GameEvent::Pets(PetRecord::LevelUp { pet: 1016, level: 2 }), GameEvent::Pets(PetRecord::LevelUp { pet: 1017, level: 3 })]
        );
        assert!(d.offer(second, 1_300).is_empty(), "already read");
        assert!(d.offer(first, 1_400).is_empty(), "already read");
    }

    #[test]
    fn a_gap_that_never_fills_is_given_up() {
        let mut d = Dispatcher::new();
        let mut game = Conn::new(SERVER, 13328);
        lock(&mut d, &mut game, 0);
        game.send(level_up(1016, 2));
        assert!(d.offer(game.send(level_up(1017, 3)), 1_000).is_empty());
        let events = d.offer(game.send(level_up(1018, 4)), 1_000 + GAP_WAIT_MS);
        assert_eq!(events, vec![GameEvent::Pets(PetRecord::LevelUp { pet: 1017, level: 3 }), GameEvent::Pets(PetRecord::LevelUp { pet: 1018, level: 4 })]);
        assert_eq!(d.offer(game.send(level_up(1019, 5)), 6_100).len(), 1, "read as it comes again");
    }

    #[test]
    fn a_relayed_copy_is_not_read_while_the_game_connection_is_live() {
        let mut d = Dispatcher::new();
        let mut game = Conn::new(SERVER, 13328);
        let mut relay = Conn::new(Ipv4Addr::LOCALHOST, 13328);
        lock(&mut d, &mut game, 0);
        assert!(lock(&mut d, &mut relay, 100).is_empty());
        d.offer(game.send(heartbeat()), 1_000);
        assert!(d.offer(relay.send(level_up(1016, 2)), 1_100).is_empty());
        assert_eq!(d.status().server_port, Some(13328));
    }

    #[test]
    fn a_new_connection_takes_over_once_the_old_one_is_quiet() {
        let mut d = Dispatcher::new();
        let mut old = Conn::new(SERVER, 13328);
        lock(&mut d, &mut old, 0);
        let mut new = Conn::new(Ipv4Addr::new(193, 202, 112, 100), 13329);
        let quiet = 1_000 + QUIET_MS;
        assert!(d.offer(new.send(level_up(1020, 1)), quiet).is_empty());
        let events = lock(&mut d, &mut new, quiet + 100);
        assert_eq!(events, vec![GameEvent::Pets(PetRecord::LevelUp { pet: 1020, level: 1 })]);
        assert_eq!(d.status().server_port, Some(13329));
    }
}
