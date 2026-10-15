//! Réunions (édition Pro) — **signalisation** WebRTC sur le réseau local.
//!
//! Ce module ne transporte NI la vidéo NI le son : les flux vont de pair à pair
//! (WebRTC), directement entre les machines. Il n'existe que pour ce que le
//! pair-à-pair ne sait pas faire tout seul — se trouver : échanger les
//! descriptions de session (SDP), les candidats ICE, et relayer les messages de
//! salle (chat, transcription, états micro/caméra) à tout le monde.
//!
//! Portée réseau : un serveur HTTP/WebSocket sur `0.0.0.0:8767`, donc joignable
//! depuis le LAN de l'entreprise ou à travers un VPN qui en donne l'équivalent.
//! Il n'y a **pas de serveur externe, pas de STUN, pas de TURN** : hors de ce
//! réseau, une salle n'est pas joignable — c'est le choix assumé de Lumen.
//!
//! Contrôle d'accès : une salle porte un code, exigé à la connexion. C'est une
//! protection de réseau de confiance (comme un code de réunion), pas un
//! chiffrement de bout en bout — le média WebRTC, lui, est chiffré (DTLS-SRTP)
//! par construction.
//!
//! Le relais est écrit comme une structure testable (`Rooms`) : les fonctions
//! renvoient les messages à envoyer plutôt que de les envoyer elles-mêmes, ce
//! qui permet de vérifier le protocole sans ouvrir de socket (cf. `mod tests`).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Query, State},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

pub const MEET_PORT: u16 = 8767;
/// Au-delà, une mosaïque WebRTC en maillage complet s'effondre (chaque pair
/// encode un flux par destinataire). La limite est donc un garde-fou de
/// qualité, pas une licence.
const MAX_PEERS: usize = 12;

// ===================== État partagé =====================

struct Peer {
    name: String,
    tx: mpsc::UnboundedSender<String>,
}

struct Room {
    title: String,
    code: String,
    created_at: u64,
    peers: HashMap<String, Peer>,
}

#[derive(Default)]
pub struct Rooms {
    map: HashMap<String, Room>,
}

#[derive(Serialize, Clone)]
pub struct RoomInfo {
    pub room_id: String,
    pub title: String,
    pub code: String,
    pub peers: usize,
    pub created_at: u64,
}

/// Raison d'un refus de connexion — le client en fait un message lisible.
#[derive(Debug, PartialEq)]
pub enum JoinError {
    UnknownRoom,
    BadCode,
    Full,
}

impl JoinError {
    fn as_str(&self) -> &'static str {
        match self {
            JoinError::UnknownRoom => "Salle inconnue sur cet hôte.",
            JoinError::BadCode => "Code de salle incorrect.",
            JoinError::Full => "Salle complète.",
        }
    }
}

impl Rooms {
    pub fn open(&mut self, room_id: String, title: String, code: String, at: u64) -> RoomInfo {
        let room = self.map.entry(room_id.clone()).or_insert_with(|| Room {
            title: title.clone(),
            code: code.clone(),
            created_at: at,
            peers: HashMap::new(),
        });
        // Rouvrir une salle existante ne casse pas les connexions en cours :
        // on met seulement à jour ce qui est réglable.
        room.title = title;
        room.code = code;
        RoomInfo {
            room_id,
            title: room.title.clone(),
            code: room.code.clone(),
            peers: room.peers.len(),
            created_at: room.created_at,
        }
    }

    pub fn close(&mut self, room_id: &str) {
        self.map.remove(room_id);
    }

    pub fn list(&self) -> Vec<RoomInfo> {
        let mut out: Vec<RoomInfo> = self
            .map
            .iter()
            .map(|(id, r)| RoomInfo {
                room_id: id.clone(),
                title: r.title.clone(),
                code: r.code.clone(),
                peers: r.peers.len(),
                created_at: r.created_at,
            })
            .collect();
        out.sort_by_key(|r| r.created_at);
        out
    }

