// Pont frontend <-> orbe physique (ESP32). Backend : src-tauri/src/orb_bridge.rs.
//
// - Gère DEUX liens indépendants, chacun avec sa propre adresse :
//     localStorage.setItem('orbBridgeHost', '192.168.x.x')   // orbe ESP32
//     localStorage.setItem('controllerHost', '192.168.x.y')  // Lumen Controller
//     (+ 'orbBridgePort' / 'controllerPort', 8787 par défaut)
//   puis window.OrbBridge.connect()  (ou recharge l'app).
//   Les deux appareils parlent le même protocole mais sont des machines
//   distinctes : ils fonctionnent désormais en même temps.
// - Reçoit les commandes de l'orbe (dictée, veille/réveil) et
//   déclenche la dictée (#btn-dictation).
// - Pousse l'état de l'orbe logiciel (thème / mode / niveau audio) vers l'orbe
//   physique via les accroches de orb.js (pushMode / pushTheme / pushLevel).

const core = window.__TAURI__ && window.__TAURI__.core;
const evt = window.__TAURI__ && window.__TAURI__.event;

if (core && evt) {
  const invoke = core.invoke;

  // Personnages Lumen → palette compatible du firmware ESP (themes.py).
  const THEME_MAP = {
    'soft-white': 'mono', 'soft-sky': 'ocean', 'soft-mint': 'aurora',
    'soft-coral': 'ember', 'soft-violet': 'violet', 'soft-amber': 'ember',
    'soft-raspberry': 'raspberry',
    rubis: 'ember', amber: 'ember', dark: 'mono', violet: 'violet',
    rose: 'violet', ice: 'ocean', sky: 'ocean', default: 'aurora',
  };
  const espTheme = (name) => THEME_MAP[name] || 'aurora';
  const espMode = (s) =>
    s === 'speaking' ? 'speaking'
    : (s === 'listening' || s === 'thinking') ? 'listening'
    : 'idle';

  // Un lien par appareil. `connected` seul obligeait à choisir entre l'orbe
  // et le contrôleur, qui parlent pourtant le même protocole sur deux machines.
  const connectedTo = { orb: false, controller: false };
  let lastMode = null, lastRawMode = null, lastTheme = null, lastLevelT = 0;
  // Capacités annoncées par le pair dans son message "hello". null tant qu'on
  // n'a rien reçu : l'orbe ESP32 n'en envoie pas, on reste donc permissif.
  let peerCapabilities = null;
  let lastContext = '';
  let lastActivity = '';

  // Outil -> pictogramme dessiné par le firmware (m5fire-orb/orb.py _act_icon).
  function toolIcon(name) {
    const n = String(name || '');
    if (/weather|air_quality/.test(n)) return 'weather';
    if (/^mail_/.test(n)) return 'mail';
    if (/agenda|reminder|calendar|day_overview|kanban/.test(n)) return 'calendar';
    if (/^notes_/.test(n)) return 'notes';
    if (/^memory_/.test(n)) return 'memory';
    if (/^web_|news/.test(n)) return 'web';
    if (/^domotique_/.test(n)) return 'home';
    if (/^sandbox_|^doc_|export_pdf/.test(n)) return 'files';
    if (/^agent_/.test(n)) return 'agent';
    if (/search|apps_|app_data|query_tables|tables_list|search_documents/.test(n)) return 'search';
    return 'tool';
  }
  const TOOL_LABELS = {
    weather: 'Meteo', mail: 'Mes mails', calendar: 'Mon agenda', notes: 'Mes notes',
    memory: 'Ma memoire', web: 'Recherche web', home: 'Domotique', files: 'Mes fichiers',
    agent: 'Agent', search: 'Recherche', tool: 'Outil',
  };
  function toolLabel(name) {
    const n = String(name || '');
    if (n === 'day_overview') return 'Ma journee';
    if (n === 'lumen_search') return 'Recherche partout';
    if (n === 'memory_remember') return 'Je retiens';
    return TOOL_LABELS[toolIcon(n)] || n.slice(0, 20);
  }

  // RÔLE réellement identifié derrière chaque champ de configuration.
  //
  // Le champ dans lequel l'utilisateur a saisi une adresse ne dit pas quel
  // appareil s'y trouve : historiquement il n'y en avait qu'un, et un
  // contrôleur peut donc être renseigné dans le champ « orbe ». S'y fier
  // envoyait l'audio de l'orbe au contrôleur, et surtout privait celui-ci de
  // l'état et du catalogue — modèles divergents, badge de voix absent.
  //
  // Le contrôleur s'annonce par un "hello" dès la connexion : on s'en sert
  // pour l'identifier, quel que soit le champ utilisé.
  const roleOf = { orb: null, controller: null };

  function slotFor(role) {
    for (const slot of Object.keys(roleOf)) {
      if (roleOf[slot] === role) return slot;      // appareil identifié
    }
    // Personne ne s'est annoncé pour ce rôle : on retombe sur le champ du même
    // nom, sauf s'il abrite manifestement autre chose.
    return roleOf[role] && roleOf[role] !== role ? null : role;
  }

  // `role` vaut 'orb' ou 'controller'; '*' diffuse à tous les liens ouverts,
  // ce qui est le cas des messages d'état, que les deux appareils affichent.
  // Mise à jour OTA en cours : on ne pousse RIEN d'autre à l'orbe (niveaux,
  // thème, activités, alertes) — elle a besoin de tout son temps pour écrire.
  let otaActive = false;
  let otaGuard = null;
  evt.listen('orb-ota-progress', () => {
    otaActive = true;
    clearTimeout(otaGuard);
    otaGuard = setTimeout(() => { otaActive = false; }, 20000);   // filet si l'OTA s'interrompt
  });
  evt.listen('orb-ota-done', () => {
    // L'orbe redémarre : on reste discret le temps qu'elle revienne.
    clearTimeout(otaGuard);
    otaGuard = setTimeout(() => { otaActive = false; }, 8000);
  });

  async function send(obj, role = 'orb') {
    if (otaActive && role !== 'controller') return;
    if (role === '*') {
      await Promise.all(Object.keys(connectedTo)
        .filter((slot) => connectedTo[slot])
        .map((slot) => sendToSlot(obj, slot)));
      return;
    }
    const slot = slotFor(role);
    if (!slot || !connectedTo[slot]) return;
    await sendToSlot(obj, slot);
  }

  async function sendToSlot(obj, slot) {
    try {
      await invoke('orb_send', { line: JSON.stringify(obj), device: slot });
    } catch (e) {
      connectedTo[slot] = false;
      const link = LINKS[slot];
      if (link && link.timer) { clearInterval(link.timer); link.timer = null; }
    }
  }

  const OrbBridge = {
    pushMode(s) {
      // `mode` reste le vocabulaire réduit de l'orbe ESP32 (3 animations),
      // qui écrase notamment `thinking` en `listening`. Le Lumen Controller
      // affiche du texte : il lui faut l'état BRUT, sinon la réflexion
      // s'affiche « Listening ». On envoie donc les deux, et le contrôleur
      // préfère `status` quand il est présent.
      const m = espMode(s);
      const raw = String(s || 'idle');
      if (m !== lastMode || raw !== lastRawMode) {
        lastMode = m;
        lastRawMode = raw;
        send({ mode: m, status: raw }, '*');   // les deux l'affichent
      }
    },
    // État transitoire que orb.js ne connaît pas (chargement d'un modèle en
    // mémoire). Affiché tel quel par le contrôleur.
    pushBusy(label) {
      const raw = String(label || 'idle');
      if (raw === lastRawMode) return;
      lastRawMode = raw;
      lastMode = null;              // force le prochain pushMode à réémettre
      send({ mode: espMode(raw), status: raw }, '*');
    },
    // Fuseau de l'orbe : celui de la zone météo si connue, sinon celui du Mac.
    pushTz() {
      let tz = -new Date().getTimezoneOffset() * 60;
      try {
        const c = JSON.parse(localStorage.getItem('orbWeatherCache') || 'null');
        if (c && c.data && typeof c.data.utc_offset === 'number') tz = c.data.utc_offset;
      } catch (e) {}
      send({ tz });
    },
    // Bip seul (pas d'écran) : connexion, etc.
    pushChime(kind = 'connect') {
      send({ chime: String(kind) });
    },
    pushTheme(name) {
      const th = espTheme(name);
      if (th !== lastTheme) { lastTheme = th; send({ theme: th }); }
    },
    pushLevel(level, state) {
      if (espMode(state) !== 'speaking') return;
      const now = Date.now();
      if (now - lastLevelT < 40) return;        // ~25 Hz max
      lastLevelT = now;
      send({ level: Math.max(0, Math.min(1, level)) });
    },
    pushNotification(notification, count = 1) {
      const n = notification && typeof notification === 'object'
        ? notification
        : { text: String(notification || ''), count };
      // Couleur des notifications lumineuses, choisie dans Réglages →
      // Notifications. Le Lumen Controller en fait un pulse sur son bandeau ;
      // l'orbe ESP32, qui ne connaît pas la clé, l'ignore.
      const stored = localStorage.getItem('notifLedColor') || '';
      const color = /^#[0-9a-f]{6}$/i.test(n.color || '') ? n.color
        : (/^#[0-9a-f]{6}$/i.test(stored) ? stored : '#ff9f0a');
      // Diffusé aux DEUX appareils : le contrôleur est le seul à porter des
      // LEDs adressables, et il n'était jusqu'ici jamais prévenu.
      send({ notification: {
        text: String(n.text || '').replace(/\s+/g, ' ').trim().slice(0, 700),
        source: String(n.source || 'Lumen').slice(0, 20),
        success: n.success !== false,
        timestamp: String(n.timestamp || '').slice(0, 16),
        count: Math.max(1, (n.count ?? count) | 0),
        color,
      }}, '*');
    },
    pushMessage(message) {
      send({ message: String(message || '').replace(/\s+/g, ' ').trim().slice(0, 700) });
    },
    // Activité affichée sous l'orbe (icône + libellé) : réflexion, outil,
    // transcription, réponse. `name` = nom d'outil pour kind 'tool'.
    pushActivity(kind, label = '', name = '') {
      const icon = kind === 'tool' ? toolIcon(name) : '';
      const text = String(label || (kind === 'tool' ? toolLabel(name) : '')).replace(/\s+/g, ' ').trim().slice(0, 40);
      const key = kind + '|' + icon + '|' + text;
      if (key === lastActivity) return;
      lastActivity = key;
      send({ activity: { kind, icon, label: text } });
    },
    // Texte de la réponse rangé sur l'orbe SANS quitter l'accueil (Menu >
    // Conversation pour le relire) : l'orbe reste visible pendant qu'elle parle.
    pushCaption(text) {
      send({ caption: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 700) });
    },
    pushMicResult(text = '', ok = true, error = '') {
      send({ mic_result: {
        text: String(text || '').slice(0, 180),
        ok: !!ok,
        error: String(error || '').slice(0, 180),
      }});
    },
    async pushWav(path) {
      const orbSlot = slotFor('orb');
      if (!orbSlot || !connectedTo[orbSlot] || !path) return false;
      // orb_send_wav écrit le WAV en BINAIRE BRUT à la suite de son en-tête
      // JSON, sur la même socket. Seul un pair qui sait basculer en lecture
      // brute peut l'encaisser : le Lumen Controller, lui, continue à faire
      // readline() et tente de parser du PCM, d'où un flot d'erreurs JSON.
      // Son "hello" n'annonce pas la capacité "audio" : on s'abstient.
      if (peerCapabilities && !peerCapabilities.includes('audio')) return false;
      try {
        await invoke('orb_send_wav', { path, device: orbSlot });
        return true;
      } catch (e) {
        console.warn('[OrbBridge] WAV', e);
        return false;
      }
    },
    // Occupation du contexte, affichée « CTX 2.5k/8k » sur le contrôleur.
    pushContext(used, total) {
      const u = Math.max(0, Math.round(Number(used) || 0));
      const total_ = Math.max(0, Math.round(Number(total) || 0));
      if (!total_) return;
      const key = u + '/' + total_;
      if (key === lastContext) return;   // un e-paper ne se redessine pas pour rien
      lastContext = key;
      send({ type: 'state', ctx_used: u, ctx_total: total_ }, 'controller');
    },
    // Débit de la dernière réponse, affiché sur l'écran du contrôleur.
    pushTokens(tps) {
      const value = Number(tps);
      if (!isFinite(value) || value <= 0) return;
      send({ type: 'state', tps: Math.round(value * 10) / 10 }, 'controller');
    },
    pushAgent(state = {}) {
      send({ agent: {
        active: !!state.active,
        count: Math.max(0, state.count | 0),
        task: String(state.task || '').slice(0, 80),
        agent_id: String(state.agent_id || '').slice(0, 24),
      }});
    },
    pushConnection(online) {
      send({ connected: !!online });
    },
    // Mode ASSOCIATION du lecteur RFID.
    //
    // En fonctionnement normal le contrôleur ne signale que les transitions :
    // un badge posé n'est envoyé qu'une fois, et ne repart qu'après un retrait.
    // Un écran d'association attendrait donc indéfiniment un badge déjà posé.
    // Tant qu'il est armé, le contrôleur réémet l'UID présent.
    pushRfidPairing(on) {
      send({ type: 'state', rfid_pairing: !!on }, 'controller');
    },
    // Compatibilité : `connected` a toujours désigné l'orbe (Voice Lab s'en
    // sert pour décider d'envoyer un WAV).
    get connected() {
      const slot = slotFor('orb');
      return !!slot && connectedTo[slot];
    },
    get links() { return { ...connectedTo }; },
    connect,
  };
  window.OrbBridge = OrbBridge;

  // --- Synchronisation d'état avec le Lumen Controller (ESP32 / Pico W) ---
  //
  // Le firmware applique les messages {"type":"state", ...} (net.py, Link.apply)
  // et ignore tout le reste. Sans cet envoi la synchro était à sens unique : la
  // molette poussait vers l'app, mais un changement de modèle fait DANS Lumen
  // ne remontait jamais au contrôleur, dont l'écran e-paper affichait donc
  // encore l'ancienne valeur.
  const SOURCE_TO_BACKEND = { shortcut: 'apple' };   // inverse de espSource

  // Modèle réellement en mémoire, pas seulement celui coché dans l'interface.
  // Charger un modèle dans Ollama ne modifie aucune clé localStorage: il faut
  // interroger /api/ps (ou l'état de llama-server) pour que l'écran suive.
  async function loadedModelName(backend) {
    try {
      if (backend === 'llama') {
        const status = await invoke('llama_status');
        if (status && status.running && status.model) return status.model;
      } else if (backend === 'ollama') {
        const ps = await invoke('ollama_get_json', {
          url: localStorage.getItem('ollamaUrl') || null,
          path: 'api/ps',
        });
        if (ps && Array.isArray(ps.models) && ps.models.length) {
          return ps.models[0].name || ps.models[0].model || '';
        }
      }
    } catch (e) { /* backend hors ligne: on retombe sur la sélection */ }
    return '';
  }

  async function controllerState() {
    const source = localStorage.getItem('aiSource') || 'ollama';
    const backend = SOURCE_TO_BACKEND[source] || source;
    const selected = (backend === 'api'
      ? localStorage.getItem('apiModel')
      : localStorage.getItem('selectedModel')) || '';
    // Priorité à la SÉLECTION, pas au modèle résident.
    //
    // Un badge RFID (ou le menu de la barre) change la sélection sans rien
    // charger : le modèle en mémoire reste l'ancien pendant plusieurs secondes.
    // Afficher le résident faisait donc croire que le badge n'avait rien fait.
    // Le résident ne sert plus que de repli, quand rien n'est sélectionné —
    // typiquement un modèle lancé hors de Lumen, par `ollama run`.
    const model = selected || (await loadedModelName(backend));
    let voice = '';
    try { voice = (await invoke('tts_active_voice')) || ''; } catch (e) { /* Piper absent */ }
    return {
      backend,
      // Nom EXACT, sans retirer `:latest`.
      //
      // Le contrôleur retrouve la position de la molette par
      // `catalogue.index(modele)`. Un nom raccourci n'y figure pas : il
      // repartait donc de l'index 0 à chaque cran et ne pouvait plus atteindre
      // que les deux premiers modèles, en boucle. L'écran, lui, raccourcit
      // déjà l'affichage de son côté.
      model: String(model),
      // Mode de discussion : setOllamaMode() le persiste sous cette clé.
      chat_mode: localStorage.getItem('ollamaMode') || 'chat',
      voice: String(voice),
    };
  }

  let lastPushedState = '';
  let statePending = false;
  async function pushControllerState(force) {
    // controllerState() interroge le backend: sans ce verrou, deux tics du
    // heartbeat pourraient se croiser et se marcher sur lastPushedState.
    // `send()` cible le contrôleur identifié : on vérifie qu'il y en a un.
    if (!slotFor('controller') || statePending) return;
    statePending = true;
    try {
      const s = await controllerState();
      if (!s.model || !slotFor('controller')) return;
      const key = [s.backend, s.model, s.chat_mode, s.voice].join(' ');
      if (!force && key === lastPushedState) return;
      lastPushedState = key;
      send({
        type: 'state', backend: s.backend, model: s.model,
        chat_mode: s.chat_mode, voice: s.voice,
      }, 'controller');
    } finally {
      statePending = false;
    }
  }
  OrbBridge.pushControllerState = pushControllerState;

  // Catalogue des modèles réellement disponibles -> molette du contrôleur.
  // Sans lui, le firmware ne fait défiler que la liste codée en dur de
  // config.py, qui ne correspond pas aux modèles installés.
  // Les listes sont bornées : le Pico W lit la ligne JSON entière en RAM.
  const CATALOG_MAX_ENTRIES = 32;   // aligné sur le plafond du firmware
  const CATALOG_MAX_NAME = 48;
  const trim = (names) => names
    .filter(Boolean)
    .map((n) => String(n).slice(0, CATALOG_MAX_NAME))
    .slice(0, CATALOG_MAX_ENTRIES);

  async function collectCatalog() {
    const models = {};
    try {
      const gguf = await invoke('llama_list_models');
      const names = trim((Array.isArray(gguf) ? gguf : []).map((m) => m && m.filename));
      if (names.length) models.llama = names;
    } catch (e) { /* llama.cpp non installé */ }
    try {
      const found = await invoke('ollama_list_models', {
        url: localStorage.getItem('ollamaUrl') || null,
      });
      const names = trim(Array.isArray(found) ? found : []);
      if (names.length) models.ollama = names;
    } catch (e) { /* Ollama hors ligne */ }
    // L'API n'expose pas de liste : le modèle configuré est la seule vérité.
    const apiModel = localStorage.getItem('apiModel');
    if (apiModel) models.api = [String(apiModel).slice(0, CATALOG_MAX_NAME)];
    return models;
  }

  // Voix de synthèse INSTALLÉES. Le catalogue complet contient aussi les voix
  // téléchargeables : les proposer à la molette ferait choisir une voix
  // inutilisable.
  async function collectVoices() {
    try {
      const catalog = await invoke('tts_catalog');
      if (!Array.isArray(catalog)) return [];
      return trim(catalog.filter((v) => v && v.installed).map((v) => v.id));
    } catch (e) {
      return [];
    }
  }

  let lastCatalog = '';
  async function pushCatalog(force) {
    if (!slotFor('controller')) return;
    let models, voices;
    try {
      [models, voices] = await Promise.all([collectCatalog(), collectVoices()]);
    } catch (e) { return; }
    if (!Object.keys(models).length && !voices.length) return;
    const payload = { type: 'catalog', models, voices };
    const key = JSON.stringify(payload);
    if (!force && key === lastCatalog) return;
    lastCatalog = key;
    send(payload, 'controller');
  }
  OrbBridge.pushCatalog = pushCatalog;

  // Commandes entrantes (orbe -> app)
  evt.listen('orb-command', (e) => {
    // Recevoir quoi que ce soit prouve que le lien est ouvert. Sans cela, un
    // message arrivant avant que `orb_connect` n'ait rendu la main trouvait
    // `connectedTo` encore a false, et toute reponse etait jetee.
    const from = e && e.payload && e.payload.device;
    if (from && from in connectedTo) connectedTo[from] = true;
    const cmd = e && e.payload && e.payload.cmd;
    // Le contrôleur se présente avec la liste de ce qu'il sait traiter. Il
    // envoie ce message à CHAQUE nouvelle connexion, donc aussi après un
    // redémarrage de la carte : c'est le signal qu'il repart des valeurs par
    // défaut de config.py et qu'il faut lui réimposer l'état réel, sans quoi
    // l'écran affiche un modèle qui ne correspond plus à celui de Lumen.
    if (e && e.payload && e.payload.type === 'hello') {
      // Seul le Lumen Controller émet ce message : sa présence IDENTIFIE le
      // lien, quel que soit le champ dans lequel l'adresse a été saisie.
      const slot = e.payload.device || 'orb';
      if (roleOf[slot] !== 'controller') {
        roleOf[slot] = 'controller';
        if (slot !== 'controller') {
          console.warn('[OrbBridge] un Lumen Controller répond sur le champ « '
            + slot + ' » : il est traité comme tel.');
        }
      }
      if (Array.isArray(e.payload.capabilities)) {
        peerCapabilities = e.payload.capabilities;
        // Partagé avec les autres fenêtres (Réglages) : elles n'ont pas le
        // pont, mais elles doivent pouvoir dire à l'utilisateur qu'un firmware
        // trop ancien n'annonce pas telle capacité — un « Tester » sans effet
        // et sans explication n'apprend rien.
        try {
          localStorage.setItem('controllerCaps:' + slot, JSON.stringify(peerCapabilities));
        } catch { /* quota : le diagnostic se passera de cette information */ }
      }
      lastCatalog = '';
      lastPushedState = '';
      pushCatalog(true);
      pushControllerState(true);
    }
    // Commandes du panneau Lumen Controller (ESP32/Pico W). Elles sont
    // diffusées en événements DOM afin que chaque webview puisse appliquer
    // sa propre implémentation native (volume HID, changement de backend…).
    if (cmd === 'set_backend' || cmd === 'set_model') {
      const p = e.payload || {};
      const source = p.backend === 'apple' ? 'shortcut' : p.backend;
      if (source) localStorage.setItem('aiSource', source);
      if (p.model) localStorage.setItem(p.backend === 'api' ? 'apiModel' : 'selectedModel', String(p.model));
      // On ne pré-arme plus lastPushedState ici : la clé d'état agrège
      // maintenant backend, modèle, mode et voix, valeurs qu'on ne connaît pas
      // toutes à cet instant. Reconstruire une clé partielle la rendrait
      // simplement toujours différente. Au pire le prochain tic renvoie une
      // fois l'état au contrôleur, qui le réapplique à l'identique.
      window.dispatchEvent(new CustomEvent('lumen-controller-config', {
        detail: { ...p, source }
      }));
    }
    if (cmd === 'hid_volume') {
      window.dispatchEvent(new CustomEvent('lumen-controller-volume', { detail: e.payload || {} }));
    }
    if (cmd === 'desktop') {
      window.dispatchEvent(new CustomEvent('lumen-controller-desktop', { detail: e.payload || {} }));
    }
    if (cmd === 'pause') {
      window.dispatchEvent(new CustomEvent('lumen-controller-pause', { detail: e.payload || {} }));
    }
    if (cmd === 'rfid') {
      // Le contrôleur n'envoie que l'UID : la table des associations et le
      // choix de l'action vivent dans Lumen.
      const uid = e.payload && e.payload.uid;
      if (uid) {
        window.dispatchEvent(new CustomEvent('lumen-controller-rfid', {
          cancelable: true, detail: { uid: String(uid) },
        }));
      }
    }
    if (cmd === 'rfid_removed') {
      // Le badge a quitté le lecteur. Aucune action associée à défaire, mais
      // l'information permet de savoir qu'un badge reposé ensuite est un
      // véritable nouveau geste, et non une répétition.
      window.dispatchEvent(new CustomEvent('lumen-controller-rfid-removed'));
    }
    if (cmd === 'stop_speech') {
      // Bouton B pendant la lecture, ou Fire retournée : on coupe la voix.
      window.dispatchEvent(new CustomEvent('lumen-orb-stop-speech'));
    }
    if (cmd === 'stop') {
      window.dispatchEvent(new CustomEvent('lumen-orb-stop-speech'));
      // Appui long sur le poussoir de l'encodeur : tout arrêter.
      const handled = !window.dispatchEvent(
        new CustomEvent('lumen-controller-stop', { cancelable: true })
      );
      if (!handled) console.warn('[OrbBridge] stop sans gestionnaire');
    }
    if (cmd === 'new_chat') {
      // Appui long sur Mic : nouvelle conversation.
      const handled = !window.dispatchEvent(
        new CustomEvent('lumen-controller-new-chat', { cancelable: true })
      );
      if (!handled) console.warn('[OrbBridge] new_chat sans gestionnaire');
    }
    if (cmd === 'set_mode') {
      // Bouton Mode : mode de discussion (chat, router, tools, docs).
      const handled = !window.dispatchEvent(
        new CustomEvent('lumen-controller-mode', {
          cancelable: true, detail: e.payload || {},
        })
      );
      if (!handled) console.warn('[OrbBridge] set_mode sans gestionnaire');
    }
    if (cmd === 'set_voice') {
      // Molette en fonction « voix » : voix de synthèse Piper.
      const voice = e.payload && e.payload.voice;
      if (voice) invoke('tts_set_voice', { voice: String(voice) }).catch((err) =>
        console.warn('[OrbBridge] tts_set_voice', err));
    }
    if (cmd === 'load_model') {
      // Bouton intégré de l'encodeur : charge en mémoire le modèle affiché.
      const handled = !window.dispatchEvent(
        new CustomEvent('lumen-controller-preload', {
          cancelable: true, detail: e.payload || {},
        })
      );
      if (!handled) console.warn('[OrbBridge] load_model sans gestionnaire');
    }
    if (cmd === 'dictation') {
      // La fenêtre principale écoute cet événement et enchaîne sur l'envoi
      // automatique du message : depuis le contrôleur, il n'y a pas de clavier
      // pour valider. dispatchEvent() renvoie false si preventDefault() a été
      // appelé, ce qui nous sert d'accusé de prise en charge.
      const handled = !window.dispatchEvent(
        new CustomEvent('lumen-controller-dictation', { cancelable: true })
      );
      if (!handled) {
        // Repli : webview sans ce gestionnaire. Dictée simple, sans envoi.
        const btn = document.querySelector('#btn-dictation');
        if (btn && !btn.disabled) btn.click();
      }
    }
    if (cmd === 'sleep') window.dispatchEvent(new CustomEvent('lumen-orb-sleep'));
    if (cmd === 'wake') window.dispatchEvent(new CustomEvent('lumen-orb-wake'));
    if (cmd === 'open_app' && e.payload.app) {
      // Le bureau est une autre webview : un CustomEvent DOM ne la traverse
      // pas. L'événement Tauri est diffusé à toutes les webviews.
      evt.emit?.('lumen-orb-open-app', { app: e.payload.app });
      if (typeof window.LumenOpenAppById === 'function') {
        window.LumenOpenAppById(e.payload.app);
      } else {
        window.dispatchEvent(new CustomEvent('lumen-orb-open-app', {
          detail: { app: e.payload.app }
        }));
      }
    }
    if (cmd === 'conversation') {
      window.dispatchEvent(new CustomEvent('lumen-orb-request-message'));
    }
    if (cmd === 'agent_status') {
      window.dispatchEvent(new CustomEvent('lumen-orb-request-agent'));
    }
    if (cmd === 'hello_device') {
      // L'appareil branché sur le lien « orbe » se présente (M5 Fire) : la
      // mise à jour OTA vérifie ensuite que le dossier choisi est le bon.
      try { localStorage.setItem('orbDeviceKind', String(e.payload.device || '')); } catch (err) {}
      if (e.payload.device === 'm5fire') { setTimeout(() => pushAgents(true), 1500); setTimeout(() => OrbBridge.pushLang(), 800); }
    }
    if (cmd === 'pull') {
      handlePull(e.payload.what);
    }
  });

  evt.listen('orb-mic-audio', (e) => {
    window.dispatchEvent(new CustomEvent('lumen-orb-mic-audio', { detail: e.payload }));
  });

  // L'orbe demande une info de la plateforme -> on la récupère et on la renvoie.
  async function handlePull(what) {
    try {
      if (what === 'agents') {
        // Seule la M5 Fire a une page Agents : la demande l'identifie.
        try { localStorage.setItem('orbDeviceKind', 'm5fire'); } catch (err) {}
        pushAgents(true);
      } else if (what === 'sensors') {
        send({ sensors: await collectSensors() });
      } else if (what === 'status') {
        send({ status: await collectStatus() });
      } else if (what === 'system') {
        send({ system: await collectSystem() });
      } else if (what === 'weather') {
        send({ weather: await collectWeather() });
      } else if (what === 'messages') {
        send({ messages: await collectMessages() });
      } else if (what === 'day') {
        send({ day: await collectDay() });
      } else if (what === 'events' || what === 'agenda') {
        // L'écran « Agenda » de la Fire demande « agenda » : sans cet alias,
        // il restait vide.
        send({ events: await collectEvents() });
      } else if (what === 'tasks') {
        send({ tasks: await collectTasks() });
      }
    } catch (err) {
      console.warn('[OrbBridge] pull', what, err);
    }
  }

  // ===== Pages de la Fire =====
  const BACKEND_LABELS = {
    ollama: 'Ollama', llama: 'llama.cpp', api: 'API cloud', applefm: 'Apple Intelligence',
    lumen: 'Lumen Server', apple: 'Raccourcis', shortcut: 'Raccourcis', bonsai: 'Bonsai',
  };
  const fmtBytes = (b) => {
    if (!b) return '';
    const gb = b / 1073741824;
    return gb >= 1 ? gb.toFixed(1).replace('.', ',') + ' Go' : Math.round(b / 1048576) + ' Mo';
  };

  // Système : backend, modèle actif, mémoire du modèle s'il est chargé.
  async function collectSystem() {
    const source = localStorage.getItem('aiSource') || 'ollama';
    const backend = SOURCE_TO_BACKEND[source] || source;
    const out = { backend: BACKEND_LABELS[source] || BACKEND_LABELS[backend] || source,
      model: '', loaded: false, ram: '', ctx: '', compute: '', unread: 0 };
    try {
      if (backend === 'llama') {
        const st = await invoke('llama_status');
        out.loaded = !!(st && st.running);
        out.model = (st && st.model) || localStorage.getItem('selectedModel') || '';
        out.ram = fmtBytes(st && st.mem_bytes);
        if (st && st.ctx_size) out.ctx = Math.round(st.ctx_size / 1024) + 'k';
        if (st && st.backend) out.compute = String(st.backend).toUpperCase();
      } else if (backend === 'ollama') {
        const ps = await invoke('ollama_get_json', { url: localStorage.getItem('ollamaUrl') || null, path: 'api/ps' });
        const m = ps && Array.isArray(ps.models) ? ps.models[0] : null;
        out.loaded = !!m;
        out.model = (m && (m.name || m.model)) || localStorage.getItem('selectedModel') || '';
        out.ram = fmtBytes(m && (m.size || m.size_vram));
        if (m && m.size_vram) out.compute = m.size_vram >= (m.size || 0) ? 'GPU' : 'CPU+GPU';
      } else if (source === 'applefm') {
        // Apple Foundation Models : sur la puce de ce Mac (ou Private Cloud
        // Compute) — son modèle propre, pas celui de l'API cloud.
        const m = localStorage.getItem('applefmModel') || 'apple-on-device';
        out.model = m === 'apple-private-cloud' ? 'Private Cloud Compute' : 'Sur l appareil';
        out.loaded = m !== 'apple-private-cloud';
        out.compute = m === 'apple-private-cloud' ? 'distant' : 'puce Apple';
      } else if (source === 'lumen') {
        out.model = localStorage.getItem('lumenModel') || '';
        out.loaded = false;
        out.compute = 'serveur';
      } else if (source === 'shortcut' || source === 'apple') {
        out.model = 'Raccourci Apple';
        out.compute = 'puce Apple';
      } else {
        // API cloud : rien en mémoire locale.
        out.model = localStorage.getItem('apiModel') || '';
        out.loaded = false;
        out.compute = 'distant';
      }
    } catch (e) { /* backend hors ligne : « Non chargé » */ }
    if (out.model.endsWith(':latest')) out.model = out.model.slice(0, -7);
    out.model = out.model.split('/').pop().replace(/\.gguf$/i, '');
    try {
      const msgs = JSON.parse((await invoke('inbox_load')) || '[]');
      out.unread = msgs.filter((m) => !m.read).length;
    } catch (e) {}
    return out;
  }

  // Météo de la zone choisie dans Réglages › Orbe physique. Au plus une
  // requête toutes les 15 minutes : sinon la valeur en cache est renvoyée.
  const WEATHER_TTL = 15 * 60000;
  async function collectWeather() {
    const place = (localStorage.getItem('orbWeatherPlace') || '').trim();
    if (!place) return { error: 'Choisis ta ville dans Lumen : Reglages > Appareils > Zone meteo.' };
    let cache = null;
    try { cache = JSON.parse(localStorage.getItem('orbWeatherCache') || 'null'); } catch (e) {}
    if (cache && cache.place === place && Date.now() - cache.at < WEATHER_TTL) return cache.data;
    try {
      const data = await invoke('live_weather_data', { place });
      localStorage.setItem('orbWeatherCache', JSON.stringify({ place, at: Date.now(), data }));
      return data;
    } catch (e) {
      // Hors ligne : on garde la dernière valeur connue plutôt qu'un écran vide.
      return (cache && cache.data) || { error: String(e).slice(0, 120) };
    }
  }

  // Derniers messages reçus : e-mails non lus, messagerie des agents,
  // notifications de Lumen — les plus récents d'abord.
  async function collectMessages() {
    const out = [];
    const hm = (ts) => {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      const p = (x) => ('0' + x).slice(-2);
      return d.toDateString() === new Date().toDateString()
        ? p(d.getHours()) + ':' + p(d.getMinutes()) : p(d.getDate()) + '/' + p(d.getMonth() + 1);
    };
    try {
      const { collectDayItems } = await import('./lib/app-data.js');
      for (const m of (await collectDayItems(invoke)).mails || []) {
        out.push({ src: 'mail', from: m.from, text: m.subject, when: '', unread: true, ts: Date.now() });
      }
    } catch (e) {}
    try {
      const msgs = JSON.parse((await invoke('inbox_load')) || '[]');
      for (const m of msgs.slice(-6)) {
        out.push({ src: 'agent', from: m.from || 'Agent', text: m.subject || m.body || '', when: hm(m.ts), unread: !m.read, ts: m.ts || 0 });
      }
    } catch (e) {}
    try {
      const notifs = JSON.parse(localStorage.getItem('heartbeatNotifications') || '[]');
      for (const n of notifs.slice(-6)) {
        const ts = Date.parse(n.timestamp || n.ts || '') || 0;
        out.push({ src: 'notif', from: n.source || n.title || 'Lumen', text: n.text || n.body || '', when: hm(ts), unread: false, ts });
      }
    } catch (e) {}
    // Non lus d'abord, puis du plus récent au plus ancien.
    out.sort((a, b) => (b.unread - a.unread) || (b.ts - a.ts));
    return out.slice(0, 8).map(({ ts, ...m }) => ({ ...m, text: String(m.text).replace(/\s+/g, ' ').slice(0, 80) }));
  }

  // « Ma journée » (écran compagnon de la Fire) : agenda du jour, mails non
  // lus, cartes Kanban à échéance — mêmes lecteurs que l'outil day_overview.
  async function collectDay() {
    const { collectDayItems } = await import('./lib/app-data.js');
    return collectDayItems(invoke);
  }

  // ===== Compagnon de poche : alertes proactives =====
  // Toutes les minutes, tant que l'orbe est connectée : nouveau mail non lu et
  // rendez-vous dans les 10 minutes deviennent une notification sur l'orbe
  // (bip + écran). Une alerte n'est émise qu'une fois (clé mémorisée).
  const alerted = new Set();
  let mailPrimed = false;
  async function proactiveTick() {
    if (!connectedTo.orb) return;
    try {
      const { collectDayItems } = await import('./lib/app-data.js');
      const day = await collectDayItems(invoke);
      const now = Date.now();
      for (const ev of day.events || []) {
        const key = 'ev:' + ev.at + ':' + ev.label;
        if (ev.at && ev.at - now > 0 && ev.at - now <= 10 * 60000 && !alerted.has(key)) {
          alerted.add(key);
          OrbBridge.pushNotification({ source: 'Agenda', text: ev.time + '  ' + ev.label });
        }
      }
      for (const m of day.mails || []) {
        const key = 'mail:' + m.uid;
        if (alerted.has(key)) continue;
        alerted.add(key);
        // Premier passage : on mémorise l'existant sans sonner pour chacun.
        if (mailPrimed) OrbBridge.pushNotification({ source: 'Email', text: m.from + ' : ' + m.subject });
      }
      mailPrimed = true;
    } catch (e) {
      console.warn('[OrbBridge] alertes', e);
    }
  }
  setInterval(proactiveTick, 60000);

  // Capteurs domotique : liste des objets -> GET /state -> liste aplatie.
  async function collectSensors() {
    const out = [];
    let devices = [];
    try {
      devices = JSON.parse((await invoke('domotique_devices_load')) || '[]');
    } catch (e) {
      return out;
    }
    for (const d of devices) {
      let state;
      try {
        state = JSON.parse(await invoke('domotique_device_state', { reference: d.id || d.name }));
      } catch (e) {
        state = null;
      }
      // Objet hors ligne ou sans IP : il reste affiché (il existe dans l'app),
      // simplement sans valeur.
      if (!state || typeof state !== 'object' || !Object.keys(state).length) {
        out.push({ name: d.name || d.id || 'Objet', value: '--', offline: true });
        continue;
      }
      const keys = Object.keys(state);
      for (const key of keys) {
        const val = state[key];
        const multi = keys.length > 1;
        const entry = { name: (d.name || key) + (multi ? ' ' + key : '') };
        if (val && typeof val === 'object') {
          if ('temp' in val) entry.temp = val.temp;
          if ('hum' in val) entry.hum = val.hum;
          if (!('temp' in val) && !('hum' in val)) {
            const k0 = Object.keys(val)[0];
            if (k0 !== undefined) entry.value = String(val[k0]);
          }
        } else if (val !== null && val !== undefined) {
          entry.value = String(val);
        }
        out.push(entry);
      }
    }
    return out;
  }

  // Agenda : rappels non faits, à venir, triés, formatés HH:MM (ou JJ/MM).
  function _fmtWhen(ms) {
    try {
      const d = new Date(ms), n = new Date();
      const p = (x) => ('0' + x).slice(-2);
      return d.toDateString() === n.toDateString()
        ? p(d.getHours()) + ':' + p(d.getMinutes())
        : p(d.getDate()) + '/' + p(d.getMonth() + 1);
    } catch (e) { return ''; }
  }

  async function collectEvents() {
    let rems = [];
    try { rems = JSON.parse((await invoke('reminders_load')) || '[]'); }
    catch (e) { return []; }
    const now = Date.now();
    return rems
      .filter((r) => !r.done && (r.due_at || 0) >= now - 60000)
      .sort((a, b) => (a.due_at || 0) - (b.due_at || 0))
      .slice(0, 12)
      .map((r) => ({ time: _fmtWhen(r.due_at), label: r.title || '(sans titre)' }));
  }

  // Tâches : messages de l'inbox (agents -> todo), non-lus = à traiter.
  async function collectTasks() {
    let msgs = [];
    try { msgs = JSON.parse((await invoke('inbox_load')) || '[]'); }
    catch (e) { return []; }
    return msgs
      .slice(-20)
      .reverse()
      .map((m) => ({
        text: (m.from ? m.from + ': ' : '') + (m.body || ''),
        done: !!m.read,
      }));
  }

  async function collectStatus() {
    let running = [];
    try { running = (await invoke('agents_running')) || []; } catch (e) {}
    let unread = 0;
    try {
      const msgs = JSON.parse((await invoke('inbox_load')) || '[]');
      unread = msgs.filter((m) => !m.read).length;
    } catch (e) {}

    // Modèle réellement chargé : /api/ps pour Ollama, état Tauri pour
    // llama-server (qui n'expose pas l'endpoint Ollama /api/ps). Même source
    // de vérité que l'écran du contrôleur, pour éviter qu'ils divergent.
    const source = localStorage.getItem('aiSource') || 'ollama';
    let model = (await loadedModelName(SOURCE_TO_BACKEND[source] || source)) || '--';
    if (model === '--') {
      // repli : modèle sélectionné (Ollama) ou modèle API
      model = localStorage.getItem('selectedModel') ||
              localStorage.getItem('apiModel') || '--';
    }
    if (model && model.endsWith(':latest')) model = model.slice(0, -7);

    return {
      model: model,
      agent: running.length > 0,
      agent_count: running.length,
      unread: unread,
    };
  }
  // ===== Deux liens indépendants =====
  //
  // L'orbe ESP32 et le Lumen Controller parlent le même protocole sur le même
  // port, mais ce sont deux appareils distincts. Une seule adresse pour les
  // deux obligeait à choisir : chacun a désormais sa clé et sa connexion.
  const LINKS = {
    orb: { hostKey: 'orbBridgeHost', portKey: 'orbBridgePort' },
    controller: { hostKey: 'controllerHost', portKey: 'controllerPort' },
  };
  for (const link of Object.values(LINKS)) {
    link.timer = null;
    link.reconnect = null;
  }

  const hostOf = (name) => localStorage.getItem(LINKS[name].hostKey) || '';
  const portOf = (name) =>
    parseInt(localStorage.getItem(LINKS[name].portKey) || '8787', 10);

  // Connexion ouverte ailleurs (fenêtre Réglages) : on l'adopte ici — état,
  // battement de cœur, thème — au lieu de l'ignorer.
  evt.listen('orb-connected', (e) => {
    const name = e?.payload?.device || 'orb';
    const link = LINKS[name];
    if (!link) return;
    connectedTo[name] = true;
    if (link.reconnect) { clearTimeout(link.reconnect); link.reconnect = null; }
    if (!link.timer) link.timer = setInterval(() => send({ heartbeat: Date.now() }, name), 3000);
    lastMode = null; lastRawMode = null; lastTheme = null; lastActivity = '';
    OrbBridge.pushTheme(localStorage.getItem('orbTheme') || 'default');
    OrbBridge.pushTz();
    window.dispatchEvent(new CustomEvent('lumen-orb-connected', { detail: { device: name } }));
  });

  evt.listen('orb-disconnected', (e) => {
    // L'événement porte l'appareil concerné. Sans lui on couperait aussi
    // l'autre lien, pourtant intact.
    const name = e?.payload?.device || 'orb';
    if (!LINKS[name]) return;
    connectedTo[name] = false;
    roleOf[name] = null;              // l'identité est réapprise à la reconnexion
    // Les capacités décrivent le firmware d'un appareil PRÉSENT : les garder
    // après la coupure ferait diagnostiquer sur des données périmées.
    try { localStorage.removeItem('controllerCaps:' + name); } catch { /* ignoré */ }
    if (LINKS[name].timer) { clearInterval(LINKS[name].timer); LINKS[name].timer = null; }
    scheduleReconnect(name);
  });

  // Une IP modifiée depuis la fenêtre Paramètres (autre webview, même origine)
  // -> on se (re)connecte pour reprendre le push d'état.
  window.addEventListener('storage', (e) => {
    for (const [name, link] of Object.entries(LINKS)) {
      if (e.key === link.hostKey) { connectedTo[name] = false; connect(name); }
    }
    // Le modèle et la source se changent depuis la fenêtre Paramètres ou la
    // barre, c'est-à-dire une autre webview : on répercute sur le contrôleur.
    if (e.key === 'aiSource' || e.key === 'selectedModel' ||
        e.key === 'apiModel' || e.key === 'ollamaMode') {
      pushControllerState(false);
    }
  });

  function scheduleReconnect(name) {
    const link = LINKS[name];
    if (link.reconnect || !hostOf(name)) return;
    link.reconnect = setTimeout(() => { link.reconnect = null; connect(name); }, 4000);
  }

  async function connect(name = null) {
    if (name === null) {
      // Les deux liens sont indépendants : l'échec de l'un ne doit pas
      // empêcher l'autre de s'établir.
      await Promise.allSettled(Object.keys(LINKS).map((n) => connect(n)));
      return;
    }
    const link = LINKS[name];
    const h = hostOf(name);
    if (!h) return;                     // appareil non configuré : on s'abstient

    // Remises à zéro AVANT la connexion, jamais après.
    //
    // Le contrôleur envoie son « hello » dès l'acceptation TCP : l'événement
    // peut donc arriver PENDANT l'await ci-dessous. Réinitialiser ensuite
    // effaçait l'identification qui venait d'avoir lieu — et comme le hello
    // n'est émis qu'une fois par connexion, le lien n'était plus jamais
    // reconnu comme un contrôleur.
    roleOf[name] = null;
    peerCapabilities = null;
    lastCatalog = '';
    lastPushedState = '';
    lastMode = null; lastRawMode = null;
    lastTheme = null;

    try {
      await invoke('orb_connect', { host: h, port: portOf(name), device: name });
      connectedTo[name] = true;
      if (link.timer) clearInterval(link.timer);
      link.timer = setInterval(() => send({ heartbeat: Date.now() }, name), 3000);
      // Le thème ne concerne que l'orbe; un contrôleur ignore simplement la
      // clé, `Link.apply()` ne retenant que ce qu'il connaît.
      OrbBridge.pushTheme(localStorage.getItem('orbTheme') || 'default');
    OrbBridge.pushTz();
      window.dispatchEvent(new CustomEvent('lumen-orb-connected', { detail: { device: name } }));
      console.log('[OrbBridge] ' + name + ' connecté à', h);
    } catch (e) {
      connectedTo[name] = false;
      console.warn('[OrbBridge] ' + name + ' : connexion échouée:', e);
      scheduleReconnect(name);
    }
  }

  // Synchronisation périodique du contrôleur.
  //
  // Ce filet dépendait auparavant du NOM du champ de configuration : un
  // contrôleur renseigné dans le champ « orbe » n'était jamais synchronisé.
  // Un minuteur unique suffit — `send()` résout lui-même le lien concerné, et
  // ne fait rien si aucun contrôleur n'est relié.
  let syncTicks = 0;
  setInterval(() => {
    // localStorage peut être modifié sans événement 'storage' (même webview).
    // On ne pousse que si la valeur a changé.
    pushControllerState(false);
    // Le catalogue coûte deux invoke() : re-scruté toutes les 60 s, pour voir
    // apparaître un modèle fraîchement téléchargé.
    if (++syncTicks % 20 === 0) pushCatalog(false);
  }, 3000);

  // --- Agents sur la M5 Fire -------------------------------------------------
  //
  // La page « Agents » du firmware (m5fire-orb/agents.py) affiche l'équipe :
  // chaque agent est rendu ICI avec ses calques Kenney (lib/agent-avatar.js)
  // en trois images RGB565 de 112 px — repos, bouche ouverte (parole), réussite —
  // que la Fire anime elle-même (respiration, parole au rythme de l'audio).
  // Une étape d'agent le fait « travailler » à l'écran ; à la fin de sa tâche,
  // il annonce le résultat AVEC SA VOIX (tts_send_to_orb, voix de l'agent).
  // Désactivable : localStorage m5AgentVoice = 'off'.
  const SPRITE = 112;
  let agentCache = [];
  const isFire = () => (localStorage.getItem('orbDeviceKind') || '') === 'm5fire';
  const imgCache = new Map();
  function loadImg(src) {
    if (!imgCache.has(src)) {
      const pending = new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Avatar M5 : image introuvable (${src})`));
        image.src = src;
      }).catch((error) => { imgCache.delete(src); throw error; });
      imgCache.set(src, pending);
    }
    return imgCache.get(src);
  }
  async function renderAgentFrame(mod, agent, frame) {
    const c = document.createElement('canvas'); c.width = c.height = SPRITE;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, SPRITE, SPRITE);
    const state = frame === 2 ? 'done' : 'idle';
    for (const l of mod.avatarLayers(agent, { state, hands: true })) {
      if (frame === 1 && /\/face_[a-l]\.png$/.test(l.src)) {
        // Bouche ouverte : yeux + bouche calés sur le visage (comme dans Lumen XR).
        const parts = mod.talkingFaceParts(l, 0.8);
        const [eye, mouth] = await Promise.all([loadImg(parts.eyeSrc), loadImg(parts.mouthSrc)]);
        if (eye) for (const e of parts.eyes) g.drawImage(eye, e.x * SPRITE, e.y * SPRITE, e.w * SPRITE, e.h * SPRITE);
        if (mouth) { const m = parts.mouth; g.drawImage(mouth, m.x * SPRITE, m.y * SPRITE, m.w * SPRITE, m.h * SPRITE); }
        continue;
      }
      const im = await loadImg(l.src);
      if (!im) continue;
      const lw = l.w * SPRITE, lh = (l.h ?? (l.w * im.naturalHeight / im.naturalWidth)) * SPRITE;
      g.save(); g.translate(l.x * SPRITE + lw / 2, l.y * SPRITE + lh / 2);
      if (l.rot) g.rotate(l.rot * Math.PI / 180);
      if (l.flip) g.scale(-1, 1);
      g.drawImage(im, -lw / 2, -lh / 2, lw, lh); g.restore();
    }
    // RGBA -> RGB565 gros-boutiste (format validé par test_display.py / pushImage).
    const px = g.getImageData(0, 0, SPRITE, SPRITE).data;
    const out = new Uint8Array(SPRITE * SPRITE * 2);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 2) {
      const v = ((px[i] & 0xf8) << 8) | ((px[i + 1] & 0xfc) << 3) | (px[i + 2] >> 3);
      out[j] = v >> 8; out[j + 1] = v & 0xff;
    }
    let bin = '';
    for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  let pushingAgents = false;
  let agentsRefreshPending = false;
  async function pushAgents(requested = false) {
    if (!isFire() && !requested) return;
    if (pushingAgents) { agentsRefreshPending ||= requested; return; }
    const device = slotFor('orb');
    if (!device || !connectedTo[device]) return;
    pushingAgents = true;
    try {
      const mod = await import('/lib/agent-avatar.js');
      const list = ((await invoke('agent_list')) || []).slice(0, 8);
      agentCache = list;
      let running = [];
      try { running = (await invoke('agents_running')) || []; } catch (e) {}
      const busy = new Set(running.map((r) => r.agent_id || r.id || r));
      await invoke('orb_send', { device, line: JSON.stringify({ agents: list.map((a) => ({
        id: String(a.id).slice(0, 24), name: String(a.name || 'Agent').slice(0, 20),
        color: parseInt(String(mod.avatarColor(a)).replace('#', ''), 16) || 0x7873ee,
        state: busy.has(a.id) ? 'work' : 'idle',
      })) }) });
      // A manual refresh always resends sprites, including after M5 reboot or failure.
      for (const a of list) {
        for (const frame of [0, 1, 2]) {
          const b64 = await renderAgentFrame(mod, a, frame);
          await invoke('orb_send_sprite', { meta: { agent_id: String(a.id).slice(0, 24), frame, w: SPRITE, h: SPRITE }, b64, device });
        }
      }
    } catch (e) {
      console.warn('[OrbBridge] agents M5', e);
    } finally {
      pushingAgents = false;
      if (agentsRefreshPending) { agentsRefreshPending = false; setTimeout(() => pushAgents(true), 0); }
    }
  }
  OrbBridge.pushAgents = pushAgents;
  // Langue de Lumen → M5 Fire (libellés FR/EN), à la connexion et au changement.
  const lumenLang = () => ((localStorage.getItem('lang') || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr');
  OrbBridge.pushLang = (lang) => send({ lang: lang || lumenLang() });
  window.addEventListener('lumen-orb-connected', () => setTimeout(() => OrbBridge.pushLang(), 1200));
  window.addEventListener('lumen-orb-connected', () => setTimeout(pushAgents, 2500));
  evt.listen('agents-updated', () => { clearTimeout(pushAgents._t); pushAgents._t = setTimeout(pushAgents, 1500); });
  evt.listen('agent-step', (e) => {
    const p = e?.payload || {};
    if (!isFire() || !p.agent_id) return;
    send({ agent_state: { agent_id: String(p.agent_id).slice(0, 24), state: 'work', text: String(p.skill || p.kind || '').slice(0, 60) } });
  });
  evt.listen('agent-progress', async (e) => {
    const p = e?.payload || {};
    if (!isFire() || !p.agent_id || p.output === undefined) return;
    const id = String(p.agent_id).slice(0, 24);
    const ok = p.success !== false;
    const a = agentCache.find((x) => String(x.id) === String(p.agent_id)) || {};
    const name = a.name || p.agent || 'Agent';
    const first = String(p.output || '').replace(/[#*_`>|]/g, ' ').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] || '';
    const en = (localStorage.getItem('lang') || 'fr').toLowerCase().startsWith('en');
    const text = (ok
      ? (en ? `${name}: done. ${first}` : `${name} : c'est fait. ${first}`)
      : (en ? `${name}: I couldn't do it. ${first}` : `${name} : je n'ai pas réussi. ${first}`)).slice(0, 220);
    await send({ agent_state: { agent_id: id, state: ok ? 'done' : 'fail', text: '' } });
    if (localStorage.getItem('m5AgentVoice') === 'off') return;
    await send({ agent_say: { agent_id: id, text } });
    try { await invoke('tts_send_to_orb', { text, voice: a.voice || null }); } catch (err) { console.warn('[OrbBridge] voix agent', err); }
  });

  // Connexion au démarrage si un hôte est déjà configuré.
  connect();
}
