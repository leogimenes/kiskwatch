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

/// Which program is in front: the game, Kiskwatch itself, or another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Front {
    Game,
    Us,
    Other,
}

/// Follows the window in front. Off Windows it can't tell (always None).
pub struct Foreground {
    system: System,
    /// The last process in front, and whether it was the game.
    last: Option<(u32, bool)>,
}

impl Foreground {
    pub fn new() -> Self {
        Self { system: System::new_with_specifics(RefreshKind::nothing()), last: None }
    }

    /// None while no window is in front, as for a moment when switching.
    pub fn front(&mut self) -> Option<Front> {
        let pid = foreground_pid()?;
        if pid == std::process::id() {
            return Some(Front::Us);
        }
        let game = match self.last {
            Some((last, game)) if last == pid => game,
            _ => {
                let p = sysinfo::Pid::from_u32(pid);
                self.system.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::nothing());
                let game = self.system.process(p).is_some_and(|p| is_game(p.name()));
                self.last = Some((pid, game));
                game
            }
        };
        Some(if game { Front::Game } else { Front::Other })
    }
}

#[cfg(windows)]
fn foreground_pid() -> Option<u32> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    // SAFETY: plain Win32 calls with no pointers kept.
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        (pid != 0).then_some(pid)
    }
}

#[cfg(not(windows))]
fn foreground_pid() -> Option<u32> {
    None
}

/// Show a window without taking the focus from the one in front, which
/// Tauri's `show` would: the game would stop taking keys. Tauri still thinks
/// the overlays hidden, and hides them again on any change to their window
/// (see `show_overlays`).
#[cfg(windows)]
pub fn show_window(w: &tauri::WebviewWindow, show: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNOACTIVATE, ShowWindow};
    if let Ok(hwnd) = w.hwnd() {
        // SAFETY: the window is alive while we hold it.
        unsafe { ShowWindow(hwnd.0 as _, if show { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
    }
}

#[cfg(not(windows))]
pub fn show_window(w: &tauri::WebviewWindow, show: bool) {
    let _ = if show { w.show() } else { w.hide() };
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
