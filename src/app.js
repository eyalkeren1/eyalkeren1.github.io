/* app.js — viewport, parameter wiring, and STL export for the bin generator. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { buildBin, buildLid, mergeSolids } from './gridfinity.js';

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c1116);
scene.fog = new THREE.Fog(0x0c1116, 280, 620);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 4000);
camera.position.set(150, 130, 175);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 18, 0);

// ---- lighting: cool key + warm rim, soft fill (machinist bench feel) ----
scene.add(new THREE.HemisphereLight(0x9fb4c4, 0x16110a, 0.55));
const key = new THREE.DirectionalLight(0xfff1dd, 1.55);
key.position.set(80, 140, 60);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 10; key.shadow.camera.far = 600;
key.shadow.camera.left = -160; key.shadow.camera.right = 160;
key.shadow.camera.top = 160; key.shadow.camera.bottom = -160;
key.shadow.bias = -0.0004;
scene.add(key);
const rim = new THREE.DirectionalLight(0xff8a3c, 0.6);
rim.position.set(-120, 60, -90);
scene.add(rim);
const fill = new THREE.DirectionalLight(0x5fd0ff, 0.25);
fill.position.set(-40, 30, 120);
scene.add(fill);

// ---- ground: shadow catcher + engineering grid ----
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1200, 1200),
  new THREE.ShadowMaterial({ opacity: 0.32 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(840, 20, 0xff8a3c, 0x24303a);
grid.material.opacity = 0.5; grid.material.transparent = true;
scene.add(grid);

// ---- materials ----
const binMat = new THREE.MeshStandardMaterial({
  color: 0xff7a2f, metalness: 0.18, roughness: 0.62, flatShading: true,
});
const lidMat = new THREE.MeshStandardMaterial({
  color: 0x6fd6ff, metalness: 0.22, roughness: 0.5, flatShading: true,
  transparent: true, opacity: 0.96,
});

// model group oriented +Z(model) -> +Y(scene)
const root = new THREE.Group();
root.rotation.x = -Math.PI / 2;
scene.add(root);

let binMesh = null, lidMesh = null;
let lastBinSolid = null, lastLidSolid = null, lastMeta = null;

function disposeMesh(m) {
  if (!m) return;
  root.remove(m);
  m.geometry.dispose();
}
function geomFromSolid(solid) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(solid.positions, 3));
  g.computeVertexNormals(); // non-indexed => crisp flat facets
  return g;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const ids = [
  'gx','gy','heightUnits','wall','floor','divX','divY','dividerThickness',
  'stackingLip','vaseMode',
  'holesEnabled','holeDiameter','holeDepth',
  'indentCount','indentRadius','indentDepth',
  'lidEnabled','lidClearance','lidWall','lidSkirt','lidTop','lidPinch','lidStackable',
  'showLid','explode',
];
function readParams() {
  return {
    gx: +$('gx').value, gy: +$('gy').value,
    heightUnits: +$('heightUnits').value,
    wall: +$('wall').value, floor: +$('floor').value,
    divX: +$('divX').value, divY: +$('divY').value,
    dividerThickness: +$('dividerThickness').value,
    cornerSegs: 8,
    stackingLip: $('stackingLip').checked,
    vaseMode: $('vaseMode').checked,
    holes: { enabled: $('holesEnabled').checked, diameter: +$('holeDiameter').value, depth: +$('holeDepth').value },
    indents: { count: +$('indentCount').value, radius: +$('indentRadius').value, depth: +$('indentDepth').value },
    lid: {
      clearance: +$('lidClearance').value, wall: +$('lidWall').value,
      skirtHeight: +$('lidSkirt').value, topThickness: +$('lidTop').value,
      pinchHandle: $('lidPinch').checked, stackable: $('lidStackable').checked,
    },
  };
}

// keep numeric readouts in sync
function syncReadouts() {
  document.querySelectorAll('[data-out]').forEach((el) => {
    const src = $(el.dataset.out);
    if (src) el.textContent = (+src.value).toFixed(src.step && src.step.includes('.') ? 1 : 0);
  });
}

// ---------------------------------------------------------------------------
// Regenerate
// ---------------------------------------------------------------------------
function regenerate() {
  const p = readParams();
  let bin;
  try { bin = buildBin(p); } catch (e) { console.error(e); return; }
  lastBinSolid = mergeSolids(bin.solids);
  lastMeta = bin.meta;

  disposeMesh(binMesh);
  binMesh = new THREE.Mesh(geomFromSolid(lastBinSolid), binMat);
  binMesh.castShadow = true; binMesh.receiveShadow = true;
  root.add(binMesh);

  disposeMesh(lidMesh); lidMesh = null; lastLidSolid = null;
  if (p.lid && $('lidEnabled').checked) {
    const lid = buildLid(p, bin.meta);
    lastLidSolid = lid.solid;
    lidMesh = new THREE.Mesh(geomFromSolid(lid.solid), lidMat);
    lidMesh.castShadow = true;
    lidMesh.userData.seatZ = lid.seatZ;
    lidMesh.userData.height = lid.height;
    root.add(lidMesh);
  }
  positionLid();
  updateReadout(p);
  frameModel();
}

function positionLid() {
  if (!lidMesh || !lastMeta) return;
  lidMesh.visible = $('showLid').checked;
  const seatZ = lidMesh.userData.seatZ;
  const gap = $('explode').checked ? 38 : 0;
  // lid built with its underside at local z=0; place along model +Z
  lidMesh.position.set(0, 0, seatZ + gap);
}

function updateReadout(p) {
  const W = lastMeta ? lastMeta.halfX * 2 : (p.gx * 42 - 0.5);
  const D = lastMeta ? lastMeta.halfY * 2 : (p.gy * 42 - 0.5);
  const H = lastMeta ? lastMeta.total : p.heightUnits * 7; // includes lip when present
  $('dimW').textContent = W.toFixed(1);
  $('dimD').textContent = D.toFixed(1);
  $('dimH').textContent = H.toFixed(1);
  const triCount = (lastBinSolid ? lastBinSolid.positions.length / 9 : 0) +
                   (lastLidSolid ? lastLidSolid.positions.length / 9 : 0);
  $('triCount').textContent = triCount.toLocaleString();
}

// fit camera target height to model without snapping the orbit each tweak
let framedOnce = false;
function frameModel() {
  if (framedOnce) return;
  framedOnce = true;
  const p = readParams();
  controls.target.set(0, (p.heightUnits * 7) / 2, 0);
}

// ---------------------------------------------------------------------------
// STL export
// ---------------------------------------------------------------------------
const exporter = new STLExporter();
function downloadSTL(solid, name) {
  if (!solid) return;
  const g = geomFromSolid(solid);
  const mesh = new THREE.Mesh(g);
  // export in model space (+Z up) which is the conventional print orientation
  const str = exporter.parse(mesh, { binary: true });
  const blob = new Blob([str], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  g.dispose();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
let debounce;
function onChange() {
  syncReadouts();
  clearTimeout(debounce);
  debounce = setTimeout(regenerate, 110);
}
ids.forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', onChange);
  el.addEventListener('change', onChange);
});
$('showLid').addEventListener('change', positionLid);
$('explode').addEventListener('change', positionLid);
$('exportBin').addEventListener('click', () => downloadSTL(lastBinSolid, 'gridfinity-bin.stl'));
$('exportLid').addEventListener('click', () =>
  downloadSTL(lastLidSolid, 'gridfinity-lid.stl') || (!lastLidSolid && flash('Enable the lid first')));
$('resetView').addEventListener('click', () => {
  camera.position.set(150, 130, 175);
  controls.target.set(0, (readParams().heightUnits * 7) / 2, 0);
});

function flash(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------------------
// Resize + render loop
// ---------------------------------------------------------------------------
function resize() {
  const w = viewport.clientWidth || viewport.parentElement.clientWidth || window.innerWidth;
  const h = viewport.clientHeight || viewport.parentElement.clientHeight || window.innerHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

try {
  resize();
  syncReadouts();
  regenerate();
  // size can be 0 on the very first frame in some browsers; re-fit next frame
  requestAnimationFrame(() => { resize(); });
  tick();
  if (typeof window !== 'undefined') window.__GF_OK__ = true;
} catch (err) {
  if (typeof window !== 'undefined' && window.__gfError) window.__gfError(err);
  else console.error(err);
}
