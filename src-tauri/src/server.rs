// Backend HTTP locale (porting di server/server.js): legge cameras.json, salva lo stato UI
// e converte i flussi RTSP in MJPEG (via ffmpeg) consumabile da un <img>.
use crate::update;
use serde_json::{json, Map, Value};
use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{BuildHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

const PORT: u16 = 17890;
const STALL: Duration = Duration::from_secs(15);
// Margine per la chiusura ordinata di ffmpeg: legge la "q" solo quando si sveglia il ciclo principale (ogni -stats_period,
// 2 s), poi invia il TEARDOWN. Con un margine di 2 s il kill arrivava quasi sempre prima della fine.
const GRACE: Duration = Duration::from_secs(4);
// Il browser apre max 6 connessioni per indirizzo:porta e ogni flusso ne tiene una aperta. Ascolto su piu' indirizzi
// di loopback (127.0.0.1-8) cosi' il client puo' distribuire i flussi e superare il limite.
const ADDRS: usize = 8;

#[derive(Clone)]
struct Stream {
    label: String,
    url: String,
}

#[derive(Clone)]
struct Cam {
    id: String,
    name: String,
    streams: Vec<Stream>,
}

// Flusso attivo: processo ffmpeg e statistiche raccolte (log di ffmpeg, byte/frame inviati al client)
struct Live {
    sid: String,
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>, // per la chiusura ordinata ("q")
    pid: u32,
    cam: String,
    cam_name: String,
    stream: usize,
    label: String,
    started: Instant,
    w: f64,
    fps: f64,
    q: f64,
    hw: String,
    input: Mutex<String>,  // riga "Video: ..." dell'ingresso (codec, profilo, risoluzione, fps)
    output: Mutex<String>, // riga "Video: mjpeg ..." dell'uscita
    hwdec: Mutex<String>,  // tipo di decodifica hardware effettivamente usata
    progress: Mutex<HashMap<String, String>>,
    bytes: AtomicU64,
    frames: AtomicU64,
    rtp_bad: AtomicU64, // pacchetti RTP fuori sequenza segnalati da ffmpeg ("bad cseq")
    cpu: Mutex<(f64, Instant)>, // ultimo campione CPU (secondi, istante) per calcolare la percentuale
}

impl Live {
    // Chiusura ordinata: "q" su stdin e ffmpeg chiude la sessione RTSP con un TEARDOWN. Se lo si uccide di colpo l'NVR tiene la
    // sessione aperta per un po' e, accumulandosi, mescola i flussi (pacchetti RTP fuori sequenza, immagini corrotte o di altri canali).
    fn quit(&self) {
        if let Some(mut si) = self.stdin.lock().unwrap().take() {
            let _ = si.write_all(b"q");
            let _ = si.flush();
        }
    }

    // Attende la chiusura del processo; allo scadere del tempo lo uccide.
    fn wait_or_kill(&self, timeout: Duration) {
        let end = Instant::now() + timeout;
        loop {
            let mut c = self.child.lock().unwrap();
            if matches!(c.try_wait(), Ok(Some(_)) | Err(_)) {
                return;
            }
            if Instant::now() >= end {
                let _ = c.kill();
                let _ = c.wait();
                return;
            }
            drop(c);
            std::thread::sleep(Duration::from_millis(40));
        }
    }
}

enum Phase {
    Input,
    Output,
}

// Dividi una riga di log "[ctx @ addr] [livello] messaggio" in (livello, messaggio)
fn split_level(l: &str) -> Option<(&'static str, &str)> {
    ["fatal", "error", "warning", "info"].into_iter().find_map(|lv| l.find(&format!("[{lv}] ")).map(|i| (lv, &l[i + lv.len() + 3..])))
}

// Interpreta una riga di stderr di ffmpeg: errori, informazioni sui flussi e blocchi -progress (chiave=valore)
fn log_line(live: &Live, last_err: &Mutex<String>, phase: &mut Phase, line: &str) {
    let l = line.trim();
    if l.is_empty() {
        return;
    }
    match split_level(l) {
        Some(("fatal" | "error", m)) => *last_err.lock().unwrap() = m.trim().to_string(),
        Some(("info", m)) => {
            let m = m.trim_start();
            if m.starts_with("Stream mapping") || m.starts_with("Output #") {
                *phase = Phase::Output;
            }
            if let Some(v) = m.strip_prefix("Stream #").and_then(|r| r.split_once(": Video: ")).map(|x| x.1) {
                match phase {
                    Phase::Input if live.input.lock().unwrap().is_empty() => *live.input.lock().unwrap() = v.to_string(),
                    Phase::Output if v.starts_with("mjpeg") => *live.output.lock().unwrap() = v.to_string(),
                    _ => {}
                }
            }
            if let Some(i) = m.find("hwaccel type ") {
                if let Some(t) = m[i + 13..].split_whitespace().next() {
                    *live.hwdec.lock().unwrap() = t.to_string();
                }
            }
        }
        Some(("warning", m)) => {
            if m.contains("bad cseq") {
                live.rtp_bad.fetch_add(1, Ordering::Relaxed);
            }
        }
        Some(_) => {}
        None if !l.starts_with('[') => {
            if let Some((k, v)) = l.split_once('=') {
                live.progress.lock().unwrap().insert(k.trim().to_string(), v.trim().to_string());
            }
        }
        None => {}
    }
}

// Larghezza dal testo "h264 (High), yuv420p(progressive), 1280x720, 15 fps, ..."
fn src_width(input: &str) -> Option<u32> {
    input.split([',', ' ']).find_map(|t| {
        let (w, h) = t.split_once('x')?;
        h.parse::<u32>().ok()?;
        w.parse::<u32>().ok().filter(|w| *w >= 16)
    })
}

// Conta i frame nel flusso mpjpeg (ogni frame inizia con "--ffmpeg\r\n"), anche a cavallo di due letture
fn count_frames(carry: &mut Vec<u8>, chunk: &[u8]) -> u64 {
    const PAT: &[u8] = b"--ffmpeg\r\n";
    let mut buf = std::mem::take(carry);
    buf.extend_from_slice(chunk);
    let (mut n, mut i) = (0, 0);
    while i + PAT.len() <= buf.len() {
        if buf[i..].starts_with(PAT) {
            n += 1;
            i += PAT.len();
        } else {
            i += 1;
        }
    }
    *carry = buf[buf.len().saturating_sub(PAT.len() - 1)..].to_vec();
    n
}

// Tempo CPU (utente + kernel) consumato dal processo, in secondi
#[cfg(windows)]
fn proc_cpu_secs(child: &Child) -> Option<f64> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        lo: u32,
        hi: u32,
    }
    extern "system" {
        fn GetProcessTimes(h: *mut std::ffi::c_void, c: *mut FileTime, e: *mut FileTime, k: *mut FileTime, u: *mut FileTime) -> i32;
    }
    let (mut c, mut e, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
    if unsafe { GetProcessTimes(child.as_raw_handle(), &mut c, &mut e, &mut k, &mut u) } == 0 {
        return None;
    }
    let t = |f: FileTime| ((f.hi as u64) << 32 | f.lo as u64) as f64 / 1e7; // unita' da 100 ns
    Some(t(k) + t(u))
}

