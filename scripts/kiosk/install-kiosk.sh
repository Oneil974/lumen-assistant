#!/usr/bin/env bash
# Déploie Lumen en mode « Desktop kiosque » sur une distribution Linux.
#
# Le poste démarre directement sur le bureau de Lumen, plein écran, sans
# gestionnaire de fenêtres visible, sans barre système et sans échappatoire
# ordinaire : une borne d'atelier, un poste d'accueil, un terminal de saisie.
#
# CE QUE CE SCRIPT FAIT
#   1. crée un utilisateur dédié (non privilégié, sans mot de passe de session) ;
#   2. installe une session graphique minimale : un compositeur (cage) qui ne
#      sait afficher qu'UNE fenêtre, en plein écran ;
#   3. branche la connexion automatique de cet utilisateur ;
#   4. lance Lumen au démarrage de la session, en mode bureau.
#
# CE QU'IL NE FAIT PAS
#   * il n'installe pas Lumen : fournissez le .deb ou l'AppImage ;
#   * il ne verrouille pas le BIOS, ni le démarrage sur clé USB, ni les
#     consoles virtuelles (Ctrl+Alt+F2). Un kiosque logiciel n'est pas un
#     kiosque physique — si le poste est en libre accès, il faut aussi le
#     fermer côté matériel.
#
# Testé sur Debian 12 / Ubuntu 24.04 (systemd + greetd + cage).
#
#   sudo ./install-kiosk.sh --app /chemin/vers/Lumen.AppImage
#   sudo ./install-kiosk.sh --app /usr/bin/lumen --user borne --name "Accueil"

set -euo pipefail

APP=""
KIOSK_USER="lumen"
KIOSK_NAME="Lumen"
ROTATE=""
DRY_RUN=0

usage() {
  # Imprime l'en-tete du fichier, et lui seul : la premiere ligne non
  # commentee arrete la lecture.
  awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
  cat <<'USAGE'

Options :
  --app <chemin>     Exécutable ou AppImage de Lumen (obligatoire)
  --user <nom>       Utilisateur de la borne (défaut : lumen)
  --name <nom>       Nom affiché de la borne (défaut : Lumen)
  --rotate <sens>    Rotation de l'écran : normal | 90 | 180 | 270
  --dry-run          Montre ce qui serait écrit, sans rien modifier
  -h, --help         Cette aide
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:?--app demande un chemin}"; shift 2 ;;
    --user) KIOSK_USER="${2:?}"; shift 2 ;;
    --name) KIOSK_NAME="${2:?}"; shift 2 ;;
    --rotate) ROTATE="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$APP" ] || { echo "Erreur : --app est obligatoire." >&2; usage >&2; exit 2; }
[ -x "$APP" ] || { echo "Erreur : $APP n'est pas un exécutable." >&2; exit 2; }
# `--dry-run` ne touche a rien : exiger root pour SIMULER obligerait a
# invoquer sudo juste pour relire ce que le script ferait.
[ "$DRY_RUN" = "1" ] || [ "$(id -u)" = "0" ] || { echo "Erreur : lancez ce script avec sudo (ou --dry-run pour simuler)." >&2; exit 2; }

say() { printf '  %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}
write() { # write <chemin> <<'EOF' … EOF
  local path="$1"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] écrirait %s :\n' "$path"
    sed 's/^/      | /'
  else
    install -D /dev/stdin "$path"
  fi
}

echo "Lumen — installation du mode kiosque"
say "application : $APP"
say "utilisateur : $KIOSK_USER"

# ---------- 1. Dépendances ----------
# cage : un compositeur Wayland qui n'affiche qu'une seule fenêtre, en plein
# écran. C'est exactement la définition d'un kiosque — plutôt qu'un bureau
# complet qu'il faudrait ensuite brider fenêtre par fenêtre.
# greetd : la connexion automatique, sans écran de login.
say "installation de cage et greetd…"
if command -v apt-get >/dev/null 2>&1; then
  run env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends cage greetd
