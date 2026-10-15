//! Synthèse vocale locale multiplateforme via **Piper**. Linux/Windows utilisent
//! le runtime historique MIT de `rhasspy/piper`; macOS utilise le runtime Piper
//! maintenu installé dans un venv isolé. Les voix viennent de
//! `rhasspy/piper-voices` (Hugging Face).
//!
//! Linux diffuse le WAV de Piper vers paplay/aplay/pw-play. macOS et Windows
//! synthétisent un fichier temporaire, lu respectivement par `afplay` et
//! `System.Media.SoundPlayer`. Voir `scripts/piper/` pour l'installation.
//!
//! Les fichiers de voix (`<id>.onnx` + `<id>.onnx.json`) sont stockés sous
//! `app_data_dir/piper-voices/`. La voix active est mémorisée dans `tts.json`.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Une voix du catalogue (sous-ensemble curé de `piper-voices`, licences permissives).
#[derive(Serialize, Clone)]
pub struct VoiceInfo {
    /// Identifiant = nom de fichier de base (ex. `fr_FR-siwis-medium`).
    pub id: String,
    pub label: String,
    pub lang: String,
    pub quality: String,
    pub size_mb: u32,
    pub license: String,
    /// Chemin relatif dans le dépôt HF (sans le nom de fichier).
    pub hf_path: String,
    pub installed: bool,
    /// Moteur de synthèse : "piper" ou "kokoro".
    pub engine: String,
}

/// Entrée brute du catalogue : (id, label, lang, quality, size_mb, license, hf_path).
const CATALOG: &[(&str, &str, &str, &str, u32, &str, &str)] = &[
    (
        "fr_FR-siwis-medium",
        "Siwis (français, féminine)",
        "fr_FR",
        "medium",
        60,
        "CC BY 4.0",
        "fr/fr_FR/siwis/medium",
    ),
    (
        "fr_FR-siwis-low",
        "Siwis (français, féminine, légère)",
        "fr_FR",
        "low",
        20,
        "CC BY 4.0",
        "fr/fr_FR/siwis/low",
    ),
    (
        "fr_FR-tom-medium",
        "Tom (français, masculine)",
        "fr_FR",
        "medium",
        60,
        "AGPLv3",
        "fr/fr_FR/tom/medium",
    ),
    (
        "fr_FR-upmc-medium",
        "UPMC (français, multi-voix)",
        "fr_FR",
        "medium",
        60,
        "CC BY 4.0",
        "fr/fr_FR/upmc/medium",
    ),
    (
        "fr_FR-mls-medium",
        "MLS (français)",
        "fr_FR",
        "medium",
        60,
        "CC BY 4.0",
        "fr/fr_FR/mls/medium",
    ),
    (
        "en_US-amy-medium",
        "Amy (anglais US, féminine)",
        "en_US",
        "medium",
        60,
        "CC BY 4.0",
        "en/en_US/amy/medium",
    ),
    (
        "en_GB-alba-medium",
        "Alba (anglais GB, féminine)",
        "en_GB",
        "medium",
        60,
        "CC BY 4.0",
        "en/en_GB/alba/medium",
    ),
];

const HF_BASE: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

// ===================== Kokoro (TTS neuronal, Apache 2.0) =====================
//
// Kokoro-82M est un TTS multilingue de haute qualité exécuté en ONNX (CPU, donc
// adapté au Raspberry Pi). Contrairement à Piper, un SEUL modèle (`model.onnx`)
// + un fichier d'embeddings (`voices.bin`) contiennent toutes les voix : choisir
// une voix = passer son nom (ex. `ff_siwis`) à l'inférence. On encode le moteur
// dans l'id (`kokoro:<voix>`) pour ne pas changer la surface des commandes.
//
// Inférence : un petit script Python (`kokoro_tts.py`, écrit à la volée depuis la
// ressource embarquée) lit le texte sur stdin, produit un WAV sur stdout que l'on
// redirige vers `aplay`. Dépendances Python via scripts/kokoro/install.sh.

const KOKORO_PREFIX: &str = "kokoro:";
const KOKORO_MODEL_URL: &str = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx";
const KOKORO_VOICES_URL: &str = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";
// Script du démon Kokoro résident, écrit à la volée dans kokoro_dir au 1er play.
// (Le one-shot scripts/kokoro/kokoro_tts.py reste pour le debug via test.sh.)
const KOKORO_DAEMON_SCRIPT: &str = include_str!("../../scripts/kokoro/kokoro_daemon.py");

/// Voix Kokoro proposées : (voix, label, lang). Le poids (~340 Mo) est partagé.
const KOKORO_CATALOG: &[(&str, &str, &str)] = &[
    ("ff_siwis", "Siwis (français, féminine) — Kokoro", "fr_FR"),
    ("af_heart", "Heart (anglais US, féminine) — Kokoro", "en_US"),
    (
        "am_michael",
        "Michael (anglais US, masculine) — Kokoro",
        "en_US",
    ),
    ("bf_emma", "Emma (anglais GB, féminine) — Kokoro", "en_GB"),
    (
        "bm_george",
        "George (anglais GB, masculine) — Kokoro",
        "en_GB",
    ),
];

fn kokoro_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path())
        .map_err(|e| e.to_string())?
        .join("kokoro");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
fn kokoro_model(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(kokoro_dir(app)?.join("model.onnx"))
}
fn kokoro_voices_bin(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(kokoro_dir(app)?.join("voices.bin"))
}
/// Le moteur Kokoro est-il prêt (modèle + embeddings présents) ?
fn kokoro_ready(app: &tauri::AppHandle) -> bool {
    matches!((kokoro_model(app), kokoro_voices_bin(app)), (Ok(m), Ok(v)) if m.exists() && v.exists())
}
/// Interpréteur Python à utiliser (venv dédié en priorité).
fn kokoro_python() -> String {
    for cand in [
        "/opt/kokoro-venv/bin/python3",
        "/opt/kokoro-venv/bin/python",
    ] {
        if std::path::Path::new(cand).exists() {
            return cand.to_string();
        }
    }
    "python3".to_string()
}
/// Liste des ids de voix Kokoro (préfixés) du catalogue.
fn kokoro_catalog_ids() -> Vec<String> {
    KOKORO_CATALOG
        .iter()
        .map(|(v, ..)| format!("{KOKORO_PREFIX}{v}"))
        .collect()
}

/// État runtime : process d'énonciation en cours (pour pouvoir l'arrêter) + le
/// démon Kokoro résident (modèle chargé une fois, réutilisé à chaque play).
#[derive(Default)]
pub struct TtsState {
    pub current: Mutex<Vec<Child>>,
    pub kokoro: Mutex<Option<KokoroDaemon>>,
}