#[cfg(not(windows))]
fn proc_cpu_secs(child: &Child) -> Option<f64> {
    let stat = fs::read_to_string(format!("/proc/{}/stat", child.id())).ok()?;
    let f: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    Some((f.get(11)?.parse::<f64>().ok()? + f.get(12)?.parse::<f64>().ok()?) / 100.0) // tick da 10 ms
}

pub struct Backend {
    data: PathBuf,
    ffmpeg: PathBuf,
    cameras: Mutex<Vec<Cam>>,
    config_error: Mutex<Option<String>>,
    cfg_version: AtomicU64,
    seen_mtime: Mutex<Option<SystemTime>>,
    active: Mutex<HashMap<String, Arc<Live>>>,
    bound: Mutex<Vec<String>>,
    salt: RandomState,
    counter: AtomicU64,
    update: Mutex<Option<(Instant, Option<update::Release>)>>, // ultimo controllo: in cache per non superare i limiti dell'API di GitHub
    updating: AtomicBool,
    relaunch: Mutex<Option<PathBuf>>, // exe appena installato, da rilanciare dopo la chiusura
    exit: Mutex<Option<Box<dyn Fn() + Send + Sync>>>, // chiude l'app (impostato da main)
}

// ---------- utilita' ----------
fn slug(s: &str) -> String {
    let mapped: String = s.to_lowercase().chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { '-' }).collect();
    mapped.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-")
}

fn percent_decode(s: &str, plus: bool) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() => {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
                i += 3;
                continue;
            }
            b'+' if plus => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn uri_encode(s: &str) -> String {
    let mut out = String::new();
    for &c in s.as_bytes() {
        if c.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&c) {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}

fn has_escape(s: &str) -> bool {
    s.as_bytes().windows(3).any(|w| w[0] == b'%' && w[1].is_ascii_hexdigit() && w[2].is_ascii_hexdigit())
}

// Codifica utente/password (es. '@' o '$' nella password): l'ULTIMA '@' separa le credenziali dall'host.
fn encode_auth(url: &str) -> String {
    let lower = url.to_ascii_lowercase();
    let n = if lower.starts_with("rtsps://") { 8 } else if lower.starts_with("rtsp://") { 7 } else { return url.into() };
    let (scheme, rest) = url.split_at(n);
    let Some(at) = rest.rfind('@') else { return url.into() };
    let enc = |v: &str| if has_escape(v) { v.to_string() } else { uri_encode(v) }; // gia' codificato: lascio com'e'
    let cred = &rest[..at];
    let auth = match cred.find(':') {
        None => enc(cred),
        Some(i) => format!("{}:{}", enc(&cred[..i]), enc(&cred[i + 1..])),
    };
    format!("{scheme}{auth}@{}", &rest[at + 1..])
}

fn valid_url(u: &str) -> bool {
    let Some((scheme, rest)) = u.split_once("://") else { return false };
    ["rtsp", "rtsps", "http", "https"].contains(&scheme.to_ascii_lowercase().as_str()) && !rest.is_empty() && !u.chars().any(char::is_whitespace)
}

fn parse_json(text: &str) -> Result<Value, String> {
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())
}

