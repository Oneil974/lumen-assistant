//! Bloc et déclencheur RFID : présence dans le catalogue et forme sérialisée.

use fluxo_engine::{Engine, Trigger};

#[test]
fn rfid_block_is_registered() {
    let engine = Engine::with_builtins();
    let spec = engine
        .specs()
        .into_iter()
        .find(|s| s.id == "lumen_rfid_badge")
        .expect("bloc lumen_rfid_badge absent du catalogue");
    assert_eq!(spec.category, "Lumen");
    let keys: Vec<_> = spec.params.iter().map(|p| p.key.clone()).collect();
    assert_eq!(keys, vec!["wait_seconds", "field"]);
}

#[test]
fn rfid_trigger_round_trips() {
    let t: Trigger = serde_json::from_str(r#"{"type":"rfid","uid":"04A2B3C4"}"#).unwrap();
    match &t {
        Trigger::Rfid { uid } => assert_eq!(uid, "04A2B3C4"),
        other => panic!("mauvais déclencheur : {other:?}"),
    }
    // L'UID est facultatif : absent = n'importe quel badge.
    let any: Trigger = serde_json::from_str(r#"{"type":"rfid"}"#).unwrap();
    assert!(matches!(any, Trigger::Rfid { ref uid } if uid.is_empty()));
    assert_eq!(
        serde_json::to_string(&t).unwrap(),
        r#"{"type":"rfid","uid":"04A2B3C4"}"#
    );
}
