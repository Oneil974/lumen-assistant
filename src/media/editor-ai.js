// Assistant de montage : le volet IA partagé (lib/ai-prompt.js) avec les
// outils du studio. Les mêmes outils servent aux App Intents : l'assistant
// principal de Lumen peut demander « fais un reel de mes photos de vacances »
// sans que Médias soit ouverte — Lumen ouvre l'app et lui remet l'intention.

import { mountAiPrompt, runAiTools, tool, T } from "../lib/ai-prompt.js?v=5";
import { tt } from "../apps-i18n.js";
import { FILTER_PRESETS, TEXT_PRESETS, TRANSITIONS, MOTIONS, TEXT_ANIMS_IN, TEXT_ANIMS_OUT } from "./editor-catalog.js";

const ids = (list) => list.map((x) => x.id);
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const POS = { top: 0.14, center: 0.5, middle: 0.5, bottom: 0.84, haut: 0.14, centre: 0.5, bas: 0.84 };

export function buildTools() {
  return [
    tool("get_project", "État complet du montage : clips (id, fichier, début, durée), incrustations, textes, pistes audio, repères, format.", {}),
    tool("list_media", "Liste les fichiers vidéo/photo/musique des sandboxes, utilisables dans le montage.", {
      kind: T.enum(["all", "video", "image", "audio"], "Type de média"), query: T.str("Filtre sur le nom (optionnel)"),
    }),
    tool("add_media", "Ajoute un fichier de la bibliothèque au montage. track=main (piste principale, enchaînée), overlay (incrustation par-dessus) ou audio.", {
      file: T.str("Nom ou chemin du fichier (cf. list_media)"), track: T.enum(["main", "overlay", "audio"], "Piste"),
      at: T.num("Position en secondes (facultatif)"), audio_kind: T.enum(["music", "voice", "sfx"], "Pour l'audio"), duration: T.num("Durée à l'écran pour une photo (s)"),
    }, ["file"]),
    tool("remove_items", "Supprime des éléments du montage par identifiant.", { ids: T.list("Identifiants (cf. get_project)") }, ["ids"]),
    tool("update_clip", "Modifie un clip ou une incrustation : découpe (in/out en s dans le fichier), durée (photo), vitesse, volume (0-2), muet, cadrage, fondus, mouvement, échelle, position, rotation, opacité.", {
      id: T.str("Identifiant"), in: T.num("Début dans le fichier (s)"), out: T.num("Fin dans le fichier (s)"), duration: T.num("Durée d'une photo/couleur (s)"),
      speed: T.num("Vitesse 0.25-4"), volume: T.num("0 à 2"), mute: T.bool("Couper le son"), fit: T.enum(["cover", "contain"], "Cadrage"),
      fade_in: T.num("Fondu d'entrée (s)"), fade_out: T.num("Fondu de sortie (s)"), motion: T.enum(ids(MOTIONS), "Mouvement de caméra"),
      scale: T.num("Échelle (1 = normal)"), x: T.num("Décalage horizontal -1..1"), y: T.num("Décalage vertical -1..1"), rotate: T.num("Degrés"), opacity: T.num("0..1"),
      start: T.num("Début sur la timeline (incrustations et audio)"),
    }, ["id"]),
    tool("move_clip", "Déplace un clip de la piste principale à une autre place (index 0 = premier).", { id: T.str("Identifiant"), index: T.int("Nouvelle position") }, ["id", "index"]),
    tool("split", "Coupe le clip (ou l'élément indiqué) au temps donné.", { time: T.num("Temps en secondes sur la timeline"), id: T.str("Élément à couper (facultatif)") }, ["time"]),
    tool("add_text", "Ajoute un texte à l'écran.", {
      text: T.str("Texte (\\n pour un retour à la ligne)"), start: T.num("Début (s)"), end: T.num("Fin (s)"),
      style: T.enum(ids(TEXT_PRESETS), "Style prêt à l'emploi"), position: T.enum(["top", "center", "bottom"], "Position verticale"),
      color: T.str("Couleur CSS (facultatif)"), size: T.num("Taille (64 = normal)"), anim_in: T.enum(ids(TEXT_ANIMS_IN), "Animation d'entrée"), anim_out: T.enum(ids(TEXT_ANIMS_OUT), "Animation de sortie"),
    }, ["text"]),
    tool("update_text", "Modifie un texte existant.", {
      id: T.str("Identifiant"), text: T.str("Nouveau texte"), start: T.num("Début (s)"), end: T.num("Fin (s)"), style: T.enum(ids(TEXT_PRESETS), "Style"),
      position: T.enum(["top", "center", "bottom"], "Position"), color: T.str("Couleur"), size: T.num("Taille"), anim_in: T.enum(ids(TEXT_ANIMS_IN), "Entrée"), anim_out: T.enum(ids(TEXT_ANIMS_OUT), "Sortie"),
    }, ["id"]),
    tool("add_sticker", "Ajoute un emoji animé à l'écran.", { emoji: T.str("Emoji"), start: T.num("Début (s)"), end: T.num("Fin (s)") }, ["emoji"]),
    tool("apply_filter", "Applique un filtre couleur à un clip, ou à tous (target=\"all\").", { target: T.str("Identifiant ou \"all\""), preset: T.enum(ids(FILTER_PRESETS), "Filtre") }, ["target", "preset"]),
    tool("set_transition", "Pose une transition après un clip (vers le suivant), ou à toutes les jonctions (target=\"all\").", { target: T.str("Identifiant du clip ou \"all\""), type: T.enum(ids(TRANSITIONS), "Transition"), duration: T.num("Durée (s), 0.5 par défaut") }, ["target", "type"]),
    tool("set_format", "Règle le format du montage.", { aspect: T.enum(["16:9", "9:16", "1:1", "4:5", "4:3", "21:9"], "Format (9:16 = Reels/TikTok)"), quality: T.int("480, 720, 1080, 1440 ou 2160"), fps: T.int("24, 25, 30 ou 60"), background: T.enum(["black", "color", "blur"], "Remplissage des bords"), title: T.str("Titre du projet") }),
    tool("auto_captions", "Génère les sous-titres automatiques (transcription locale Whisper) des clips parlés et voix off.", { style: T.enum(["caption", "subtitle", "highlight", "plain"], "Style des légendes") }),
    tool("remove_silences", "Coupe les silences des clips vidéo (tous, ou celui indiqué).", { id: T.str("Clip (facultatif)"), min_silence: T.num("Durée minimale d'un silence (s), 0.6 par défaut") }),
    tool("beat_sync", "Repère les temps forts de la musique et y cale les changements de photo.", { music_id: T.str("Piste musicale (facultatif)") }),
    tool("add_voiceover", "Crée une voix off de synthèse lisant un texte, posée au temps donné.", { text: T.str("Texte à lire"), at: T.num("Position (s)") }, ["text"]),
    tool("auto_montage", "Montage automatique : ajoute des fichiers puis pose transitions, filtre, mouvements, titre et musique selon un style.", {
      files: T.list("Fichiers à ajouter (noms, facultatif : sinon les clips déjà présents)"), style: T.enum(["dynamic", "vlog", "cinematic", "calm"], "Style"),
      music: T.str("Musique (nom de fichier, facultatif)"), title: T.str("Titre affiché au début"), duration: T.num("Durée visée (s)"), aspect: T.enum(["16:9", "9:16", "1:1", "4:5"], "Format"),
    }),
    tool("export_video", "Exporte la vidéo finale en MP4 dans une sandbox (temps réel : dure autant que le montage).", { quality: T.int("Résolution (720, 1080…)") }),
    tool("undo", "Annule la dernière modification.", {}),
  ];
}

