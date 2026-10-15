// Simulateur de périphériques domotiques pour tester l'app Domotique de Lumen
// SANS matériel réel. Parle le protocole « Lumen Local Device » (LLD) :
//   - répond à la découverte UDP (port 50001) avec une annonce par objet ;
//   - sert des commandes HTTP signées HMAC-SHA256 (même format que le backend
//     Rust src-tauri/src/domotique.rs et le firmware MicroPython firmware.js).
//
// Usage :
//   node scripts/mock-domotique.mjs              # clé par défaut « lumentest »
//   LUMEN_KEY=maclef node scripts/mock-domotique.mjs
//
// Dans l'app : clique « Découvrir » (les objets apparaissent), puis renseigne la
// clé partagée (⚙︎ sur chaque carte) = la clé affichée ci-dessous. Ou ajoute-les
// à la main : IP 127.0.0.1, port indiqué, type indiqué, même clé.

import http from "node:http";
import dgram from "node:dgram";
import crypto from "node:crypto";

const SECRET = process.env.LUMEN_KEY || "lumentest";
const DISCOVERY_PORT = 50001;

// ----- Objets simulés -----
const devices = [
  {
    id: "mock-temp", name: "Capteur salon (mock)", type: "temperature", port: 8091,
    state: { temp: 21.5, hum: 46 },
    tick(s) { s.temp = +(20 + Math.random() * 4).toFixed(1); s.hum = +(40 + Math.random() * 15).toFixed(1); },
  },
  {
    id: "mock-relay", name: "Prise cuisine (mock)", type: "relay", port: 8092,
    state: { on: false },
  },
  {
    id: "mock-rgb", name: "Bandeau bureau (mock)", type: "rgb", port: 8093,
    state: { on: false, r: 255, g: 255, b: 255, brightness: 100 },
  },
  {
    id: "mock-presence", name: "Détecteur entrée (mock)", type: "presence", port: 8094,
    state: { motion: false },
    tick(s) { s.motion = Math.random() < 0.3; },
  },
];

// ----- Signature (identique à domotique.rs / firmware.js) -----
function verify(method, path, body, headers) {
  const ts = headers["x-lumen-ts"] || "";
  const nonce = headers["x-lumen-nonce"] || "";
  const sig = headers["x-lumen-sig"] || "";
  if (!sig) return false;
  const msg = `${ts}.${nonce}.${method} ${path}\n${body}`;
  const expected = crypto.createHmac("sha256", SECRET).update(msg).digest("hex");
  // comparaison à temps constant
  return sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function send(res, code, obj) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

// ----- Serveurs HTTP (un par objet) -----
for (const dev of devices) {
  http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = req.url.split("?")[0];
      const method = req.method.toUpperCase();

      // /info public (diagnostic)
      if (path === "/info" && method === "GET") {
        return send(res, 200, { id: dev.id, name: dev.name, type: dev.type });
      }
      // Le reste exige une signature valide.
      if (!verify(method, path, body, req.headers)) {
        return send(res, 401, { err: "signature invalide" });
      }
      if (path === "/state") {
        if (dev.tick) dev.tick(dev.state);
        return send(res, 200, dev.state);
      }
      if (path === "/cmd") {
        let data = {};
        try { data = body ? JSON.parse(body) : {}; } catch {}
        const p = data.params || data;
        if (data.action === "toggle") dev.state.on = !dev.state.on;
        else Object.assign(dev.state, p); // set
        console.log(`  [${dev.name}] ${JSON.stringify(dev.state)}`);
        return send(res, 200, { ok: true, ...dev.state });
      }
      send(res, 404, { err: "route inconnue" });
    });
  }).listen(dev.port, () => console.log(`• ${dev.name}  →  http://127.0.0.1:${dev.port}  (${dev.type})`));
}

// ----- Répondeur de découverte UDP -----
const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
udp.on("message", (msg, rinfo) => {
  if (!msg.includes("discover")) return;
  for (const dev of devices) {
    const announce = JSON.stringify({
      id: dev.id, name: dev.name, type: dev.type, ip: "127.0.0.1", port: dev.port,
      caps: { kind: dev.type === "relay" || dev.type === "rgb" ? "actuator" : "sensor", type: dev.type },
    });
    udp.send(announce, rinfo.port, rinfo.address);
  }
});
udp.bind(DISCOVERY_PORT, () => console.log(`• Découverte UDP en écoute sur :${DISCOVERY_PORT}`));

console.log(`\n🔑 Clé partagée : « ${SECRET} »  (à renseigner dans l'app)\n`);
console.log("Astuce : dans l'app Domotique → « Découvrir », puis ⚙︎ sur chaque objet pour coller la clé.\n");
