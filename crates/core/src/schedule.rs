//! Recurring events and scheduled bosses, and when each next comes.
//!
//! The schedule is `data/events.json`, imported from A2Tools' Event Timers
//! plugin: start times are minutes after midnight in the server region's time
//! zone (UTC for the resets), on the listed weekdays (0 = Sunday).

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    /// "event", "boss" or "reset".
    pub kind: String,
    /// A key into `data/text.json`.
    pub name: String,
    #[serde(default)]
    pub also: Vec<String>,
    #[serde(default)]
    pub r#where: Vec<String>,
    /// "elyos", "asmodian", or none for both.
    pub side: Option<String>,
    pub days: Vec<u32>,
    pub starts: Vec<u32>,
    /// How long it runs, 0 when the tables don't say.
    #[serde(default)]
    pub minutes: u32,
    /// Seconds after the start the entrance stays open, when it closes early.
    #[serde(default)]
    pub enter: Option<u32>,
    /// Times are UTC, not the region's.
    #[serde(default)]
    pub utc: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Showing {
    pub start_ms: i64,
    pub end_ms: i64,
}

/// The time zone of a server region: the second digit of a server's id.
pub fn region_zone(region: u32) -> Option<Tz> {
    Some(match region {
        1 => chrono_tz::America::New_York,
        2 => chrono_tz::America::Los_Angeles,
        3 => chrono_tz::Europe::Berlin,
        4 => chrono_tz::America::Sao_Paulo,
        5 => chrono_tz::Asia::Seoul,
        _ => return None,
    })
}

fn at_minutes(tz: Tz, date: NaiveDate, minutes: u32) -> Option<DateTime<Utc>> {
    let midnight = date.and_hms_opt(0, 0, 0)? + Duration::minutes(i64::from(minutes));
    // A time a clock change skips is taken an hour later; a repeated one, the first.
    let local = tz
        .from_local_datetime(&midnight)
        .earliest()
        .or_else(|| tz.from_local_datetime(&(midnight + Duration::hours(1))).earliest())?;
    Some(local.with_timezone(&Utc))
}

impl Event {
    /// How long a showing counts as running: an entrance that closes early
    /// ends it then, so the next showing comes up once it can't be joined.
    fn run_ms(&self) -> i64 {
        match self.enter {
            Some(s) => i64::from(s) * 1000,
            None => i64::from(self.minutes) * 60_000,
        }
    }

    /// The showing running at `now_ms`, or else the next one.
    pub fn next(&self, region_tz: Tz, now_ms: i64) -> Option<Showing> {
        let tz = if self.utc { chrono_tz::UTC } else { region_tz };
        let now = Utc.timestamp_millis_opt(now_ms).single()?;
        let today = now.with_timezone(&tz).date_naive();
        let run = self.run_ms();
        let mut best: Option<Showing> = None;
        for back in -1..=8 {
            let date = today + Duration::days(back);
            if !self.days.contains(&date.weekday().num_days_from_sunday()) {
                continue;
            }
            for &m in &self.starts {
                let Some(start) = at_minutes(tz, date, m) else { continue };
                let start_ms = start.timestamp_millis();
                let s = Showing { start_ms, end_ms: start_ms + run };
                let live = if run > 0 { s.end_ms > now_ms } else { start_ms > now_ms };
                if live && best.is_none_or(|b| s.start_ms < b.start_ms) {
                    best = Some(s);
                }
            }
        }
        best
    }

    /// The last start at or before `now_ms`: for a reset, when it last happened.
    pub fn last_start(&self, region_tz: Tz, now_ms: i64) -> Option<i64> {
        let tz = if self.utc { chrono_tz::UTC } else { region_tz };
        let now = Utc.timestamp_millis_opt(now_ms).single()?;
        let today = now.with_timezone(&tz).date_naive();
        (-8..=0)
            .map(|back| today + Duration::days(back))
            .filter(|d| self.days.contains(&d.weekday().num_days_from_sunday()))
            .flat_map(|d| self.starts.iter().filter_map(move |&m| at_minutes(tz, d, m)))
            .map(|s| s.timestamp_millis())
            .filter(|&s| s <= now_ms)
            .max()
    }

    /// Whether the event is for a player of `side` ("elyos" or "asmodian").
    pub fn for_side(&self, side: &str) -> bool {
        self.side.as_deref().is_none_or(|s| s == side)
    }
}

/// Lead times an alarm can be set to ring before an event, in minutes.
pub const ALARM_LEADS: [u32; 7] = [60, 30, 15, 10, 5, 2, 1];