/** Retrouve un fichier de la bibliothèque à partir d'un nom approximatif. */
export function findFile(api, name, kind = "") {
  const files = api.files().filter((f) => !kind || f.kind === kind || (kind === "visual" && f.kind !== "audio"));
  const q = norm(name);
  if (!q) return null;
  return files.find((f) => f.path === name || f.name === name)
    || files.find((f) => norm(f.name) === q)
    || files.find((f) => norm(f.name).includes(q) || norm(f.path).includes(q))
    || files.find((f) => q.split(" ").every((w) => norm(f.path).includes(w)))
    || null;
}

export async function executeTool(api, name, a = {}) {
  const P = api.P;
  const M = api.model;
  const one = (id) => M.findItem(api.P, id);
  switch (name) {
    case "get_project":
      return JSON.stringify({ ...api.describe(), playhead: Math.round(api.t * 100) / 100 });
    case "list_media": {
      const q = norm(a.query);
      const out = api.files().filter((f) => (!a.kind || a.kind === "all" || f.kind === a.kind) && (!q || norm(f.path).includes(q))).slice(0, 80)
        .map((f) => ({ name: f.name, path: f.path, sandbox: f.sandbox, kind: f.kind }));
      return out.length ? JSON.stringify(out) : "Aucun média trouvé.";
    }
    case "add_media": {
      const f = findFile(api, a.file, a.track === "audio" ? "audio" : "");
      if (!f) return `Fichier introuvable : ${a.file}. Utilise list_media.`;
      const item = await api.add(f, { track: f.kind === "audio" ? "audio" : a.track || "main", at: a.at, audioKind: a.audio_kind, dur: a.duration, silent: true });
      return item ? `Ajouté (id ${item.id}).` : "Échec de l'ajout.";
    }
    case "remove_items":
      api.removeItems(a.ids || []);
      return `Supprimé : ${(a.ids || []).length} élément(s).`;
    case "update_clip": {
      const f = one(a.id);
      if (!f || f.type === "text") return "Identifiant inconnu.";
      api.change(() => {
        const it = f.item;
        if (a.in != null) it.in = Math.max(0, a.in);
        if (a.out != null) it.out = Math.max(it.in + 0.1, a.out);
        if (a.duration != null && it.kind !== "video") it.dur = Math.max(0.2, a.duration);
        if (a.speed != null) it.speed = Math.max(0.25, Math.min(4, a.speed));
        if (a.volume != null) it.volume = Math.max(0, Math.min(2, a.volume));
        if (a.mute != null) it.mute = !!a.mute;
        if (a.start != null && "start" in it) it.start = Math.max(0, a.start);
        if (f.type === "audio") return;
        if (a.fit) it.fit = a.fit;
        if (a.fade_in != null) it.fadeIn = Math.max(0, a.fade_in);
        if (a.fade_out != null) it.fadeOut = Math.max(0, a.fade_out);
        if (a.motion) it.motion = a.motion;
        if (a.scale != null) it.transform.scale = a.scale;
        if (a.x != null) it.transform.x = a.x;
        if (a.y != null) it.transform.y = a.y;
        if (a.rotate != null) it.transform.rotate = a.rotate;
        if (a.opacity != null) it.transform.opacity = a.opacity;
      });
      return "Clip modifié.";
    }
    case "move_clip": {
      const c = P.clips.find((x) => x.id === a.id);
      if (!c) return "Clip inconnu.";
      api.change((p) => { p.clips.splice(p.clips.indexOf(c), 1); p.clips.splice(Math.max(0, Math.min(p.clips.length, a.index | 0)), 0, c); });
      return "Clip déplacé.";
    }
    case "split": {
      if (a.id) api.select({ type: one(a.id)?.type || "clip", id: a.id });
      const b = api.split(Number(a.time) || 0);
      return b ? `Coupé ; nouvel élément ${b.id || ""}.` : "Rien à couper à ce temps.";
    }
    case "add_text": {
      const start = a.start ?? api.t;
      const patch = {};
      if (a.position) patch.y = POS[a.position] ?? 0.5;
      if (a.color) patch.color = a.color;
      if (a.size) patch.size = a.size;
      if (a.anim_in || a.anim_out) patch.anim = { in: a.anim_in || "fade", out: a.anim_out || "fade", dur: 0.35 };
      const x = api.addText({ preset: a.style || "plain", text: a.text, start, end: a.end ?? start + 3, patch });
      return `Texte ajouté (id ${x.id}).`;
    }
    case "update_text": {
      const f = one(a.id);
      if (!f || f.type !== "text") return "Texte inconnu.";
      api.change(() => {
        const x = f.item;
        if (a.style) { const p = TEXT_PRESETS.find((s) => s.id === a.style); if (p) Object.assign(x, structuredClone(p.s), { preset: p.id }); }
        if (a.text != null) x.text = a.text;
        if (a.start != null) x.start = Math.max(0, a.start);
        if (a.end != null) x.end = Math.max(x.start + 0.2, a.end);
        if (a.position) x.y = POS[a.position] ?? x.y;
        if (a.color) x.color = a.color;
        if (a.size) x.size = a.size;
        if (a.anim_in) x.anim = { ...x.anim, in: a.anim_in };
        if (a.anim_out) x.anim = { ...x.anim, out: a.anim_out };
      });
      return "Texte modifié.";
    }
    case "add_sticker": {
      const x = api.addSticker(a.emoji || "✨");
      if (a.start != null || a.end != null) api.change(() => { if (a.start != null) x.start = a.start; x.end = a.end ?? x.start + 3; });
      return `Sticker ajouté (id ${x.id}).`;
    }
    case "apply_filter": {
      const { filterFromPreset } = await import("./editor-catalog.js");
      const list = a.target === "all" ? [...P.clips, ...P.overlays] : [one(a.target)?.item].filter(Boolean);
      if (!list.length) return "Cible inconnue.";
      api.change(() => { for (const c of list) c.filter = filterFromPreset(a.preset); });
      return `Filtre « ${a.preset} » appliqué à ${list.length} clip(s).`;
    }
    case "set_transition": {
      const dur = a.duration || 0.5;
      const tr = a.type === "none" ? null : { type: a.type, dur };
      if (a.target === "all") { api.change((p) => { p.clips.forEach((c, i) => { c.transition = i < p.clips.length - 1 ? (tr && { ...tr }) : null; }); }); return "Transition posée à toutes les jonctions."; }
      const c = P.clips.find((x) => x.id === a.target);
      if (!c) return "Clip inconnu.";
      api.change(() => { c.transition = tr; });
      return "Transition posée.";
    }
    case "set_format":
      api.change((p) => {
        if (a.aspect && M.ASPECTS[a.aspect]) p.aspect = a.aspect;
        if (a.quality) p.quality = a.quality;
        if (a.fps) p.fps = a.fps;
        if (a.background) p.bg.mode = a.background;
        if (a.title) p.title = a.title;
      });
      api.resize();
      if (a.title) { const ti = document.getElementById("ed-title"); if (ti) ti.value = a.title; }
      return "Format mis à jour.";
    case "auto_captions": {
      const n = await api.autoCaptions({ preset: a.style || "caption" });
      return n ? `${n} sous-titres ajoutés.` : "Aucun sous-titre ajouté (pas de parole détectée ou Whisper indisponible).";
    }
    case "remove_silences": {
      const s = await api.removeSilences({ onlyId: a.id || null, minDur: a.min_silence || 0.6 });
      return s ? `Silences coupés : ${s} s gagnées.` : "Aucun silence coupé.";
    }
    case "beat_sync": {
      const r = await api.beatSync({ musicId: a.music_id || null });
      return r ? `Rythme ≈ ${r.bpm} BPM, ${r.beats} repères ; photos calées.` : "Pas de musique à analyser.";
    }
    case "add_voiceover": {
      const it = await api.ttsVoice(a.text, a.at ?? api.t);
      return it ? `Voix off ajoutée (id ${it.id}).` : "Voix de synthèse indisponible.";
    }
    case "auto_montage": {
      const files = (a.files || []).map((n) => findFile(api, n, "visual")).filter(Boolean);
      const music = a.music ? findFile(api, a.music, "audio") : null;
      const out = await api.autoMontage({ files, style: a.style || "dynamic", music, title: a.title || "", duration: a.duration || 0, aspect: a.aspect || "" });
      return out ? `Montage prêt : ${out.clips.length} clips, ${out.duration} s.` : "Rien à monter.";
    }
    case "export_video": {
      if (a.quality) api.change((p) => { p.quality = a.quality; });
      const r = await api.exportVideo({});
      return r ? `Vidéo exportée : ${r.sandbox}/${r.path}` : "Export interrompu.";
    }
    case "undo":
      api.undo();
      return "Dernière modification annulée.";
    default:
      return `Outil inconnu : ${name}`;
  }
}

