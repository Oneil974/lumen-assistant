#!/usr/bin/env python3
"""Génère un PDF complet de la documentation de Lumen.

Sert de corpus de test pour le RAG : contenu dense, factuel et varié (commandes,
ports, valeurs par défaut, raccourcis…) — idéal pour éprouver à la fois la
recherche par mot-clé (FTS5) et la recherche sémantique (embeddings).

Usage : python3 scripts/build-doc-pdf.py
Sortie : docs/Lumen-Documentation.pdf
"""

import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    ListFlowable, ListItem,
)

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "Lumen-Documentation.pdf")
OUT = os.path.abspath(OUT)

ACCENT = colors.HexColor("#ff2d92")
INK = colors.HexColor("#1c1c1e")
MUTED = colors.HexColor("#6b6b70")
PANEL = colors.HexColor("#f4f4f7")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle("LH1", parent=styles["Heading1"], fontSize=20, spaceBefore=8,
                          spaceAfter=10, textColor=ACCENT, leading=24))
styles.add(ParagraphStyle("LH2", parent=styles["Heading2"], fontSize=14, spaceBefore=12,
                          spaceAfter=5, textColor=INK, leading=18))
styles.add(ParagraphStyle("LBody", parent=styles["BodyText"], fontSize=10.5, leading=15,
                          alignment=TA_JUSTIFY, spaceAfter=6, textColor=INK))
styles.add(ParagraphStyle("LBullet", parent=styles["LBody"], leftIndent=10, spaceAfter=2))
styles.add(ParagraphStyle("LLead", parent=styles["LBody"], fontSize=12, textColor=MUTED,
                          leading=17, spaceAfter=10))
styles.add(ParagraphStyle("LCode", parent=styles["BodyText"], fontName="Courier",
                          fontSize=9.5, leading=13, textColor=colors.HexColor("#0a3"),
                          backColor=PANEL, borderPadding=6, spaceAfter=8, leftIndent=4))
styles.add(ParagraphStyle("LNote", parent=styles["LBody"], backColor=colors.HexColor("#fff4fa"),
                          borderColor=ACCENT, borderWidth=0.5, borderPadding=7,
                          leftIndent=4, rightIndent=4, spaceAfter=8))
styles.add(ParagraphStyle("LCoverTitle", parent=styles["Title"], fontSize=34,
                          textColor=ACCENT, spaceAfter=4))
styles.add(ParagraphStyle("LCoverSub", parent=styles["Normal"], fontSize=13,
                          textColor=MUTED, alignment=1, leading=18))

S = []

def h1(t): S.append(Paragraph(t, styles["LH1"]))
def h2(t): S.append(Paragraph(t, styles["LH2"]))
def p(t): S.append(Paragraph(t, styles["LBody"]))
def lead(t): S.append(Paragraph(t, styles["LLead"]))
def code(t): S.append(Paragraph(t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), styles["LCode"]))
def note(t): S.append(Paragraph("ⓘ &nbsp; " + t, styles["LNote"]))
def gap(h=6): S.append(Spacer(1, h))
def bullets(items):
    S.append(ListFlowable(
        [ListItem(Paragraph(i, styles["LBullet"]), leftIndent=12, value="•") for i in items],
        bulletType="bullet", start="•", leftIndent=14, spaceAfter=8))

def kvtable(rows, col0=55*mm):
    t = Table(rows, colWidths=[col0, None])
    t.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), "Helvetica", 9.5),
        ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 9.5),
        ("TEXTCOLOR", (0, 0), (0, -1), ACCENT),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, colors.HexColor("#e2e2e8")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ]))
    S.append(t)
    gap(8)

# ============================ COVER ============================
S.append(Spacer(1, 70*mm))
S.append(Paragraph("Lumen", styles["LCoverTitle"]))
S.append(Paragraph("Documentation complète", ParagraphStyle("ct2", parent=styles["Title"], fontSize=18, textColor=INK)))
S.append(Spacer(1, 8))
S.append(Paragraph("Votre agent IA local, privé et agentique.<br/>macOS · Linux · Raspberry Pi · Windows", styles["LCoverSub"]))
S.append(Spacer(1, 40*mm))
S.append(Paragraph("Lumen · Local · Privé · On-device — version de référence", styles["LCoverSub"]))
S.append(PageBreak())

