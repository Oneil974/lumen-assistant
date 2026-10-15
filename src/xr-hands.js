// Lumen XR — mains.
//
// Lecture des articulations (WebXR Hand Input via three.js `getHand`) et
// détection de trois gestes, sans dépendance :
//
//   • PINCEMENT (pouce + index) : position du point de pincement, avec
//     hystérésis — sert à la saisie DIRECTE (attraper l'orbe ou une poignée
//     à portée de main, sans rayon) ;
//   • POKE : bout de l'index, pour appuyer sur les boutons d'un panneau proche ;
//   • PAUME VERS LE HAUT, main ouverte, tenue ~0,8 s : appelle l'orbe.
//
// Repère des articulations (spec WebXR Hand Input) : −Z le long de l'os vers
// le bout des doigts, −Y perpendiculaire à la PAUME. Paume vers le haut ⇔ la
// direction −Y du poignet pointe vers le ciel.

import * as THREE from "/lib/three.module.js";

const PINCH_ON = 0.018;   // m : pouce/index plus proches → pincement
const PINCH_OFF = 0.035;  // m : hystérésis de relâchement
const PALM_HOLD_MS = 800;
const THUMB_HOLD_MS = 500;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Hands {
  constructor(renderer, scene) {
    this.hands = [0, 1].map((i) => {
      const hand = renderer.xr.getHand(i);
      scene.add(hand);
      const h = {
        index: i, hand, tracked: false,
        pinching: false, pinchPoint: new THREE.Vector3(),
        tip: new THREE.Vector3(), wrist: new THREE.Vector3(), palmNormal: new THREE.Vector3(),
        palmUpSince: 0, palmFired: false, handedness: "",
        thumbSince: 0, thumbFired: false, speed: 0, prevTip: new THREE.Vector3(), prevT: 0,
      };
      hand.addEventListener("connected", (e) => { h.handedness = e.data?.handedness || ""; h.source = e.data; });
      hand.addEventListener("disconnected", () => { h.tracked = false; h.pinching = false; h.source = null; });
      return h;
    });
    this.onPalmUp = null; // (hand) => void
    this.onThumbsUp = null; // (hand) => void — pouce levé, autres doigts repliés
  }

  /// Main suivie correspondant à un inputSource (celui du contrôleur i).
  forSource(source) {
    return this.hands.find((h) => h.source && h.source === source && h.tracked) || null;
  }

  update(now) {
    for (const h of this.hands) {
      const j = h.hand.joints;
      const tip = j?.["index-finger-tip"], thumb = j?.["thumb-tip"], wrist = j?.["wrist"];
      h.tracked = !!(h.source && tip && thumb && wrist && tip.visible !== false && wrist.visible !== false);
      if (!h.tracked) { h.pinching = false; h.palmUpSince = 0; continue; }
      tip.getWorldPosition(h.tip);
      thumb.getWorldPosition(_b);
      wrist.getWorldPosition(h.wrist);
      // Vitesse du bout de l'index (m/s) : un geste brusque vers l'orbe la fait s'écarter.
      if (h.prevT) h.speed = h.speed * 0.6 + 0.4 * (h.tip.distanceTo(h.prevTip) / Math.max(0.008, (now - h.prevT) / 1000));
      h.prevTip.copy(h.tip); h.prevT = now;
      // Pouce levé : pouce bien au-dessus du poignet, index et majeur repliés.
      const mid = j["middle-finger-tip"];
      if (mid) {
        mid.getWorldPosition(_a);
        const up = _b.y - h.wrist.y > 0.065 && h.tip.distanceTo(h.wrist) < 0.1 && _a.distanceTo(h.wrist) < 0.1;
        if (up) {
          if (!h.thumbSince) h.thumbSince = now;
          if (!h.thumbFired && now - h.thumbSince > THUMB_HOLD_MS) { h.thumbFired = true; this.onThumbsUp?.(h); }
        } else { h.thumbSince = 0; h.thumbFired = false; }
      }
      const d = h.tip.distanceTo(_b);
      h.pinching = h.pinching ? d < PINCH_OFF : d < PINCH_ON;
      h.pinchPoint.copy(h.tip).add(_b).multiplyScalar(0.5);

      // Paume : −Y du poignet, en coordonnées monde.
      wrist.getWorldQuaternion(_q);
      h.palmNormal.set(0, -1, 0).applyQuaternion(_q);
      const open = d > 0.06 && h.tip.distanceTo(h.wrist) > 0.12;
      if (h.palmNormal.y > 0.75 && open) {
        if (!h.palmUpSince) h.palmUpSince = now;
        if (!h.palmFired && now - h.palmUpSince > PALM_HOLD_MS) {
          h.palmFired = true;
          this.onPalmUp?.(h);
        }
      } else {
        h.palmUpSince = 0;
        h.palmFired = false;
      }
    }
  }

  /// Point au-dessus de la paume (pour y faire venir l'orbe).
  abovePalm(h, height = 0.14) {
    _a.copy(h.wrist).lerp(h.tip, 0.35);
    return _a.clone().addScaledVector(h.palmNormal, height);
  }
}