function contextText(api) {
  const d = api.describe();
  const lib = api.files();
  const by = (k) => lib.filter((f) => f.kind === k).length;
  return `Projet : ${JSON.stringify(d)}
Tête de lecture : ${Math.round(api.t * 10) / 10} s.
Bibliothèque : ${by("video")} vidéos, ${by("image")} photos, ${by("audio")} musiques. Exemples : ${lib.slice(0, 25).map((f) => f.name).join(", ")}`;
}

const RULES = `- Les temps sont en secondes sur la timeline ; get_project donne les identifiants à utiliser.
- Pour un format vertical (Reels, TikTok, Shorts) : set_format aspect 9:16.
- Pour « fais un montage / une vidéo avec… », préfère auto_montage puis ajuste.
- N'exporte (export_video) que si l'utilisateur le demande explicitement.`;

export function mountEditorAI(api) {
  const opts = {
    app: "Montage vidéo",
    className: "media-ai",
    title: tt("Assistant de montage"),
    intro: "Tu es monteur vidéo : tu construis et retouches le montage de l'utilisateur dans l'éditeur (pistes, coupes, textes, transitions, filtres, musique, sous-titres).",
    placeholder: tt("Ex. : fais un reel 9:16 de 30 s avec mes photos, transitions dynamiques et musique"),
    rules: RULES,
    suggestions: [
      { label: tt("Montage auto"), prompt: "Fais un montage dynamique avec les clips de la timeline, un titre et une musique de ma bibliothèque." },
      { label: tt("Sous-titres"), prompt: "Ajoute des sous-titres automatiques style légende TikTok." },
      { label: tt("Format Reels"), prompt: "Passe le montage en 9:16 avec un fond flou et des textes lisibles." },
      { label: tt("Plus cinéma"), prompt: "Donne un rendu cinématographique : filtre, fondus au noir, titre élégant." },
    ],
    tools: buildTools(),
    execute: (name, args) => executeTool(api, name, args),
    context: () => contextText(api),
    maxTurns: 12,
  };
  const dock = mountAiPrompt(null, opts);
  registerIntents(api, opts);
  return dock;
}

