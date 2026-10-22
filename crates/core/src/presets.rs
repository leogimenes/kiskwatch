//! Skill presets. The game keeps 3, each with its own skills and stigmas, but
//! the official profile shows only the one in use. So each read is filed
//! under a preset and the others are the reads kept from before.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The game's skill presets.
pub const PRESETS: u8 = 3;

/// One preset as the site showed it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Preset {
    /// The profile's `equipment.skill`, as sent.
    pub skill: Value,
    pub fetched_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Presets {
    /// The preset (1 to 3) the last read is.
    pub current: u8,
    pub kept: BTreeMap<u8, Preset>,
    /// The preset the last read wrote over, to give back if it moves.
    pub replaced: Option<(u8, Preset)>,
}

/// The stigmas slotted in a skill list: equipped and levelled. A stigma on
/// another preset still has the equipped mark, but no level.
pub fn slotted(skill: &Value) -> Vec<u64> {
    let mut ids: Vec<u64> = skill
        .get("skillList")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| matches!(s.get("category").and_then(Value::as_str), Some("Dp" | "Stigma")))
        .filter(|s| s.get("equip").and_then(Value::as_u64) == Some(1) && s.get("skillLevel").and_then(Value::as_u64).unwrap_or(0) > 0)
        .filter_map(|s| s.get("id")?.as_u64())
        .collect();
    ids.sort_unstable();
    ids
}

impl Presets {
    /// Files a read: under the preset with the same slotted stigmas, else the
    /// first not read yet, else the one in use last time.
    pub fn file(before: Option<&Presets>, skill: Value, fetched_ms: i64) -> Presets {
        let mut kept = before.map(|b| b.kept.clone()).unwrap_or_default();
        let last = before.map_or(1, |b| b.current.clamp(1, PRESETS));
        let stigmas = slotted(&skill);
        let n = kept
            .iter()
            .find(|(_, p)| !stigmas.is_empty() && slotted(&p.skill) == stigmas)
            .map(|(n, _)| *n)
            .or_else(|| (1..=PRESETS).find(|n| !kept.contains_key(n)))
            .unwrap_or(last);
        let replaced = kept.insert(n, Preset { skill, fetched_ms }).map(|old| (n, old));
        Presets { current: n, kept, replaced }
    }

    /// The user says the last read is preset `n`: move it there, giving back
    /// what it wrote over where it was filed.
    pub fn move_to(&mut self, n: u8) {
        let from = self.current;
        if !(1..=PRESETS).contains(&n) || n == from {
            return;
        }
        let Some(read) = self.kept.remove(&from) else { return };
        if let Some((at, old)) = self.replaced.take() {
            if at == from {
                self.kept.insert(from, old);
            }
        }
        self.replaced = self.kept.insert(n, read).map(|old| (n, old));
        self.current = n;
    }

    /// Drops a preset kept from before; the one in use stays.
    pub fn forget(&mut self, n: u8) {
        if n != self.current {
            self.kept.remove(&n);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn skill(stigmas: &[(u64, u64)]) -> Value {
        let list: Vec<Value> = stigmas
            .iter()
            .map(|(id, lv)| json!({ "id": id, "category": "Dp", "equip": 1, "skillLevel": lv, "acquired": 1 }))
            .chain([json!({ "id": 1, "category": "Active", "equip": 1, "skillLevel": 10, "acquired": 1 })])
            .collect();
        json!({ "skillList": list })
    }

    fn file(before: Option<&Presets>, stigmas: &[(u64, u64)], at: i64) -> Presets {
        Presets::file(before, skill(stigmas), at)
    }

    #[test]
    fn slotted_stigmas_have_a_level() {
        assert_eq!(slotted(&skill(&[(30, 5), (20, 0), (10, 3)])), [10, 30], "level 0 is on another preset");
        assert!(slotted(&Value::Null).is_empty());
    }

    #[test]
    fn files_reads_under_presets() {
        let a = file(None, &[(10, 5)], 1);
        assert_eq!(a.current, 1);
        let b = file(Some(&a), &[(20, 5)], 2);
        assert_eq!((b.current, b.kept.len()), (2, 2), "new stigmas: the first preset not read");
        let c = file(Some(&b), &[(10, 6), (20, 0)], 3);
        assert_eq!(c.current, 1, "same stigmas as preset 1, levels aside");
        assert_eq!(c.kept[&2].fetched_ms, 2, "preset 2 is kept");
        let d = file(Some(&c), &[(30, 5)], 4);
        let e = file(Some(&d), &[(40, 5)], 5);
        assert_eq!(e.current, 3, "all read and none match: the one in use last");
        assert_eq!(e.replaced.as_ref().map(|r| (r.0, r.1.fetched_ms)), Some((3, 4)));
        assert_eq!(file(Some(&Presets::default()), &[], 6).current, 1, "an old save with no presets");
    }

    #[test]
    fn moving_a_read_gives_back_what_it_wrote_over() {
        let a = file(None, &[(10, 5)], 1);
        let b = file(Some(&a), &[(20, 5)], 2);
        let c = file(Some(&b), &[(30, 5)], 3);
        let mut d = file(Some(&c), &[(40, 5)], 4);
        assert_eq!(d.current, 3);
        d.move_to(2);
        assert_eq!(d.current, 2);
        assert_eq!(d.kept[&3].fetched_ms, 3, "preset 3 is back");
        assert_eq!(d.kept[&2].fetched_ms, 4);
        assert_eq!(d.replaced.as_ref().map(|r| (r.0, r.1.fetched_ms)), Some((2, 2)));
        d.move_to(9);
        assert_eq!(d.current, 2, "only 1 to 3");
        d.forget(2);
        assert!(d.kept.contains_key(&2), "the one in use stays");
        d.forget(1);
        assert!(!d.kept.contains_key(&1));
    }

    #[test]
    fn a_first_read_moves_to_an_empty_preset() {
        let mut a = file(None, &[(10, 5)], 1);
        a.move_to(3);
        assert_eq!((a.current, a.kept.keys().copied().collect::<Vec<_>>()), (3, vec![3]));
    }
}
