//! Déploiement d'un modèle de l'Atelier ML sur un Raspberry Pi (ou tout hôte
//! SSH) et test à distance.
//!
//! Volontairement bâti sur les binaires `ssh` / `scp` du système, en mode
//! `BatchMode` : l'authentification est celle de l'utilisateur (clé, agent),
//! jamais un mot de passe saisi dans Lumen et rejoué en clair. Un hôte non
//! encore connu de `known_hosts` est accepté à la première connexion
//! (`accept-new`), puis épinglé.

use serde::Serialize;
use std::process::Command;
use std::time::Duration;

#[derive(Serialize)]
pub struct SshOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

fn valid_host(host: &str) -> Result<(), String> {
    let h = host.trim();
    if h.is_empty() || h.starts_with('-') || h.chars().any(|c| c.is_whitespace() || c == '@') {
        return Err("Adresse d'hôte invalide".into());
    }
    Ok(())
}

fn valid_user(user: &str) -> Result<(), String> {
    let u = user.trim();
    if u.is_empty() || u.starts_with('-') || u.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')) {
        return Err("Nom d'utilisateur invalide".into());
    }
    Ok(())
}

fn ssh_base_args(port: u16) -> Vec<String> {
    vec![
        "-o".into(), "BatchMode=yes".into(),
        "-o".into(), "ConnectTimeout=10".into(),
        "-o".into(), "StrictHostKeyChecking=accept-new".into(),
        "-p".into(), port.to_string(),
    ]
}

fn run(cmd: &mut Command) -> Result<SshOutput, String> {
    let out = cmd.output().map_err(|e| format!("{} introuvable : {e}", cmd.get_program().to_string_lossy()))?;
    Ok(SshOutput {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

/// Exécute une commande sur l'hôte et renvoie sa sortie.
#[tauri::command]
pub async fn pi_ssh_exec(host: String, user: String, port: Option<u16>, command: String) -> Result<SshOutput, String> {
    valid_host(&host)?;
    valid_user(&user)?;
    let port = port.unwrap_or(22);
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("ssh");
        cmd.args(ssh_base_args(port)).arg(format!("{}@{}", user.trim(), host.trim())).arg(command);
        run(&mut cmd)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copie des fichiers d'une sandbox vers `remote_dir` sur l'hôte (créé au besoin).
#[tauri::command]
pub async fn pi_scp_push(
    app: tauri::AppHandle,
    host: String,
    user: String,
    port: Option<u16>,
    sandbox: String,
    paths: Vec<String>,
    remote_dir: String,
) -> Result<SshOutput, String> {
    valid_host(&host)?;
    valid_user(&user)?;
    let remote_dir = remote_dir.trim().to_string();
    if remote_dir.is_empty() || remote_dir.contains(['\'', '"', ';', '&', '|', '$', '`', '\n']) {
        return Err("Dossier distant invalide".into());
    }
    let mut files = Vec::new();
    for p in &paths {
        files.push(crate::sandbox::sandbox_file_path(&app, &sandbox, p)?);
    }
    if files.is_empty() {
        return Err("Aucun fichier à déployer".into());
    }
    let port = port.unwrap_or(22);
    tauri::async_runtime::spawn_blocking(move || {
        let target = format!("{}@{}", user.trim(), host.trim());
        let mut mk = Command::new("ssh");
        mk.args(ssh_base_args(port)).arg(&target).arg(format!("mkdir -p '{}'", remote_dir));
        let made = run(&mut mk)?;
        if !made.ok {
            return Ok(made);
        }
        let mut scp = Command::new("scp");
        scp.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", "-P", &port.to_string()]);
        for f in &files {
            scp.arg(f);
        }
        scp.arg(format!("{target}:{remote_dir}/"));
        run(&mut scp)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// POST JSON vers un serveur d'inférence (le `pi_server.py` déployé) — la
/// WebView ne peut pas joindre un hôte du réseau local en HTTP clair.
#[tauri::command]
pub async fn pi_http_json(url: String, body: serde_json::Value, timeout_s: Option<u64>) -> Result<String, String> {
    let u = url.trim().to_string();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("URL invalide".into());
    }
    let timeout = Duration::from_secs(timeout_s.unwrap_or(120).clamp(5, 900));
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder().timeout(timeout).build().map_err(|e| e.to_string())?;
        let resp = client.post(&u).json(&body).send().map_err(|e| e.to_string())?;
        let status = resp.status();
        let text = resp.text().map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("HTTP {} : {}", status.as_u16(), text.chars().take(400).collect::<String>()));
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}