# ============================ 1. VUE D'ENSEMBLE ============================
h1("1. Vue d'ensemble")
lead("Lumen est un agent IA de bureau : une barre flottante en verre dépoli, accompagnée "
     "d'un avatar orbe animé, qui fonctionne 100 % en local et agit pour vous.")
p("Lumen s'appuie par défaut sur <b>Ollama</b> pour faire tourner des modèles localement "
  "(LFM 2.5, Llama, Qwen, Mistral…). Aucune donnée ne quitte la machine. En option, Lumen "
  "peut utiliser les <b>modèles d'Apple</b> via l'app Raccourcis (macOS), ou une <b>API cloud "
  "compatible OpenAI</b> (OpenAI, Groq, OpenRouter…).")
h2("Les trois sources d'IA")
kvtable([
    ["Source", "Description"],
    ["Ollama local", "Mode par défaut. Privé, hors-ligne, gratuit, agentique (function calling)."],
    ["Raccourcis macOS", "Modèles Apple, zéro configuration de modèle. Pas de function calling."],
    ["API cloud", "Tout point d'accès OpenAI-compatible. La clé est stockée côté application, jamais exposée à l'interface."],
])
h2("Modules principaux")
bullets([
    "<b>Avatar orbe</b> — sphère de verre WebGL (Three.js), états repos / réflexion / parole, entièrement personnalisable.",
    "<b>Heartbeat</b> — planificateur CRON qui déclenche un raccourci ou un workflow Fluxo à intervalle régulier.",
    "<b>Agents autonomes</b>, <b>Sandboxes</b> fichiers, <b>Fluxo</b> (workflows), <b>Mémoire cognitive</b>, <b>Base de connaissances (RAG)</b>.",
    "<b>Apps</b> : Kanban, Calendrier, Connaissances, Mindmap, Notes, Domotique, Studio d'images, Data Analysis, Éditeur de code.",
    "<b>Compagnon iPhone</b> — pilotage à distance via un code à usage unique (TOTP).",
])

# ============================ 2. INSTALLATION ============================
S.append(PageBreak())
h1("2. Installation & prérequis")
p("Les scripts d'installation sont <b>interactifs</b> (chaque étape demande O/n) et "
  "<b>idempotents</b> : relançables sans risque. Ajoutez <code>--yes</code> pour tout "
  "installer sans question.")
h2("macOS 13+ (Apple Silicon recommandé)")
p("Installe Ollama (via Homebrew) et télécharge le modèle par défaut. La voix et la dictée "
  "système restent disponibles ; l'installateur propose aussi Piper local et deux voix.")
code("./scripts/install-prereqs-macos.sh")
h2("Linux (Debian/Ubuntu x86_64)")
p("Installe Ollama et le modèle, puis propose les voix locales <b>Piper</b> (FR & EN) et "
  "<b>Kokoro</b>, ainsi que la dictée <b>whisper.cpp</b>.")
h2("Raspberry Pi (64-bit)")
p("Comme Linux, en arm64. Privilégiez un petit modèle ; pour l'image et les gros modèles, "
  "déportez l'inférence sur une autre machine via Réglages → IA → URL. Le service GPIO se "
  "configure via <code>./scripts/install-prereqs-pi.sh</code>.")
h2("Windows 10/11 x64")
p("Installe Ollama (via winget) et le modèle, puis propose Piper MIT avec les voix FR et EN. "
  "Les voix système Windows et l'app compagnon iPhone restent disponibles.")
note("Piper est disponible sur macOS, Windows, Linux et Raspberry Pi (MIT sur Windows/Linux/Pi, "
     "runtime maintenu GPL-3.0 sur macOS). Kokoro et la dictée "
     "Whisper restent actuellement destinés à Linux/Raspberry Pi ; macOS et Windows gardent leurs services système. "
     "Besoin d'un modèle cloud ? Ajoutez une clé API dans Réglages → IA, aucun script requis.")
h2("Développement")
code("npm install\n./dev.sh            # ou : npm run tauri dev\nnpm run tauri build  # build .app / .dmg")