/// Démon Kokoro maintenu en vie : on lui écrit une requête JSON par ligne et il
/// répond `OK` / `ERR …` après avoir écrit le WAV. Le modèle reste en mémoire.
pub struct KokoroDaemon {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl KokoroDaemon {
    fn spawn(py: &str, script: &Path, model: &Path, voices: &Path) -> Result<Self, String> {
        // Limite les threads d'inférence pour laisser du CPU à l'UI (sinon la
        // synthèse sature les cœurs et fige l'app sur Pi). On garde ~2 cœurs libres.
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .saturating_sub(2)
            .max(1);
        let mut cmd = Command::new(py);
        cmd.arg(script)
            .args(["--model", &model.to_string_lossy()])
            .args(["--voices", &voices.to_string_lossy()])
            .args(["--threads", &threads.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // stderr hérité : warnings/traceback Python visibles dans le terminal
            // (et pas d'EPIPE qui tuerait le démon quand onnxruntime journalise).
            .stderr(Stdio::inherit());
        scrub_appimage_env(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| {
            format!("Démon Kokoro introuvable ({e}). Installe : scripts/kokoro/install.sh")
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or("stdin démon Kokoro indisponible")?;
        let mut stdout = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("stdout démon Kokoro indisponible")?,
        );
        // Attend le marqueur READY = modèle chargé (peut prendre quelques secondes).
        let mut line = String::new();
        loop {
            line.clear();
            let n = stdout.read_line(&mut line).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("démon Kokoro terminé avant d'être prêt (voir la sortie du terminal : dépendances Python ?)".into());
            }
            if line.trim() == "READY" {
                break;
            }
        }
        Ok(Self {
            child,
            stdin,
            stdout,
        })
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Demande une synthèse ; le WAV est écrit dans `out`. Bloque le temps de la
    /// synthèse (rapide, modèle déjà chargé).
    fn synth(&mut self, text: &str, voice: &str, out: &Path) -> Result<(), String> {
        let req = serde_json::json!({ "text": text, "voice": voice, "out": out.to_string_lossy() });
        writeln!(self.stdin, "{req}").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        let n = self
            .stdout
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("démon Kokoro : connexion perdue".into());
        }
        let line = line.trim();
        if line == "OK" {
            Ok(())
        } else if let Some(msg) = line.strip_prefix("ERR ") {
            Err(format!("Kokoro : {msg}"))
        } else {
            Err(format!("Kokoro : réponse inattendue « {line} »"))
        }
    }
}

fn voices_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path())
        .map_err(|e| e.to_string())?
        .join("piper-voices");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn tts_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::shared_data_dir(app.path())
        .map_err(|e| e.to_string())?
        .join("tts.json"))
}

#[derive(Serialize, Deserialize, Default)]
struct TtsConfig {
    voice: String,
    /// Réglages Piper PAR VOIX (l'identifiant de locuteur n'a de sens que pour
    /// un modèle donné, et un débit agréable dépend de la voix).
    #[serde(default)]
    tuning: std::collections::HashMap<String, PiperTuning>,
}

/// Réglages de synthèse Piper exposés à l'utilisateur, façon « personnaliser
/// la voix » (débit, expressivité, variation, pauses, locuteur).
///
/// Les plages sont volontairement ÉTROITES : au-delà, Piper produit des
/// artefacts (voix qui bégaie, souffle, phonèmes avalés). `clamped()` est
/// appliqué à l'écriture ET à la lecture, pour qu'un fichier édité à la main
/// ne puisse pas non plus pousser le moteur hors de sa zone de confort.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct PiperTuning {
    /// Durée des phonèmes : < 1 plus rapide, > 1 plus lent. Défaut Piper : 1.0.
    #[serde(default = "default_length_scale")]
    pub length_scale: f32,
    /// Bruit du générateur : expressivité/intonation. Défaut Piper : 0.667.
    #[serde(default = "default_noise_scale")]
    pub noise_scale: f32,
    /// Bruit de durée des phonèmes : variation du rythme. Défaut Piper : 0.8.
    #[serde(default = "default_noise_w")]
    pub noise_w: f32,
    /// Silence après chaque phrase, en secondes. Défaut Piper : 0.2.
    #[serde(default = "default_sentence_silence")]
    pub sentence_silence: f32,
    /// Locuteur, pour les modèles multi-locuteurs seulement.
    #[serde(default)]
    pub speaker: Option<u32>,
}

fn default_length_scale() -> f32 { 1.0 }
fn default_noise_scale() -> f32 { 0.667 }
fn default_noise_w() -> f32 { 0.8 }
fn default_sentence_silence() -> f32 { 0.2 }

/// Bornes fonctionnelles, partagées avec le frontend via `tts_tuning_limits`.
pub const LENGTH_SCALE_RANGE: (f32, f32) = (0.7, 1.4);
pub const NOISE_SCALE_RANGE: (f32, f32) = (0.3, 1.0);
pub const NOISE_W_RANGE: (f32, f32) = (0.4, 1.0);
pub const SENTENCE_SILENCE_RANGE: (f32, f32) = (0.0, 0.6);

impl Default for PiperTuning {
    fn default() -> Self {
        Self {
            length_scale: default_length_scale(),
            noise_scale: default_noise_scale(),
            noise_w: default_noise_w(),
            sentence_silence: default_sentence_silence(),
            speaker: None,
        }
    }
}

impl PiperTuning {
    fn clamp_or(v: f32, range: (f32, f32), fallback: f32) -> f32 {
        if v.is_finite() { v.clamp(range.0, range.1) } else { fallback }
    }
    pub fn clamped(self) -> Self {
        Self {
            length_scale: Self::clamp_or(self.length_scale, LENGTH_SCALE_RANGE, default_length_scale()),
            noise_scale: Self::clamp_or(self.noise_scale, NOISE_SCALE_RANGE, default_noise_scale()),
            noise_w: Self::clamp_or(self.noise_w, NOISE_W_RANGE, default_noise_w()),
            sentence_silence: Self::clamp_or(self.sentence_silence, SENTENCE_SILENCE_RANGE, default_sentence_silence()),
            speaker: self.speaker,
        }
    }
    fn is_default(&self) -> bool { *self == Self::default() }
    /// Arguments Piper. Les formes à tiret bas sont acceptées à la fois par le
    /// binaire C++ (Linux/Windows) et par le paquet `piper-tts` (macOS).
    fn args(&self) -> Vec<String> {
        let t = self.clamped();
        let mut out = vec![
            "--length_scale".into(), format!("{:.3}", t.length_scale),
            "--noise_scale".into(), format!("{:.3}", t.noise_scale),
            "--noise_w".into(), format!("{:.3}", t.noise_w),
            "--sentence_silence".into(), format!("{:.2}", t.sentence_silence),
        ];
        if let Some(id) = t.speaker {
            out.push("--speaker".into());
            out.push(id.to_string());
        }
        out
    }
}

fn read_tts_config(app: &tauri::AppHandle) -> TtsConfig {
    tts_config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<TtsConfig>(&s).ok())
        .unwrap_or_default()
}

fn write_tts_config(app: &tauri::AppHandle, cfg: &TtsConfig) -> Result<(), String> {
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(tts_config_path(app)?, s).map_err(|e| e.to_string())
}

fn read_active_voice(app: &tauri::AppHandle) -> String {
    read_tts_config(app).voice
}

/// Réglages effectifs d'une voix Piper (bornés), avec le locuteur validé
/// contre le modèle : un identifiant hors plage ferait planter Piper.
fn piper_tuning_for(app: &tauri::AppHandle, voice: &str) -> PiperTuning {
    let mut t = read_tts_config(app)
        .tuning
        .get(voice)
        .copied()
        .unwrap_or_default()
        .clamped();
    if let Some(id) = t.speaker {
        let n = voice_speakers(app, voice).map(|v| v.len()).unwrap_or(0);
        if n <= 1 || id as usize >= n {
            t.speaker = None;
        }
    }
    t
}

/// Locuteurs d'un modèle Piper, lus dans son `.onnx.json` (`speaker_id_map`).
/// Vide pour un modèle mono-locuteur.
fn voice_speakers(app: &tauri::AppHandle, voice: &str) -> Result<Vec<SpeakerInfo>, String> {
    let cfg_path = model_path(app, voice)?.with_extension("onnx.json");
    let raw = std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let n = json.get("num_speakers").and_then(|v| v.as_u64()).unwrap_or(1);
    if n <= 1 {
        return Ok(Vec::new());
    }
    let mut out: Vec<SpeakerInfo> = json
        .get("speaker_id_map")
        .and_then(|m| m.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(name, id)| id.as_u64().map(|id| SpeakerInfo { id: id as u32, name: name.clone() }))
                .collect()
        })
        .unwrap_or_default();
    if out.is_empty() {
        out = (0..n as u32).map(|id| SpeakerInfo { id, name: format!("#{id}") }).collect();
    }
    out.sort_by_key(|s| s.id);
    Ok(out)
}

