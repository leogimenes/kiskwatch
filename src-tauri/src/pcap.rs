//! Live capture through libpcap (Npcap on Windows), loaded at runtime so no
//! SDK is needed to build. Every device with an address is captured, IPv4 TCP
//! only and not the web's ports; the dispatcher (`kiskwatch_core::dispatch`)
//! picks the game's connection out of it.
//!
//! From A2Tools (`src-tauri/src/capture/pcap_capturer.rs`): the FFI, device
//! listing, capture filter and frame parsing are its code; the port lock,
//! safety net and filter narrowing are left out, the dispatcher doing that job.

use std::collections::HashSet;
use std::ffi::{c_char, c_int, c_long, c_uint, CStr, CString};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};

use kiskwatch_core::dispatch::Segment;
use libloading::{Library, Symbol};

macro_rules! info { ($($t:tt)*) => { eprintln!("kiskwatch: {}", format!($($t)*)) } }
macro_rules! warn { ($($t:tt)*) => { eprintln!("kiskwatch: {}", format!($($t)*)) } }

/// The libraries to try, in order.
#[cfg(windows)]
const LIBRARIES: &[&str] = &["wpcap.dll"];
#[cfg(not(windows))]
const LIBRARIES: &[&str] = &["libpcap.so.1", "libpcap.so.0.8", "libpcap.so"];

#[cfg(windows)]
pub const MISSING_HELP: &str = "Instale o Npcap (https://npcap.com) com a opção \"WinPcap API-compatible Mode\".";
#[cfg(not(windows))]
pub const MISSING_HELP: &str = "Instale a libpcap e dê ao app a permissão cap_net_raw.";

