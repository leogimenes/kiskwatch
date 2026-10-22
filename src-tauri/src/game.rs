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
    /// The game's window, the last time it was in front.
    game_window: Option<isize>,
}

impl Foreground {
    pub fn new() -> Self {
        Self { system: System::new_with_specifics(RefreshKind::nothing()), last: None, game_window: None }
    }

    /// None while no window is in front, as for a moment when switching.
    pub fn front(&mut self) -> Option<Front> {
        let (hwnd, pid) = foreground()?;
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
        if game {
            self.game_window = Some(hwnd);
        }
        Some(if game { Front::Game } else { Front::Other })
    }

    /// The game's window, the last time it was in front.
    pub fn game_window(&self) -> Option<isize> {
        self.game_window
    }
}

/// The window in front and its process.
#[cfg(windows)]
fn foreground() -> Option<(isize, u32)> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    // SAFETY: plain Win32 calls with no pointers kept.
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        (pid != 0).then_some((hwnd as isize, pid))
    }
}

#[cfg(not(windows))]
fn foreground() -> Option<(isize, u32)> {
    None
}

/// Where a window's inside is on the screen, in pixels: its left, top and
/// width, without the title bar when the game runs in a window. None once
/// the window is gone.
#[cfg(windows)]
pub fn client_area(hwnd: isize) -> Option<(i32, i32, u32)> {
    use windows_sys::Win32::Foundation::{POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetClientRect, IsWindow};
    let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;
    // SAFETY: plain Win32 calls on a handle we check first; the structs are ours.
    unsafe {
        if IsWindow(hwnd) == 0 {
            return None;
        }
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if GetClientRect(hwnd, &mut rect) == 0 {
            return None;
        }
        let mut corner = POINT { x: 0, y: 0 };
        if ClientToScreen(hwnd, &mut corner) == 0 {
            return None;
        }
        Some((corner.x, corner.y, rect.right.max(0) as u32))
    }
}

#[cfg(not(windows))]
pub fn client_area(_hwnd: isize) -> Option<(i32, i32, u32)> {
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
