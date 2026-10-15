#!/usr/bin/env bash
# Déploie Lumen sur un Raspberry Pi (ou un Linux Debian/Ubuntu ordinaire) et le
# fait démarrer DIRECTEMENT en plein écran, sur le bureau de Lumen.
#
# Deux façons de tenir l'écran :
#
#   • bureau (défaut)  — on garde la session graphique de l'appareil (Raspberry
#     Pi OS Desktop, Ubuntu…). Lumen est lancé à l'ouverture de session avec
#     LUMEN_KIOSK=1 : son bureau s'ouvre plein écran par-dessus tout. On peut
#     toujours en sortir (F11, Échap du plein écran, fermer la fenêtre) : c'est
#     le mode « écran principal », pas une borne verrouillée.
#
#   • --kiosk          — poste dédié : aucun bureau, un compositeur qui ne sait
#     afficher qu'une fenêtre (cage + greetd), connexion automatique d'un
#     utilisateur sans privilèges, relance si Lumen s'arrête. C'est
#     scripts/kiosk/install-kiosk.sh, appelé pour vous. Convient aussi à un
#     Raspberry Pi OS *Lite* (sans bureau).
#
# D'où vient l'application :
#
#   --build            compile sur place (scripts/build-pi.sh, feature rpi) puis
#                      installe le .deb produit ;
#   --deb <fichier>    installe ce paquet Debian ;
#   --appimage <f>     copie l'AppImage dans /opt/lumen et l'utilise ;
#   (rien)             cherche le dernier .deb / AppImage déjà construit dans
#                      src-tauri/target/release/bundle/.
#
# Ce que le script règle en plus sur un Raspberry Pi :
#   · extinction d'écran désactivée (raspi-config), car un écran noir se lit
#     comme une panne ;
#   · compositeur picom en autostart sous X11 (sans lui, la fenêtre
#     transparente de Lumen s'affiche en noir — cf. docs/raspberry-pi.md) ;
#   · service GPIO (pigpiod, ou pigpio-lite sur Pi 5) si demandé (--gpio).
#
# Exemples :
#   ./scripts/deploy-pi.sh --build                    # Pi de bureau : compile et pose l'autostart
#   ./scripts/deploy-pi.sh --deb ~/Lumen_0.2.0_arm64.deb --gpio
#   sudo ./scripts/deploy-pi.sh --appimage ~/Lumen.AppImage --kiosk   # borne verrouillée
#   ./scripts/deploy-pi.sh --uninstall                # retire l'autostart
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="desktop"      # desktop | kiosk
SOURCE=""           # build | deb | appimage | auto
ARTIFACT=""
WANT_GPIO=0
HIDE_CURSOR=0
UNINSTALL=0
DRY_RUN=0
KIOSK_ARGS=()

usage() {
  awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
  cat <<'USAGE'

Options :
  --build              Compiler ici (scripts/build-pi.sh) puis installer le .deb
  --deb <fichier>      Installer ce .deb
  --appimage <fichier> Utiliser cette AppImage (copiée dans /opt/lumen)
  --kiosk              Borne verrouillée (cage + greetd), via install-kiosk.sh — sudo requis
  --user <nom>         (kiosk) utilisateur de la borne — défaut : lumen
  --rotate <sens>      (kiosk) rotation de l'écran : normal | 90 | 180 | 270
  --gpio               Installer/activer le service GPIO (pigpiod ou pigpio-lite)
  --hide-cursor        Masquer le pointeur au repos (unclutter) — écran tactile
  --uninstall          Retirer l'autostart plein écran (garde l'application)
  --dry-run            Montrer ce qui serait fait
  -h, --help           Cette aide
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --build) SOURCE="build"; shift ;;
    --deb) SOURCE="deb"; ARTIFACT="${2:?--deb demande un fichier}"; shift 2 ;;
    --appimage) SOURCE="appimage"; ARTIFACT="${2:?--appimage demande un fichier}"; shift 2 ;;
    --kiosk) MODE="kiosk"; shift ;;
    --user) KIOSK_ARGS+=(--user "${2:?}"); shift 2 ;;
    --rotate) KIOSK_ARGS+=(--rotate "${2:?}"); shift 2 ;;
    --gpio) WANT_GPIO=1; shift ;;
    --hide-cursor) HIDE_CURSOR=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