/// Load the first of the OS's names for libpcap. Npcap keeps `wpcap.dll` in
/// `System32\Npcap` unless installed in its WinPcap-compatible mode; that
/// folder is tried too, letting the DLL find its `Packet.dll` beside it.
fn load_library() -> Result<Library, String> {
    let mut errors = Vec::new();
    for name in LIBRARIES {
        // SAFETY: loading libpcap runs no initialisation we depend on not running.
        match unsafe { Library::new(name) } {
            Ok(lib) => return Ok(lib),
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }
    #[cfg(windows)]
    {
        use libloading::os::windows::{Library as WinLibrary, LOAD_WITH_ALTERED_SEARCH_PATH};
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let path = std::path::Path::new(&root).join("System32").join("Npcap").join("wpcap.dll");
        // SAFETY: as above.
        match unsafe { WinLibrary::load_with_flags(&path, LOAD_WITH_ALTERED_SEARCH_PATH) } {
            Ok(lib) => return Ok(lib.into()),
            Err(e) => errors.push(format!("{}: {e}", path.display())),
        }
    }
    Err(format!("{} ({})", MISSING_HELP, errors.join("; ")))
}

// ===== Raw pcap FFI types =====

type PcapT = *mut std::ffi::c_void;
type PcapIfT = *mut PcapIf;

#[repr(C)]
struct PcapIf {
    next: *mut PcapIf,
    name: *const c_char,
    description: *const c_char,
    addresses: *mut PcapAddr,
    flags: c_uint,
}

#[repr(C)]
struct PcapAddr {
    next: *mut PcapAddr,
    addr: *mut SockAddr,
    netmask: *mut SockAddr,
    broadaddr: *mut SockAddr,
    dstaddr: *mut SockAddr,
}

#[repr(C)]
struct SockAddr {
    sa_family: u16,
    sa_data: [u8; 14],
}

/// `struct pcap_pkthdr`. The timestamp is a C `struct timeval`, two `long`s:
/// 32-bit on Windows, 64-bit on 64-bit Linux. Declaring them `i32` (as this
/// once did) reads `caplen` from the middle of the timestamp on Linux.
#[repr(C)]
struct PcapPkthdr {
    ts_sec: c_long,
    ts_usec: c_long,
    caplen: c_uint,
    len: c_uint,
}

/// `struct bpf_program`: a compiled capture filter.
#[repr(C)]
struct BpfProgram {
    bf_len: c_uint,
    bf_insns: *mut std::ffi::c_void,
}

/// `PCAP_NETMASK_UNKNOWN`: only broadcast tests need the netmask, and the
/// filters here have none.
const PCAP_NETMASK_UNKNOWN: u32 = 0xffff_ffff;

// ===== Device info =====

#[derive(Clone)]
struct DeviceInfo {
    name: String,
    description: String,
    has_addresses: bool,
}

impl DeviceInfo {
    fn label(&self) -> &str {
        if self.description.is_empty() {
            &self.name
        } else {
            &self.description
        }
    }
}

// ===== Pcap library wrapper =====

struct PcapLib {
    _lib: Library,
    findalldevs: unsafe extern "C" fn(*mut PcapIfT, *mut c_char) -> c_int,
    freealldevs: unsafe extern "C" fn(PcapIfT),
    open_live: unsafe extern "C" fn(*const c_char, c_int, c_int, c_int, *mut c_char) -> PcapT,
    close: unsafe extern "C" fn(PcapT),
    next_ex: unsafe extern "C" fn(PcapT, *mut *mut PcapPkthdr, *mut *const u8) -> c_int,
    datalink: unsafe extern "C" fn(PcapT) -> c_int,
    filter: Option<FilterFns>,
}

/// libpcap's filter calls. Every libpcap and Npcap has them; without them
/// the capture runs unfiltered, as it did before filters.
struct FilterFns {
    compile: unsafe extern "C" fn(PcapT, *mut BpfProgram, *const c_char, c_int, u32) -> c_int,
    setfilter: unsafe extern "C" fn(PcapT, *mut BpfProgram) -> c_int,
    freecode: unsafe extern "C" fn(*mut BpfProgram),
    geterr: unsafe extern "C" fn(PcapT) -> *const c_char,
    /// libpcap's filter compiler was not thread-safe before 1.8, and every
    /// device has its own thread.
    compiling: Mutex<()>,
}

impl PcapLib {
    fn load() -> Result<Self, String> {
        let lib = load_library()?;

        unsafe {
            let findalldevs: Symbol<unsafe extern "C" fn(*mut PcapIfT, *mut c_char) -> c_int> =
                lib.get(b"pcap_findalldevs").map_err(|e| format!("pcap_findalldevs: {}", e))?;
            let freealldevs: Symbol<unsafe extern "C" fn(PcapIfT)> =
                lib.get(b"pcap_freealldevs").map_err(|e| format!("pcap_freealldevs: {}", e))?;
            let open_live: Symbol<
                unsafe extern "C" fn(*const c_char, c_int, c_int, c_int, *mut c_char) -> PcapT,
            > = lib.get(b"pcap_open_live").map_err(|e| format!("pcap_open_live: {}", e))?;
            let close: Symbol<unsafe extern "C" fn(PcapT)> =
                lib.get(b"pcap_close").map_err(|e| format!("pcap_close: {}", e))?;
            let next_ex: Symbol<
                unsafe extern "C" fn(PcapT, *mut *mut PcapPkthdr, *mut *const u8) -> c_int,
            > = lib.get(b"pcap_next_ex").map_err(|e| format!("pcap_next_ex: {}", e))?;
            let datalink: Symbol<unsafe extern "C" fn(PcapT) -> c_int> =
                lib.get(b"pcap_datalink").map_err(|e| format!("pcap_datalink: {}", e))?;
            let filter = (|| {
                Some(FilterFns {
                    compile: *lib.get(b"pcap_compile").ok()?,
                    setfilter: *lib.get(b"pcap_setfilter").ok()?,
                    freecode: *lib.get(b"pcap_freecode").ok()?,
                    geterr: *lib.get(b"pcap_geterr").ok()?,
                    compiling: Mutex::new(()),
                })
            })();
            if filter.is_none() {
                warn!("libpcap has no pcap_setfilter: capturing without a filter");
            }

            Ok(Self {
                findalldevs: *findalldevs,
                freealldevs: *freealldevs,
                open_live: *open_live,
                close: *close,
                next_ex: *next_ex,
                datalink: *datalink,
                filter,
                _lib: lib,
            })
        }
    }

    fn find_all_devs(&self) -> Result<Vec<DeviceInfo>, String> {
        let mut alldevs: PcapIfT = ptr::null_mut();
        let mut errbuf = [0u8; 256];

        let ret =
            unsafe { (self.findalldevs)(&mut alldevs, errbuf.as_mut_ptr() as *mut c_char) };

        if ret != 0 || alldevs.is_null() {
            let err = unsafe { CStr::from_ptr(errbuf.as_ptr() as *const c_char) }
                .to_string_lossy()
                .to_string();
            return Err(format!("pcap_findalldevs failed: {}", err));
        }

        let mut devices = Vec::new();
        let mut dev = alldevs;
        while !dev.is_null() {
            let d = unsafe { &*dev };
            let name = if d.name.is_null() {
                String::new()
            } else {
                unsafe { CStr::from_ptr(d.name) }
                    .to_string_lossy()
                    .to_string()
            };
            let description = if d.description.is_null() {
                String::new()
            } else {
                unsafe { CStr::from_ptr(d.description) }
                    .to_string_lossy()
                    .to_string()
            };
            let has_addresses = !d.addresses.is_null();

            devices.push(DeviceInfo {
                name,
                description,
                has_addresses,
            });
            dev = d.next;
        }

        unsafe { (self.freealldevs)(alldevs) };
        Ok(devices)
    }

    fn open_live_handle(&self, name: &str) -> Result<PcapT, String> {
        let c_name = CString::new(name).map_err(|e| format!("Invalid device name: {}", e))?;
        let mut errbuf = [0u8; 256];

        let handle = unsafe {
            (self.open_live)(
                c_name.as_ptr(),
                65535,  // snaplen
                0,      // not promiscuous: only this machine's own traffic
                100,    // timeout ms
                errbuf.as_mut_ptr() as *mut c_char,
            )
        };

        if handle.is_null() {
            let err = unsafe { CStr::from_ptr(errbuf.as_ptr() as *const c_char) }
                .to_string_lossy()
                .to_string();
            return Err(format!("pcap_open_live failed: {}", err));
        }

        Ok(handle)
    }

    /// Has the kernel pass this handle only what `filter` matches.
    fn set_filter(&self, handle: PcapT, filter: &str) -> Result<(), String> {
        let f = self.filter.as_ref().ok_or("no pcap_setfilter")?;
        let text = CString::new(filter).map_err(|e| e.to_string())?;
        let mut program = BpfProgram { bf_len: 0, bf_insns: ptr::null_mut() };
        let error = || unsafe { CStr::from_ptr((f.geterr)(handle)) }.to_string_lossy().into_owned();
        {
            let _one_at_a_time = f.compiling.lock().unwrap_or_else(|p| p.into_inner());
            // SAFETY: a live handle, and a program for libpcap to fill.
            if unsafe { (f.compile)(handle, &mut program, text.as_ptr(), 1, PCAP_NETMASK_UNKNOWN) } != 0 {
                return Err(error());
            }
        }
        // SAFETY: the program compiled above; libpcap copies it, so it is
        // freed whatever setfilter says.
        let set = unsafe { (f.setfilter)(handle, &mut program) };
        let result = if set == 0 { Ok(()) } else { Err(error()) };
        unsafe { (f.freecode)(&mut program) };
        result
    }
}

/// The capture filter, as libpcap filter text: the game's port once it is
/// locked (both directions, as the dispatcher reads it), and before that all
/// IPv4 TCP but the web's ports (the game has never used them; what comes on
/// them is HTTPS and HTTP from browsers and launchers). The first form also
/// matches frames with one or two VLAN tags, which some network cards add
/// (see `link_header_len`); the second is for link types where libpcap has no
/// VLAN test.
fn capture_filters(port: Option<u16>) -> [String; 2] {
    let plain = match port {
        Some(port) => format!("ip and tcp port {port}"),
        None => "ip and tcp and not port 80 and not port 443".to_string(),
    };
    // Nested: each `vlan` moves the offsets for everything after it in the
    // expression, so side-by-side alternatives would add their tags up.
    [format!("({plain}) or (vlan and (({plain}) or (vlan and {plain})))"), plain]
}

/// Where IPv4 starts in a frame of pcap link type `link_type`, or `None` if this
/// frame is not IPv4 under that type. Link types are libpcap's (DLT_*/LINKTYPE_*),
/// the same on every OS.
fn link_header_len(link_type: c_int, frame: &[u8]) -> Option<usize> {
    let be16 = |at: usize| frame.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]]));
    match link_type {
        // Ethernet, with up to two 802.1Q / 802.1ad VLAN tags (some NICs, e.g.
        // Realtek with "Priority & VLAN" on, tag every frame).
        1 => {
            let mut at = 12;
            for _ in 0..2 {
                match be16(at)? {
                    0x8100 | 0x88A8 => at += 4,
                    _ => break,
                }
            }
            (be16(at)? == 0x0800).then_some(at + 2)
        }
        // BSD loopback / Npcap loopback: 4-byte address family, AF_INET = 2.
        0 => (frame.get(..4)? == [2, 0, 0, 0]).then_some(4),
        // Raw IP (VPN and tunnel adapters, WireGuard).
        12 | 14 | 101 | 228 => Some(0),
        // Linux "cooked" capture v1: protocol at bytes 14-15, 16-byte header.
        113 => (be16(14)? == 0x0800).then_some(16),
        // Linux "cooked" capture v2: protocol at bytes 0-1, 20-byte header.
        276 => (be16(0)? == 0x0800).then_some(20),
        _ => None,
    }
}

