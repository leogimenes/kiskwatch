//! Whether AION 2 is running: a process named AION2.exe (as A2Tools looks
//! for it; under Proton too).

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

fn is_game(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().eq_ignore_ascii_case("AION2.exe")
}

pub struct Watcher {
    system: System,
}

impl Watcher {
    pub fn new() -> Self {
        Self { system: System::new_with_specifics(RefreshKind::nothing()) }
    }

    pub fn running(&mut self) -> bool {
        self.system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        self.system.processes().values().any(|p| is_game(p.name()))
    }
}

pub fn running() -> bool {
    Watcher::new().running()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_the_game() {
        assert!(is_game("AION2.exe".as_ref()));
        assert!(is_game("aion2.EXE".as_ref()));
        assert!(!is_game("Aion2Launcher.exe".as_ref()));
    }
}