# ============================ 3. GUIDE RAPIDE ============================
S.append(PageBreak())
h1("3. Guide rapide")
bullets([
    "Ouvrez la barre, tapez votre question, validez avec Entrée ou le bouton →.",
    "Le bouton ⚙ ouvre les Paramètres ; le bouton ▦ ouvre la Boîte à outils (tous les modules).",
    "Le sélecteur de <b>type de chat</b> propose : <b>Chat</b> (conversation simple) et "
    "<b>Function Calling</b> (l'IA peut appeler des outils : workflows Fluxo, domotique, mémoire, rappels, recherche documents).",
    "Le microphone lance la dictée ; le haut-parleur (auto-lecture) énonce les réponses.",
    "Les boutons d'outils s'adaptent à la taille de barre choisie (petit / moyen / grand) ; les moins utilisés se replient dans un menu « Plus ».",
])
note("La synthèse vocale du chat réutilise le canal du Heartbeat. Sur macOS la commande "
     "système « say » est utilisée ; le verrou de lecture est relâché avant la lecture pour "
     "qu'un appel figé ne bloque jamais les énonciations suivantes.")

# ============================ 4. IA & MODELES ============================
S.append(PageBreak())
h1("4. IA & modèles (configuration)")
p("La source d'IA se choisit dans Réglages → Général → Source d'IA. Selon la source, des "
  "champs supplémentaires apparaissent.")
h2("Ollama local")
kvtable([
    ["Réglage", "Détail"],
    ["URL d'Ollama", "http://localhost:11434 par défaut."],
    ["Modèle", "Sélection parmi les modèles installés (ex. liquidai/lfm2.5-350m:latest)."],
    ["Mode raisonnement", "Laisse le modèle « réfléchir » (modèles compatibles : qwen3, deepseek-r1)."],
    ["Taille du contexte", "Curseur à paliers : Défaut du modèle, 2k, 4k, 8k, 16k, 32k, 64k, 128k tokens."],
    ["Keep-alive", "Durée de maintien en mémoire (ex. 5m, 1h, -1 = toujours, 0 = décharger)."],
])
h2("API cloud (OpenAI-compatible)")
p("Renseignez la clé API, l'URL de base (ex. https://api.openai.com/v1) et le modèle "
  "(ex. gpt-4o-mini). La clé est conservée dans un fichier protégé côté application et "
  "n'est jamais exposée à l'interface. Laissez le champ vide pour conserver la clé enregistrée.")
note("Le backend cloud bascule tout le pipeline LLM (barre, outils, agents, blocs Fluxo) sur "
     "le point d'accès OpenAI-compatible choisi.")

# ============================ 5. AGENTS ============================
S.append(PageBreak())
h1("5. Agents autonomes")
p("Un agent = un nom, une <b>sandbox</b> attribuée, des <b>skills</b> (workflows Fluxo "
  "enchaînés exposés comme outils), une <b>todo list</b>, et une planification <b>CRON</b>. "
  "Les agents reposent sur le function calling d'Ollama — indisponibles en source Apple.")
h2("Le cycle de travail (un tick)")
bullets([
    "L'agent prend sa prochaine tâche échue (date du jour ou passée, ou sans date).",
    "Il appelle ses skills comme des outils pour accomplir la tâche, dans sa sandbox.",
    "Il produit un compte rendu écrit dans sa sandbox et poste un message dans la Messagerie.",
])
h2("Tâches programmées (dates)")
p("Une tâche sans date est disponible immédiatement. Une tâche avec une date n'est visible "
  "par l'agent qu'à partir de ce jour (badge 🔒 tant que l'échéance est future, badge vert "
  "le jour venu). Les tâches datées des agents apparaissent aussi dans l'app Calendrier.")
note("Supprimer un agent retire sa configuration mais ne touche pas à sa sandbox : les "
     "fichiers produits restent dans l'explorateur de sandboxes.")

# ============================ 6. SANDBOX ============================
S.append(PageBreak())
h1("6. Sandboxes fichiers")
p("Une sandbox est un espace fichiers <b>isolé et limité en taille</b> où un agent peut "
  "créer et analyser des fichiers. Toutes les opérations sont cantonnées à la racine de la "
  "sandbox (anti-traversée de chemin, quota d'espace, versioning).")
p("C'est une sandbox <b>applicative</b>, pas une isolation noyau : elle protège contre un "
  "agent qui dérape ou un fichier piégé, à condition de ne pas exposer d'exécution de "
  "commandes ni de réseau arbitraire.")