step() { printf '\n→ %s\n' "$*"; }
run() { if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }
as_root() { if [ "$(id -u)" = "0" ]; then run "$@"; else run sudo "$@"; fi; }
write() { # write <chemin> <<EOF … EOF   (fichier de l'utilisateur courant)
  local path="$1"
  if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] écrirait %s :\n' "$path"; sed 's/^/      | /'
  else mkdir -p "$(dirname "$path")"; cat > "$path"; fi
}

IS_PI=0
if [ -r /proc/device-tree/model ] && grep -qi "raspberry" /proc/device-tree/model 2>/dev/null; then IS_PI=1; fi
if [ "$IS_PI" = "1" ]; then say "Raspberry Pi détecté : $(tr -d '\0' < /proc/device-tree/model)"; else say "Linux générique (pas un Raspberry Pi)"; fi

# ---------- Désinstallation de l'autostart ----------
if [ "$UNINSTALL" = "1" ]; then
  step "Retrait de l'autostart plein écran"
  run rm -f "$HOME/.config/autostart/lumen-fullscreen.desktop"
  if [ -f /etc/greetd/config.toml ] && grep -q lumen-kiosk /etc/greetd/config.toml 2>/dev/null; then
    say "mode borne détecté : sudo systemctl disable --now greetd pour revenir à un bureau normal"
  fi
  echo "Fait. L'application reste installée."
  exit 0
fi

# ---------- 1. L'application ----------
step "Application"
if [ "$MODE" = "kiosk" ] && [ "$(id -u)" != "0" ] && [ "$DRY_RUN" != "1" ]; then
  echo "Le mode --kiosk écrit dans /etc : relancez avec sudo." >&2; exit 2
fi
if [ "$SOURCE" = "build" ]; then
  if [ "$(id -u)" = "0" ]; then echo "--build ne se lance pas en root (cf. build-pi.sh) : relancez sans sudo, puis --deb … --kiosk avec sudo." >&2; exit 2; fi
  say "compilation (scripts/build-pi.sh)…"
  run "$ROOT/scripts/build-pi.sh"
  SOURCE="auto"
fi
if [ -z "$SOURCE" ] || [ "$SOURCE" = "auto" ]; then
  BUNDLE="$ROOT/src-tauri/target/release/bundle"
  ARTIFACT="$(ls -t "$BUNDLE"/deb/*.deb 2>/dev/null | head -n1 || true)"
  if [ -n "$ARTIFACT" ]; then SOURCE="deb"; else
    ARTIFACT="$(ls -t "$BUNDLE"/appimage/*.AppImage 2>/dev/null | head -n1 || true)"
    [ -n "$ARTIFACT" ] && SOURCE="appimage"
  fi
  [ -n "$ARTIFACT" ] || { echo "Aucun paquet trouvé dans $BUNDLE : lancez --build, ou donnez --deb / --appimage." >&2; exit 2; }
  say "paquet trouvé : $ARTIFACT"
fi

APP_BIN=""
case "$SOURCE" in
  deb)
    [ -f "$ARTIFACT" ] || { echo "Introuvable : $ARTIFACT" >&2; exit 2; }
    say "installation du paquet Debian…"
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$(readlink -f "$ARTIFACT")"
    APP_BIN="$(command -v lumen || command -v Lumen || true)"
    [ -n "$APP_BIN" ] || APP_BIN="/usr/bin/lumen"
    ;;
  appimage)
    [ -f "$ARTIFACT" ] || { echo "Introuvable : $ARTIFACT" >&2; exit 2; }
    say "copie de l'AppImage dans /opt/lumen…"
    as_root mkdir -p /opt/lumen
    as_root install -m 755 "$ARTIFACT" /opt/lumen/Lumen.AppImage
    # Une AppImage a besoin de FUSE ; sur Bookworm c'est libfuse2 qui manque le plus souvent.
    if command -v apt-get >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y libfuse2 || true
    fi
    APP_BIN="/opt/lumen/Lumen.AppImage"
    ;;
