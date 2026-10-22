//! When each player used each skill, to set against the skill's cooldown.
//!
//! The game sends hits, not casts: one use of a skill can hit several targets
//! or hit several times. Hits of the same skill by the same player that come
//! within `SAME_USE_MS` of the last one are the same use; DoT ticks are never
//! a use.
//!
//! Skills are counted by their base id: the last four digits of a player
//! skill are the specializations picked for it (17010230 is 17010000 with
//! specializations 2 and 3), the id the game data and the profile use.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::combat::Class;

/// Hits this close to the skill's last hit belong to the same use.
pub const SAME_USE_MS: i64 = 1_000;

/// One skill's uses in a recording.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SkillCasts {
    /// The base skill id.
    pub skill: i32,
    /// Each use, in ms from the recording's start.
    pub at: Vec<i64>,
}

/// A player skill's base id; none for a monster's or a summon's skill.
pub fn base_skill(skill: i32) -> Option<i32> {
    Class::of_skill(skill).map(|_| skill / 10_000 * 10_000)
}

#[derive(Debug, Clone, Default)]
struct Uses {
    at: Vec<i64>,
    last_hit: i64,
}

/// Uses by (player, base skill) over a recording.
#[derive(Debug, Clone, Default)]
pub struct Casts {
    uses: HashMap<(i32, i32), Uses>,
}

impl Casts {
    /// A hit by `actor` at `now`, a recording that started at `started`.
    pub fn hit(&mut self, actor: i32, skill: i32, dot: bool, now: i64, started: i64) {
        let Some(skill) = base_skill(skill).filter(|_| !dot) else { return };
        let u = self.uses.entry((actor, skill)).or_default();
        if u.at.is_empty() || now - u.last_hit > SAME_USE_MS {
            u.at.push(now - started);
        }
        u.last_hit = now;
    }

    /// A player's skills, most used first.
    pub fn of(&self, actor: i32) -> Vec<SkillCasts> {
        let mut out: Vec<SkillCasts> =
            self.uses.iter().filter(|((a, _), _)| *a == actor).map(|(&(_, skill), u)| SkillCasts { skill, at: u.at.clone() }).collect();
        out.sort_by_key(|s| (std::cmp::Reverse(s.at.len()), s.skill));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hits_close_together_are_one_use() {
        let mut c = Casts::default();
        // Three targets at once, a second hit 600 ms later, then a new use.
        for now in [10_000, 10_000, 10_000, 10_600, 18_000] {
            c.hit(1, 17_010_230, false, now, 9_000);
        }
        assert_eq!(c.of(1), vec![SkillCasts { skill: 17_010_000, at: vec![1_000, 9_000] }]);
    }

    #[test]
    fn a_long_multi_hit_stays_one_use() {
        let mut c = Casts::default();
        for now in (0..4_000).step_by(800) {
            c.hit(1, 14_020_000, false, now, 0);
        }
        assert_eq!(c.of(1)[0].at, vec![0]);
    }

    #[test]
    fn ticks_and_monster_skills_are_not_uses() {
        let mut c = Casts::default();
        c.hit(1, 17_030_000, true, 0, 0);
        c.hit(1, 2_000_100, false, 0, 0);
        c.hit(1, 11_000_000, false, 0, 0);
        assert!(c.of(1).is_empty());
    }

    #[test]
    fn specializations_count_as_the_same_skill() {
        let mut c = Casts::default();
        c.hit(1, 17_010_000, false, 0, 0);
        c.hit(1, 17_010_047, false, 5_000, 0);
        c.hit(2, 17_010_000, false, 5_000, 0);
        assert_eq!(c.of(1), vec![SkillCasts { skill: 17_010_000, at: vec![0, 5_000] }]);
        assert_eq!(c.of(2).len(), 1);
    }
}
