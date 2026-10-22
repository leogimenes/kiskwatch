//! Updates: which release is newer than the one running, and whether a
//! downloaded installer is the one the release published. The app fetches
//! `latest.json` from the latest GitHub Release, the release workflow writes
//! it next to the installer and SHA256SUMS.txt.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// `latest.json`, as the release workflow writes it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Latest {
    /// "X.Y.Z".
    pub version: String,
    /// "vX.Y.Z".
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub published_at: String,
    /// The release page, with what changed.
    #[serde(default)]
    pub notes_url: String,
    pub installer: Installer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Installer {
    /// "Kiskwatch_X.Y.Z_x64-setup.exe".
    pub name: String,
    pub url: String,
    /// Lowercase hex.
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
}

/// A semver version: "1.2.3", "v1.2.3", "1.2.3-beta.1"; build metadata
/// ("+...") is ignored, as semver says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// The pre-release identifiers, empty for a release.
    pub pre: Vec<String>,
}

impl Version {
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let s = s.strip_prefix('v').unwrap_or(s);
        let s = s.split('+').next()?;
        let (core, pre) = match s.split_once('-') {
            Some((core, pre)) => (core, pre.split('.').map(str::to_owned).collect::<Vec<_>>()),
            None => (s, Vec::new()),
        };
        if pre.iter().any(|p| p.is_empty()) {
            return None;
        }
        let mut parts = core.split('.').map(|p| if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) { None } else { p.parse().ok() });
        let v = Version { major: parts.next()??, minor: parts.next()??, patch: parts.next()??, pre };
        parts.next().is_none().then_some(v)
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch)).then_with(|| {
            // A pre-release comes before its release.
            match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => {
                    for (a, b) in self.pre.iter().zip(&other.pre) {
                        let o = match (a.parse::<u64>(), b.parse::<u64>()) {
                            (Ok(a), Ok(b)) => a.cmp(&b),
                            (Ok(_), Err(_)) => Ordering::Less,
                            (Err(_), Ok(_)) => Ordering::Greater,
                            (Err(_), Err(_)) => a.cmp(b),
                        };
                        if o != Ordering::Equal {
                            return o;
                        }
                    }
                    self.pre.len().cmp(&other.pre.len())
                }
            }
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// The release, if it's newer than `current`.
pub fn newer(current: &str, latest: Latest) -> Option<Latest> {
    let now = Version::parse(current)?;
    (Version::parse(&latest.version)? > now).then_some(latest)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The downloaded installer is the one the release published: same size
/// (when given) and same SHA-256. The name must be a plain .exe file name,
/// since it becomes a path on disk.
pub fn verify(installer: &Installer, bytes: &[u8]) -> Result<(), String> {
    let name = &installer.name;
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.starts_with('.') || !name.to_ascii_lowercase().ends_with(".exe") {
        return Err(format!("nome de instalador inválido: {name}"));
    }
    if let Some(size) = installer.size.filter(|&s| s != bytes.len() as u64) {
        return Err(format!("o download veio com {} bytes, a release diz {size}", bytes.len()));
    }
    let expected = installer.sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("a release não traz um SHA-256 válido".into());
    }
    let got = sha256_hex(bytes);
    if got != expected {
        return Err(format!("o checksum não confere (esperado {expected}, baixado {got})"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    fn latest(version: &str) -> Latest {
        Latest {
            version: version.into(),
            tag: format!("v{version}"),
            published_at: String::new(),
            notes_url: String::new(),
            installer: Installer { name: format!("Kiskwatch_{version}_x64-setup.exe"), url: String::new(), sha256: String::new(), size: None },
        }
    }

    #[test]
    fn parses() {
        assert_eq!(v("v1.2.3"), Version { major: 1, minor: 2, patch: 3, pre: vec![] });
        assert_eq!(v("1.2.3-beta.1+abc").pre, vec!["beta", "1"]);
        for bad in ["", "1.2", "1.2.3.4", "1.x.3", "1.2.3-", "1..3", "+1.2.3"] {
            assert!(Version::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn orders_like_semver() {
        let list = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "1.10.0", "2.0.0"];
        for pair in list.windows(2) {
            assert!(v(pair[0]) < v(pair[1]), "{} < {}", pair[0], pair[1]);
        }
        assert_eq!(v("v1.0.0"), v("1.0.0+build"));
    }

    #[test]
    fn only_newer_releases() {
        assert!(newer("0.1.0", latest("0.2.0")).is_some());
        assert!(newer("0.1.0", latest("0.1.0")).is_none());
        assert!(newer("0.2.0", latest("0.1.9")).is_none());
        assert!(newer("0.1.0", latest("nope")).is_none());
    }

    #[test]
    fn reads_latest_json() {
        let json = r#"{"version":"0.2.0","tag":"v0.2.0","published_at":"2026-10-22T19:00:00Z","notes_url":"https://github.com/leogimenes/kiskwatch/releases/tag/v0.2.0",
            "installer":{"name":"Kiskwatch_0.2.0_x64-setup.exe","url":"https://github.com/x","sha256":"ab","size":12}}"#;
        let l: Latest = serde_json::from_str(json).unwrap();
        assert_eq!(l.installer.size, Some(12));
        assert_eq!(l.tag, "v0.2.0");
    }

    #[test]
    fn verifies_the_checksum() {
        let bytes = b"kiskwatch";
        let mut i = latest("0.2.0").installer;
        i.sha256 = sha256_hex(bytes).to_uppercase();
        i.size = Some(bytes.len() as u64);
        assert_eq!(verify(&i, bytes), Ok(()));
        assert!(verify(&i, b"kiskwatcH").unwrap_err().contains("checksum"));
        assert!(verify(&i, b"kiskwatch!").unwrap_err().contains("bytes"));
        i.size = None;
        i.sha256 = "zz".into();
        assert!(verify(&i, bytes).is_err());
        i.sha256 = sha256_hex(bytes);
        for name in ["..\\evil.exe", "a/b.exe", "setup.msi", "C:x.exe", ""] {
            i.name = name.into();
            assert!(verify(&i, bytes).is_err(), "{name}");
        }
    }

    #[test]
    fn sha256_of_nothing() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
