// Lumen XR — panneaux en couches WebXR natives (expérimental).
//
// Un panneau est d'ordinaire une TEXTURE posée sur un plan 3D : le casque la
// ré-échantillonne deux fois (texture → image de l'œil → déformation de la
// lentille), d'où un texte un peu doux. Une « quad layer » est confiée
// directement au compositeur du casque, qui l'échantillonne une seule fois à
// la résolution de l'écran : texte net comme dans le navigateur du Quest.
//
// Mise en œuvre (passthrough uniquement) :
//   • les couches quad passent SOUS la couche de projection de three.js ;
//   • le maillage du panneau reste dans la scène mais n'écrit plus de couleur
//     (colorWrite = false) : il perce un trou transparent dans la projection
//     à travers lequel on voit la couche, tout en gardant sa profondeur — un
//     objet 3D derrière le panneau reste caché, une main devant passe devant ;
//   • chaque fois que le panneau se redessine, son canvas est recopié dans la
//     texture de la couche.
// En VR (fond opaque) ou sans le support « layers », rien ne change.

import * as THREE from "/lib/three.module.js";

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

export class PanelLayers {
  constructor(renderer, panels) {
    this.renderer = renderer;
    this.panels = panels;          // tableau vivant des panneaux de xr.js
    this.enabled = false;
    this.session = null;
    this.binding = null;
    this.base = null;              // couche de projection de three.js
    this.quads = new Map();        // panneau → { layer, w, h }
    this.lastOrder = "";
  }

  get supported() {
    return typeof XRWebGLBinding !== "undefined" && "createQuadLayer" in XRWebGLBinding.prototype;
  }

  /// À l'entrée en XR, APRÈS renderer.xr.setSession().
  start(session, passthrough) {
    this.stop();
    const layers = session.renderState?.layers;
    if (!this.enabled || !passthrough || !this.supported || !layers?.length) return false;
    this.session = session;
    this.binding = this.renderer.xr.getBinding();
    this.base = layers[0];
    return true;
  }

  stop() {
    for (const [panel, q] of this.quads) {
      panel.material.colorWrite = true;
      try { q.layer.destroy?.(); } catch {}
    }
    this.quads.clear();
    this.session = null;
    this.binding = null;
    this.base = null;
    this.lastOrder = "";
  }

  /// Une fois par image, avant le rendu de three.js.
  update(frame, refSpace) {
    if (!this.session || !frame || !refSpace) return;
    const gl = this.renderer.getContext();
    const visible = this.panels.filter((p) => isShown(p.object));

    // Couches à créer (nouveau panneau visible, ou canvas redimensionné).
    for (const panel of visible) {
      const q = this.quads.get(panel);
      const w = panel.canvas.width, h = panel.canvas.height;
      if (q && q.w === w && q.h === h) continue;
      if (q) { try { q.layer.destroy?.(); } catch {} }
      let layer;
      try {
        layer = this.binding.createQuadLayer({
          space: refSpace, viewPixelWidth: w, viewPixelHeight: h, layout: "mono",
        });
      } catch { continue; }
      this.quads.set(panel, { layer, w, h });
      panel.layerDirty = true;
    }
    // Couches à retirer (panneau caché ou fermé).
    for (const [panel, q] of this.quads) {
      if (visible.includes(panel)) continue;
      panel.material.colorWrite = true;
      try { q.layer.destroy?.(); } catch {}
      this.quads.delete(panel);
    }

    // Pose, taille et contenu de chaque couche.
    for (const [panel, q] of this.quads) {
      panel.mesh.updateMatrixWorld(true);
      panel.mesh.matrixWorld.decompose(_p, _q, _s);
      q.layer.transform = new XRRigidTransform(
        { x: _p.x, y: _p.y, z: _p.z },
        { x: _q.x, y: _q.y, z: _q.z, w: _q.w },
      );
      // Une quad layer se mesure en DEMI-largeur / DEMI-hauteur.
      q.layer.width = (panel.width * _s.x) / 2;
      q.layer.height = (panel.height * _s.y) / 2;
      panel.material.colorWrite = false;
      if (panel.layerDirty || q.layer.needsRedraw) {
        const sub = this.binding.getSubImage(q.layer, frame);
        gl.bindTexture(gl.TEXTURE_2D, sub.colorTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, panel.canvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.bindTexture(gl.TEXTURE_2D, null);
        panel.layerDirty = false;
        // three.js suit l'état GL : on l'avertit qu'on y a touché.
        this.renderer.resetState();
      }
    }

    // Ordre de composition : couches des panneaux SOUS la projection.
    const order = [...this.quads.values()].map((q) => q.w + "x" + q.h).join(",") + "|" + this.quads.size;
    if (order !== this.lastOrder) {
      this.lastOrder = order;
      try {
        this.session.updateRenderState({ layers: [...[...this.quads.values()].map((q) => q.layer), this.base] });
      } catch { /* le navigateur refuse : on reste sur les textures */ }
    }
  }
}

function isShown(obj) {
  for (let o = obj; o; o = o.parent) if (!o.visible) return false;
  return true;
}