fn normalize(raw: &Value) -> Vec<Cam> {
    let mut used = HashSet::new();
    let list = raw.get("cameras").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    list.iter()
        .enumerate()
        .map(|(i, c)| {
            let mut items: Vec<&Value> = c.get("streams").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
            if items.is_empty() {
                // forma alternativa: stream1, stream2, ...
                let mut keys: Vec<&String> = c
                    .as_object()
                    .map(|o| o.keys().filter(|k| k.len() > 6 && k[..6].eq_ignore_ascii_case("stream") && k[6..].bytes().all(|b| b.is_ascii_digit())).collect())
                    .unwrap_or_default();
                keys.sort();
                items = keys.iter().map(|k| &c[k.as_str()]).collect();
            }
            let streams = items
                .iter()
                .enumerate()
                .filter_map(|(n, s)| {
                    let def = format!("Flusso {}", n + 1);
                    let (label, url) = match s {
                        Value::String(u) => (def, u.as_str()),
                        _ => (
                            s.get("label").and_then(Value::as_str).filter(|l| !l.is_empty()).map(String::from).unwrap_or(def),
                            s.get("url").and_then(Value::as_str).unwrap_or(""),
                        ),
                    };
                    (!url.is_empty()).then(|| Stream { label, url: encode_auth(url) })
                })
                .collect();
            let name = c.get("name").and_then(Value::as_str).filter(|n| !n.is_empty());
            let mut id = match c.get("id") {
                Some(Value::String(s)) if !s.is_empty() => s.clone(),
                _ => match slug(name.unwrap_or("")) {
                    s if s.is_empty() => format!("cam{}", i + 1),
                    s => s,
                },
            };
            while used.contains(&id) {
                id += &format!("-{i}");
            }
            used.insert(id.clone());
            Cam { name: name.map(String::from).unwrap_or_else(|| id.clone()), id, streams }
        })
        .collect()
}

fn validate_config(b: &Value) -> Result<Value, String> {
    let list = b.get("cameras").and_then(Value::as_array).ok_or("manca l'elenco \"cameras\"")?;
    let mut out = Vec::new();
    for (i, c) in list.iter().enumerate() {
        let name = c.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).ok_or_else(|| format!("telecamera {}: nome mancante", i + 1))?;
        let streams = c.get("streams").and_then(Value::as_array).filter(|a| !a.is_empty()).ok_or_else(|| format!("{name}: serve almeno un flusso"))?;
        let mut ss = Vec::new();
        for (k, s) in streams.iter().enumerate() {
            let url = match s {
                Value::String(u) => Some(u.as_str()),
                _ => s.get("url").and_then(Value::as_str),
            };
            let label = s.get("label").and_then(Value::as_str).map(str::trim).unwrap_or("");
            let url = url.map(str::trim).filter(|u| valid_url(u)).ok_or_else(|| format!("{name}, flusso {}: URL non valido (deve iniziare con rtsp://)", k + 1))?;
            ss.push(if label.is_empty() { json!(url) } else { json!({ "label": label, "url": url }) });
        }
        let mut o = Map::new();
        o.insert("name".into(), json!(name.trim()));
        if let Some(id) = c.get("id").and_then(Value::as_str).map(str::trim).filter(|i| !i.is_empty()) {
            o.insert("id".into(), json!(id));
        }
        o.insert("streams".into(), Value::Array(ss));
        out.push(Value::Object(o));
    }
    Ok(json!({ "cameras": out }))
}