/** App Intents déclarés au manifeste (scripts/app-packages.mjs). */
function registerIntents(api, opts) {
  const intents = window.lumen?.intents;
  if (!intents) return;
  const on = (id, fn) => intents.on(id, fn).catch(() => {});
  on("media_edit", async ({ instruction }) => {
    const answer = await runAiTools(opts, String(instruction || ""), () => {});
    return answer || "Montage mis à jour.";
  });
  on("media_create_montage", async (a = {}) => {
    let files = (a.files || []).map((n) => findFile(api, n, "visual")).filter(Boolean);
    if (!files.length && a.query) {
      const q = norm(a.query);
      files = api.files().filter((f) => f.kind !== "audio" && q.split(" ").some((w) => w.length > 2 && norm(f.path).includes(w))).slice(0, 40);
    }
    const music = a.music ? findFile(api, a.music, "audio") : null;
    const out = await api.autoMontage({ files, style: a.style || "dynamic", music, title: a.title || "", duration: a.duration || 0, aspect: a.aspect || "" });
    if (a.captions) await api.autoCaptions({});
    return out ? `Montage « ${api.P.title} » prêt dans Médias : ${out.clips.length} clips, ${out.duration} s.` : "Aucun média trouvé pour ce montage.";
  });
  on("media_export", async (a = {}) => {
    if (a.quality) api.change((p) => { p.quality = a.quality; });
    const r = await api.exportVideo({});
    return r ? `Vidéo exportée : ${r.sandbox}/${r.path}` : "Export interrompu.";
  });
  on("media_project", async () => JSON.stringify(api.describe()));
}
