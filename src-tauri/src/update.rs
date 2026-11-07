// Autoaggiornamento dell'exe portable: legge l'ultima release di GitHub, scarica cams.exe, ne verifica lo SHA-256 e lo sostituisce.
// Windows non permette di sovrascrivere un exe in esecuzione ma permette di rinominarlo: cams.exe -> cams.exe.old, cams.exe.new -> cams.exe.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const REPO: &str = "globdug/cams";
const ASSET: &str = "cams.exe";
const MAX_SIZE: u64 = 100 * 1024 * 1024;

#[derive(Clone)]
pub struct Release {
    pub tag: String,
    pub notes: String,
    url: String,
    size: u64,
    sha_url: String,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .user_agent(concat!("cams/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn parse_version(s: &str) -> Option<[u64; 3]> {
    let mut it = s.trim().trim_start_matches('v').split('.');
    let v = [it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?];
    it.next().is_none().then_some(v)
}

/// Vero se `tag` e' una versione piu' recente di quella in esecuzione. Tag non numerici (es. "0.3.0-beta") non contano.
pub fn is_newer(tag: &str) -> bool {
    match (parse_version(tag), parse_version(env!("CARGO_PKG_VERSION"))) {
        (Some(t), Some(c)) => t > c,
        _ => false,
    }
}

/// L'ultima release pubblicata, o None se il repo non ne ha ancora.
pub fn latest() -> Result<Option<Release>, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = match agent().get(&url).set("Accept", "application/vnd.github+json").call() {
        Ok(r) => r,
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(e) => return Err(format!("GitHub non raggiungibile: {e}")),
    };
    let v: Value = serde_json::from_reader(resp.into_reader().take(2 << 20)).map_err(|e| format!("risposta di GitHub non valida: {e}"))?;
    let tag = v["tag_name"].as_str().ok_or("release senza tag")?.to_string();
    // solo asset ospitati dalla release del repo: il percorso e' fisso, non arriva dall'esterno
    let prefix = format!("https://github.com/{REPO}/releases/download/");
    let asset = |name: &str| v["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"] == name));
    let link = |a: &Value| a["browser_download_url"].as_str().filter(|u| u.starts_with(&prefix)).map(String::from);
    let (Some(exe), Some(sha)) = (asset(ASSET), asset(&format!("{ASSET}.sha256"))) else {
        return Err(format!("la release {tag} non contiene {ASSET} e {ASSET}.sha256"));
    };
    Ok(Some(Release {
        notes: v["body"].as_str().unwrap_or("").to_string(),
        url: link(exe).ok_or("indirizzo di download non valido")?,
        sha_url: link(sha).ok_or("indirizzo dello SHA-256 non valido")?,
        size: exe["size"].as_u64().unwrap_or(0),
        tag,
    }))
}

/// Scarica la release e sostituisce l'exe in esecuzione. Restituisce il percorso dell'exe da rilanciare.
pub fn install(rel: &Release) -> Result<PathBuf, String> {
    if cfg!(not(windows)) {
        return Err("l'aggiornamento automatico e' disponibile solo su Windows".into());
    }
    if cfg!(debug_assertions) {
        return Err("aggiornamento disattivato nella build di sviluppo".into());
    }
    if rel.size == 0 || rel.size > MAX_SIZE {
        return Err("dimensione della release non valida".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let (new, old) = (side(&exe, "new"), side(&exe, "old"));

    let res = download(rel, &new).and_then(|_| {
        let _ = fs::remove_file(&old);
        fs::rename(&exe, &old).map_err(|e| format!("impossibile sostituire l'exe (cartella non scrivibile?): {e}"))?;
        fs::rename(&new, &exe).map_err(|e| {
            let _ = fs::rename(&old, &exe); // ripristino
            format!("impossibile installare il nuovo exe: {e}")
        })
    });
    if res.is_err() {
        let _ = fs::remove_file(&new);
    }
    res.map(|_| exe)
}

/// Al riavvio: toglie i file temporanei lasciati dall'aggiornamento precedente.
pub fn cleanup() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = fs::remove_file(side(&exe, "old"));
        let _ = fs::remove_file(side(&exe, "new"));
    }
}

fn side(exe: &Path, ext: &str) -> PathBuf {
    let mut n = exe.as_os_str().to_owned();
    n.push(".");
    n.push(ext);
    PathBuf::from(n)
}

fn download(rel: &Release, dest: &Path) -> Result<(), String> {
    let ag = agent();
    let mut want = String::new();
    ag.get(&rel.sha_url).call().map_err(|e| format!("download dello SHA-256: {e}"))?.into_reader().take(4096).read_to_string(&mut want).map_err(|e| e.to_string())?;
    let want = want.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    if want.len() != 64 || !want.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("SHA-256 della release non valido".into());
    }

    let mut src = ag.get(&rel.url).call().map_err(|e| format!("download di {ASSET}: {e}"))?.into_reader().take(rel.size + 1);
    let mut out = File::create(dest).map_err(|e| format!("impossibile scrivere {}: {e}", dest.display()))?;
    let (mut hash, mut total, mut buf) = (Sha256::new(), 0u64, vec![0u8; 64 * 1024]);
    loop {
        let n = src.read(&mut buf).map_err(|e| format!("download interrotto: {e}"))?;
        if n == 0 {
            break;
        }
        if total == 0 && !buf.starts_with(b"MZ") {
            return Err("il file scaricato non e' un eseguibile".into());
        }
        hash.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        total += n as u64;
    }
    out.flush().map_err(|e| e.to_string())?;
    if total != rel.size {
        return Err(format!("download incompleto: {total} byte su {}", rel.size));
    }
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != want {
        return Err("SHA-256 diverso: file scaricato non integro".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(parse_version("v1.2.3"), Some([1, 2, 3]));
        assert_eq!(parse_version("0.10.0"), Some([0, 10, 0]));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("1.2.3-beta"), None);
        assert!(parse_version("0.10.0") > parse_version("0.9.9"));
    }

    #[test]
    fn side_names() {
        assert_eq!(side(Path::new("D:\\x\\cams.exe"), "new"), PathBuf::from("D:\\x\\cams.exe.new"));
    }
}