/// The original guess at the link layer, from the frame alone. Kept as the
/// fallback so nothing that parsed before the link type was consulted can stop
/// parsing now.
fn guess_link_header_len(frame: &[u8]) -> Option<usize> {
    if frame.len() >= 14 {
        let ether_type = u16::from_be_bytes([frame[12], frame[13]]);
        if ether_type == 0x0800 {
            Some(14) // Standard Ethernet
        } else if frame[0] == 2 && frame[1] == 0 && frame[2] == 0 && frame[3] == 0 {
            Some(4) // NULL/Loopback: AF_INET (little-endian 2) = IPv4
        } else if (frame[0] >> 4) == 4 {
            Some(0) // Raw IPv4
        } else {
            None
        }
    } else if (frame[0] >> 4) == 4 {
        Some(0) // Raw IPv4 (short frame)
    } else {
        None
    }
}

/// Parse raw captured frame to extract TCP payload. The link type says where
/// IPv4 starts; when it does not fit, the frame-only guess gets a chance.
fn parse_tcp_payload(frame: &[u8], link_type: c_int) -> Option<Segment> {
    if frame.len() < 4 {
        return None;
    }
    let ip_offset = link_header_len(link_type, frame)
        .filter(|&at| frame.get(at).is_some_and(|b| b >> 4 == 4))
        .or_else(|| guess_link_header_len(frame))?;

    if frame.len() < ip_offset + 20 {
        return None;
    }
    let ip_header = &frame[ip_offset..];
    if ip_header[0] >> 4 != 4 {
        return None;
    }
    let ip_header_len = ((ip_header[0] & 0x0F) as usize) * 4;
    if ip_header[9] != 6 {
        return None; // Not TCP
    }

    // Kept as numbers: formatting them as text cost two allocations for
    // every packet on every device, and nothing reads them as text.
    let src_ip = std::net::Ipv4Addr::new(ip_header[12], ip_header[13], ip_header[14], ip_header[15]);
    let dst_ip = std::net::Ipv4Addr::new(ip_header[16], ip_header[17], ip_header[18], ip_header[19]);

    let tcp_offset = ip_offset + ip_header_len;
    if frame.len() < tcp_offset + 20 {
        return None;
    }
    let tcp_header = &frame[tcp_offset..];
    let src_port = u16::from_be_bytes([tcp_header[0], tcp_header[1]]);
    let dst_port = u16::from_be_bytes([tcp_header[2], tcp_header[3]]);
    let tcp_seq = u32::from_be_bytes([tcp_header[4], tcp_header[5], tcp_header[6], tcp_header[7]]);
    let tcp_header_len = ((tcp_header[12] >> 4) as usize) * 4;

    // The payload ends where the IP packet says it does, not at the end of the
    // frame: Ethernet pads short frames to 60 bytes, so a bare ACK carries 6
    // padding bytes after its TCP header. Most network cards pad with zeros,
    // which the framing skips; some pad with whatever was in the buffer, and
    // those bytes landed in the game stream and threw the framing off. One
    // player's meter read 77% of a boss's damage while their party member's,
    // in the same fight, read all of it (2026-10-06). A total length of 0
    // (segmentation offload) or past the frame keeps the frame's end.
    let ip_total_len = u16::from_be_bytes([ip_header[2], ip_header[3]]) as usize;
    let ip_end = ip_offset + ip_total_len;
    let end = if ip_total_len >= ip_header_len + 20 && ip_end <= frame.len() { ip_end } else { frame.len() };
    let payload_offset = tcp_offset + tcp_header_len;
    if payload_offset >= end {
        return None;
    }
    let payload = &frame[payload_offset..end];
    if payload.is_empty() {
        return None;
    }

    Some(Segment { src_ip, src_port, dst_ip, dst_port, seq: tcp_seq, data: payload.to_vec() })
}

