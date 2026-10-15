// Réunion — le maillage WebRTC et son canal de signalisation.
//
// Ce que fait ce module, et rien d'autre : ouvrir un WebSocket vers l'hôte de
// la salle (le Lumen qui l'a créée), tenir une connexion pair-à-pair par
// participant, et relayer les messages de salle (chat, transcription, états).
// L'audio et la vidéo, eux, ne passent JAMAIS par le serveur : ils vont
// directement d'une machine à l'autre, chiffrés par WebRTC (DTLS-SRTP).
//
// Deux décisions structurantes :
//
//   1. **Pas de renégociation.** Chaque connexion naît avec un émetteur audio
//      et un émetteur vidéo, même quand la caméra est éteinte. Allumer la
//      caméra, partager l'écran ou couper le micro se fait ensuite par
//      `replaceTrack()`, qui ne demande aucun nouvel échange d'offre. C'est ce
//      qui rend les bascules instantanées et évite les collisions d'offres.
//
//   2. **Qui appelle qui est décidé d'avance.** L'arrivant émet les offres vers
//      ceux qui sont déjà là ; les présents attendent. Sans cette règle, deux
//      pairs s'appellent en même temps (« glare ») et il faut arbitrer.
//
// Aucun STUN, aucun TURN : la salle vit sur le réseau local (ou un VPN qui en
// tient lieu), là où les candidats d'hôte suffisent.

const RTC_CONFIG = { iceServers: [] };

export function joinRoom({ url, room, code, name, onEvent }) {
  const emit = (event) => { try { onEvent?.(event); } catch (e) { console.error("[meet]", e); } };
  const peers = new Map(); // peerId → { name, pc, stream, audioSender, videoSender, pending: [] }
  let socket = null;
  let selfId = "";
  let localStream = null;
  let closed = false;

  const wsUrl = `${url.replace(/^http/, "ws")}/meet/ws?room=${encodeURIComponent(room)}`
    + `&code=${encodeURIComponent(code || "")}&name=${encodeURIComponent(name || "Invité")}`;

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function peerOf(id, peerName) {
    let peer = peers.get(id);
    if (peer) return peer;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peer = {
      id, name: peerName || "Invité", pc,
      stream: new MediaStream(),
      pending: [],   // candidats ICE reçus avant la description distante
      mic: true, cam: false,
    };
    peers.set(id, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: "signal", to: id, kind: "ice", payload: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      // Une piste remplacée par `replaceTrack` réutilise le même flux : on
      // ajoute la piste au flux du pair plutôt que d'en recréer un, sinon
      // l'élément <video> perd son image à chaque bascule.
      peer.stream.addTrack(e.track);
      emit({ type: "stream", id, name: peer.name, stream: peer.stream });
    };
    pc.onconnectionstatechange = () => {
      emit({ type: "peer-state", id, state: pc.connectionState });
      if (["failed", "closed"].includes(pc.connectionState)) dropPeer(id);
    };
    return peer;
  }

  /**
   * Accroche les pistes locales aux émetteurs de CETTE connexion, par nature.
   * On passe par les transceivers plutôt que par des références gardées de
   * côté : côté répondeur, ce sont ceux créés par la description distante qui
   * comptent, et eux seuls sont réellement rattachés à une ligne média.
   */
  function applyLocalTracks(peer) {
    const byKind = {
      audio: localStream?.getAudioTracks()[0] || null,
      video: localStream?.getVideoTracks()[0] || null,
    };
    for (const transceiver of peer.pc.getTransceivers()) {
      const kind = transceiver.receiver?.track?.kind || transceiver.sender?.track?.kind;
      if (!kind || !(kind in byKind)) continue;
      transceiver.sender.replaceTrack(byKind[kind]).catch(() => {});
    }
  }

  function dropPeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    try { peer.pc.close(); } catch {}
    peers.delete(id);
    emit({ type: "peer-leave", id, name: peer.name });
  }

  async function callPeer(id, peerName) {
    const peer = peerOf(id, peerName);
    // L'appelant pose les deux lignes média une fois pour toutes : une audio,
    // une vidéo, dans cet ordre. Tout le reste de la réunion (couper le micro,
    // allumer la caméra, partager l'écran) se fera par `replaceTrack`, sans
    // jamais renégocier.
    peer.pc.addTransceiver("audio", { direction: "sendrecv" });
    peer.pc.addTransceiver("video", { direction: "sendrecv" });
    applyLocalTracks(peer);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    send({ type: "signal", to: id, kind: "offer", payload: { sdp: peer.pc.localDescription.sdp } });
  }

  async function onSignal(msg) {
    const peer = peerOf(msg.from, msg.fromName);
    try {
      if (msg.kind === "offer") {
        await peer.pc.setRemoteDescription({ type: "offer", sdp: msg.payload.sdp });
        await flushCandidates(peer);
        // Les transceivers n'existent qu'APRÈS la description distante : c'est
        // seulement ici qu'on peut leur accrocher nos pistes et déclarer qu'on
        // émet aussi. Les créer avant reviendrait à parier sur l'appariement
        // automatique des lignes média, qui laisse des émetteurs orphelins.
        for (const transceiver of peer.pc.getTransceivers()) {
          try { transceiver.direction = "sendrecv"; } catch { /* ligne refusée par le pair */ }
        }
        applyLocalTracks(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        send({ type: "signal", to: msg.from, kind: "answer", payload: { sdp: peer.pc.localDescription.sdp } });
      } else if (msg.kind === "answer") {
        await peer.pc.setRemoteDescription({ type: "answer", sdp: msg.payload.sdp });
        await flushCandidates(peer);
      } else if (msg.kind === "ice") {
        if (peer.pc.remoteDescription?.type) await peer.pc.addIceCandidate(msg.payload);
        else peer.pending.push(msg.payload);
      }
    } catch (e) {
      emit({ type: "error", message: `Négociation avec ${peer.name} : ${e.message || e}` });
    }
  }

  async function flushCandidates(peer) {
    const list = peer.pending.splice(0);
    for (const candidate of list) {
      try { await peer.pc.addIceCandidate(candidate); } catch { /* candidat périmé */ }
    }
  }

  function connect() {
    socket = new WebSocket(wsUrl);
    socket.onopen = () => emit({ type: "open" });
    socket.onerror = () => emit({ type: "error", message: "Connexion à la salle impossible. Vérifiez l'adresse, le code et que l'hôte est joignable sur le réseau." });
    socket.onclose = () => { if (!closed) emit({ type: "closed" }); };
    socket.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.type) {
        case "welcome":
          selfId = msg.self;
          emit({ type: "welcome", self: msg.self, title: msg.title, peers: msg.peers });
          // L'arrivant appelle ceux qui sont déjà là.
          for (const p of msg.peers || []) await callPeer(p.id, p.name);
          break;
        case "peer-join":
          peerOf(msg.id, msg.name);
          emit({ type: "peer-join", id: msg.id, name: msg.name });
          break;
        case "peer-leave":
          dropPeer(msg.id);
          break;
        case "signal":
          await onSignal(msg);
          break;
        default:
          // chat, transcript, state… : le module ne les interprète pas, il les
          // remonte tels quels à l'application.
          emit({ ...msg, from: msg.from, name: msg.fromName });
      }
    };
  }

  connect();

  return {
    get selfId() { return selfId; },
    get peers() { return peers; },
    /** Remplace le flux local sur toutes les connexions, sans renégocier. */
    setLocalStream(stream) {
      localStream = stream;
      for (const peer of peers.values()) applyLocalTracks(peer);
    },
    say(message) { send(message); },
    close() {
      closed = true;
      for (const id of [...peers.keys()]) dropPeer(id);
      try { socket?.close(); } catch {}
    },
  };
}