    /// Vérifie qu'une connexion est recevable, sans encore inscrire le pair.
    pub fn check_join(&self, room_id: &str, code: &str) -> Result<(), JoinError> {
        let room = self.map.get(room_id).ok_or(JoinError::UnknownRoom)?;
        if !room.code.is_empty() && room.code != code {
            return Err(JoinError::BadCode);
        }
        if room.peers.len() >= MAX_PEERS {
            return Err(JoinError::Full);
        }
        Ok(())
    }

    /// Message de bienvenue d'un pair : qui il est, et qui est déjà là.
    fn welcome(&self, room_id: &str, peer_id: &str) -> Value {
        let room = match self.map.get(room_id) {
            Some(r) => r,
            None => return json!({ "type": "error", "message": "Salle fermée." }),
        };
        let peers: Vec<Value> = room
            .peers
            .iter()
            .filter(|(id, _)| id.as_str() != peer_id)
            .map(|(id, p)| json!({ "id": id, "name": p.name }))
            .collect();
        json!({ "type": "welcome", "self": peer_id, "room": room_id, "title": room.title, "peers": peers })
    }

    /// Diffuse un message à tous les pairs de la salle sauf `except`.
    fn broadcast(&self, room_id: &str, except: Option<&str>, msg: &Value) {
        if let Some(room) = self.map.get(room_id) {
            let text = msg.to_string();
            for (id, peer) in &room.peers {
                if Some(id.as_str()) == except {
                    continue;
                }
                let _ = peer.tx.send(text.clone());
            }
        }
    }

    fn send_to(&self, room_id: &str, peer_id: &str, msg: &Value) {
        if let Some(peer) = self.map.get(room_id).and_then(|r| r.peers.get(peer_id)) {
            let _ = peer.tx.send(msg.to_string());
        }
    }

    /// Achemine un message reçu d'un pair : à un destinataire précis quand le
    /// champ `to` est présent (signalisation WebRTC), à toute la salle sinon
    /// (chat, transcription, états). L'émetteur est réécrit côté serveur : un
    /// client ne peut donc pas se faire passer pour un autre.
    fn route(&self, room_id: &str, from: &str, mut msg: Value) {
        let name = self
            .map
            .get(room_id)
            .and_then(|r| r.peers.get(from))
            .map(|p| p.name.clone())
            .unwrap_or_default();
        let to = msg.get("to").and_then(|v| v.as_str()).map(str::to_string);
        if let Some(obj) = msg.as_object_mut() {
            obj.insert("from".into(), json!(from));
            obj.insert("fromName".into(), json!(name));
            obj.remove("to");
        }
        match to {
            Some(target) => self.send_to(room_id, &target, &msg),
            None => self.broadcast(room_id, Some(from), &msg),
        }
    }
}

type Shared = Arc<Mutex<Rooms>>;