#[derive(Serialize, Clone)]
pub struct SpeakerInfo {
    pub id: u32,
    pub name: String,
}

#[derive(Serialize)]
pub struct TuningLimits {
    pub length_scale: (f32, f32),
    pub noise_scale: (f32, f32),
    pub noise_w: (f32, f32),
    pub sentence_silence: (f32, f32),
    pub defaults: PiperTuning,
}

fn model_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    // `id` est un nom de base simple : on rejette tout séparateur de chemin.
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("Identifiant de voix invalide".into());
    }
    Ok(voices_dir(app)?.join(format!("{id}.onnx")))
}

fn voice_is_installed(app: &tauri::AppHandle, voice: &str) -> bool {
    if let Some(kokoro_voice) = voice.strip_prefix(KOKORO_PREFIX) {
        return KOKORO_CATALOG.iter().any(|(id, ..)| *id == kokoro_voice) && kokoro_ready(app);
    }
    model_path(app, voice)
        .is_ok_and(|path| path.is_file() && path.with_extension("onnx.json").is_file())
}

/// Remplace automatiquement une ancienne sélection dont les fichiers ne sont
/// plus installés. Le choix corrigé est persisté pour les lectures suivantes.
fn resolved_active_voice(app: &tauri::AppHandle) -> String {
    let configured = read_active_voice(app);
    if voice_is_installed(app, &configured) {
        return configured;
    }
    let fallback = CATALOG
        .iter()
        .map(|(id, ..)| *id)
        .find(|id| voice_is_installed(app, id))
        .map(str::to_string)
        .or_else(|| {
            kokoro_catalog_ids()
                .into_iter()
                .find(|id| voice_is_installed(app, id))
        })
        .unwrap_or_default();
    if fallback != configured {
        let _ = tts_set_voice(app.clone(), fallback.clone());
    }
    fallback
}

// ===================== Commandes Tauri =====================

/// Catalogue de voix (avec drapeau « installée »).
#[tauri::command]
pub fn tts_catalog(app: tauri::AppHandle) -> Vec<VoiceInfo> {
    let dir = voices_dir(&app).ok();
    let mut out: Vec<VoiceInfo> = CATALOG
        .iter()
        .map(|(id, label, lang, quality, size, license, hf)| {
            let installed = dir
                .as_ref()
                .map(|d| d.join(format!("{id}.onnx")).exists())
                .unwrap_or(false);
            VoiceInfo {
                id: (*id).into(),
                label: (*label).into(),
                lang: (*lang).into(),
                quality: (*quality).into(),
                size_mb: *size,
                license: (*license).into(),
                hf_path: (*hf).into(),
                installed,
                engine: "piper".into(),
            }
        })
        .collect();
    // Voix Kokoro : toutes « installées » dès que le modèle partagé est présent.
    let ready = kokoro_ready(&app);
    for (v, label, lang) in KOKORO_CATALOG {
        out.push(VoiceInfo {
            id: format!("{KOKORO_PREFIX}{v}"),
            label: (*label).into(),
            lang: (*lang).into(),
            quality: "kokoro".into(),
            size_mb: 340,
            license: "Apache 2.0".into(),
            hf_path: String::new(),
            installed: ready,
            engine: "kokoro".into(),
        });
    }
    out
}

/// Voix actuellement installées (ids).
#[tauri::command]
pub fn tts_installed(app: tauri::AppHandle) -> Vec<String> {
    let mut out = vec![];
    if let Ok(dir) = voices_dir(&app) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if let Some(base) = name.strip_suffix(".onnx") {
                    out.push(base.to_string());
                }
            }
        }
    }
    // Voix Kokoro disponibles si le modèle partagé est installé.
    if kokoro_ready(&app) {
        out.extend(kokoro_catalog_ids());
    }
    out.sort();
    out
}

/// Voix active mémorisée.
#[tauri::command]
pub fn tts_active_voice(app: tauri::AppHandle) -> String {
    resolved_active_voice(&app)
}

/// Définit la voix active (mémorisée dans tts.json).
#[tauri::command]
pub fn tts_set_voice(app: tauri::AppHandle, voice: String) -> Result<(), String> {
    // Changer de voix ne doit pas effacer les réglages faits sur les autres.
    let mut cfg = read_tts_config(&app);
    cfg.voice = voice;
    write_tts_config(&app, &cfg)
}

/// Réglages Piper de la voix donnée (ou de la voix active). Toujours bornés.
#[tauri::command]
pub fn tts_get_tuning(app: tauri::AppHandle, voice: Option<String>) -> PiperTuning {
    let voice = voice.filter(|v| !v.is_empty()).unwrap_or_else(|| resolved_active_voice(&app));
    piper_tuning_for(&app, &voice)
}

/// Enregistre les réglages Piper d'une voix, après bornage. Les valeurs par
/// défaut ne sont pas écrites : « revenir au défaut » = supprimer l'entrée.
#[tauri::command]
pub fn tts_set_tuning(app: tauri::AppHandle, voice: Option<String>, tuning: PiperTuning) -> Result<PiperTuning, String> {
    let voice = voice.filter(|v| !v.is_empty()).unwrap_or_else(|| resolved_active_voice(&app));
    if voice.is_empty() {
        return Err("Aucune voix active.".into());
    }
    let t = tuning.clamped();
    let mut cfg = read_tts_config(&app);
    if t.is_default() {
        cfg.tuning.remove(&voice);
    } else {
        cfg.tuning.insert(voice.clone(), t);
    }
    write_tts_config(&app, &cfg)?;
    Ok(piper_tuning_for(&app, &voice))
}

/// Bornes et défauts, pour que les curseurs du frontend ne puissent pas
/// proposer une valeur que le backend refuserait.
#[tauri::command]
pub fn tts_tuning_limits() -> TuningLimits {
    TuningLimits {
        length_scale: LENGTH_SCALE_RANGE,
        noise_scale: NOISE_SCALE_RANGE,
        noise_w: NOISE_W_RANGE,
        sentence_silence: SENTENCE_SILENCE_RANGE,
        defaults: PiperTuning::default(),
    }
}

/// Locuteurs d'une voix Piper installée (vide si mono-locuteur ou Kokoro).
#[tauri::command]
pub fn tts_voice_speakers(app: tauri::AppHandle, voice: String) -> Vec<SpeakerInfo> {
    if voice.starts_with(KOKORO_PREFIX) {
        return Vec::new();
    }
    voice_speakers(&app, &voice).unwrap_or_default()
}