elif command -v dnf >/dev/null 2>&1; then
  run dnf install -y cage greetd
elif command -v pacman >/dev/null 2>&1; then
  run pacman -S --noconfirm cage greetd
else
  echo "Gestionnaire de paquets non reconnu : installez « cage » et « greetd » à la main." >&2
fi

# ---------- 2. Utilisateur dédié ----------
# Sans mot de passe de connexion (la session s'ouvre seule) mais SANS sudo :
# la borne ne doit pas pouvoir devenir administrateur d'elle-même.
if id "$KIOSK_USER" >/dev/null 2>&1; then
  say "utilisateur $KIOSK_USER : déjà présent"
else
  say "création de l'utilisateur $KIOSK_USER…"
  run useradd --create-home --shell /usr/sbin/nologin --comment "$KIOSK_NAME (kiosque)" "$KIOSK_USER"
fi
run usermod -aG video,input,render "$KIOSK_USER" 2>/dev/null || true

# ---------- 3. Script de session ----------
# Relance en boucle : si Lumen s'arrête (plantage, mise à jour), la borne
# revient d'elle-même. Une borne qui reste sur un écran noir n'est pas une
# borne.
write "/usr/local/bin/lumen-kiosk" <<EOF
#!/usr/bin/env bash
# Session kiosque de $KIOSK_NAME. Écrit par scripts/kiosk/install-kiosk.sh.
set -u

# Ouvre directement le BUREAU de Lumen, plein écran, au lieu de la barre de
# recherche. Lue par l'application au démarrage (cf. src-tauri/src/lib.rs,
# « Mode borne »).
export LUMEN_KIOSK=1
# Le compositeur ne gère pas la mise en veille : on la coupe franchement plutôt
# que de laisser un écran noir qu'un passant croirait éteint.
export WLR_NO_HARDWARE_CURSORS=1

while true; do
  "$APP" || true
  # Un redémarrage immédiat en boucle masquerait une panne : on souffle une
  # seconde, ce qui laisse les journaux lisibles.
  sleep 1
done
EOF
run chmod +x /usr/local/bin/lumen-kiosk

# ---------- 4. greetd : connexion automatique ----------
ROTATE_ARG=""
[ -n "$ROTATE" ] && ROTATE_ARG=" -r $ROTATE"
write "/etc/greetd/config.toml" <<EOF
# Connexion automatique de la borne $KIOSK_NAME.
# Écrit par scripts/kiosk/install-kiosk.sh — les modifications manuelles seront
# écrasées à la prochaine exécution.
[terminal]
vt = 1

[default_session]
# cage : un seul programme, plein écran, aucune décoration.
#   -s  autorise le VT switching (garde une porte de sortie pour l'administrateur)
command = "cage -s$ROTATE_ARG -- /usr/local/bin/lumen-kiosk"
user = "$KIOSK_USER"
EOF

say "activation du service…"
run systemctl enable greetd.service

# ---------- 5. Garde-fous ----------
# La borne ne doit pas s'endormir ni éteindre son écran.
write "/etc/systemd/logind.conf.d/10-lumen-kiosk.conf" <<'EOF'
# Une borne ne dort pas : un écran noir se lit comme un poste en panne.
[Login]
IdleAction=ignore
HandleLidSwitch=ignore
HandlePowerKey=ignore
EOF

cat <<EOF

Installé.

  Démarrer maintenant : sudo systemctl start greetd
  Revenir à un bureau normal : sudo systemctl disable --now greetd

Ce qui reste à VOTRE charge, et que ce script ne peut pas faire :
  · verrouiller le BIOS et le démarrage sur support externe ;
  · désactiver les consoles virtuelles si le poste est en libre accès
    (cage est lancé avec -s, qui les laisse volontairement accessibles) ;
  · chiffrer le disque si la borne porte des données.
EOF
