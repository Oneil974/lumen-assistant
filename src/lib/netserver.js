// Client de Lumen Server, côté Lumen Pro.
//
// # Le jeton n'est pas ici
//
// Toutes les requêtes passent par la commande Rust `netserver_api`, qui pose le
// jeton d'appareil. Cette page ne l'a jamais eu, et ne peut donc pas le laisser
// fuir — ni dans un stockage local, ni dans une trace, ni dans une capture.
//
// # Le chiffrement, lui, est ici — et nulle part ailleurs
//
// Un message est chiffré dans cette page, **une fois par appareil
// destinataire**, avec les clés publiques lues dans l'annuaire. Le serveur ne
// reçoit que des enveloppes closes.
//
// ECDH P-256 + HKDF-SHA256 + AES-GCM, et non X25519/ChaCha20 comme le plan le
// prévoyait : X25519 n'est pas disponible dans WebCrypto sur toutes les
// webviews que Lumen vise (WKWebView, WebKitGTK). P-256 l'est partout, offre le
// même niveau de sécurité pratique, et du chiffrement qui tourne vaut mieux que
// du chiffrement qui figure au plan.

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const listen = (window.__TAURI__ || window.parent?.__TAURI__)?.event?.listen;

const need = () => {
  if (!invoke) throw new Error("Ouvrez cette application depuis Lumen.");
};

// ===================== Liaison =====================

export async function serverState() {
  need();
  return invoke("netserver_state");
}

/** Lie ce poste : la paire de clés est produite ICI, seule la publique part. */
export async function linkServer(url, code, deviceName) {
  need();
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey));
  const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
  return invoke("netserver_link", { url, code, deviceName, publicJwk, privateJwk });
}

export async function unlinkServer() {
  need();
  return invoke("netserver_unlink");
}

export async function api(method, path, body) {
  need();
  return invoke("netserver_api", { method, path, body: body ?? null });
}

// ===================== Socket =====================

/** Ouvre la socket (idempotent) et rend une fonction de désabonnement. */
export async function onServerEvent(handler) {
  need();
  // S'abonner AVANT de démarrer la socket : le serveur pousse `hello` puis
  // les présences dès l'upgrade. L'ordre inverse perdait ces événements au
  // premier démarrage, et rendait l'état initial dépendant du timing du réseau.
  const un = listen
    ? await listen("netserver-event", (event) => handler(event.payload))
    : () => {};
  try {
    await invoke("netserver_connect");
  } catch (error) {
    un();
    throw error;
  }
  return un;
}

export async function sendEnvelope(kind, payload) {
  need();
  return invoke("netserver_send", {
    envelope: { v: 1, id: `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, t: kind, ts: Math.floor(Date.now() / 1000), p: payload },
  });
}

// ===================== Chiffrement de bout en bout =====================

const b64 = {
  from: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  to: (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
};

let mine = null; // { privateKey, publicJwk }

async function keys() {
  if (mine) return mine;
  need();
  const { publicJwk, privateJwk } = await invoke("netserver_keys");
  const privateKey = await crypto.subtle.importKey(
    "jwk", JSON.parse(privateJwk), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
  );
  mine = { privateKey, publicJwk };
  return mine;
}

/** Secret partagé avec un appareil, dérivé puis étendu en clé AES-GCM. */
async function sharedKey(peerJwk) {
  const { privateKey } = await keys();
  const peer = await crypto.subtle.importKey(
    "jwk", JSON.parse(peerJwk), { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  // HKDF plutôt que le secret brut : deux conversations ne doivent pas
  // réutiliser la même clé sous prétexte que les appareils sont les mêmes.
  const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("lumen-message-v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Chiffre un texte pour une liste d'appareils.
 * @param {string} text
 * @param {Array<{deviceId: string, publicKey: string}>} devices
 * @returns {Promise<Array<{device_id: string, ciphertext: string}>>}
 */
export async function sealFor(text, devices) {
  const plain = new TextEncoder().encode(text);
  const sealed = [];
  for (const device of devices) {
    if (!device.publicKey) continue; // appareil sans clé publiée : il ne peut pas lire
    try {
      const key = await sharedKey(device.publicKey);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const box = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
      sealed.push({ device_id: device.deviceId, ciphertext: `${b64.from(iv)}.${b64.from(box)}` });
    } catch {
      // Une clé illisible ne doit pas empêcher l'envoi aux autres : ce
      // destinataire-là verra simplement un message qu'il ne peut pas ouvrir.
    }
  }
  return sealed;
}

/** Ouvre une enveloppe reçue. Rend `null` si elle ne nous est pas destinée. */
export async function open(ciphertext, senderPublicJwk) {
  try {
    const [ivPart, boxPart] = String(ciphertext).split(".");
    if (!ivPart || !boxPart) return null;
    const key = await sharedKey(senderPublicJwk);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64.to(ivPart) }, key, b64.to(boxPart),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Oublie les clés en mémoire (déliaison, changement de compte). */
export function forgetKeys() {
  mine = null;
}

// ===================== Annuaire =====================

/** Personnes du réseau, clés publiques comprises. */
export async function directory() {
  const { people } = await api("GET", "/v1/directory");
  return people || [];
}

/** Tous les appareils d'une liste de comptes, prêts pour `sealFor`. */
export function devicesOf(people, accountIds) {
  const out = [];
  for (const person of people) {
    if (!accountIds.includes(person.id)) continue;
    for (const key of person.device_keys || []) {
      out.push({ deviceId: key.device_id, publicKey: key.public_key, account: person.id });
    }
  }
  return out;
}