/// The alarms due in `(from_ms, to_ms]`: for each enabled lead, the moment
/// `lead` minutes before the next start. Returns (lead, showing) pairs.
pub fn alarms_due(event: &Event, tz: Tz, leads: &[u32], from_ms: i64, to_ms: i64) -> Vec<(u32, Showing)> {
    let mut due = Vec::new();
    for &lead in leads {
        let lead_ms = i64::from(lead) * 60_000;
        // The showing that starts after the window opens, seen from lead earlier.
        let Some(s) = event.next(tz, from_ms + lead_ms) else { continue };
        let ring = s.start_ms - lead_ms;
        if ring > from_ms && ring <= to_ms {
            due.push((lead, s));
        }
    }
    due
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(json: &str) -> Event {
        serde_json::from_str(json).unwrap()
    }

    fn ms(s: &str) -> i64 {
        DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
    }

    fn rift() -> Event {
        event(r#"{"id":"rift","kind":"event","name":"=rift","side":null,"days":[0,1,2,3,4,5,6],
            "starts":[120,300,480,660,840,1020,1200,1380],"minutes":10}"#)
    }

    #[test]
    fn the_next_rift_in_sao_paulo() {
        let tz = region_zone(4).unwrap();
        // 2026-10-21 10:00 in São Paulo (UTC-3): the next is 11:00 local, 14:00 UTC.
        let s = rift().next(tz, ms("2026-10-21T13:00:00Z")).unwrap();
        assert_eq!(s.start_ms, ms("2026-10-21T14:00:00Z"));
        assert_eq!(s.end_ms - s.start_ms, 600_000);
    }

    #[test]
    fn a_running_showing_is_the_current_one() {
        let tz = region_zone(4).unwrap();
        let s = rift().next(tz, ms("2026-10-21T14:05:00Z")).unwrap();
        assert_eq!(s.start_ms, ms("2026-10-21T14:00:00Z"));
    }

    #[test]
    fn a_weekly_reset_is_utc_on_its_day() {
        let weekly = event(r#"{"id":"weekly","kind":"reset","name":"=weekly","side":null,"days":[3],
            "starts":[420],"minutes":0,"utc":true}"#);
        // Wednesday 2026-10-21 08:00 UTC is past this week's: next Wednesday.
        let s = weekly.next(region_zone(1).unwrap(), ms("2026-10-21T08:00:00Z")).unwrap();
        assert_eq!(s.start_ms, ms("2026-10-28T07:00:00Z"));
    }

    #[test]
    fn the_last_weekly_reset() {
        let weekly = event(r#"{"id":"weekly","kind":"reset","name":"=weekly","side":null,"days":[3],
            "starts":[420],"minutes":0,"utc":true}"#);
        let tz = region_zone(4).unwrap();
        assert_eq!(weekly.last_start(tz, ms("2026-10-21T08:00:00Z")), Some(ms("2026-10-21T07:00:00Z")));
        assert_eq!(weekly.last_start(tz, ms("2026-10-21T06:59:00Z")), Some(ms("2026-10-14T07:00:00Z")));
        assert_eq!(weekly.last_start(tz, ms("2026-10-21T07:00:00Z")), Some(ms("2026-10-21T07:00:00Z")));
    }

    #[test]
    fn an_early_closing_entrance_ends_the_showing() {
        let fest = event(r#"{"id":"f","kind":"event","name":"x","side":"elyos","days":[0,1,2,3,4,5,6],
            "starts":[0,60],"minutes":7,"enter":180}"#);
        let tz = chrono_tz::UTC;
        let s = fest.next(tz, ms("2026-10-21T00:04:00Z")).unwrap();
        assert_eq!(s.start_ms, ms("2026-10-21T01:00:00Z"));
        assert!(fest.for_side("elyos") && !fest.for_side("asmodian"));
    }

    #[test]
    fn alarms_ring_once_at_each_lead() {
        let tz = region_zone(4).unwrap();
        let start = ms("2026-10-21T14:00:00Z");
        let leads = [15, 5];
        let window = |from: i64| alarms_due(&rift(), tz, &leads, from, from + 1000);
        assert_eq!(window(start - 15 * 60_000 - 500).iter().map(|d| d.0).collect::<Vec<_>>(), vec![15]);
        assert_eq!(window(start - 5 * 60_000 - 500).iter().map(|d| d.0).collect::<Vec<_>>(), vec![5]);
        assert!(window(start - 10 * 60_000).is_empty());
    }
}