/// Télécharge une voix du catalogue (fichiers `.onnx` + `.onnx.json`). Bloquant
/// (réseau) : exécuté hors thread principal.
#[tauri::command]
pub async fn tts_download_voice(app: tauri::AppHandle, id: String) -> Result<(), String> {
    // Voix Kokoro : on télécharge (une fois) le modèle partagé + les embeddings.
    if let Some(voice) = id.strip_prefix(KOKORO_PREFIX) {
        if !KOKORO_CATALOG.iter().any(|(v, ..)| *v == voice) {
            return Err("Voix Kokoro inconnue".into());
        }
        let model = kokoro_model(&app)?;
        let voices = kokoro_voices_bin(&app)?;
        if !(model.exists() && voices.exists()) {
            tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
                let client = reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_secs(1800))
                    .build()
                    .map_err(|e| e.to_string())?;
                for (url, dest) in [(KOKORO_MODEL_URL, &model), (KOKORO_VOICES_URL, &voices)] {
                    if dest.exists() {
                        continue;
                    }
                    let resp = client
                        .get(url)
                        .send()
                        .and_then(|r| r.error_for_status())
                        .map_err(|e| format!("Téléchargement Kokoro échoué : {e}"))?;
                    let bytes = resp.bytes().map_err(|e| e.to_string())?;
                    std::fs::write(dest, &bytes).map_err(|e| e.to_string())?;
                }
                Ok(())
            })
            .await
            .map_err(|e| e.to_string())??;
        }
        if resolved_active_voice(&app).is_empty() {
            let _ = tts_set_voice(app.clone(), id.clone());
        }
        return Ok(());
    }
    let entry = CATALOG
        .iter()
        .find(|(vid, ..)| *vid == id)
        .ok_or_else(|| "Voix inconnue".to_string())?;
    let hf = entry.6.to_string();
    let dir = voices_dir(&app)?;
    let id2 = id.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| e.to_string())?;
        for ext in ["onnx", "onnx.json"] {
            let url = format!("{HF_BASE}/{hf}/{id2}.{ext}?download=true");
            let resp = client
                .get(&url)
                .send()
                .and_then(|r| r.error_for_status())
                .map_err(|e| format!("Téléchargement échoué ({ext}) : {e}"))?;
            let bytes = resp.bytes().map_err(|e| e.to_string())?;
            std::fs::write(dir.join(format!("{id2}.{ext}")), &bytes).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    // Première voix installée ⇒ devient active par défaut.
    if resolved_active_voice(&app).is_empty() {
        let _ = tts_set_voice(app.clone(), id.clone());
    }
    Ok(())
}

/// Supprime une voix installée.
#[tauri::command]
pub fn tts_delete_voice(app: tauri::AppHandle, id: String) -> Result<(), String> {
    // Une voix Kokoro partage le modèle commun : le supprimer désinstalle toutes
    // les voix Kokoro d'un coup.
    if id.starts_with(KOKORO_PREFIX) {
        let _ = std::fs::remove_file(kokoro_model(&app)?);
        let _ = std::fs::remove_file(kokoro_voices_bin(&app)?);
        return Ok(());
    }
    let onnx = model_path(&app, &id)?;
    let _ = std::fs::remove_file(&onnx);
    let _ = std::fs::remove_file(onnx.with_extension("onnx.json"));
    Ok(())
}

/// Énonce un texte avec Piper (voix donnée, sinon voix active). Coupe d'abord toute
/// énonciation en cours. Renvoie quand la lecture est lancée (non bloquant).
#[tauri::command]
pub fn tts_speak(
    app: tauri::AppHandle,
    _state: tauri::State<'_, TtsState>,
    text: String,
    voice: Option<String>,
) -> Result<(), String> {
    tts_speak_workflow(app, text, voice)
}

/// Même point d'entrée pour les workflows Fluxo exécutés côté hôte.
pub fn tts_speak_workflow(
    app: tauri::AppHandle,
    text: String,
    voice: Option<String>,
) -> Result<(), String> {
    let text = fluxo_engine::actions::strip_markdown_for_speech(&text).trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    let voice = voice
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| resolved_active_voice(&app));
    if voice.is_empty() {
        return Err("Aucune voix sélectionnée : télécharge une voix dans les réglages.".into());
    }
    // Validation rapide (erreur immédiate à l'UI) avant de partir en thread.
    if voice.starts_with(KOKORO_PREFIX) {
        if !kokoro_ready(&app) {
            return Err(
                "Modèle Kokoro non installé : télécharge une voix Kokoro dans les réglages.".into(),
            );
        }
    } else {
        if !model_path(&app, &voice)?.exists() {
            return Err(format!("Voix « {voice} » non installée."));
        }
        if piper_executable().is_none() {
            return Err(
                "Piper introuvable. Lance le script scripts/piper/install.sh (macOS/Linux) ou install-windows.ps1 (Windows)."
                    .into(),
            );
        }
    }

    // Synthèse + lecture (bloquantes) exécutées HORS du thread principal : sinon
    // la commande synchrone gèlerait l'UI (et la saturation CPU figerait le Pi).
    // « tts-ended » est émis à la fin → le front anime l'orbe pendant la lecture.
    let worker = app.clone();
    std::thread::spawn(move || {
        let state = worker.state::<TtsState>();
        let res = if let Some(kvoice) = voice.strip_prefix(KOKORO_PREFIX) {
            kokoro_speak(&worker, &state, &text, kvoice)
        } else {
            piper_speak(&worker, &state, &text, &voice)
        };
        if let Err(e) = res {
            eprintln!("TTS: {e}");
            let _ = worker.emit("tts-error", e);
        }
        let _ = worker.emit("tts-ended", ());
    });
    Ok(())
}

/// Indique au frontend si le moteur Piper historique est réellement accessible.
/// Les apps macOS lancées depuis Finder n'héritent généralement pas du PATH du
/// shell, d'où la recherche supplémentaire dans les emplacements d'installation
/// utilisés par les scripts Lumen.
#[tauri::command]
pub fn tts_runtime_available(app: tauri::AppHandle) -> bool {
    let voice = resolved_active_voice(&app);
    if voice.starts_with(KOKORO_PREFIX) {
        kokoro_ready(&app)
    } else {
        !voice.is_empty() && piper_executable().is_some()
    }
}

/// État du moteur vocal, pour que l'interface dise la vérité à l'utilisateur au
/// lieu d'échouer silencieusement au moment de parler.
///
/// `installable` distingue les plateformes où Lumen peut installer le moteur
/// lui-même (macOS, via le runtime Python `piper-tts`) de celles où il est déjà
/// livré dans le bundle (Linux, Windows).
#[derive(Serialize)]
pub struct TtsEngineStatus {
    pub engine_ready: bool,
    pub bundled: bool,
    pub installable: bool,
    pub voices_installed: usize,
    /// Voix système utilisable en attendant (toujours vrai : Web Speech / `say`).
    pub system_voice_fallback: bool,
}

#[tauri::command]
pub fn tts_engine_status(app: tauri::AppHandle) -> TtsEngineStatus {
    let bundled = bundled_piper().is_some();
    TtsEngineStatus {
        engine_ready: piper_executable().is_some(),
        bundled,
        installable: cfg!(target_os = "macos") && !bundled,
        voices_installed: tts_installed(app).len(),
        system_voice_fallback: true,
    }
}