fn shared() -> &'static Shared {
    static S: std::sync::OnceLock<Shared> = std::sync::OnceLock::new();
    S.get_or_init(|| Arc::new(Mutex::new(Rooms::default())))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn rand_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    let _ = getrandom::getrandom(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

// ===================== Serveur =====================

#[derive(Deserialize)]
struct JoinQuery {
    room: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    name: String,
}

async fn health() -> impl IntoResponse {
    let rooms = shared().lock().await.list();
    Json(json!({ "ok": true, "rooms": rooms.len() }))
}

async fn ws_join(
    ws: WebSocketUpgrade,
    Query(q): Query<JoinQuery>,
    State(state): State<Shared>,
) -> impl IntoResponse {
    // Le refus est décidé AVANT l'upgrade : un code faux ne doit pas ouvrir de
    // socket, même une seconde.
    if let Err(e) = state.lock().await.check_join(&q.room, &q.code) {
        return (axum::http::StatusCode::FORBIDDEN, e.as_str()).into_response();
    }
    ws.on_upgrade(move |socket| handle_peer(socket, state, q))
}

async fn handle_peer(socket: WebSocket, state: Shared, q: JoinQuery) {
    let (mut sink, mut stream) = socket.split();
    let peer_id = rand_hex(6);
    let name = if q.name.trim().is_empty() {
        "Invité".to_string()
    } else {
        q.name.trim().chars().take(48).collect()
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    {
        let mut rooms = state.lock().await;
        if rooms.check_join(&q.room, &q.code).is_err() {
            return;
        }
        if let Some(room) = rooms.map.get_mut(&q.room) {
            room.peers.insert(
                peer_id.clone(),
                Peer {
                    name: name.clone(),
                    tx: tx.clone(),
                },
            );
        }
        let hello = rooms.welcome(&q.room, &peer_id);
        let _ = tx.send(hello.to_string());
        rooms.broadcast(
            &q.room,
            Some(&peer_id),
            &json!({ "type": "peer-join", "id": peer_id, "name": name }),
        );
    }

    // Sortie : tout ce qui est destiné à ce pair passe par le canal.
    let mut send_task = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    // Entrée : chaque message est un objet JSON, acheminé par le relais.
    let room_id = q.room.clone();
    let from = peer_id.clone();
    let st = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };
            // Un message trop gros n'a rien à faire ici : la signalisation est
            // de l'ordre du kilo-octet, le média ne passe pas par ce canal.
            if text.len() > 256 * 1024 {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                st.lock().await.route(&room_id, &from, value);
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    let mut rooms = state.lock().await;
    if let Some(room) = rooms.map.get_mut(&q.room) {
        room.peers.remove(&peer_id);
    }
    rooms.broadcast(
        &q.room,
        Some(&peer_id),
        &json!({ "type": "peer-leave", "id": peer_id, "name": name }),
    );
}

fn router() -> Router {
    Router::new()
        .route("/meet/health", get(health))
        .route("/meet/ws", get(ws_join))
        .with_state(shared().clone())
}

static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Démarre l'écouteur si ce n'est pas déjà fait. Idempotent.
fn ensure_server() {
    use std::sync::atomic::Ordering;
    // Édition standard : aucun écouteur n'est ouvert, jamais. Le module est
    // compilé (il ne dépend que de ce que Lumen embarque déjà) mais dort.
    if !cfg!(feature = "pro") {
        return;
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        let addr = SocketAddr::from(([0, 0, 0, 0], MEET_PORT));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                if let Err(e) = axum::serve(listener, router()).await {
                    eprintln!("[meet] serveur arrêté : {e}");
                    STARTED.store(false, Ordering::SeqCst);
                }
            }
            Err(e) => {
                eprintln!("[meet] écoute impossible sur {addr} : {e}");
                STARTED.store(false, Ordering::SeqCst);
            }
        }
    });
}

// ===================== Commandes =====================

#[derive(Serialize)]
pub struct MeetHost {
    pub port: u16,
    pub ip: Option<String>,
    pub running: bool,
}

/// Adresse à communiquer aux participants (IP du LAN + port).
#[tauri::command]
pub fn meet_host() -> MeetHost {
    MeetHost {
        port: MEET_PORT,
        ip: crate::companion::local_ip(),
        running: STARTED.load(std::sync::atomic::Ordering::SeqCst),
    }
}

/// Ouvre (ou rouvre) une salle sur cette machine et démarre le serveur.
#[tauri::command]
pub async fn meet_open_room(
    room_id: Option<String>,
    title: String,
    code: Option<String>,
) -> Result<RoomInfo, String> {
    if !cfg!(feature = "pro") {
        return Err("Les réunions font partie de Lumen Pro (build avec --features pro).".into());
    }
    ensure_server();
    let id = room_id.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| rand_hex(4));
    let code = code
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| rand_hex(3).to_uppercase());
    let title = if title.trim().is_empty() {
        "Réunion".to_string()
    } else {
        title.trim().to_string()
    };
    Ok(shared().lock().await.open(id, title, code, now_ms()))
}

#[tauri::command]
pub async fn meet_close_room(room_id: String) -> Result<(), String> {
    shared().lock().await.close(&room_id);
    Ok(())
}