// Origini ammesse: pagine dell'app su loopback (finestra Tauri: tauri.localhost in produzione, 127.0.0.1:<porta> in "tauri dev").
// Qualsiasi sito esterno e' rifiutato.
fn origin_ok(o: &str) -> bool {
    if o == "tauri://localhost" {
        return true;
    }
    let Some(rest) = o.strip_prefix("http://").or_else(|| o.strip_prefix("https://")) else { return false };
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if auth.contains('@') {
        return false;
    }
    let host = if auth.starts_with('[') {
        auth.split(']').next().map(|h| format!("{h}]")).unwrap_or_default()
    } else {
        auth.rsplit_once(':').map_or(auth.as_str(), |(h, _)| h).to_string()
    };
    ["127.0.0.1", "localhost", "[::1]", "tauri.localhost"].contains(&host.as_str())
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

// ffmpeg: variabile FFMPEG, poi ffmpeg.exe accanto all'exe, poi PATH
fn find_ffmpeg() -> PathBuf {
    if let Some(p) = std::env::var_os("FFMPEG") {
        return p.into();
    }
    if let Some(p) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("ffmpeg.exe"))) {
        if p.exists() {
            return p;
        }
    }
    "ffmpeg".into()
}

// ---------- HTTP minimale ----------
struct Req {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(s: &TcpStream) -> Result<Req, u16> {
    let mut r = BufReader::new(s.try_clone().map_err(|_| 500u16)?);
    let mut line = String::new();
    (&mut r).take(8192).read_line(&mut line).map_err(|_| 400u16)?;
    let mut it = line.split_whitespace();
    let (method, target) = match (it.next(), it.next()) {
        (Some(m), Some(t)) => (m.to_string(), t.to_string()),
        _ => return Err(400),
    };
    let mut headers = HashMap::new();
    for _ in 0..100 {
        line.clear();
        (&mut r).take(8192).read_line(&mut line).map_err(|_| 400u16)?;
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > 1 << 20 {
        return Err(413);
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).map_err(|_| 400u16)?;
    let (path, q) = target.split_once('?').unwrap_or((&target, ""));
    let query = q
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (percent_decode(k, true), percent_decode(v, true))
        })
        .collect();
    Ok(Req { method, path: path.to_string(), query, headers, body })
}

type Cors = Vec<(&'static str, String)>;

fn respond(s: &mut TcpStream, code: u16, ctype: &str, cors: &Cors, body: &[u8]) {
    let reason = match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "",
    };
    let mut h = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (k, v) in cors {
        h += &format!("{k}: {v}\r\n");
    }
    h += "\r\n";
    let _ = s.write_all(h.as_bytes()).and_then(|_| s.write_all(body));
    let _ = s.flush();
}

fn send(s: &mut TcpStream, code: u16, cors: &Cors, v: &Value) {
    respond(s, code, "application/json", cors, v.to_string().as_bytes());
}