/// Installe le moteur vocal quand il n'est pas livré avec l'application (macOS).
///
/// Reprend ce que faisait `scripts/piper/install.sh` — un venv isolé contenant
/// `piper-tts` — mais piloté depuis l'interface : l'utilisateur n'ouvre jamais de
/// terminal. La progression est diffusée via l'évènement `tts-install-progress`.
#[tauri::command]
pub async fn tts_install_runtime(app: tauri::AppHandle) -> Result<(), String> {
    if bundled_piper().is_some() {
        return Ok(()); // déjà livré avec Lumen
    }
    if !cfg!(target_os = "macos") {
        return Err("Le moteur vocal est fourni avec Lumen sur cette plateforme.".into());
    }
    let runtime = crate::paths::shared_data_dir(app.path())
        .map_err(|e| e.to_string())?
        .join("piper-runtime");
    let emit = |app: &tauri::AppHandle, step: &str| {
        let _ = app.emit("tts-install-progress", serde_json::json!({ "step": step }));
    };

    let app_task = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let python = ["python3", "/usr/bin/python3"]
            .into_iter()
            .find(|candidate| {
                Command::new(candidate)
                    .arg("--version")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            })
            .ok_or("Python 3 est requis pour installer le moteur vocal sur macOS.")?;

        emit(&app_task, "venv");
        let _ = std::fs::remove_dir_all(&runtime);
        let status = Command::new(python)
            .arg("-m")
            .arg("venv")
            .arg(&runtime)
            .status()
            .map_err(|e| format!("Création de l'environnement impossible : {e}"))?;
        if !status.success() {
            return Err("Création de l'environnement Python échouée.".into());
        }

        emit(&app_task, "download");
        let status = Command::new(runtime.join("bin/python"))
            .args(["-m", "pip", "install", "--disable-pip-version-check", "piper-tts"])
            .env("PIP_NO_CACHE_DIR", "1")
            .status()
            .map_err(|e| format!("Installation de piper-tts impossible : {e}"))?;
        if !status.success() {
            return Err("Installation de piper-tts échouée (connexion réseau ?).".into());
        }

        emit(&app_task, "verify");
        let ok = Command::new(runtime.join("bin/piper"))
            .arg("--help")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Err("Le moteur vocal s'est installé mais ne répond pas.".into());
        }
        emit(&app_task, "done");
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Synthétise un texte en WAV et l'écrit directement dans une sandbox.
#[tauri::command]
pub fn tts_export_wav(
    app: tauri::AppHandle,
    state: tauri::State<'_, TtsState>,
    text: String,
    voice: Option<String>,
    sandbox_id: String,
    path: String,
) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Texte vide.".into());
    }
    let voice = voice
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| resolved_active_voice(&app));
    if voice.is_empty() {
        return Err("Aucune voix sélectionnée : télécharge une voix dans les réglages.".into());
    }

    let tmp = crate::paths::shared_cache_dir(app.path())
        .map_err(|e| e.to_string())?
        .join("tts-export");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out = tmp.join(format!("tts-{stamp}-{:?}.wav", std::thread::current().id()));

    if let Some(kvoice) = voice.strip_prefix(KOKORO_PREFIX) {
        kokoro_synth_file(&app, &state, &text, kvoice, &out)?;
    } else {
        piper_synth_file(&app, &text, &voice, &out)?;
    }

    let bytes = std::fs::read(&out).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out);
    crate::sandbox::sandbox_write_binary(app, sandbox_id, path.clone(), bytes)?;
    Ok(path)
}

/// Synthétise un texte et renvoie le WAV en Base64 (Lumen XR : le casque
/// joue la voix de Lumen elle-même, le navigateur du Quest n'ayant pas de
/// synthèse vocale fiable). Asynchrone : la synthèse ne doit pas geler l'UI.
#[tauri::command]
pub async fn tts_synth_b64(
    app: tauri::AppHandle,
    text: String,
    voice: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
    tauri::async_runtime::spawn_blocking(move || {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("Texte vide.".to_string());
        }
        let voice = voice
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| resolved_active_voice(&app));
        if voice.is_empty() {
            return Err("Aucune voix installée.".into());
        }
        let tmp = crate::paths::shared_cache_dir(app.path())
            .map_err(|e| e.to_string())?
            .join("tts-export");
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let out = tmp.join(format!("xr-{stamp}.wav"));
        if let Some(kvoice) = voice.strip_prefix(KOKORO_PREFIX) {
            let state = app.state::<TtsState>();
            kokoro_synth_file(&app, &state, &text, kvoice, &out)?;
        } else {
            piper_synth_file(&app, &text, &voice, &out)?;
        }
        let bytes = std::fs::read(&out).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&out);
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Termine proprement un WAV PCM signé 16 bits par une rampe vers zéro,
/// puis 100 ms de silence. Le DAC du Fire ne s'arrête ainsi jamais sur un
/// échantillon non neutre, ce qui évite le gros clic/grésillement de fin.
#[cfg(target_os = "macos")]
fn soften_s16_wav_end(path: &Path) -> Result<(), String> {
    let mut wav = std::fs::read(path).map_err(|e| format!("lecture WAV: {e}"))?;
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err("WAV TTS invalide".into());
    }
    let mut pos = 12usize;
    let mut data_chunk = None;
    while pos + 8 <= wav.len() {
        let size = u32::from_le_bytes(wav[pos + 4..pos + 8].try_into().unwrap()) as usize;
        if &wav[pos..pos + 4] == b"data" {
            data_chunk = Some((pos, size));
            break;
        }
        pos = pos.saturating_add(8 + size + (size & 1));
    }
    let (chunk_pos, old_size) = data_chunk.ok_or("bloc data WAV absent")?;
    let data_end = chunk_pos + 8 + old_size;
    if old_size < 2 || data_end > wav.len() || old_size & 1 != 0 {
        return Err("taille data WAV invalide".into());
    }

    let start = i16::from_le_bytes([wav[data_end - 2], wav[data_end - 1]]) as i32;
    let ramp_len = 320usize; // 20 ms à 16 kHz
    let silence_len = 1600usize; // 100 ms à 16 kHz
    let mut tail = Vec::with_capacity((ramp_len + silence_len) * 2);
    for i in 1..=ramp_len {
        let value = start - (start * i as i32 / ramp_len as i32);
        tail.extend_from_slice(&(value as i16).to_le_bytes());
    }
    tail.resize((ramp_len + silence_len) * 2, 0);
    wav.splice(data_end..data_end, tail);

    let new_size = old_size + (ramp_len + silence_len) * 2;
    wav[chunk_pos + 4..chunk_pos + 8].copy_from_slice(&(new_size as u32).to_le_bytes());
    let riff_size = (wav.len() - 8) as u32;
    wav[4..8].copy_from_slice(&riff_size.to_le_bytes());
    std::fs::write(path, wav).map_err(|e| format!("écriture WAV: {e}"))
}

/// Synthétise une réponse du chat et l'envoie directement à l'orbe M5.
#[tauri::command]
pub async fn tts_send_to_orb(
    app: tauri::AppHandle,
    state: tauri::State<'_, TtsState>,
    text: String,
    voice: Option<String>,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    let _ = &state;
    #[cfg(target_os = "macos")]
    {
        let tmp = crate::paths::shared_cache_dir(app.path())
            .map_err(|e| e.to_string())?
            .join("tts-export");
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let aiff = tmp.join(format!("orb-{stamp}.aiff"));
        let wav = tmp.join(format!("orb-{stamp}.wav"));
        let mut say = Command::new("say");
        say.args(["-o", aiff.to_str().ok_or("chemin audio invalide")?, &text]);
        if let Some(v) = voice.as_deref().filter(|v| !v.is_empty()) {
            say.args(["-v", v]);
        }
        let status = say.status().map_err(|e| format!("say: {e}"))?;
        if !status.success() {
            return Err("say a échoué".into());
        }
        let status = Command::new("afconvert")
            .args([
                aiff.to_str().unwrap(),
                wav.to_str().unwrap(),
                "-f",
                "WAVE",
                "-d",
                "LEI16@16000",
                "-c",
                "1",
            ])
            .status()
            .map_err(|e| format!("afconvert: {e}"))?;
        let _ = std::fs::remove_file(&aiff);
        if !status.success() {
            return Err("afconvert a échoué".into());
        }
        soften_s16_wav_end(&wav)?;
        // Audio: vers l'orbe uniquement, le contrôleur n'a pas de haut-parleur.
        let result =
            crate::orb_bridge::orb_send_wav(wav.to_string_lossy().to_string(), None).await;
        let _ = std::fs::remove_file(&wav);
        return result;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let voice = voice
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| resolved_active_voice(&app));
        if voice.is_empty() {
            return Err("Aucune voix TTS sélectionnée".into());
        }
        let tmp = crate::paths::shared_cache_dir(app.path())
            .map_err(|e| e.to_string())?
            .join("tts-export");
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let out = tmp.join(format!("orb-{stamp}.wav"));
        if let Some(kvoice) = voice.strip_prefix(KOKORO_PREFIX) {
            kokoro_synth_file(&app, &state, &text, kvoice, &out)?;
        } else {
            piper_synth_file(&app, &text, &voice, &out)?;
        }
        let result = crate::orb_bridge::orb_send_wav(out.to_string_lossy().to_string(), None).await;
        let _ = std::fs::remove_file(&out);
        result
    }
}

