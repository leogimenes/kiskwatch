//! Boss history: every recording against the same boss, how long it took and
//! how much damage per second, and a fight set against your best one.
//!
//! A recording counts for the boss it hit hardest. The game doesn't say when
//! a boss dies, so a fight's time against it runs from the first hit any
//! player landed on it to the last. Your best is the recording where your
//! damage per second on it was highest.

use std::collections::HashMap;

use serde::Serialize;

use crate::dps::{Fight, FightBoss};

/// One recording against a boss.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attempt {
    pub fight_id: String,
    pub name: String,
    pub started_ms: i64,
    /// First to last hit on the boss.
    pub kill_ms: i64,
    pub my_dps: f64,
    pub group_dps: f64,
    pub players: usize,
}

/// Every recording against one boss, newest first.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BossHistory {
    pub code: i32,
    pub attempts: Vec<Attempt>,
    /// The attempt with your highest damage per second.
    pub best_id: String,
    pub avg_kill_ms: i64,
    pub fastest_kill_ms: i64,
    pub avg_my_dps: f64,
    pub avg_group_dps: f64,
}

/// The boss a recording was against: the one it hit hardest.
pub fn main_boss(f: &Fight) -> Option<&FightBoss> {
    f.bosses.first().filter(|b| b.damage > 0)
}

fn kill_ms(b: &FightBoss) -> i64 {
    (b.last_ms - b.first_ms).max(1_000)
}

fn per_second(n: i64, ms: i64) -> f64 {
    n as f64 * 1000.0 / ms as f64
}

fn attempt(f: &Fight, b: &FightBoss) -> Attempt {
    let ms = kill_ms(b);
    Attempt {
        fight_id: f.id.clone(),
        name: f.name.clone(),
        started_ms: f.started_ms,
        kill_ms: ms,
        my_dps: per_second(b.my_damage, ms),
        group_dps: per_second(b.damage, ms),
        players: f.players.len(),
    }
}

/// The best of a boss's recordings: your highest damage per second, the
/// faster on a tie.
fn best<'a>(fights: impl Iterator<Item = &'a Fight>, code: i32) -> Option<&'a Fight> {
    fights
        .filter_map(|f| main_boss(f).filter(|b| b.code == code).map(|b| (f, attempt(f, b))))
        .max_by(|(_, a), (_, b)| a.my_dps.total_cmp(&b.my_dps).then(b.kill_ms.cmp(&a.kill_ms)))
        .map(|(f, _)| f)
}

/// Each boss's recordings, the boss fought most recently first.
pub fn by_boss(fights: &[Fight]) -> Vec<BossHistory> {
    let mut groups: HashMap<i32, Vec<Attempt>> = HashMap::new();
    for f in fights {
        if let Some(b) = main_boss(f) {
            groups.entry(b.code).or_default().push(attempt(f, b));
        }
    }
    let mut out: Vec<BossHistory> = groups
        .into_iter()
        .map(|(code, mut attempts)| {
            attempts.sort_by_key(|a| std::cmp::Reverse(a.started_ms));
            let n = attempts.len() as f64;
            let best_id = best(fights.iter(), code).map(|f| f.id.clone()).unwrap_or_default();
            BossHistory {
                code,
                best_id,
                avg_kill_ms: (attempts.iter().map(|a| a.kill_ms as f64).sum::<f64>() / n).round() as i64,
                fastest_kill_ms: attempts.iter().map(|a| a.kill_ms).min().unwrap_or_default(),
                avg_my_dps: attempts.iter().map(|a| a.my_dps).sum::<f64>() / n,
                avg_group_dps: attempts.iter().map(|a| a.group_dps).sum::<f64>() / n,
                attempts,
            }
        })
        .collect();
    out.sort_by_key(|h| (std::cmp::Reverse(h.attempts[0].started_ms), h.code));
    out
}

/// A skill's damage on the boss, in this fight and in the best.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkillDiff {
    pub skill: i32,
    pub damage: i64,
    pub hits: u32,
    pub dps: f64,
    pub best_damage: i64,
    pub best_hits: u32,
    pub best_dps: f64,
}

/// A fight set against your best recording against the same boss.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Comparison {
    pub code: i32,
    pub now: Attempt,
    pub best: Attempt,
    /// This fight is the best one: `best` is the best of the others.
    pub is_best: bool,
    /// Every skill either used, the best fight's biggest first.
    pub skills: Vec<SkillDiff>,
}

