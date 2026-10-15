// Matériaux de l'orbe de Lumen (cœur de couleurs + coque de verre).
//
// Partagés par l'orbe du bureau (orb.js) et celle de Lumen XR (xr.js) : c'est
// la MÊME orbe, seul l'habillage autour (yeux HTML ou 3D, caméra) change.
// L'orbe est définie dans une sphère de rayon 1 (cœur 0,82, coque 1,0).

import * as THREE from './three.module.js';

/**
 * @param {string[]} colors      cinq teintes (hex)
 * @param {string}   pulseColor  couleur du battement de cœur
 */
export function createOrbMaterials(colors, pulseColor = '#ff4d6d') {
  const cols = colors.map((h) => new THREE.Color(h));
  const orbPulseColor = pulseColor;
  const coreUniforms = {
    uTime: { value: 0 },
    uSpeed: { value: 0.30 },
    uIntensity: { value: 1.0 },
    uAudio: { value: 0.0 },
    uPulse: { value: 0.0 },           // current pulse strength (0 when idle)
    uPulseRadius: { value: 0.0 },     // expanding ring position (0 center → ~1.1 rim)
    uPulseColor: { value: new THREE.Color(orbPulseColor) },
    uCol0: { value: cols[0] },
    uCol1: { value: cols[1] },
    uCol2: { value: cols[2] },
    uCol3: { value: cols[3] },
    uCol4: { value: cols[4] },
  };
  const coreMat = new THREE.ShaderMaterial({
    uniforms: coreUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      varying vec3 vPos;
      varying vec3 vViewNormal;
      varying vec3 vViewPos;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        vViewNormal = normalize(normalMatrix * normal);
        vPos = position;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uIntensity;
      uniform float uAudio;
      uniform float uPulse;
      uniform float uPulseRadius;
      uniform vec3 uPulseColor;
      uniform vec3 uCol0, uCol1, uCol2, uCol3, uCol4;
      varying vec3 vPos;
      varying vec3 vViewNormal;
      varying vec3 vViewPos;

      void main() {
        float t = uTime;
        float breath = 0.5 + 0.5 * sin(t * 0.8);
        float R = 0.82 * (1.0 + 0.03 * breath);
        float sharp = mix(5.0, 7.5, uAudio);
        float mv = 0.42 + uAudio * 0.25;

        vec3 colSum = vec3(0.0);
        float total = 0.0;
        vec3 dir; float w;

        dir = normalize(vec3( 0.6,  0.5,  0.4) + vec3(sin(t*0.61+1.7), sin(t*0.52+1.0), sin(t*0.73+2.0)) * mv);
        w = exp(-sharp * pow(distance(vPos, dir * R), 2.0)); colSum += uCol0 * w; total += w;
        dir = normalize(vec3(-0.5,  0.6, -0.2) + vec3(sin(t*0.55+0.3), sin(t*0.48+2.2), sin(t*0.66+0.9)) * mv);
        w = exp(-sharp * pow(distance(vPos, dir * R), 2.0)); colSum += uCol1 * w; total += w;
        dir = normalize(vec3( 0.2, -0.5,  0.7) + vec3(sin(t*0.70+2.5), sin(t*0.50+0.7), sin(t*0.60+3.1)) * mv);
        w = exp(-sharp * pow(distance(vPos, dir * R), 2.0)); colSum += uCol2 * w; total += w;
        dir = normalize(vec3(-0.55, -0.35, 0.5) + vec3(sin(t*0.50+1.1), sin(t*0.62+2.9), sin(t*0.58+1.5)) * mv);
        w = exp(-sharp * pow(distance(vPos, dir * R), 2.0)); colSum += uCol3 * w; total += w;
        dir = normalize(vec3( 0.45, 0.15, -0.6) + vec3(sin(t*0.66+0.5), sin(t*0.54+1.8), sin(t*0.70+2.4)) * mv);
        w = exp(-sharp * pow(distance(vPos, dir * R), 2.0)); colSum += uCol4 * w; total += w;

        vec3 blob = colSum / max(total, 0.0001);
        float presence = smoothstep(0.03, 0.70, total);

        // pastel at rest, much more saturated while thinking/speaking (uAudio up)
        float pastel = 0.16 * (1.0 - 0.85 * uAudio);
        vec3 col = mix(blob, vec3(1.0), pastel);
        col = mix(col, blob, uAudio * 0.55);

        float facing = max(dot(normalize(vViewNormal), normalize(-vViewPos)), 0.0);
        col *= 0.92 + 0.14 * facing;
        col *= uIntensity * (1.0 + uAudio * 0.22);

        // transparent between blobs (frosted desktop shows through)
        float alpha = 0.10 + presence * (0.60 + uAudio * 0.22);

        // Heartbeat: a colored ring rippling radially from the front center
        // out to the rim. uPulseRadius expands over time, uPulse fades it out.
        if (uPulse > 0.001) {
          float facing = max(dot(normalize(vViewNormal), normalize(-vViewPos)), 0.0);
          float rad = 1.0 - facing;                       // 0 center → 1 rim
          float ring = smoothstep(0.22, 0.0, abs(rad - uPulseRadius));
          col += uPulseColor * ring * uPulse * 1.4;
          alpha = clamp(alpha + ring * uPulse * 0.8, 0.0, 1.0);
        }

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  const GLASS_TYPES = {
    thin:    { opacity: 0.42, rimPower: 4.5, rimStrength: 1.0,  specPower: 60.0,  specStrength: 0.45, fill: 0.0,  iridescence: 0 },
    crystal: { opacity: 0.70, rimPower: 3.0, rimStrength: 1.35, specPower: 100.0, specStrength: 0.85, fill: 0.0,  iridescence: 0 },
    frosted: { opacity: 0.55, rimPower: 2.2, rimStrength: 0.75, specPower: 22.0,  specStrength: 0.25, fill: 0.14, iridescence: 0 },
    bubble:  { opacity: 0.60, rimPower: 3.2, rimStrength: 1.15, specPower: 80.0,  specStrength: 0.55, fill: 0.02, iridescence: 1 },
    none:    { opacity: 0.0,  rimPower: 4.5, rimStrength: 0.0,  specPower: 60.0,  specStrength: 0.0,  fill: 0.0,  iridescence: 0 },
  };
  const shellUniforms = {
    uOpacity: { value: 0.42 },
    uRimPower: { value: 4.5 },
    uRimStrength: { value: 1.0 },
    uSpecPower: { value: 60.0 },
    uSpecStrength: { value: 0.45 },
    uFill: { value: 0.0 },
    uIridescence: { value: 0.0 },
  };
  const shellMat = new THREE.ShaderMaterial({
    uniforms: shellUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      varying vec3 vViewNormal;
      varying vec3 vViewPos;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uOpacity, uRimPower, uRimStrength, uSpecPower, uSpecStrength, uFill, uIridescence;
      varying vec3 vViewNormal;
      varying vec3 vViewPos;
      void main() {
        vec3 N = normalize(vViewNormal);
        vec3 V = normalize(-vViewPos);
        // bright rim at the edge — sharpness controlled by the glass type
        float fres = pow(1.0 - max(dot(N, V), 0.0), uRimPower);
        // tight specular highlight
        vec3 L = normalize(vec3(-0.35, 0.8, 0.5));
        float spec = pow(max(dot(reflect(-L, N), V), 0.0), uSpecPower) * uSpecStrength;
        // soap-bubble iridescence: shift rim hue with the viewing angle
        vec3 rimCol = vec3(1.0);
        if (uIridescence > 0.5) {
          rimCol = 0.55 + 0.45 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + fres * 1.4));
        }
        vec3 color = rimCol * fres * uRimStrength + vec3(1.0) * spec;
        float alpha = clamp(fres * uRimStrength * 0.7 + spec + uFill, 0.0, 1.0) * uOpacity;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
  return { coreUniforms, coreMat, shellUniforms, shellMat, GLASS_TYPES };
}