/// Énonce un texte via la synthèse vocale native de macOS (`say`).
#[tauri::command]
pub fn tts_speak_macos(
    app: tauri::AppHandle,
    state: tauri::State<'_, TtsState>,
    text: String,
    voice: Option<String>,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, &state, text, voice);
        Err("Synthèse vocale macOS disponible uniquement sur Mac.".into())
    }
    #[cfg(target_os = "macos")]
    {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Ok(());
        }
        let mut cmd = Command::new("say");
        if let Some(v) = voice.filter(|v| !v.trim().is_empty()) {
            cmd.args(["-v", v.trim()]);
        }
        cmd.arg(text);
        // On SUIT le process `say` dans `state.current` afin que `tts_stop`
        // puisse l'interrompre — sinon « Stop » ne couperait pas la voix sur Mac.
        let child = cmd.spawn().map_err(|e| format!("say: {e}"))?;
        let pid = child.id();
        {
            let mut guard = state.current.lock().map_err(|_| "verrou TTS")?;
            guard.push(child);
        }
        let worker = app.clone();
        std::thread::spawn(move || {
            let state = worker.state::<TtsState>();
            wait_for_player(&state, pid); // se termine à la fin OU si tts_stop tue le pid
            let _ = worker.emit("tts-ended", ());
        });
        Ok(())
    }
}

fn normalize_tts_text(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| {
            if l.ends_with(['.', '!', '?', ':', ';', '…']) {
                l.to_string()
            } else {
                format!("{l}.")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn piper_synth_file(
    app: &tauri::AppHandle,
    text: &str,
    voice: &str,
    out: &Path,
) -> Result<(), String> {
    let model = model_path(app, voice)?;
    if !model.exists() {
        return Err(format!("Voix « {voice} » non installée."));
    }
    let mut piper_cmd =
        Command::new(piper_executable().unwrap_or_else(|| std::path::PathBuf::from("piper")));
    hide_console_window(&mut piper_cmd);
    piper_cmd
        .args([
            "--model",
            &model.to_string_lossy(),
            "--output_file",
            &out.to_string_lossy(),
        ])
        .args(piper_tuning_for(app, voice).args())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    scrub_appimage_env(&mut piper_cmd);
    let mut piper = piper_cmd
        .spawn()
        .map_err(|e| format!("piper introuvable ({e}). Installe-le : scripts/piper/install.sh"))?;
    if let Some(mut sin) = piper.stdin.take() {
        let _ = sin.write_all(normalize_tts_text(text).as_bytes());
    }
    let output = piper.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Échec de synthèse Piper.".into()
        } else {
            format!("Échec de synthèse Piper : {detail}")
        });
    }
    Ok(())
}

fn kokoro_synth_file(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, TtsState>,
    text: &str,
    voice: &str,
    out: &Path,
) -> Result<(), String> {
    if !kokoro_ready(app) {
        return Err(
            "Modèle Kokoro non installé : télécharge une voix Kokoro dans les réglages.".into(),
        );
    }
    let dir = kokoro_dir(app)?;
    let script = dir.join("kokoro_daemon.py");
    std::fs::write(&script, KOKORO_DAEMON_SCRIPT).map_err(|e| e.to_string())?;
    let model = kokoro_model(app)?;
    let voices = kokoro_voices_bin(app)?;

    let mut guard = state.kokoro.lock().map_err(|_| "verrou Kokoro")?;
    let need_spawn = match guard.as_mut() {
        Some(d) => !d.alive(),
        None => true,
    };
    if need_spawn {
        *guard = Some(KokoroDaemon::spawn(
            &kokoro_python(),
            &script,
            &model,
            &voices,
        )?);
    }
    guard
        .as_mut()
        .expect("démon Kokoro présent")
        .synth(text, voice, out)
}

/// Énonce avec Piper (synthèse + lecture, bloquant : appelé depuis un thread).
fn piper_speak(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, TtsState>,
    text: &str,
    voice: &str,
) -> Result<(), String> {
    let model = model_path(app, voice)?;
    if !model.exists() {
        return Err(format!("Voix « {voice} » non installée."));
    }
    stop_children(state);

    // `afplay` (macOS) et System.Media.SoundPlayer (Windows) lisent un fichier,
    // contrairement à paplay/aplay sur Linux qui acceptent le WAV sur stdin.
    #[cfg(any(target_os = "macos", windows))]
    {
        let dir = crate::paths::shared_cache_dir(app.path())
            .map_err(|e| e.to_string())?
            .join("tts-playback");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let out = dir.join(format!("piper-{stamp}.wav"));
        piper_synth_file(app, text, voice, &out)?;

        let player = audio_player_file(&out)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Lecteur audio système introuvable ({e})"))?;
        let player_pid = player.id();
        {
            let mut guard = state.current.lock().map_err(|_| "verrou TTS")?;
            guard.push(player);
        }
        let _ = app.emit("tts-playing", playing_payload(Some(&out)));
        wait_for_player(state, player_pid);
        let _ = std::fs::remove_file(&out);
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        use std::io::Write as _;
        let mut piper_cmd =
            Command::new(piper_executable().unwrap_or_else(|| std::path::PathBuf::from("piper")));
        hide_console_window(&mut piper_cmd);
        piper_cmd
            .args(["--model", &model.to_string_lossy(), "--output_file", "-"])
            .args(piper_tuning_for(app, voice).args())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        scrub_appimage_env(&mut piper_cmd);
        let mut piper = piper_cmd.spawn().map_err(|e| {
            format!("piper introuvable ({e}). Installe-le : scripts/piper/install.sh")
        })?;
        if let Some(mut sin) = piper.stdin.take() {
            // Piper traite chaque LIGNE comme un énoncé distinct et, avec une sortie
            // WAV unique, seule la première ligne est lue. On fusionne donc le texte
            // en une seule ligne (chaque ligne ponctuée pour garder une pause).
            let oneline = normalize_tts_text(text);
            let _ = sin.write_all(oneline.as_bytes());
            // `sin` est droppé ici → EOF, Piper synthétise puis termine.
        }
        let aplay = audio_player()
            .stdin(piper.stdout.take().ok_or("flux Piper indisponible")?)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                format!("Lecteur audio introuvable ({e}). Installe pipewire-utils ou alsa-utils.")
            })?;

        let aplay_pid = aplay.id();
        {
            let mut guard = state.current.lock().map_err(|_| "verrou TTS")?;
            guard.push(piper);
            guard.push(aplay);
        }
        let _ = app.emit("tts-playing", playing_payload(None));
        wait_for_player(state, aplay_pid);
        Ok(())
    }
}