h2("Accès depuis les workflows")
p("Les blocs <code>read_file</code> et <code>write_file</code> de Fluxo savent viser une "
  "sandbox nommée (via le pont Lumen, qui conserve quota et versioning) ou se confiner "
  "directement au dossier de l'agent.")

# ============================ 7. FLUXO ============================
S.append(PageBreak())
h1("7. Fluxo — moteur d'automatisation")
p("Fluxo enchaîne des <b>blocs</b> (actions) en workflows, conçus dans le Designer en "
  "glisser-déposer. Un modèle compatible function calling peut déclencher lui-même vos "
  "workflows. Le moteur communique avec Lumen via un serveur loopback local "
  "(<code>http://127.0.0.1:8765</code>).")
h2("Quelques blocs Lumen")
kvtable([
    ["Bloc", "Rôle"],
    ["Notification Lumen", "Pousse une notification (bulle flottante + centre de notifications)."],
    ["Widget Lumen", "Affiche un widget structuré (gabarit + titre + données JSON) dans la discussion."],
    ["Générer une image", "Bonsai local ou OpenAI ; enregistre le fichier dans une sandbox."],
    ["Consolider la mémoire", "Digère les souvenirs épisodiques récents en connaissances durables."],
    ["Rechercher dans les connaissances", "Recherche RAG ; renvoie les extraits pertinents pour la suite du workflow."],
    ["Lancer un agent", "Déclenche un agent (chaîne de skills) — idéal depuis le Heartbeat."],
])

# ============================ 8. CALENDRIER & RAPPELS ============================
S.append(PageBreak())
h1("8. Calendrier & rappels")
p("L'app Calendrier affiche une grille mensuelle agrégeant vos <b>rappels datés</b> et les "
  "<b>tâches programmées des agents</b> (en lecture seule, badge agent).")
h2("Rappels qui se déclenchent")
p("Un rappel a un titre, une note, une échéance horodatée et une récurrence (aucune, "
  "quotidienne, hebdomadaire, mensuelle). Un ticker d'arrière-plan vérifie les échéances "
  "toutes les 30 secondes et déclenche une notification (cloche + pulsation de l'orbe) à "
  "terme. Les rappels manqués hors-ligne sont rattrapés ; les récurrents se ré-arment.")
h2("Création par l'IA et les agents")
bullets([
    "Assistant de la barre : l'outil <code>create_reminder</code> crée un rappel daté à partir du langage naturel (« rappelle-moi demain 9h »).",
    "Agents / blocs Fluxo : la route loopback <code>POST /reminders</code> permet de poser un rappel daté.",
])

# ============================ 9. BASE DE CONNAISSANCES (RAG) ============================
S.append(PageBreak())
h1("9. Base de connaissances (RAG)")
p("L'app Connaissances importe des documents (PDF, texte, Markdown, CSV, JSON, code) que "
  "Lumen découpe en extraits et vectorise <b>localement</b>, via le backend IA actif. "
  "L'assistant et les agents peuvent alors s'appuyer dessus.")
h2("Architecture")
p("Base vectorielle <b>SQLite + sqlite-vec</b> (fichier rag.db), portable sur toutes les "
  "plateformes, sans dépendance système. Les embeddings sont calculés par Ollama "
  "(<code>nomic-embed-text</code> par défaut) ou l'API cloud "
  "(<code>text-embedding-3-small</code>).")
h2("Recherche hybride")
p("La recherche combine deux approches pour de meilleurs résultats :")
bullets([
    "<b>Mot-clé (FTS5/BM25)</b> — prioritaire, idéale pour les noms propres et termes exacts.",
    "<b>Sémantique (cosinus)</b> — en complément, avec un seuil de pertinence pour écarter le hors-sujet.",
])
h2("Réglages d'embedding simplifiés")
kvtable([
    ["Découpage", "Usage"],
    ["Petit (~500 car.)", "Réponses précises : Q/R, fiches, annuaires."],
    ["Moyen (~1000 car.)", "Équilibré (défaut)."],
    ["Grand (~1800 car.)", "Conserve le contexte : prose, rapports."],
])
note("Changer de découpage ou de modèle d'embedding s'applique aux prochains imports. Le "
     "bouton Réindexer reconstruit l'index à partir du texte déjà stocké, sans réimport.")
