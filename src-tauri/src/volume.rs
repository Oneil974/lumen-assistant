//! Volume de sortie du système, piloté par le potentiomètre du Lumen Controller.
//!
//! Le microcontrôleur ne peut pas se présenter comme un clavier USB HID tout en
//! utilisant le Wi-Fi sur toutes les builds MicroPython. Il envoie donc une
//! commande réseau (`hid_volume`) et c'est Lumen qui applique le volume, via les
//! API natives de chaque plateforme.
//!
//! Le potentiomètre donne une position ABSOLUE : la commande règle donc le
//! volume à une valeur, elle ne l'incrémente pas.

use std::process::Command;

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

/// Règle le volume de sortie du système, en pourcentage (0–100).
#[tauri::command]
pub fn system_set_volume(percent: i64) -> Result<(), String> {
    let percent = percent.clamp(0, 100);

    #[cfg(target_os = "macos")]
    {
        // `set volume output volume` attend 0–100 et ne demande aucune
        // autorisation particulière, contrairement aux événements clavier
        // synthétiques qui exigeraient l'accès Accessibilité.
        let mut cmd = Command::new("osascript");
        cmd.arg("-e")
            .arg(format!("set volume output volume {percent}"));
        hide_console_window(&mut cmd);
        let out = cmd
            .output()
            .map_err(|e| format!("osascript indisponible : {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "Réglage du volume refusé : {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        return Ok(());
    }

    #[cfg(windows)]
    {
        // Windows n'expose pas de commande intégrée pour le volume maître.
        // On passe par IAudioEndpointVolume (Core Audio) via P/Invoke
        // PowerShell : pas de dépendance externe, et c'est un réglage absolu,
        // là où VK_VOLUME_UP/DOWN ne ferait que des pas de 2 %.
        let script = format!(
            r#"
Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {{
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int j(); int GetMasterVolumeLevelScalar(out float level);
  int k(); int l(); int m(); int n();
  int SetMute(bool mute, Guid ctx);
}}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {{ int Activate(ref Guid id, int ctx, IntPtr p, out IAudioEndpointVolume o); }}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {{ int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject {{ }}
public class Audio {{
  public static void Set(float v) {{
    IMMDeviceEnumerator e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; e.GetDefaultAudioEndpoint(0, 1, out dev);
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume vol; dev.Activate(ref iid, 23, IntPtr.Zero, out vol);
    vol.SetMasterVolumeLevelScalar(v, Guid.Empty);
    vol.SetMute(v <= 0.0001f, Guid.Empty);
  }}
}}
"@
[Audio]::Set({:.4})
"#,
            percent as f32 / 100.0
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        hide_console_window(&mut cmd);
        let out = cmd
            .output()
            .map_err(|e| format!("PowerShell indisponible : {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "Réglage du volume refusé : {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        return Ok(());
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        // PipeWire et PulseAudio partagent `pactl`. Repli sur ALSA seul, encore
        // présent sur les systèmes minimaux et les images Raspberry Pi.
        let mut errors = Vec::new();
        for (bin, args) in [
            (
                "pactl",
                vec![
                    "set-sink-volume".to_string(),
                    "@DEFAULT_SINK@".to_string(),
                    format!("{percent}%"),
                ],
            ),
            (
                "amixer",
                vec![
                    "-q".to_string(),
                    "sset".to_string(),
                    "Master".to_string(),
                    format!("{percent}%"),
                ],
            ),
        ] {
            let mut cmd = Command::new(bin);
            cmd.args(&args);
            hide_console_window(&mut cmd);
            match cmd.output() {
                Ok(out) if out.status.success() => return Ok(()),
                Ok(out) => errors.push(format!(
                    "{bin} : {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                )),
                Err(e) => errors.push(format!("{bin} : {e}")),
            }
        }
        return Err(format!(
            "Aucun mixeur utilisable ({}). Installez pulseaudio-utils ou alsa-utils.",
            errors.join(" ; ")
        ));
    }
}