/// `fight` against the best of the other recordings (`saved`) against its boss.
pub fn compare(fight: &Fight, saved: &[Fight]) -> Option<Comparison> {
    let b = main_boss(fight)?;
    let other = best(saved.iter().filter(|f| f.id != fight.id), b.code)?;
    let ob = main_boss(other)?;
    let now = attempt(fight, b);
    let then = attempt(other, ob);
    let mut skills: HashMap<i32, SkillDiff> = HashMap::new();
    let blank = |skill| SkillDiff { skill, damage: 0, hits: 0, dps: 0.0, best_damage: 0, best_hits: 0, best_dps: 0.0 };
    for s in &b.my_skills {
        let d = skills.entry(s.skill).or_insert_with(|| blank(s.skill));
        (d.damage, d.hits, d.dps) = (s.damage, s.hits, per_second(s.damage, now.kill_ms));
    }
    for s in &ob.my_skills {
        let d = skills.entry(s.skill).or_insert_with(|| blank(s.skill));
        (d.best_damage, d.best_hits, d.best_dps) = (s.damage, s.hits, per_second(s.damage, then.kill_ms));
    }
    let mut skills: Vec<SkillDiff> = skills.into_values().collect();
    skills.sort_by_key(|s| (std::cmp::Reverse(s.best_damage), std::cmp::Reverse(s.damage), s.skill));
    let is_best = now.my_dps >= then.my_dps;
    Some(Comparison { code: b.code, now, best: then, is_best, skills })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dps::SkillDamage;

    const BOSS: i32 = 2_301_208;
    const OTHER: i32 = 2_301_300;

    /// A fight starting at `at` s, `secs` long on `code`, your damage by skill.
    fn fight(at: i64, code: i32, secs: i64, group: i64, mine: &[(i32, i64)]) -> Fight {
        Fight {
            id: at.to_string(),
            name: format!("luta {at}"),
            started_ms: at * 1000,
            ended_ms: (at + secs) * 1000,
            bosses: vec![FightBoss {
                code,
                first_ms: at * 1000,
                last_ms: (at + secs) * 1000,
                damage: group,
                my_damage: mine.iter().map(|s| s.1).sum(),
                my_skills: mine.iter().map(|&(skill, damage)| SkillDamage { skill, damage, hits: 1 }).collect(),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn recordings_group_by_boss_with_averages() {
        let fights = [
            fight(300, BOSS, 100, 10_000, &[(1, 1_000)]),
            fight(200, OTHER, 10, 500, &[(1, 100)]),
            fight(100, BOSS, 50, 10_000, &[(1, 1_000)]),
            Fight { id: "0".into(), ..Default::default() },
        ];
        let h = by_boss(&fights);
        assert_eq!(h.iter().map(|h| h.code).collect::<Vec<_>>(), [BOSS, OTHER]);
        let boss = &h[0];
        assert_eq!(boss.attempts.iter().map(|a| a.fight_id.as_str()).collect::<Vec<_>>(), ["300", "100"]);
        assert_eq!((boss.avg_kill_ms, boss.fastest_kill_ms), (75_000, 50_000));
        assert_eq!((boss.avg_my_dps, boss.avg_group_dps), (15.0, 150.0));
        assert_eq!(boss.best_id, "100");
    }

    #[test]
    fn a_fight_against_the_best_skill_by_skill() {
        let fights = [
            fight(300, BOSS, 100, 10_000, &[(1, 600), (2, 400)]),
            fight(200, BOSS, 50, 10_000, &[(1, 1_000), (3, 500)]),
            fight(100, BOSS, 100, 10_000, &[(1, 100)]),
        ];
        let c = compare(&fights[0], &fights).unwrap();
        assert!(!c.is_best);
        assert_eq!((c.now.my_dps, c.best.my_dps, c.best.fight_id.as_str()), (10.0, 30.0, "200"));
        let s: Vec<_> = c.skills.iter().map(|s| (s.skill, s.damage, s.best_damage)).collect();
        assert_eq!(s, [(1, 600, 1_000), (3, 0, 500), (2, 400, 0)]);
        assert_eq!((c.skills[0].dps, c.skills[0].best_dps), (6.0, 20.0));
    }

    #[test]
    fn the_best_is_set_against_the_next_best() {
        let fights = [fight(200, BOSS, 50, 10_000, &[(1, 1_000)]), fight(100, BOSS, 100, 10_000, &[(1, 100)])];
        let c = compare(&fights[0], &fights).unwrap();
        assert!(c.is_best);
        assert_eq!(c.best.fight_id, "100");
    }

    #[test]
    fn nothing_to_compare_alone() {
        let fights = [fight(200, BOSS, 50, 10_000, &[(1, 1_000)]), fight(100, OTHER, 10, 10, &[])];
        assert_eq!(compare(&fights[0], &fights), None);
        assert_eq!(compare(&Fight::default(), &fights), None);
    }
}
