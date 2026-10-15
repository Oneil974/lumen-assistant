//! Télémétrie machine du Profiler : mémoire vive réellement utilisée et poids
//! des processus qui servent les modèles (ollama, llama-server, Bonsai).
//!
//! `hardware.rs` ne donne que la RAM TOTALE, ce qui suffit à conseiller un
//! palier de modèle mais pas à répondre à la seule question qui compte quand on
//! optimise : « ce modèle, chargé avec ce contexte, tient-il encore ? ». On
//! mesure donc ici le libre/utilisé instantané et la résidence mémoire (RSS) de
//! chaque serveur d'inférence.
//!
//! Volontairement sans dépendance supplémentaire (même parti pris que
//! `hardware.rs`) : chaque plateforme expose déjà l'information par un appel
//! système simple.

use serde::Serialize;

#[derive(Serialize, Clone, Default)]
pub struct ProcessStat {
    pub pid: u32,
    /// Nom court du processus tel que rapporté par l'OS.
    pub name: String,
    /// Famille reconnue : "ollama" | "llama-server" | "bonsai".
    pub kind: String,
    /// Mémoire résidente en octets.
    pub rss: u64,
    /// Charge CPU instantanée en pourcentage (peut dépasser 100 % : multicœur).
    pub cpu: f64,
}

#[derive(Serialize, Clone, Default)]
pub struct SystemStats {
    pub total_memory: u64,
    /// Mémoire réellement disponible (0 si indéterminée).
    pub available_memory: u64,
    /// total - available (0 si `available_memory` est inconnue).
    pub used_memory: u64,
    pub cpu_count: u32,
    pub processes: Vec<ProcessStat>,
}

/// Famille de serveur d'inférence d'après le nom de processus, ou None quand
/// le processus ne nous concerne pas. Le filtrage est volontairement strict :
/// le Profiler n'a aucune raison de lister les autres programmes de la machine.
fn kind_for(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    let base = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
    let base = base.strip_suffix(".exe").unwrap_or(base);
    match base {
        "ollama" | "ollama_llama_server" | "ollama-runner" => Some("ollama"),
        "llama-server" | "llama_server" => Some("llama-server"),
        "bonsai" | "bonsai-server" => Some("bonsai"),
        _ => None,
    }
}

#[cfg(unix)]
fn processes() -> Vec<ProcessStat> {
    // `ps -Ao pid=,rss=,pcpu=,comm=` : rss en Ko, comm = chemin ou nom court.
    let output = std::process::Command::new("ps")
        .args(["-Ao", "pid=,rss=,pcpu=,comm="])
        .output();
    let Ok(output) = output else { return Vec::new() };
    let Ok(text) = String::from_utf8(output.stdout) else { return Vec::new() };
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid: u32 = parts.next()?.parse().ok()?;
            let rss_kb: u64 = parts.next()?.parse().ok()?;
            let cpu: f64 = parts.next()?.parse().unwrap_or(0.0);
            // `comm` peut contenir des espaces (chemin d'un bundle) : on reprend
            // tout le reste de la ligne plutôt que le seul premier mot.
            let comm = parts.collect::<Vec<_>>().join(" ");
            let kind = kind_for(&comm)?;
            let name = comm
                .rsplit('/')
                .next()
                .unwrap_or(&comm)
                .to_string();
            Some(ProcessStat { pid, name, kind: kind.into(), rss: rss_kb * 1024, cpu })
        })
        .collect()
}

#[cfg(windows)]
fn processes() -> Vec<ProcessStat> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // WorkingSet64 est l'équivalent Windows du RSS. Le CPU instantané n'est pas
    // exposé simplement par Get-Process : on le laisse à 0 plutôt que de
    // remonter le temps CPU cumulé, qui n'a pas le même sens.
    let script = "Get-Process | Where-Object { $_.ProcessName -match '^(ollama|llama-server|llama_server|bonsai)' } \
                  | ForEach-Object { \"$($_.Id);$($_.ProcessName);$($_.WorkingSet64)\" }";
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let Ok(output) = output else { return Vec::new() };
    let Ok(text) = String::from_utf8(output.stdout) else { return Vec::new() };
    text.lines()
        .filter_map(|line| {
            let mut parts = line.trim().split(';');
            let pid: u32 = parts.next()?.trim().parse().ok()?;
            let name = parts.next()?.trim().to_string();
            let rss: u64 = parts.next()?.trim().parse().ok()?;
            let kind = kind_for(&name)?;
            Some(ProcessStat { pid, name, kind: kind.into(), rss, cpu: 0.0 })
        })
        .collect()
}

