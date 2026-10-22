//! The daily and weekly checklist: tasks to do once (or a few times) between
//! resets, ticked off per character.
//!
//! Nothing is wiped at the reset: each tick keeps when it was made, and a tick
//! from before its period's last reset counts as not done.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Period {
    Daily,
    Weekly,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub period: Period,
    /// How many times a period it can be done (runs, entries).
    #[serde(default = "one")]
    pub times: u32,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Character {
    pub id: String,
    pub name: String,
    /// Tasks this character doesn't do.
    #[serde(default)]
    pub skip: Vec<String>,
}

/// How many times a task was done, and when that was last changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mark {
    pub count: u32,
    pub at_ms: i64,
}

/// When each period last reset, unix ms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Resets {
    pub daily_ms: i64,
    pub weekly_ms: i64,
}

impl Resets {
    fn of(&self, period: Period) -> i64 {
        match period {
            Period::Daily => self.daily_ms,
            Period::Weekly => self.weekly_ms,
        }
    }
}

/// Most tasks and characters kept, and the longest name.
pub const MAX_TASKS: usize = 60;
pub const MAX_CHARACTERS: usize = 12;
pub const MAX_NAME: usize = 50;
pub const MAX_TIMES: u32 = 99;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Checklist {
    pub tasks: Vec<Task>,
    pub characters: Vec<Character>,
    /// Ticks by character id, then task id.
    pub marks: BTreeMap<String, BTreeMap<String, Mark>>,
}

impl Default for Checklist {
    /// A start to edit: what most players do, without guessing at names.
    fn default() -> Self {
        let task = |id: &str, name: &str, period, times| Task { id: id.into(), name: name.into(), period, times };
        Self {
            tasks: vec![
                task("d-quests", "Missões diárias", Period::Daily, 1),
                task("d-dungeons", "Masmorras do dia", Period::Daily, 1),
                task("d-shop", "Loja diária", Period::Daily, 1),
                task("w-quests", "Missões semanais", Period::Weekly, 1),
                task("w-dungeons", "Masmorras da semana", Period::Weekly, 1),
                task("w-bosses", "Chefes semanais", Period::Weekly, 1),
                task("w-shop", "Loja semanal", Period::Weekly, 1),
            ],
            characters: Vec::new(),
            marks: BTreeMap::new(),
        }
    }
}

fn clip(name: &str) -> String {
    name.trim().chars().take(MAX_NAME).collect()
}

impl Checklist {
    /// How many times `character` did `task` since its period's last reset.
    pub fn count(&self, character: &str, task: &str, resets: Resets) -> u32 {
        let Some(t) = self.tasks.iter().find(|t| t.id == task) else { return 0 };
        match self.marks.get(character).and_then(|m| m.get(task)) {
            Some(m) if m.at_ms >= resets.of(t.period) => m.count.min(t.times),
            _ => 0,
        }
    }

    /// Set how many times `character` did `task` this period.
    pub fn mark(&mut self, character: &str, task: &str, count: u32, now_ms: i64, resets: Resets) {
        let Some(t) = self.tasks.iter().find(|t| t.id == task) else { return };
        if !self.characters.iter().any(|c| c.id == character) {
            return;
        }
        let count = count.min(t.times);
        let marks = self.marks.entry(character.to_string()).or_default();
        if count == 0 {
            marks.remove(task);
        } else {
            marks.insert(task.to_string(), Mark { count, at_ms: now_ms });
        }
        self.prune(resets);
    }

    /// Take a new list of tasks and characters, keeping the ticks of those
    /// still there.
    pub fn edit(&mut self, tasks: Vec<Task>, characters: Vec<Character>, resets: Resets) {
        let mut seen = std::collections::HashSet::new();
        self.tasks = tasks
            .into_iter()
            .filter(|t| !t.id.is_empty() && seen.insert(t.id.clone()))
            .map(|t| Task { name: clip(&t.name), times: t.times.clamp(1, MAX_TIMES), ..t })
            .filter(|t| !t.name.is_empty())
            .take(MAX_TASKS)
            .collect();
        let mut seen = std::collections::HashSet::new();
        self.characters = characters
            .into_iter()
            .filter(|c| !c.id.is_empty() && seen.insert(c.id.clone()))
            .map(|c| Character { name: clip(&c.name), ..c })
            .filter(|c| !c.name.is_empty())
            .take(MAX_CHARACTERS)
            .collect();
        let tasks: Vec<String> = self.tasks.iter().map(|t| t.id.clone()).collect();
        for c in &mut self.characters {
            c.skip.retain(|s| tasks.contains(s));
        }
        self.prune(resets);
    }