/// Énonce un texte avec Kokoro via le démon résident (modèle chargé une fois) :
/// le démon écrit le WAV, qu'on lit ensuite avec le lecteur audio par défaut.
fn kokoro_speak(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, TtsState>,
    text: &str,
    voice: &str,
) -> Result<(), String> {
    if !kokoro_ready(app) {
        return Err(
            "Modèle Kokoro non installé : télécharge une voix Kokoro dans les réglages.".into(),
        );
    }
    let dir = kokoro_dir(app)?;
    // Script du démon écrit (ou mis à jour) à la volée.
    let script = dir.join("kokoro_daemon.py");
    std::fs::write(&script, KOKORO_DAEMON_SCRIPT).map_err(|e| e.to_string())?;
    let model = kokoro_model(app)?;
    let voices = kokoro_voices_bin(app)?;
    let out = dir.join("last.wav");

    // Stoppe la lecture précédente AVANT de réécrire last.wav.
    stop_children(state);

    // Démon résident : démarré au 1er play (chargement du modèle), réutilisé
    // ensuite. Relancé s'il est mort.
    {
        let mut guard = state.kokoro.lock().map_err(|_| "verrou Kokoro")?;
        let need_spawn = match guard.as_mut() {
            Some(d) => !d.alive(),
            None => true,
        };
        if need_spawn {
            *guard = Some(KokoroDaemon::spawn(
                &kokoro_python(),
                &script,
                &model,
                &voices,
            )?);
        }
        // Synthèse (bloque le temps du rendu, rapide car modèle déjà chargé).
        guard
            .as_mut()
            .expect("démon Kokoro présent")
            .synth(text, voice, &out)?;
    }

    // Lecture du fichier WAV produit.
    let player = audio_player_file(&out)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            format!("Lecteur audio introuvable ({e}). Installe pulseaudio-utils ou alsa-utils.")
        })?;

    let player_pid = player.id();
    {
        let mut guard = state.current.lock().map_err(|_| "verrou TTS")?;
        guard.push(player);
    }
    // L'audio commence ICI (après la synthèse) : le front aligne l'animation de
    // l'orbe sur la voix réelle, pas sur le démarrage de la génération.
    let _ = app.emit("tts-playing", playing_payload(Some(&out)));
    // Bloque jusqu'à la fin de la lecture (orbe animé toute la durée).
    wait_for_player(&state, player_pid);
    Ok(())
}

/// Durée d'une tranche d'enveloppe, en millisecondes. 40 ms = 25 valeurs par
/// seconde : assez fin pour suivre les syllabes, assez grossier pour qu'une
/// minute de parole tienne en 1 500 octets.
const ENVELOPE_FRAME_MS: u64 = 40;

/// Enveloppe d'énergie d'un WAV PCM 16 bits : une valeur 0–255 par tranche de
/// `ENVELOPE_FRAME_MS`.
///
/// Elle sert à animer la bouche de l'orbe SUR la voix réelle. L'alternative —
/// analyser le son côté interface — n'est pas possible ici : la lecture est
/// déléguée à un lecteur système (afplay, aplay, paplay, SoundPlayer), aucun
/// échantillon ne transite par la WebView. On calcule donc l'enveloppe une fois,
/// juste avant de lancer la lecture, et le front la rejoue à l'horloge.
///
/// Renvoie un vecteur vide si le fichier n'est pas un WAV PCM 16 bits lisible :
/// l'interface retombe alors sur son animation synthétique, sans erreur.
fn wav_envelope(path: &std::path::Path) -> Vec<u8> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Vec::new();
    }
    let u16at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);

    // Parcours des chunks : `fmt ` donne le format, `data` les échantillons.
    let (mut channels, mut rate, mut bits) = (1u16, 22_050u32, 16u16);
    let (mut data_start, mut data_len) = (0usize, 0usize);
    let mut pos = 12usize;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32at(pos + 4) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            channels = u16at(body + 2).max(1);
            rate = u32at(body + 4).max(8_000);
            bits = u16at(body + 14);
        } else if id == b"data" {
            data_start = body;
            data_len = size.min(bytes.len().saturating_sub(body));
            break;
        }
        pos = body + size + (size & 1); // les chunks sont alignés sur 2 octets
    }
    if bits != 16 || data_start == 0 || data_len < 2 {
        return Vec::new();
    }

    let frame = (rate as u64 * ENVELOPE_FRAME_MS / 1000) as usize * channels as usize;
    if frame == 0 {
        return Vec::new();
    }
    let samples = &bytes[data_start..data_start + (data_len & !1)];
    let total = samples.len() / 2;
    let mut out = Vec::with_capacity(total / frame + 1);
    let mut i = 0usize;
    while i < total {
        let end = (i + frame).min(total);
        // Moyenne quadratique de la tranche : c'est ce qui suit l'oreille, là où
        // un simple maximum ferait claquer la bouche sur le moindre transitoire.
        let mut sum = 0f64;
        for k in i..end {
            let v = i16::from_le_bytes([samples[k * 2], samples[k * 2 + 1]]) as f64 / 32_768.0;
            sum += v * v;
        }
        let rms = (sum / (end - i) as f64).sqrt();
        // Compression douce : la parole vit dans le bas de l'échelle linéaire,
        // une racine carrée lui rend l'amplitude qu'on entend.
        out.push((rms.sqrt().clamp(0.0, 1.0) * 255.0) as u8);
        i = end;
    }
    // Normalisation sur la voix la plus forte du fichier : une voix douce ouvre
    // la bouche autant qu'une voix forte, ce qui est le comportement attendu.
    if let Some(&peak) = out.iter().max() {
        if peak > 0 {
            let gain = 255.0 / peak as f32;
            for v in out.iter_mut() {
                *v = ((*v as f32) * gain).min(255.0) as u8;
            }
        }
    }
    out
}

/// Charge utile de `tts-playing` : l'enveloppe de la voix qui commence, quand
/// on a pu la calculer. Le front tolère l'absence des deux champs.
fn playing_payload(path: Option<&std::path::Path>) -> serde_json::Value {
    let envelope = path.map(wav_envelope).unwrap_or_default();
    serde_json::json!({ "envelope": envelope, "frame_ms": ENVELOPE_FRAME_MS })
}

/// Arrête toute énonciation en cours.
#[tauri::command]
pub fn tts_stop(state: tauri::State<'_, TtsState>) -> Result<(), String> {
    stop_children(&state);
    Ok(())
}

/// Retire les variables d'environnement injectées par le runtime **AppImage**
/// (LD_LIBRARY_PATH, PYTHONHOME/PATH, chemins GTK/GStreamer…). Sans ça, les
/// process enfants (Python du venv Kokoro, paplay/aplay…) héritent des chemins
/// internes de l'AppImage et cassent — d'où « démon Kokoro indisponible » alors
/// que le même script marche depuis un shell propre.
pub(crate) fn scrub_appimage_env(cmd: &mut Command) {
    for k in [
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "PYTHONHOME",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "GTK_PATH",
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_PATH",
        "GIO_MODULE_DIR",
        "GSETTINGS_SCHEMA_DIR",
        "GDK_PIXBUF_MODULE_FILE",
        "GDK_PIXBUF_MODULEDIR",
    ] {
        cmd.env_remove(k);
    }
    hide_console_window(cmd);
}

fn hide_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Un binaire est-il présent dans le PATH ?
#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) fn bin_in_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|d| d.join(name).is_file()))
        .unwrap_or(false)
}

/// Dossier `resources/piper/<cible>` du bundle, mémorisé au démarrage.
///
/// `piper_executable()` est appelé depuis des fonctions sans `AppHandle` (lecture
/// audio, sondes d'état) : on retient donc le chemin une fois pour toutes au
/// lancement, plutôt que de propager le handle partout.
static BUNDLED_PIPER: std::sync::OnceLock<Option<std::path::PathBuf>> =
    std::sync::OnceLock::new();

/// Nom du dossier de ressources correspondant à la plateforme courante. `None`
/// sur macOS : les archives officielles n'y fournissent aucun binaire utilisable
/// (celle marquée `aarch64` contient un exécutable Intel et omet ses dylibs),
/// donc macOS continue de passer par le runtime `piper-tts` installé à la
/// demande (cf. `piper_install_runtime`).
fn piper_bundle_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "arm") => Some("linux-armv7"),
        ("windows", "x86_64") => Some("windows-x64"),
        _ => None,
    }
}