h2("Accès IA")
p("L'assistant utilise l'outil <code>search_documents</code> ; les workflows utilisent le "
  "bloc « Rechercher dans les connaissances » ; les agents passent par "
  "<code>POST /rag/search</code>.")

# ============================ 10. LUMEN OS & MEMOIRE ============================
S.append(PageBreak())
h1("10. Lumen OS & mémoire")
p("<b>Lumen OS</b> est le bureau immersif : fenêtres, widgets, menu Démarrer, et l'assistant "
  "intégré. Les apps s'y ouvrent en fenêtres. Le thème (clair/sombre) et la couleur d'accent "
  "sont partagés avec le reste de Lumen.")
h2("Mémoire cognitive")
p("La mémoire de Lumen comporte <b>8 types</b> (dont épisodique et prospective) avec une "
  "politique d'accès cloisonnée : un contexte (barre, agent, bloc) ne lit/écrit que les types "
  "autorisés. Le rappel est pondéré (pertinence + récence + saillance). L'app Mémoire permet "
  "de consulter, épingler, modifier et oublier des souvenirs.")
h2("Profil utilisateur")
p("Le profil (prénom, façon de s'adresser, style de réponse, centres d'intérêt, objectifs) "
  "est stocké localement et accessible à l'assistant pour personnaliser ses réponses.")

# ============================ 11. DOMOTIQUE & COMPAGNON ============================
S.append(PageBreak())
h1("11. Domotique & compagnon iPhone")
h2("Domotique")
p("L'app Domotique gère des objets connectés et leurs firmwares (ESP32 / Pico, MicroPython), "
  "via un protocole local léger. Les agents et workflows peuvent lire l'état d'un objet et "
  "envoyer des commandes sécurisées en local.")
h2("Compagnon iPhone")
p("Depuis Safari sur l'iPhone (même réseau Wi-Fi ou VPN), ouvrez l'adresse affichée dans "
  "Réglages → Compagnon pour piloter Lumen à distance. L'accès est protégé par un code à "
  "usage unique (TOTP) ; une session est ensuite mémorisée sur le téléphone. La voix "
  "(énoncer / dictée) est gérée par l'iPhone.")

# ============================ 12. API DEVELOPPEUR ============================
S.append(PageBreak())
h1("12. API développeur (loopback)")
p("Lumen expose un serveur local sur <code>http://127.0.0.1:8765</code> (loopback "
  "uniquement, jamais le réseau). Quelques routes utiles aux raccourcis, agents et blocs "
  "Fluxo :")
kvtable([
    ["Route", "Description"],
    ["GET/PUT/POST/DELETE /mem/<clé>", "Mémoire partagée (namespaces todo/ state/ user/ store/)."],
    ["POST /notify", "Notification flottante."],
    ["POST /agent/run", "Déclenche un agent."],
    ["POST /agent/task", "Ajoute une tâche à la todo d'un agent."],
    ["GET/POST /reminders", "Liste / crée un rappel daté."],
    ["POST /rag/search", "Recherche dans la base de connaissances."],
    ["POST /run/progress", "Callback de progression d'un run (mode Action)."],
])
note("Ces routes ne sont servies que sur le loopback : inaccessibles hors de la machine par "
     "construction. L'accès web pour l'IA reste volontairement sous contrôle de l'utilisateur "
     "(via Fluxo et skills) pour éviter les risques d'injection.")

gap(14)
S.append(Paragraph("— Fin de la documentation Lumen —", styles["LCoverSub"]))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(20*mm, 12*mm, "Lumen — Documentation")
    canvas.drawRightString(A4[0] - 20*mm, 12*mm, "Page %d" % doc.page)
    canvas.setStrokeColor(colors.HexColor("#e2e2e8"))
    canvas.line(20*mm, 15*mm, A4[0] - 20*mm, 15*mm)
    canvas.restoreState()


doc = SimpleDocTemplate(OUT, pagesize=A4, topMargin=20*mm, bottomMargin=20*mm,
                        leftMargin=20*mm, rightMargin=20*mm,
                        title="Lumen — Documentation", author="Lumen")
doc.build(S, onFirstPage=lambda c, d: None, onLaterPages=footer)
print("PDF écrit :", OUT)