#[cfg(not(any(unix, windows)))]
fn processes() -> Vec<ProcessStat> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn memory() -> (u64, u64) {
    let total: u64 = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    // `vm_stat` compte en pages. « Disponible » = libre + inactive + spéculative
    // + purgeable : c'est ce que macOS rendrait sous pression, et donc ce qui
    // reste réellement mobilisable pour charger un modèle.
    let Ok(output) = std::process::Command::new("vm_stat").output() else { return (total, 0) };
    let Ok(text) = String::from_utf8(output.stdout) else { return (total, 0) };
    let page_size = text
        .lines()
        .next()
        .and_then(|l| l.split("page size of ").nth(1))
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(4096);
    let pages = |label: &str| -> u64 {
        text.lines()
            .find(|l| l.trim_start().starts_with(label))
            .and_then(|l| l.split(':').nth(1))
            .map(|v| v.trim().trim_end_matches('.'))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0)
    };
    let available = (pages("Pages free")
        + pages("Pages inactive")
        + pages("Pages speculative")
        + pages("Pages purgeable"))
        * page_size;
    (total, available.min(total))
}

#[cfg(target_os = "linux")]
fn memory() -> (u64, u64) {
    let Ok(content) = std::fs::read_to_string("/proc/meminfo") else { return (0, 0) };
    let field = |label: &str| -> u64 {
        content
            .lines()
            .find(|l| l.starts_with(label))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|kb| kb.parse::<u64>().ok())
            .map(|kb| kb * 1024)
            .unwrap_or(0)
    };
    let total = field("MemTotal:");
    // MemAvailable tient compte du cache récupérable — bien plus juste que MemFree.
    let available = match field("MemAvailable:") {
        0 => field("MemFree:"),
        value => value,
    };
    (total, available.min(total))
}

#[cfg(target_os = "windows")]
fn memory() -> (u64, u64) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = "$os = Get-CimInstance Win32_OperatingSystem; \
                  \"$($os.TotalVisibleMemorySize);$($os.FreePhysicalMemory)\"";
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let Ok(output) = output else { return (0, 0) };
    let Ok(text) = String::from_utf8(output.stdout) else { return (0, 0) };
    let mut parts = text.trim().split(';');
    // Win32_OperatingSystem compte en kilooctets.
    let total = parts.next().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(0) * 1024;
    let available = parts.next().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(0) * 1024;
    (total, available.min(total))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn memory() -> (u64, u64) {
    (0, 0)
}

/// Instantané mémoire de la machine et des serveurs d'inférence. Appelé en
/// boucle par l'app Profiler ; volontairement bon marché (deux commandes
/// système), sans état conservé entre deux appels.
#[tauri::command]
pub async fn profiler_system_stats() -> Result<SystemStats, String> {
    // `ps`/`powershell` bloquent : jamais sur le fil asynchrone de Tauri.
    tauri::async_runtime::spawn_blocking(|| {
        let (total_memory, available_memory) = memory();
        SystemStats {
            total_memory,
            available_memory,
            used_memory: total_memory.saturating_sub(available_memory),
            cpu_count: std::thread::available_parallelism()
                .map(|n| n.get() as u32)
                .unwrap_or(0),
            processes: processes(),
        }
    })
    .await
    .map_err(|e| format!("Relevé système interrompu : {e}"))
}

#[cfg(test)]
mod tests {
    use super::kind_for;

    #[test]
    fn reconnait_les_serveurs_dinference() {
        assert_eq!(kind_for("ollama"), Some("ollama"));
        assert_eq!(kind_for("/opt/homebrew/bin/ollama"), Some("ollama"));
        assert_eq!(kind_for("llama-server.exe"), Some("llama-server"));
        assert_eq!(kind_for("Lumen"), None);
        // Un nom qui contient « ollama » sans être le serveur ne doit pas passer.
        assert_eq!(kind_for("ollama-notes"), None);
    }
}
