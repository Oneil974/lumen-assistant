import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
const context={measureText:s=>({width:s.length*20}),createRadialGradient:()=>({addColorStop(){}})};
for(const method of ['beginPath','roundRect','fill','fillRect','clearRect','fillText'])context[method]=()=>{};
globalThis.document={documentElement:{lang:'fr'},createElement:()=>({width:0,height:0,getContext:()=>context})};
const source=(await readFile(new URL('../src/xr-design.js',import.meta.url),'utf8')).replace('import * as THREE from \'/lib/three.module.js\';',`import * as THREE from '${new URL('../node_modules/three/build/three.module.js',import.meta.url).href}';`);
const design=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
test('sculpted icon silhouettes have finite bounds and a bounded geometry budget',()=>{
  for(const build of [design.createSculptedIcon, design.createDockIcon]) for(const kind of design.SCULPTED_ICONS){
    const icon=build(kind);icon.updateMatrixWorld(true);
    const box=new THREE.Box3().setFromObject(icon),size=box.getSize(new THREE.Vector3());
    assert.ok([size.x,size.y,size.z].every(v=>Number.isFinite(v)&&v>0&&v<1.4),`${kind}: ${size.toArray()}`);
    let triangles=0;icon.traverse(o=>{if(o.geometry)triangles+=(o.geometry.index?.count || o.geometry.attributes.position.count)/3;});
    assert.ok(triangles<12000,`${kind} has ${triangles} triangles`);
  }
});
test('rounded geometry and materials are shared; disposing an instance keeps the others usable',()=>{
  assert.equal(design.roundedGeometry(.2,.1,.01),design.roundedGeometry(.2,.1,.01));
  assert.equal(design.lightMaterial(new THREE.Color(0x123456)),design.lightMaterial(0x123456));
  assert.notEqual(design.lightMaterial(0x123456),design.lightMaterial(0x654321));
  const first=design.createSculptedIcon('calendar'),second=design.createSculptedIcon('calendar');
  let sharedDisposals=0,uniqueDisposals=0;
  first.traverse(o=>{o.geometry?.addEventListener('dispose',()=>o.geometry.userData.xrShared?sharedDisposals++:uniqueDisposals++);});
  design.disposeDesign(first);assert.equal(sharedDisposals,0);assert.ok(uniqueDisposals>0);
  assert.ok(second.children.length>0);
});
test('native XR asset table includes the new modules and all new imports resolve',async()=>{
  const companion=await readFile(new URL('../src-tauri/src/companion.rs',import.meta.url),'utf8');
  for(const file of ['xr-design.js','xr-light-desk.js'])assert.ok(companion.includes(`include_str!("../../src/${file}")`));
  for(const file of ['xr-design.js','xr-light-desk.js','xr-props.js','xr.js']){
    const text=await readFile(new URL(`../src/${file}`,import.meta.url),'utf8');
    for(const [,path]of text.matchAll(/from\s+["'](\/[^"']+)["']/g))await readFile(new URL(`../src${path}`,import.meta.url));
  }
});

test('every dock icon has a saturated backing and a separate shallow glass layer',()=>{
  for(const kind of design.DOCK_ICON_KINDS){
    const icon=design.createDockIcon(kind);icon.updateMatrixWorld(true);
    const layers={base:0,glass:0};
    icon.traverse(o=>{if(o.userData.dockLayer in layers)layers[o.userData.dockLayer]++;});
    assert.ok(layers.base>0 && layers.glass>0,`${kind}: missing backing or glass`);
    const size=new THREE.Box3().setFromObject(icon).getSize(new THREE.Vector3());
    assert.ok(size.z<.18,`${kind}: excessive relief ${size.z}`);
  }
});
test('search, focus and recenter have different geometry silhouettes',()=>{
  const signature=kind=>{
    const icon=design.createDockIcon(kind);const parts=[];
    icon.traverse(o=>{if(o.isMesh)parts.push([o.geometry.attributes.position.count,...o.position.toArray()]);});
    return JSON.stringify(parts);
  };
  assert.equal(new Set(['search','focus','target'].map(signature)).size,3);
});