// Safety: PcapLib function pointers are thread-safe (each thread gets its own pcap handle)
unsafe impl Send for PcapLib {}
unsafe impl Sync for PcapLib {}

/// How often to look for devices that appeared after the start (a VPN or
/// ping reducer connected while the app runs).
const DEVICE_SCAN_MS: u64 = 15_000;

/// Whether capture runs, and why not when it doesn't.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct CaptureState {
    pub running: bool,
    pub error: Option<String>,
    pub devices: Vec<String>,
}

/// Start capturing on every device; segments go to `sender`. Returns at once.
pub fn start(sender: SyncSender<Segment>, state: Arc<Mutex<CaptureState>>) {
    let pcap = match PcapLib::load() {
        Ok(p) => Arc::new(p),
        Err(e) => {
            warn!("{e}");
            *state.lock().unwrap() = CaptureState { running: false, error: Some(e), devices: vec![] };
            return;
        }
    };
    let active: Arc<Mutex<HashSet<String>>> = Arc::default();
    let failed: Arc<Mutex<HashSet<String>>> = Arc::default();
    let running = Arc::new(AtomicBool::new(true));
    std::thread::spawn(move || {
        loop {
            match pcap.find_all_devs() {
                Ok(devices) => {
                    for device in devices.into_iter().filter(|d| d.has_addresses && !skip_device(&d.name)) {
                        if failed.lock().unwrap().contains(&device.name) || !active.lock().unwrap().insert(device.name.clone()) {
                            continue;
                        }
                        state.lock().unwrap().devices.push(device.label().to_string());
                        start_capture_thread(device, pcap.clone(), sender.clone(), running.clone(), active.clone(), failed.clone());
                    }
                    let mut st = state.lock().unwrap();
                    st.running = !active.lock().unwrap().is_empty();
                    st.error = (!st.running).then(|| "Nenhum dispositivo de rede pôde ser aberto. Abra o Kiskwatch como administrador.".to_string());
                }
                Err(e) => {
                    let mut st = state.lock().unwrap();
                    st.running = false;
                    st.error = Some(format!("{e}. Abra o Kiskwatch como administrador."));
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(DEVICE_SCAN_MS));
        }
    });
}

/// Devices not worth opening: Linux's catch-all "any" sees every packet twice,
/// and container bridges never carry the game.
fn skip_device(name: &str) -> bool {
    name == "any"
        || ["nflog", "nfqueue", "usbmon", "dbus", "bluetooth", "veth", "docker", "br-", "podman"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

fn start_capture_thread(
    device: DeviceInfo,
    pcap: Arc<PcapLib>,
    sender: SyncSender<Segment>,
    running: Arc<AtomicBool>,
    active: Arc<Mutex<HashSet<String>>>,
    failed: Arc<Mutex<HashSet<String>>>,
) {
    std::thread::spawn(move || {
        let label = device.label().to_string();
        let release = |did_fail: bool| {
            active.lock().unwrap().remove(&device.name);
            if did_fail {
                failed.lock().unwrap().insert(device.name.clone());
            }
        };
        let handle = match pcap.open_live_handle(&device.name) {
            Ok(h) => h,
            Err(e) => {
                warn!("Failed to open capture on {label}: {e}");
                release(true);
                return;
            }
        };
        // SAFETY: a live handle.
        let link_type = unsafe { (pcap.datalink)(handle) };
        let [full, plain] = capture_filters(None);
        if let Err(e) = pcap.set_filter(handle, &full).or_else(|_| pcap.set_filter(handle, &plain)) {
            warn!("No capture filter on {label}: {e}");
        }
        info!("Capture active on {label} (link type {link_type})");
        while running.load(Ordering::SeqCst) {
            let mut header: *mut PcapPkthdr = ptr::null_mut();
            let mut data: *const u8 = ptr::null();
            // SAFETY: a live handle; libpcap owns the buffers until the next call.
            let ret = unsafe { (pcap.next_ex)(handle, &mut header, &mut data) };
            match ret {
                1 => {
                    // SAFETY: libpcap filled both on success.
                    let hdr = unsafe { &*header };
                    let frame = unsafe { std::slice::from_raw_parts(data, hdr.caplen as usize) };
                    if let Some(seg) = parse_tcp_payload(frame, link_type) {
                        // A full queue drops the segment rather than stall capture.
                        let _ = sender.try_send(seg);
                    }
                }
                0 => continue,
                _ => {
                    warn!("Capture error on {label} (ret={ret})");
                    break;
                }
            }
        }
        // SAFETY: closed once, by its only user.
        unsafe { (pcap.close)(handle) };
        release(false);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// IPv4 + TCP from 10.0.0.2:51000 to 193.202.112.99:13328, payload "hi".
    fn ipv4_tcp() -> Vec<u8> {
        let mut ip = vec![0x45, 0, 0, 42, 0, 0, 0, 0, 64, 6, 0, 0, 10, 0, 0, 2, 193, 202, 112, 99];
        let tcp = [0xC7, 0x38, 0x34, 0x10, 0, 0, 0, 1, 0, 0, 0, 0, 0x50, 0x18, 0, 0, 0, 0, 0, 0];
        ip.extend_from_slice(&tcp);
        ip.extend_from_slice(b"hi");
        ip
    }

    fn check(link_type: c_int, header: &[u8]) {
        let frame = [header, &ipv4_tcp()].concat();
        let p = parse_tcp_payload(&frame, link_type).expect("parsed");
        assert_eq!((p.src_port, p.dst_port, p.seq), (51000, 13328, 1), "link type {link_type}");
        assert_eq!(p.dst_ip, std::net::Ipv4Addr::new(193, 202, 112, 99));
        assert_eq!(p.data, b"hi");
    }

    #[test]
    fn reads_every_link_layer() {
        let ether = [[0u8; 12].as_slice(), &[0x08, 0x00]].concat();
        check(1, &ether);
        let vlan = [[0u8; 12].as_slice(), &[0x81, 0x00, 0x00, 0x05, 0x08, 0x00]].concat();
        check(1, &vlan);
        check(0, &[2, 0, 0, 0]);
        check(12, &[]);
        check(101, &[]);
        let sll = [[0u8; 14].as_slice(), &[0x08, 0x00]].concat();
        check(113, &sll);
        let sll2 = [[0x08u8, 0x00].as_slice(), &[0u8; 18]].concat();
        check(276, &sll2);
    }

    #[test]
    fn ethernet_padding_is_not_payload() {
        let ether = [[0u8; 12].as_slice(), &[0x08, 0x00]].concat();
        let mut ack = ipv4_tcp();
        ack.truncate(40);
        ack[3] = 40;
        let frame = [ether.as_slice(), &ack, &[0xbe, 0xde, 0x00, 0x03, 0x66, 0xfd]].concat();
        assert!(parse_tcp_payload(&frame, 1).is_none());
    }

    #[test]
    fn non_ipv4_frames_are_ignored() {
        let arp = [[0u8; 12].as_slice(), &[0x08, 0x06], &[0u8; 28]].concat();
        assert!(parse_tcp_payload(&arp, 1).is_none());
    }
}