esac
say "exécutable : $APP_BIN"

# ---------- 2. Réglages Raspberry Pi ----------
if [ "$IS_PI" = "1" ]; then
  step "Réglages Raspberry Pi"
  if command -v raspi-config >/dev/null 2>&1; then
    say "extinction d'écran désactivée"
    as_root raspi-config nonint do_blanking 1 || true
  fi
  if [ "$WANT_GPIO" = "1" ]; then
    if grep -qi "Pi 5" /proc/device-tree/model 2>/dev/null; then
      say "Pi 5 : pigpiod ne fonctionne pas (RP1) → pigpio-lite"
      run "$ROOT/scripts/pigpio-lite/install.sh"
    else
      say "service pigpiod"
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y pigpio || true
      as_root systemctl enable --now pigpiod || true
    fi
  fi
fi

# ---------- 3. Démarrage plein écran ----------
if [ "$MODE" = "kiosk" ]; then
  step "Mode borne (cage + greetd)"
  run "$ROOT/scripts/kiosk/install-kiosk.sh" --app "$APP_BIN" "${KIOSK_ARGS[@]}" $([ "$DRY_RUN" = "1" ] && echo --dry-run)
else
  step "Autostart de session (bureau conservé)"
  # Session X11 : la fenêtre transparente de Lumen exige un compositeur, sinon
  # elle est noire. picom en autostart règle ça ; sous Wayland (labwc/wayfire),
  # le compositeur est déjà là.
  SESSION_TYPE="${XDG_SESSION_TYPE:-}"
  if [ -z "$SESSION_TYPE" ] && command -v loginctl >/dev/null 2>&1; then
    SESSION_TYPE="$(loginctl show-session "$(loginctl 2>/dev/null | awk 'NR==2{print $1}')" -p Type --value 2>/dev/null || true)"
  fi
  if [ "$SESSION_TYPE" = "x11" ] || { [ -z "$SESSION_TYPE" ] && [ "$IS_PI" = "1" ]; }; then
    if ! command -v picom >/dev/null 2>&1; then
      say "compositeur picom (X11) : installation"
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y picom || true
    fi
    write "$HOME/.config/autostart/picom.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=picom
Exec=picom -b
X-GNOME-Autostart-enabled=true
EOF
    say "picom en autostart (transparence de la fenêtre sous X11)"
  fi
  if [ "$HIDE_CURSOR" = "1" ]; then
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y unclutter || true
    write "$HOME/.config/autostart/unclutter.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=unclutter
Exec=unclutter -idle 2 -root
EOF
  fi
  # LUMEN_KIOSK=1 : le bureau de Lumen s'ouvre directement, plein écran
  # (cf. src-tauri/src/lib.rs, « Mode borne »). Le délai laisse au compositeur
  # et au réseau (Ollama distant) le temps d'être prêts.
  write "$HOME/.config/autostart/lumen-fullscreen.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Lumen (plein écran)
Comment=Ouvre le bureau de Lumen en plein écran à l'ouverture de session
Exec=sh -c 'sleep 3; LUMEN_KIOSK=1 exec "$APP_BIN"'
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
  say "autostart : ~/.config/autostart/lumen-fullscreen.desktop"
fi

# ---------- 4. Résumé ----------
cat <<EOF

Déployé.
  application : $APP_BIN
  mode        : $([ "$MODE" = "kiosk" ] && echo "borne verrouillée (cage + greetd)" || echo "bureau conservé, Lumen plein écran à l'ouverture de session")

Essayer tout de suite :  LUMEN_KIOSK=1 $APP_BIN
Quitter le plein écran : F11 (ou le bouton « Plein écran » de la barre des tâches de Lumen).
Retirer l'autostart :    $0 --uninstall
EOF
if [ "$IS_PI" = "1" ]; then
  echo "IA : sur un Pi, pointez Lumen vers un Ollama du réseau (Réglages → Source d'IA → URL), le Pi garde tout le reste en local."
fi