/**
 * Capture continue du micro pour la transcription : des tranches de PCM 16 kHz
 * mono, prises sur le flux DÉJÀ ouvert pour la réunion — on n'ouvre pas un
 * second micro, ce que certains systèmes refusent et que tous signalent par un
 * second voyant d'enregistrement.
 */
export function chunkedPcm(stream, { seconds = 8, onChunk }) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  let chunks = [];
  let total = 0;
  const target = ctx.sampleRate * seconds;

  processor.onaudioprocess = (e) => {
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    chunks.push(data);
    total += data.length;
    if (total < target) return;
    const pcm = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) { pcm.set(c, offset); offset += c.length; }
    chunks = []; total = 0;
    onChunk(resampleTo16k(pcm, ctx.sampleRate));
  };
  source.connect(processor);
  processor.connect(ctx.destination);

  return () => {
    try { processor.disconnect(); source.disconnect(); ctx.close(); } catch {}
  };
}

/** Rééchantillonnage linéaire vers 16 kHz, le format attendu par Whisper. */
function resampleTo16k(data, rate) {
  if (rate === 16000) return data;
  const ratio = rate / 16000;
  const n = Math.floor(data.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.floor(x), frac = x - i0;
    const a = data[i0], b = data[Math.min(i0 + 1, data.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Niveau sonore instantané d'un flux (0–1), pour mettre en avant celui qui
 * parle. Renvoie une fonction d'arrêt.
 */
export function levelMeter(stream, onLevel) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let raf = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
    onLevel(peak);
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => { cancelAnimationFrame(raf); try { source.disconnect(); ctx.close(); } catch {} };
}
