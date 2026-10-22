//! Global keyboard shortcuts. They work with the game in front, where the
//! overlays' buttons can't be clicked while clicks pass through to it.

use std::str::FromStr;

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::state::Hotkeys;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Start recording the DPS, or stop the recording under way.
    Dps,
    /// Let clicks pass through the overlays, or take them back.
    ClickThrough,
}

const WHAT: [(Action, &str); 2] = [(Action::Dps, "gravar e parar o DPS"), (Action::ClickThrough, "cliques nos overlays")];

fn text(keys: &Hotkeys, action: Action) -> &str {
    match action {
        Action::Dps => &keys.dps,
        Action::ClickThrough => &keys.click_through,
    }
}

/// Keys the game leaves alone, which may go without a modifier. Any key
/// held with the shortcut still reaches the game (Shift makes the character
/// dash), so a lone key is often the better choice.
fn lone_key(name: &str) -> bool {
    let f = name.strip_prefix('F').is_some_and(|n| n.parse::<u8>().is_ok());
    let numpad = name.strip_prefix("Numpad").is_some_and(|n| n.len() == 1 && n.chars().all(|c| c.is_ascii_digit()));
    f || numpad || ["Insert", "Home", "End", "PageUp", "PageDown", "Pause", "ScrollLock"].contains(&name)
}

/// A shortcut's text, as the panel writes it ("Ctrl+Alt+D"). A letter or a
/// digit needs a modifier, so typing in the game's chat doesn't set it off.
fn parse(text: &str) -> Result<Shortcut, String> {
    let s = Shortcut::from_str(text).map_err(|_| format!("\"{text}\" não é um atalho válido"))?;
    if s.mods.is_empty() && !lone_key(&format!("{:?}", s.key)) {
        return Err(format!("\"{text}\" precisa de Ctrl ou Alt junto (F1 a F12, Insert, Home, End, Page Up, Page Down, Pause e o teclado numérico podem ir sozinhos)"));
    }
    Ok(s)
}

/// The shortcuts that are on, checked: each valid, and no two the same.
pub fn check(keys: &Hotkeys) -> Result<Vec<(Action, Shortcut)>, String> {
    let mut on: Vec<(Action, Shortcut)> = Vec::new();
    for (action, what) in WHAT {
        let t = text(keys, action).trim();
        if t.is_empty() {
            continue;
        }
        let s = parse(t).map_err(|e| format!("{what}: {e}"))?;
        if on.iter().any(|(_, other)| other.id() == s.id()) {
            return Err(format!("{t} está em dois atalhos"));
        }
        on.push((action, s));
    }
    Ok(on)
}

/// What a pressed shortcut does, by the settings.
pub fn action(keys: &Hotkeys, pressed: &Shortcut) -> Option<Action> {
    check(keys).ok()?.into_iter().find(|(_, s)| s.id() == pressed.id()).map(|(a, _)| a)
}

/// Register the shortcuts the settings ask for, in place of any before. One
/// another program already took is left out, and the error names it.
pub fn register(app: &AppHandle, keys: &Hotkeys) -> Result<(), String> {
    let on = check(keys)?;
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let busy: Vec<String> = on
        .into_iter()
        .filter(|(_, s)| shortcuts.register(*s).is_err())
        .map(|(action, _)| {
            let what = WHAT.iter().find(|(a, _)| *a == action).map_or("", |(_, w)| w);
            format!("{} ({what})", text(keys, action).trim())
        })
        .collect();
    if busy.is_empty() { Ok(()) } else { Err(format!("{} já é usado por outro programa", busy.join(" e "))) }
}

/// Let go of every shortcut, while the panel waits for a new key.
pub fn release(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(dps: &str, click_through: &str) -> Hotkeys {
        Hotkeys { dps: dps.into(), click_through: click_through.into() }
    }

    #[test]
    fn defaults_are_valid() {
        assert_eq!(check(&Hotkeys::default()).unwrap().len(), 2);
    }

    #[test]
    fn old_defaults_move_off_shift() {
        let mut k = keys("Ctrl+Shift+D", "Ctrl+Shift+X");
        k.migrate();
        assert_eq!((k.dps.as_str(), k.click_through.as_str()), ("Ctrl+Alt+D", "Ctrl+Alt+X"));
        let mut mine = keys("Ctrl+Shift+D", "F10");
        mine.migrate();
        assert_eq!(mine.dps, "Ctrl+Shift+D");
    }

    #[test]
    fn finds_the_action() {
        let k = keys("Ctrl+Shift+D", "Alt+F9");
        assert_eq!(action(&k, &Shortcut::from_str("Ctrl+Shift+D").unwrap()), Some(Action::Dps));
        assert_eq!(action(&k, &Shortcut::from_str("Alt+F9").unwrap()), Some(Action::ClickThrough));
        assert_eq!(action(&k, &Shortcut::from_str("Ctrl+D").unwrap()), None);
    }

    #[test]
    fn plain_letters_need_a_modifier() {
        assert!(check(&keys("D", "")).is_err());
        assert!(check(&keys("5", "")).is_err());
        assert_eq!(check(&keys("F9", "Numpad5")).unwrap().len(), 2);
        assert_eq!(check(&keys("Insert", "PageDown")).unwrap().len(), 2);
    }

    #[test]
    fn empty_is_off_and_twins_are_refused() {
        assert!(check(&keys("", "")).unwrap().is_empty());
        assert!(check(&keys("Ctrl+K", "Ctrl+K")).is_err());
        assert!(check(&keys("Ctrl+Banana", "")).is_err());
    }
}
