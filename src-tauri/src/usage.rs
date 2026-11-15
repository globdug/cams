// Consumo dei processi dell'app (cams.exe, ffmpeg, WebView2): tempo CPU e RAM per la barra in alto.
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

// Con due misure piu' vicine di cosi' la percentuale sarebbe solo rumore: riuso la precedente
const MIN_SPAN: Duration = Duration::from_millis(500);

pub struct Sample {
    pub cpu: f64, // tempo CPU (utente + kernel) consumato dal processo, in secondi
    pub mem: u64, // RAM privata in byte (working set privato: la "Memoria" di Task Manager)
}

#[cfg(windows)]
mod sys {
    use super::Sample;
    use std::collections::HashSet;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        lo: u32,
        hi: u32,
    }

    // PROCESS_MEMORY_COUNTERS_EX2
    #[repr(C)]
    #[derive(Default)]
    struct MemCounters {
        cb: u32,
        page_faults: u32,
        peak_ws: usize,
        ws: usize,
        paged_peak: usize,
        paged: usize,
        nonpaged_peak: usize,
        nonpaged: usize,
        pagefile: usize,
        peak_pagefile: usize,
        private_usage: usize,
        private_ws: usize,
        shared_commit: u64,
    }

    // PROCESSENTRY32W
    #[repr(C)]
    struct Entry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent: u32,
        pri: i32,
        flags: u32,
        exe: [u16; 260],
    }

    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(h: *mut c_void) -> i32;
        fn GetProcessTimes(h: *mut c_void, c: *mut FileTime, e: *mut FileTime, k: *mut FileTime, u: *mut FileTime) -> i32;
        fn K32GetProcessMemoryInfo(h: *mut c_void, m: *mut MemCounters, cb: u32) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(h: *mut c_void, e: *mut Entry) -> i32;
        fn Process32NextW(h: *mut c_void, e: *mut Entry) -> i32;
    }

    pub fn sample(pid: u32) -> Option<Sample> {
        const QUERY_LIMITED: u32 = 0x1000; // PROCESS_QUERY_LIMITED_INFORMATION
        unsafe {
            let h = OpenProcess(QUERY_LIMITED, 0, pid);
            if h.is_null() {
                return None;
            }
            let (mut c, mut e, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
            let times = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0;
            let mut m = MemCounters { cb: std::mem::size_of::<MemCounters>() as u32, ..Default::default() };
            let mut mem = None;
            if K32GetProcessMemoryInfo(h, &mut m, m.cb) != 0 {
                mem = Some(m.private_ws);
            } else {
                // Windows senza EX2: working set intero (comprende le pagine condivise)
                m.cb = std::mem::offset_of!(MemCounters, private_usage) as u32;
                if K32GetProcessMemoryInfo(h, &mut m, m.cb) != 0 {
                    mem = Some(m.ws);
                }
            }
            CloseHandle(h);
            let t = |f: FileTime| ((f.hi as u64) << 32 | f.lo as u64) as f64 / 1e7; // unita' da 100 ns
            times.then(|| Sample { cpu: t(k) + t(u), mem: mem.unwrap_or(0) as u64 })
        }
    }

    pub fn descendants(root: u32) -> Vec<(u32, String)> {
        const SNAP_PROCESS: u32 = 2; // TH32CS_SNAPPROCESS
        let mut all: Vec<(u32, u32, String)> = Vec::new(); // (pid, genitore, nome exe)
        unsafe {
            let snap = CreateToolhelp32Snapshot(SNAP_PROCESS, 0);
            if snap as isize == -1 {
                return Vec::new();
            }
            let mut e: Entry = std::mem::zeroed();
            e.size = std::mem::size_of::<Entry>() as u32;
            let mut ok = Process32FirstW(snap, &mut e) != 0;
            while ok {
                let n = e.exe.iter().position(|&c| c == 0).unwrap_or(e.exe.len());
                all.push((e.pid, e.parent, String::from_utf16_lossy(&e.exe[..n])));
                ok = Process32NextW(snap, &mut e) != 0;
            }
            CloseHandle(snap);
        }
        let mut tree = HashSet::from([root]);
        loop {
            let before = tree.len();
            for (pid, parent, _) in &all {
                if tree.contains(parent) {
                    tree.insert(*pid);
                }
            }
            if tree.len() == before {
                break;
            }
        }
        all.into_iter().filter(|(pid, _, _)| *pid != root && tree.contains(pid)).map(|(pid, _, name)| (pid, name)).collect()
    }
}