    /// Drop the ticks that no longer count: from before a reset, or of a task
    /// or character that's gone.
    fn prune(&mut self, resets: Resets) {
        let periods: BTreeMap<&str, Period> = self.tasks.iter().map(|t| (t.id.as_str(), t.period)).collect();
        let chars: Vec<&str> = self.characters.iter().map(|c| c.id.as_str()).collect();
        self.marks.retain(|c, _| chars.contains(&c.as_str()));
        for marks in self.marks.values_mut() {
            marks.retain(|task, m| periods.get(task.as_str()).is_some_and(|&p| m.at_ms >= resets.of(p)));
        }
        self.marks.retain(|_, m| !m.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RESETS: Resets = Resets { daily_ms: 1_000, weekly_ms: 500 };

    fn list() -> Checklist {
        let mut c = Checklist::default();
        c.characters.push(Character { id: "a".into(), name: "Kisk".into(), skip: vec![] });
        c.tasks.push(Task { id: "runs".into(), name: "Runs".into(), period: Period::Daily, times: 3 });
        c
    }

    #[test]
    fn a_tick_counts_until_its_reset() {
        let mut c = list();
        c.mark("a", "d-quests", 1, 1_200, RESETS);
        c.mark("a", "w-quests", 1, 800, RESETS);
        assert_eq!(c.count("a", "d-quests", RESETS), 1);
        assert_eq!(c.count("a", "w-quests", RESETS), 1);
        // The next daily reset clears the daily one only.
        let later = Resets { daily_ms: 2_000, ..RESETS };
        assert_eq!(c.count("a", "d-quests", later), 0);
        assert_eq!(c.count("a", "w-quests", later), 1);
    }

    #[test]
    fn counts_stop_at_the_times_a_period() {
        let mut c = list();
        c.mark("a", "runs", 7, 1_200, RESETS);
        assert_eq!(c.count("a", "runs", RESETS), 3);
        c.mark("a", "runs", 0, 1_300, RESETS);
        assert_eq!(c.count("a", "runs", RESETS), 0);
        assert!(c.marks.is_empty());
    }

    #[test]
    fn unknown_characters_and_tasks_are_ignored() {
        let mut c = list();
        c.mark("b", "d-quests", 1, 1_200, RESETS);
        c.mark("a", "nope", 1, 1_200, RESETS);
        assert!(c.marks.is_empty());
    }

    #[test]
    fn editing_keeps_the_ticks_of_what_stays() {
        let mut c = list();
        c.mark("a", "d-quests", 1, 1_200, RESETS);
        c.mark("a", "d-shop", 1, 1_200, RESETS);
        let tasks: Vec<Task> = c.tasks.iter().filter(|t| t.id != "d-shop").cloned().collect();
        let mut chars = c.characters.clone();
        chars[0].skip = vec!["d-shop".into(), "w-bosses".into()];
        chars.push(Character { id: "b".into(), name: "  ".into(), skip: vec![] });
        c.edit(tasks, chars, RESETS);
        assert_eq!(c.count("a", "d-quests", RESETS), 1);
        assert!(!c.marks["a"].contains_key("d-shop"));
        assert_eq!(c.characters.len(), 1, "a blank name is dropped");
        assert_eq!(c.characters[0].skip, vec!["w-bosses".to_string()]);
    }

    #[test]
    fn old_saves_read_with_the_default_tasks() {
        let c: Checklist = serde_json::from_str("{}").unwrap();
        assert!(c.tasks.iter().any(|t| t.period == Period::Weekly));
        let t: Task = serde_json::from_str(r#"{"id":"x","name":"X","period":"daily"}"#).unwrap();
        assert_eq!(t.times, 1);
    }
}