#[tauri::command]
pub async fn meet_rooms() -> Result<Vec<RoomInfo>, String> {
    Ok(shared().lock().await.list())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(rooms: &mut Rooms, room: &str, id: &str, name: &str) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel();
        rooms.map.get_mut(room).unwrap().peers.insert(
            id.to_string(),
            Peer {
                name: name.to_string(),
                tx,
            },
        );
        rx
    }

    #[test]
    fn refuse_les_salles_inconnues_et_les_mauvais_codes() {
        let mut rooms = Rooms::default();
        rooms.open("r1".into(), "Point hebdo".into(), "AB12".into(), 1);
        assert_eq!(rooms.check_join("inconnue", "AB12"), Err(JoinError::UnknownRoom));
        assert_eq!(rooms.check_join("r1", "zzzz"), Err(JoinError::BadCode));
        assert!(rooms.check_join("r1", "AB12").is_ok());
    }

    #[test]
    fn refuse_au_dela_de_la_limite_de_pairs() {
        let mut rooms = Rooms::default();
        rooms.open("r1".into(), "Salle".into(), "".into(), 1);
        for i in 0..MAX_PEERS {
            peer(&mut rooms, "r1", &format!("p{i}"), "X");
        }
        assert_eq!(rooms.check_join("r1", ""), Err(JoinError::Full));
    }

    #[test]
    fn la_signalisation_ne_va_qu_au_destinataire() {
        let mut rooms = Rooms::default();
        rooms.open("r1".into(), "Salle".into(), "".into(), 1);
        let mut a = peer(&mut rooms, "r1", "a", "Alice");
        let mut b = peer(&mut rooms, "r1", "b", "Bob");
        let mut c = peer(&mut rooms, "r1", "c", "Carla");
        rooms.route("r1", "a", json!({ "type": "signal", "to": "b", "sdp": "offer" }));
        let got: Value = serde_json::from_str(&b.try_recv().unwrap()).unwrap();
        assert_eq!(got["from"], "a");
        assert_eq!(got["fromName"], "Alice");
        assert_eq!(got["sdp"], "offer");
        assert!(got.get("to").is_none(), "le destinataire n'est pas réémis");
        assert!(a.try_recv().is_err(), "l'émetteur ne se reçoit pas lui-même");
        assert!(c.try_recv().is_err(), "les tiers ne voient pas la signalisation");
    }

    #[test]
    fn le_chat_va_a_toute_la_salle_sauf_l_emetteur() {
        let mut rooms = Rooms::default();
        rooms.open("r1".into(), "Salle".into(), "".into(), 1);
        let mut a = peer(&mut rooms, "r1", "a", "Alice");
        let mut b = peer(&mut rooms, "r1", "b", "Bob");
        let mut c = peer(&mut rooms, "r1", "c", "Carla");
        rooms.route("r1", "a", json!({ "type": "chat", "text": "bonjour" }));
        assert!(a.try_recv().is_err());
        for rx in [&mut b, &mut c] {
            let got: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
            assert_eq!(got["text"], "bonjour");
            assert_eq!(got["fromName"], "Alice");
        }
    }

    #[test]
    fn un_pair_ne_peut_pas_usurper_un_autre_emetteur() {
        let mut rooms = Rooms::default();
        rooms.open("r1".into(), "Salle".into(), "".into(), 1);
        let _a = peer(&mut rooms, "r1", "a", "Alice");
        let mut b = peer(&mut rooms, "r1", "b", "Bob");
        rooms.route("r1", "a", json!({ "type": "chat", "text": "coucou", "from": "b", "fromName": "Bob" }));
        let got: Value = serde_json::from_str(&b.try_recv().unwrap()).unwrap();
        assert_eq!(got["from"], "a", "le serveur réécrit toujours l'émetteur");
        assert_eq!(got["fromName"], "Alice");
    }

    #[test]
    fn la_bienvenue_liste_les_autres_pairs() {
        let mut rooms = Rooms::default();
        rooms.open("r1".into(), "Comité".into(), "".into(), 1);
        let _a = peer(&mut rooms, "r1", "a", "Alice");
        let _b = peer(&mut rooms, "r1", "b", "Bob");
        let hello = rooms.welcome("r1", "a");
        assert_eq!(hello["type"], "welcome");
        assert_eq!(hello["title"], "Comité");
        let peers = hello["peers"].as_array().unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0]["name"], "Bob");
    }
}