/// À appeler une fois au démarrage : localise le Piper livré avec l'application.
pub fn init_bundled_piper(app: &tauri::AppHandle) {
    let resolved = piper_bundle_target().and_then(|target| {
        let exe = if cfg!(windows) { "piper.exe" } else { "piper" };
        let resource = app.path().resource_dir().ok()?;
        // Tauri conserve le préfixe `resources/` déclaré dans tauri.conf.json,
        // mais certains bundles l'aplatissent : on teste les deux dispositions,
        // plus l'arborescence de développement.
        let mut candidates = vec![
            resource.join("resources").join("piper").join(target).join(exe),
            resource.join("piper").join(target).join(exe),
        ];
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("resources/piper").join(target).join(exe));
            candidates.push(cwd.join("src-tauri/resources/piper").join(target).join(exe));
        }
        candidates.into_iter().find(|path| path.is_file())
    });
    let _ = BUNDLED_PIPER.set(resolved);
}

fn bundled_piper() -> Option<std::path::PathBuf> {
    BUNDLED_PIPER.get().cloned().flatten()
}

fn piper_executable() -> Option<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("LUMEN_PIPER_BIN").map(std::path::PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    // Piper livré avec Lumen : prioritaire, c'est celui dont on maîtrise la
    // version et qui ne demande aucune installation à l'utilisateur.
    if let Some(path) = bundled_piper() {
        return Some(path);
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        let path = std::path::PathBuf::from(home)
            .join("Library/Application Support/com.lumen.app/piper-runtime/bin/piper");
        if path.is_file() {
            return Some(path);
        }
    }

    if let Some(path) = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            #[cfg(windows)]
            let candidate = dir.join("piper.exe");
            #[cfg(not(windows))]
            let candidate = dir.join("piper");
            candidate.is_file().then_some(candidate)
        })
    }) {
        return Some(path);
    }

    #[cfg(target_os = "macos")]
    for candidate in ["/opt/piper/piper", "/usr/local/bin/piper"] {
        let path = std::path::PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }

    #[cfg(target_os = "linux")]
    for candidate in ["/opt/piper/piper", "/usr/local/bin/piper"] {
        let path = std::path::PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }

    #[cfg(windows)]
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let path = std::path::PathBuf::from(base)
            .join("Lumen")
            .join("Piper")
            .join("piper.exe");
        if path.is_file() {
            return Some(path);
        }
    }

    None
}

/// Construit la commande de lecture d'un WAV reçu sur **stdin**. Sur le bureau du
/// Raspberry Pi (Bookworm = PipeWire), on veut sortir sur le périphérique par
/// défaut (comme le navigateur). Ordre :
///   1. `paplay` : lit le WAV depuis stdin de façon fiable ET route via PipeWire.
///   2. `aplay -q` : ALSA (route vers PipeWire si pipewire-alsa est installé).
///   3. `pw-play -` : en dernier — il lit mal un WAV non-seekable depuis stdin
///      (d'où l'absence de son quand il était prioritaire).
#[cfg(not(any(target_os = "macos", windows)))]
fn audio_player() -> Command {
    let mut c = if bin_in_path("paplay") {
        Command::new("paplay") // lit stdin si aucun fichier n'est donné
    } else if bin_in_path("aplay") {
        let mut c = Command::new("aplay");
        c.arg("-q");
        c
    } else {
        let mut c = Command::new("pw-play");
        c.arg("-"); // lecture depuis stdin (repli)
        c
    };
    scrub_appimage_env(&mut c);
    c
}

/// Lecteur multiplateforme d'un fichier WAV : afplay sur macOS, SoundPlayer via
/// PowerShell sur Windows, puis PipeWire/Pulse/ALSA sur Linux.
fn audio_player_file(path: &Path) -> Command {
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("afplay");
        c.arg(path);
        return c;
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("powershell.exe");
        hide_console_window(&mut c);
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(New-Object System.Media.SoundPlayer $env:LUMEN_TTS_WAV).PlaySync()",
        ]);
        c.env("LUMEN_TTS_WAV", path);
        return c;
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let mut c = if bin_in_path("paplay") {
            let mut c = Command::new("paplay");
            c.arg(path);
            c
        } else if bin_in_path("pw-play") {
            let mut c = Command::new("pw-play");
            c.arg(path);
            c
        } else {
            let mut c = Command::new("aplay");
            c.arg("-q");
            c.arg(path);
            c
        };
        scrub_appimage_env(&mut c);
        c
    }
}

/// Attend la fin du process de lecture (identifié par son pid dans `current`),
/// pour que la commande `tts_speak` ne rende la main qu'à la fin de l'audio — ce
/// qui maintient l'animation « parle » de l'orbe pendant toute l'énonciation.
/// Reste interruptible : si `stop_children` vide la liste (le pid disparaît), on
/// sort immédiatement.
fn wait_for_player(state: &tauri::State<'_, TtsState>, pid: u32) {
    loop {
        std::thread::sleep(Duration::from_millis(120));
        let mut guard = match state.current.lock() {
            Ok(g) => g,
            Err(_) => break,
        };
        match guard.iter().position(|c| c.id() == pid) {
            None => break, // tué par stop / remplacé
            Some(i) => {
                if let Ok(Some(_)) = guard[i].try_wait() {
                    guard.remove(i); // lecture terminée
                    break;
                }
            }
        }
    }
}

fn stop_children(state: &tauri::State<'_, TtsState>) {
    if let Ok(mut guard) = state.current.lock() {
        for mut c in guard.drain(..) {
            let _ = c.kill();
        }
    }
}

#[cfg(test)]
mod envelope_tests {
    use super::{wav_envelope, ENVELOPE_FRAME_MS};

    /// Construit un WAV PCM 16 bits mono : une seconde de silence suivie d'une
    /// seconde de sinusoïde à pleine amplitude.
    fn wav_quiet_then_loud(rate: u32) -> Vec<u8> {
        let total = (rate * 2) as usize;
        let mut data = Vec::with_capacity(total * 2);
        for i in 0..total {
            let amp = if i < rate as usize { 0.0 } else { 0.9 };
            let v = (amp * ((i as f64) * 0.05).sin() * 32_000.0) as i16;
            data.extend_from_slice(&v.to_le_bytes());
        }
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&((36 + data.len()) as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes()); // taille du chunk fmt
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * 2).to_le_bytes()); // octets/seconde
        wav.extend_from_slice(&2u16.to_le_bytes()); // alignement
        wav.extend_from_slice(&16u16.to_le_bytes()); // bits
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        wav
    }

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn suit_le_niveau_de_la_voix() {
        let rate = 22_050;
        let path = write_temp("lumen-envelope-test.wav", &wav_quiet_then_loud(rate));
        let env = wav_envelope(&path);
        let _ = std::fs::remove_file(&path);

        // Deux secondes découpées en tranches de 40 ms.
        let expected = 2 * 1000 / ENVELOPE_FRAME_MS as usize;
        assert!(
            (env.len() as i64 - expected as i64).abs() <= 1,
            "longueur inattendue : {} pour {expected} attendues",
            env.len()
        );
        let mid = env.len() / 2;
        let silence = env[..mid - 1].iter().map(|&v| v as u32).sum::<u32>() / (mid as u32 - 1);
        let voix = env[mid + 1..].iter().map(|&v| v as u32).sum::<u32>() / (mid as u32 - 1);
        assert!(silence < 10, "le silence devrait rester bas, obtenu {silence}");
        assert!(voix > 180, "la partie sonore devrait ouvrir la bouche, obtenu {voix}");
    }

    #[test]
    fn fichier_illisible_ne_casse_rien() {
        let path = write_temp("lumen-envelope-bogus.bin", b"pas un wav du tout");
        let env = wav_envelope(&path);
        let _ = std::fs::remove_file(&path);
        assert!(env.is_empty(), "un fichier non-WAV doit donner une enveloppe vide");
    }
}