#[cfg(not(windows))]
mod sys {
    use super::Sample;

    pub fn sample(pid: u32) -> Option<Sample> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let f: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
        let cpu = (f.get(11)?.parse::<f64>().ok()? + f.get(12)?.parse::<f64>().ok()?) / 100.0; // tick da 10 ms
        let pages = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?.split_whitespace().nth(1)?.parse::<u64>().ok()?;
        Some(Sample { cpu, mem: pages * 4096 })
    }

    // WebView2 c'e' solo su Windows: altrove non c'e' nulla da cercare tra i discendenti
    pub fn descendants(_root: u32) -> Vec<(u32, String)> {
        Vec::new()
    }
}

pub use sys::{descendants, sample};

// Misura piu' volte gli stessi processi e ne ricava la CPU come media dall'ultima misura
pub struct Meter {
    prev: HashMap<u32, (f64, Instant, Option<f64>)>, // pid -> (secondi CPU, istante, ultima percentuale)
    cores: f64,
}

impl Meter {
    pub fn new() -> Meter {
        Meter { prev: HashMap::new(), cores: std::thread::available_parallelism().map_or(1, |n| n.get()) as f64 }
    }

    /// Per ogni gruppo di processi: (CPU in % della CPU totale, come Task Manager; None alla prima misura, RAM privata in byte).
    pub fn measure(&mut self, groups: &[Vec<u32>]) -> Vec<(Option<f64>, u64)> {
        let now = Instant::now();
        let mut seen = HashSet::new();
        let out = groups
            .iter()
            .map(|pids| {
                let (mut cpu, mut mem) = (None, 0);
                for &pid in pids {
                    let Some(s) = sample(pid) else { continue };
                    seen.insert(pid);
                    mem += s.mem;
                    let pct = match self.prev.get(&pid).copied() {
                        Some((_, at, pct)) if now.duration_since(at) < MIN_SPAN => pct,
                        Some((secs, at, _)) => {
                            let pct = ((s.cpu - secs) / now.duration_since(at).as_secs_f64() * 100.0 / self.cores).max(0.0);
                            self.prev.insert(pid, (s.cpu, now, Some(pct)));
                            Some(pct)
                        }
                        None => {
                            self.prev.insert(pid, (s.cpu, now, None));
                            None
                        }
                    };
                    if let Some(p) = pct {
                        cpu = Some(cpu.unwrap_or(0.0) + p);
                    }
                }
                (cpu, mem)
            })
            .collect();
        self.prev.retain(|pid, _| seen.contains(pid)); // niente memoria dei processi chiusi
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_own_process() {
        let s = sample(std::process::id()).expect("misura del processo corrente");
        assert!(s.mem > 0);
        assert!(s.cpu >= 0.0);
    }

    #[test]
    fn finds_children_and_grandchildren() {
        let mut cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("cmd");
            c.args(["/c", "ping -n 4 127.0.0.1 >NUL"]);
            c
        } else {
            let mut c = std::process::Command::new("sh");
            c.args(["-c", "sleep 3; true"]);
            c
        };
        let mut child = cmd.spawn().unwrap();
        std::thread::sleep(Duration::from_millis(600));
        let found = descendants(std::process::id());
        let _ = child.kill();
        if cfg!(windows) {
            assert!(found.iter().any(|(pid, _)| *pid == child.id()), "{found:?}");
            assert!(found.iter().any(|(_, n)| n.eq_ignore_ascii_case("PING.EXE")), "{found:?}");
        }
    }

    #[test]
    fn meter_needs_two_samples_then_reports_cpu() {
        let mut m = Meter::new();
        let me = vec![std::process::id()];
        assert_eq!(m.measure(&[me.clone()])[0].0, None);
        let end = Instant::now() + Duration::from_millis(700);
        while Instant::now() < end {
            std::hint::black_box(1u64.wrapping_mul(3)); // occupa un core
        }
        let (cpu, mem) = m.measure(&[me])[0];
        let cpu = cpu.expect("seconda misura");
        assert!(cpu > 0.0 && cpu <= 100.0, "{cpu}");
        assert!(mem > 0);
    }

    // `TEST_PID=<pid> cargo test usage -- --nocapture` per confrontare con Task Manager
    #[test]
    fn print_pid() {
        if let Some(pid) = std::env::var("TEST_PID").ok().and_then(|v| v.parse().ok()) {
            let s = sample(pid);
            println!("pid {pid}: {:?}", s.map(|s| (s.cpu, s.mem)));
        }
    }
}