impl Backend {
    /// Avvia il server su 127.0.0.1-8:17890. `data` contiene cameras.json e state.json.
    pub fn start(data: PathBuf) -> Result<Arc<Backend>, String> {
        fs::create_dir_all(&data).map_err(|e| e.to_string())?;
        let config = data.join("cameras.json");
        if !config.exists() {
            let sample = json!({ "cameras": [{ "name": "Esempio", "streams": [
                "rtsp://utente:password@192.168.1.10:554/stream1",
                "rtsp://utente:password@192.168.1.10:554/stream2",
            ] }] });
            fs::write(&config, serde_json::to_string_pretty(&sample).unwrap()).map_err(|e| e.to_string())?;
        }
        let b = Arc::new(Backend {
            seen_mtime: Mutex::new(mtime(&config)),
            data,
            ffmpeg: find_ffmpeg(),
            cameras: Mutex::new(Vec::new()),
            config_error: Mutex::new(None),
            cfg_version: AtomicU64::new(0),
            active: Mutex::new(HashMap::new()),
            bound: Mutex::new(Vec::new()),
            salt: RandomState::new(),
            counter: AtomicU64::new(0),
            update: Mutex::new(None),
            updating: AtomicBool::new(false),
            relaunch: Mutex::new(None),
            exit: Mutex::new(None),
        });
        b.load_cameras();
        for i in 1..=ADDRS {
            let addr = format!("127.0.0.{i}");
            // La prima porta puo' essere ancora della copia precedente, che chiude gli ffmpeg (fino a 3 s) dopo la chiusura della
            // finestra: riapertura subito dopo, o riavvio dopo un aggiornamento. Riprovo per qualche secondo.
            let mut tries = 0;
            let bound = loop {
                match TcpListener::bind((addr.as_str(), PORT)) {
                    Err(e) if i == 1 && e.kind() == std::io::ErrorKind::AddrInUse && tries < 100 => {
                        tries += 1;
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    r => break r,
                }
            };
            match bound {
                Ok(l) => {
                    b.bound.lock().unwrap().push(addr);
                    let b = b.clone();
                    std::thread::spawn(move || {
                        for conn in l.incoming().flatten() {
                            let b = b.clone();
                            std::thread::spawn(move || b.handle(conn));
                        }
                    });
                }
                Err(e) if i == 1 => return Err(format!("impossibile avviare il backend su {addr}:{PORT} (gia' in uso?): {e}")),
                Err(e) => eprintln!("indirizzo {addr} non disponibile ({e}), ignorato"),
            }
        }
        update::cleanup();
        Ok(b)
    }

    /// Come chiudere l'app (serve all'aggiornamento, che la riavvia).
    pub fn set_exit(&self, f: impl Fn() + Send + Sync + 'static) {
        *self.exit.lock().unwrap() = Some(Box::new(f));
    }

    /// Dopo la chiusura: se e' stato installato un aggiornamento, rilancia il nuovo exe.
    pub fn relaunch_if_requested(&self) {
        if let Some(exe) = self.relaunch.lock().unwrap().take() {
            let _ = Command::new(&exe).current_dir(exe.parent().unwrap_or(Path::new("."))).spawn();
        }
    }

    /// Ultima release di GitHub (None se non ce ne sono). Il risultato resta in cache 30 minuti salvo `force`.
    fn latest_release(&self, force: bool) -> Result<Option<update::Release>, String> {
        let mut cache = self.update.lock().unwrap();
        if let Some((_, rel)) = cache.as_ref().filter(|(at, _)| !force && at.elapsed() < Duration::from_secs(1800)) {
            return Ok(rel.clone());
        }
        let rel = update::latest()?;
        *cache = Some((Instant::now(), rel.clone()));
        Ok(rel)
    }

    /// Ferma tutti i processi ffmpeg (chiusura app).
    pub fn kill_all(&self) {
        let lives: Vec<Arc<Live>> = self.active.lock().unwrap().drain().map(|(_, l)| l).collect();
        for l in &lives {
            l.quit();
        }
        // chiusura ordinata (in parallelo, max 3 s in tutto), poi uccido chi non e' uscito
        let end = Instant::now() + Duration::from_secs(3);
        for l in &lives {
            l.wait_or_kill(end.saturating_duration_since(Instant::now()));
        }
    }

    fn config_path(&self) -> PathBuf {
        self.data.join("cameras.json")
    }

    fn load_cameras(&self) {
        let res = fs::read_to_string(self.config_path()).map_err(|e| e.to_string()).and_then(|t| parse_json(&t)).map(|v| normalize(&v));
        match res {
            Ok(c) => {
                *self.cameras.lock().unwrap() = c;
                *self.config_error.lock().unwrap() = None;
            }
            Err(e) => *self.config_error.lock().unwrap() = Some(format!("cameras.json non valido: {e}")),
        }
    }

    // il client scopre le modifiche a mano di cameras.json dal polling /api/streams
    fn poll_config_change(&self) {
        let m = mtime(&self.config_path());
        let mut seen = self.seen_mtime.lock().unwrap();
        if m != *seen {
            *seen = m;
            drop(seen);
            self.load_cameras();
            self.cfg_version.fetch_add(1, Ordering::SeqCst);
        }
    }

    // impronta degli URL (con sale casuale): il client sa quando riavviare un flusso senza vedere le credenziali
    fn rev(&self, c: &Cam) -> String {
        let mut h = self.salt.build_hasher();
        for s in &c.streams {
            s.url.hash(&mut h);
        }
        format!("{:010x}", h.finish() & 0xff_ffff_ffff)
    }

    fn handle(self: Arc<Self>, mut s: TcpStream) {
        let _ = s.set_nodelay(true);
        let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
        let req = match read_request(&s) {
            Ok(r) => r,
            Err(code) => return respond(&mut s, code, "application/json", &vec![], b"{}"),
        };
        // Protezione: le credenziali delle camere passano da qui. Blocco altri siti (Origin) e DNS rebinding (Host).
        let origin = req.headers.get("origin");
        let host_ok = req.headers.get("host").is_some_and(|h| h == &format!("localhost:{PORT}") || (1..=ADDRS).any(|i| *h == format!("127.0.0.{i}:{PORT}")));
        if !host_ok || origin.is_some_and(|o| !origin_ok(o)) {
            return respond(&mut s, 403, "text/plain", &vec![], b"");
        }
        let mut cors: Cors = vec![];
        if let Some(o) = origin {
            cors.push(("Access-Control-Allow-Origin", o.clone()));
            cors.push(("Vary", "Origin".into()));
        }
        let p = req.path.as_str();
        let write = req.method == "PUT" || req.method == "POST"; // POST: richiesta semplice, nessun preflight CORS

        if req.method == "OPTIONS" {
            cors.push(("Access-Control-Allow-Methods", "GET,PUT,POST".into()));
            cors.push(("Access-Control-Allow-Headers", "Content-Type".into()));
            cors.push(("Access-Control-Allow-Private-Network", "true".into()));
            return respond(&mut s, 204, "text/plain", &cors, b"");
        }

        match p {
            "/api/cameras" => {
                self.load_cameras(); // rilegge sempre il file: il tasto Aggiorna non dipende dal polling
                // gli URL (con le credenziali) non escono mai dal backend
                let cams: Vec<Value> = self.cameras.lock().unwrap().iter().map(|c| json!({
                    "id": c.id, "name": c.name, "rev": self.rev(c),
                    "streams": c.streams.iter().map(|s| &s.label).collect::<Vec<_>>(),
                })).collect();
                send(&mut s, 200, &cors, &json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "file": self.config_path().display().to_string(),
                    "hosts": *self.bound.lock().unwrap(),
                    "error": *self.config_error.lock().unwrap(),
                    "cameras": cams,
                }));
            }
            "/api/config" if write => {
                let res = (|| -> Result<(), String> {
                    let cfg = validate_config(&parse_json(&String::from_utf8_lossy(&req.body))?)?;
                    let path = self.config_path();
                    if path.exists() {
                        fs::copy(&path, self.data.join("cameras.json.bak")).map_err(|e| e.to_string())?;
                    }
                    fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap()).map_err(|e| e.to_string())?;
                    *self.seen_mtime.lock().unwrap() = mtime(&path); // scrittura nostra: il client ricarica da solo
                    self.load_cameras();
                    Ok(())
                })();
                match res {
                    Ok(()) => send(&mut s, 200, &cors, &json!({ "ok": true })),
                    Err(e) => send(&mut s, 400, &cors, &json!({ "error": e })),
                }
            }
            "/api/config" => {
                let file = self.config_path().display().to_string();
                match fs::read_to_string(self.config_path()) {
                    Ok(text) => match parse_json(&text) {
                        Ok(config) => send(&mut s, 200, &cors, &json!({ "config": config, "file": file })),
                        Err(e) => send(&mut s, 200, &cors, &json!({ "error": e, "text": text, "file": file })),
                    },
                    Err(e) => send(&mut s, 500, &cors, &json!({ "error": e.to_string() })),
                }
            }
            "/api/state" if write => {
                let res = parse_json(&String::from_utf8_lossy(&req.body))
                    .and_then(|v| fs::write(self.data.join("state.json"), serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string()));
                match res {
                    Ok(()) => send(&mut s, 200, &cors, &json!({ "ok": true })),
                    Err(e) => send(&mut s, 400, &cors, &json!({ "error": e })),
                }
            }
            "/api/state" => {
                let v = fs::read_to_string(self.data.join("state.json")).map_err(|e| e.to_string()).and_then(|t| parse_json(&t)).unwrap_or_else(|_| json!({}));
                send(&mut s, 200, &cors, &v);
            }
            "/api/update" if write => {
                if self.updating.swap(true, Ordering::SeqCst) {
                    return send(&mut s, 409, &cors, &json!({ "error": "aggiornamento gia' in corso" }));
                }
                let res = self
                    .latest_release(true)
                    .and_then(|r| r.filter(|r| update::is_newer(&r.tag)).ok_or_else(|| "nessun aggiornamento disponibile".to_string()))
                    .and_then(|r| update::install(&r));
                match res {
                    Ok(exe) => {
                        *self.relaunch.lock().unwrap() = Some(exe);
                        send(&mut s, 200, &cors, &json!({ "ok": true }));
                        if let Some(exit) = self.exit.lock().unwrap().as_ref() {
                            exit(); // chiude l'app: dopo la chiusura degli ffmpeg parte il nuovo exe (vedi main)
                        }
                    }
                    Err(e) => {
                        self.updating.store(false, Ordering::SeqCst);
                        send(&mut s, 500, &cors, &json!({ "error": e }));
                    }
                }
            }
            "/api/update" => {
                match self.latest_release(req.query.contains_key("force")) {
                    Ok(rel) => {
                        let rel = rel.filter(|r| update::is_newer(&r.tag));
                        send(&mut s, 200, &cors, &json!({
                            "current": env!("CARGO_PKG_VERSION"),
                            "available": rel.is_some(),
                            "latest": rel.as_ref().map(|r| r.tag.as_str()),
                            "notes": rel.as_ref().map(|r| r.notes.as_str()),
                            "canInstall": cfg!(windows) && cfg!(not(debug_assertions)),
                        }));
                    }
                    Err(e) => send(&mut s, 502, &cors, &json!({ "error": e })),
                }
            }
            "/api/streams" => {
                self.poll_config_change();
                let lives: Vec<Arc<Live>> = self.active.lock().unwrap().values().cloned().collect();
                let sids: Vec<&str> = lives.iter().map(|l| l.sid.as_str()).collect();
                // larghezza nativa di ogni sorgente: il client evita di riavviare un flusso che non guadagna dettaglio
                let src: Map<String, Value> = lives.iter().filter_map(|l| src_width(&l.input.lock().unwrap()).map(|w| (l.sid.clone(), json!(w)))).collect();
                send(&mut s, 200, &cors, &json!({ "sids": sids, "src": src, "cfg": self.cfg_version.load(Ordering::SeqCst) }));
            }
            "/api/stats" => {
                let lives: Vec<Arc<Live>> = self.active.lock().unwrap().values().cloned().collect();
                let streams: Vec<Value> = lives
                    .iter()
                    .map(|l| {
                        let now = Instant::now();
                        let cpu = proc_cpu_secs(&l.child.lock().unwrap()).map(|secs| {
                            let mut prev = l.cpu.lock().unwrap();
                            let pct = (secs - prev.0) / now.duration_since(prev.1).as_secs_f64().max(0.001) * 100.0;
                            *prev = (secs, now);
                            pct
                        });
                        json!({
                            "sid": l.sid, "cam": l.cam, "name": l.cam_name, "stream": l.stream, "label": l.label, "pid": l.pid,
                            "uptime": l.started.elapsed().as_secs(),
                            "req": { "w": l.w, "fps": l.fps, "q": l.q, "hwaccel": l.hw },
                            "input": *l.input.lock().unwrap(), "output": *l.output.lock().unwrap(), "hwdec": *l.hwdec.lock().unwrap(),
                            "progress": *l.progress.lock().unwrap(),
                            "bytes": l.bytes.load(Ordering::Relaxed), "frames": l.frames.load(Ordering::Relaxed), "rtpBad": l.rtp_bad.load(Ordering::Relaxed),
                            "cpu": cpu,
                        })
                    })
                    .collect();
                send(&mut s, 200, &cors, &json!({ "ffmpeg": self.ffmpeg.display().to_string(), "streams": streams }));
            }
            _ => {
                let route = p.strip_prefix("/stream/").and_then(|r| r.split_once('/')).filter(|(id, n)| !id.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
                let Some((id, n)) = route else { return send(&mut s, 404, &cors, &json!({ "error": "not found" })) };
                let id = percent_decode(id, false);
                let cam = self.cameras.lock().unwrap().iter().find(|c| c.id == id).cloned();
                match cam {
                    Some(cam) => self.stream(&mut s, &cors, &cam, n.parse().unwrap_or(usize::MAX), &req.query),
                    None => send(&mut s, 404, &cors, &json!({ "error": "telecamera inesistente" })),
                }
            }
        }
    }

    fn stream(&self, s: &mut TcpStream, cors: &Cors, cam: &Cam, idx: usize, q: &HashMap<String, String>) {
        let Some(st) = cam.streams.get(idx) else { return send(s, 404, cors, &json!({ "error": "flusso inesistente" })) };
        let num = |k: &str, d: f64, lo: f64, hi: f64| q.get(k).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite() && *v != 0.0).unwrap_or(d).clamp(lo, hi);
        let w = num("w", 640.0, 160.0, 1920.0);
        let fps = num("fps", 10.0, 1.0, 30.0);
        let qv = num("q", 5.0, 2.0, 20.0);
        let sid = q.get("sid").filter(|v| !v.is_empty()).cloned().unwrap_or_else(|| {
            let t = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            format!("{t:x}{:x}", self.counter.fetch_add(1, Ordering::Relaxed))
        });

        // log con livello (per distinguere errori e informazioni sui flussi) e blocchi di progresso su stderr, ogni 2 s
        let mut args: Vec<String> = ["-hide_banner", "-loglevel", "level+info", "-nostats", "-progress", "pipe:2", "-stats_period", "2", "-fflags", "nobuffer", "-flags", "low_delay"].map(String::from).into();
        // sonda di ingresso breve: meno CPU e avvio piu' rapido
        args.extend(["-probesize", "1000000", "-analyzeduration", "1000000"].map(String::from));
        // decodifica hardware (CAMS_HWACCEL=none per disattivarla); se non disponibile ffmpeg ripiega sul software
        let hw = std::env::var("CAMS_HWACCEL").unwrap_or_else(|_| "auto".into());
        if !hw.is_empty() && hw != "none" {
            args.extend(["-hwaccel".into(), hw.clone()]);
        }
        // timestamp = istante di arrivo: alcune telecamere (es. Reolink) partono da un PTS enorme e il filtro fps
        // duplicherebbe centinaia di migliaia di frame per colmare il vuoto (7 core di CPU per decine di secondi)
        args.extend(["-use_wallclock_as_timestamps".into(), "1".into()]);
        if st.url.to_ascii_lowercase().starts_with("rtsp") {
            args.extend(["-rtsp_transport".into(), "tcp".into()]);
        }
        args.extend(["-i".into(), st.url.clone()]);
        // 1a uscita: copia del flusso originale verso il "nul", solo per misurarne il bitrate reale (progress: bitrate/total_size)
        let nul = if cfg!(windows) { "NUL" } else { "/dev/null" };
        args.extend(["-map", "0:v:0", "-c", "copy", "-f", "nut", nul].map(String::from));
        // 2a uscita: MJPEG per il browser
        args.extend(["-map".into(), "0:v:0".into(), "-vf".into(), format!("fps={fps},scale='min({w},iw)':-2:flags=fast_bilinear"), "-q:v".into(), qv.to_string()]);
        args.extend(["-f", "mpjpeg", "-boundary_tag", "ffmpeg", "pipe:1"].map(String::from));

        let mut cmd = Command::new(&self.ffmpeg);
        cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000 | 0x0000_4000); // senza finestra console, priorita' bassa (non rallenta il PC)
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let why = if e.kind() == std::io::ErrorKind::NotFound { "ffmpeg non trovato (mettilo accanto a cams.exe o nel PATH)".to_string() } else { e.to_string() };
                return send(s, 500, cors, &json!({ "error": why }));
            }
        };
        let mut out = child.stdout.take().unwrap();
        let err = child.stderr.take().unwrap();
        let stdin = child.stdin.take();
        let live = Arc::new(Live {
            sid: sid.clone(),
            pid: child.id(),
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            cam: cam.id.clone(),
            cam_name: cam.name.clone(),
            stream: idx,
            label: st.label.clone(),
            started: Instant::now(),
            w,
            fps,
            q: qv,
            hw: if hw.is_empty() { "none".into() } else { hw },
            input: Mutex::new(String::new()),
            output: Mutex::new(String::new()),
            hwdec: Mutex::new(String::new()),
            progress: Mutex::new(HashMap::new()),
            bytes: AtomicU64::new(0),
            frames: AtomicU64::new(0),
            rtp_bad: AtomicU64::new(0),
            cpu: Mutex::new((0.0, Instant::now())),
        });
        self.active.lock().unwrap().insert(sid.clone(), live.clone());

        let last_err = Arc::new(Mutex::new(String::new()));
        let err_thread = {
            let (last_err, live) = (last_err.clone(), live.clone());
            std::thread::spawn(move || {
                let mut phase = Phase::Input;
                for l in BufReader::new(err).lines().map_while(Result::ok) {
                    log_line(&live, &last_err, &mut phase, &l);
                }
            })
        };
        let last = Arc::new(Mutex::new(Instant::now()));
        let stalled = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        {
            let (last, stalled, done, live) = (last.clone(), stalled.clone(), done.clone(), live.clone());
            std::thread::spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(500));
                    if last.lock().unwrap().elapsed() > STALL {
                        stalled.store(true, Ordering::SeqCst);
                        live.quit();
                        live.wait_or_kill(GRACE);
                        break;
                    }
                }
            });
        }

        let mut buf = vec![0u8; 64 * 1024];
        let mut n = out.read(&mut buf).unwrap_or(0);
        let started = n > 0;
        if started {
            let mut h = String::from("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=ffmpeg\r\nCache-Control: no-store\r\nConnection: close\r\n");
            for (k, v) in cors {
                h += &format!("{k}: {v}\r\n");
            }
            h += "\r\n";
            if s.write_all(h.as_bytes()).is_ok() {
                let mut carry = Vec::new();
                while n > 0 {
                    if s.write_all(&buf[..n]).and_then(|_| s.flush()).is_err() {
                        break; // client chiuso
                    }
                    live.bytes.fetch_add(n as u64, Ordering::Relaxed);
                    live.frames.fetch_add(count_frames(&mut carry, &buf[..n]), Ordering::Relaxed);
                    *last.lock().unwrap() = Instant::now();
                    n = out.read(&mut buf).unwrap_or(0);
                }
            }
        }
        done.store(true, Ordering::SeqCst);
        if started {
            live.quit();
        }
        let drain = std::thread::spawn(move || {
            let _ = std::io::copy(&mut out, &mut std::io::sink());
        });
        live.wait_or_kill(if started { GRACE } else { Duration::ZERO });
        let _ = drain.join();
        let _ = err_thread.join();
        {
            let mut active = self.active.lock().unwrap();
            if active.get(&sid).is_some_and(|l| Arc::ptr_eq(l, &live)) {
                active.remove(&sid);
            }
        }
        if !started {
            let why = if stalled.load(Ordering::SeqCst) {
                "timeout: nessun dato ricevuto".to_string()
            } else {
                Some(last_err.lock().unwrap().clone()).filter(|e| !e.is_empty()).unwrap_or_else(|| "flusso non raggiungibile".into())
            };
            eprintln!("[{} / {}] {why}", cam.name, st.label);
            send(s, 502, cors, &json!({ "error": why }));
        }
        let _ = s.shutdown(Shutdown::Both);
    }
}
