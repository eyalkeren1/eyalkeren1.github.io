/* =============================================================================
 * geometry-core.js  —  Gridfinity geometry generator (no dependencies)
 *
 * Produces watertight triangle meshes as plain {positions:Float32Array} solids
 * (non-indexed: 9 floats per triangle). No three.js, no CSG — so it runs in
 * plain Node for testing and in the browser unchanged.
 *
 * Coordinate system: +Z up. Model centered on X/Y. Base sits at z = 0.
 * The bin is emitted as a LIST of individually-watertight solids
 * (feet + body cup + dividers). Slicers union overlapping closed solids, so the
 * assembly prints as one piece. The lid is returned as a separate solid.
 * ===========================================================================*/

import { earcut } from './earcut.js';

// ---- Gridfinity standard constants (mm) -----------------------------------
export const GRID = 42.0;       // grid pitch
export const CLEARANCE = 0.5;   // total XY clearance (0.25 / side)
export const HEIGHT_UNIT = 7.0; // z per height-unit
export const BASE_H = 4.75;     // total base/foot height
export const OUTER_R = 3.75;    // body corner radius
// base profile, bottom -> up: chamfer / straight / chamfer (45° chamfers)
const B_CHAMFER1 = 0.8;
const B_STRAIGHT = 1.8;
const B_CHAMFER2 = 2.15;
const FOOT_FULL_HALF = (GRID - CLEARANCE) / 2; // 20.75

// Stacking lip (per Gridfinity spec: adds 4.4mm at the top). Outer top chamfer
// is 45°; the rim overhangs slightly to locate a stacked bin's feet.
const LIP_H = 4.4;
const LIP_TOP_CHAMFER = 1.9;          // 45° outer chamfer at the very top
const LIP_VERT = LIP_H - LIP_TOP_CHAMFER; // 2.5 straight before the chamfer

// Derived lip + inset-lid-ledge geometry, shared by the cup and the lid so they
// always mate. `lidThk` sets the ledge depth so the inset lid sits flush.
function lipGeometry(halfX, halfY, wall, total, lidThk) {
  const cT = LIP_TOP_CHAMFER;
  const rimTopW = Math.max(0.8, wall - 0.2);          // flat rim-top width
  const support = 1.0;                                // ledge overhang under lid edge
  const ld = Math.min(Math.max(lidThk ?? 1.6, 0.8), 3.0);
  const lipTop = total + LIP_H;
  const ledgeZ = lipTop - ld;                          // shelf the lid rests on
  return {
    cT, rimTopW, support, ld, lipTop, ledgeZ,
    Ax: halfX - cT - rimTopW,                          // rim inner-top X half
    Ay: halfY - cT - rimTopW,
  };
}

// ---------------------------------------------------------------------------
// Low-level mesh accumulator
// ---------------------------------------------------------------------------
class Mesh {
  constructor() { this.v = []; } // flat list of triangle vertices (x,y,z,...)
  tri(a, b, c) { this.v.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]); }
  // quad a-b-c-d (CCW) -> two tris
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  solid() {
    const positions = makeConsistent(new Float32Array(this.v));
    return { positions };
  }
}

// Signed volume (×6) of a triangle soup.
function signedVolume6(p) {
  let vol = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax=p[i],ay=p[i+1],az=p[i+2];
    const bx=p[i+3],by=p[i+4],bz=p[i+5];
    const cx=p[i+6],cy=p[i+7],cz=p[i+8];
    const crx = by*cz - bz*cy, cry = bz*cx - bx*cz, crz = bx*cy - by*cx;
    vol += (ax*crx + ay*cry + az*crz);
  }
  return vol;
}

// Weld vertices, make all adjacent face windings mutually consistent via a BFS
// over shared edges, then flip globally so normals point outward (vol > 0).
// Robust for any orientable closed manifold — removes the need to hand-tune the
// winding of every individual face builder.
function makeConsistent(positions) {
  const nTri = positions.length / 9;
  if (nTri === 0) return positions;
  const Q = 1e4;
  const map = new Map();
  const verts = [];
  const tri = [];
  const vid = (x, y, z) => {
    const k = `${Math.round(x*Q)},${Math.round(y*Q)},${Math.round(z*Q)}`;
    let id = map.get(k);
    if (id === undefined) { id = verts.length; verts.push([x, y, z]); map.set(k, id); }
    return id;
  };
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    tri.push([
      vid(positions[o],   positions[o+1], positions[o+2]),
      vid(positions[o+3], positions[o+4], positions[o+5]),
      vid(positions[o+6], positions[o+7], positions[o+8]),
    ]);
  }
  const ekey = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
  const edgeMap = new Map();
  for (let t = 0; t < nTri; t++) {
    const [a, b, c] = tri[t];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = ekey(u, v);
      let arr = edgeMap.get(k);
      if (!arr) { arr = []; edgeMap.set(k, arr); }
      arr.push(t);
    }
  }
  const visited = new Array(nTri).fill(false);
  for (let s = 0; s < nTri; s++) {
    if (visited[s]) continue;
    visited[s] = true;
    const stack = [s];
    while (stack.length) {
      const t = stack.pop();
      const [a, b, c] = tri[t];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const arr = edgeMap.get(ekey(u, v));
        for (const nt of arr) {
          if (nt === t || visited[nt]) continue;
          const [na, nb, nc] = tri[nt];
          let sameDir = false, hasEdge = false;
          for (const [p, q] of [[na, nb], [nb, nc], [nc, na]]) {
            if (p === u && q === v) { sameDir = true; hasEdge = true; }
            else if (p === v && q === u) { hasEdge = true; }
          }
          if (!hasEdge) continue;
          if (sameDir) tri[nt] = [na, nc, nb]; // flip to oppose shared edge
          visited[nt] = true;
          stack.push(nt);
        }
      }
    }
  }
  const out = new Float32Array(positions.length);
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    const [a, b, c] = tri[t];
    out[o]=verts[a][0];   out[o+1]=verts[a][1]; out[o+2]=verts[a][2];
    out[o+3]=verts[b][0]; out[o+4]=verts[b][1]; out[o+5]=verts[b][2];
    out[o+6]=verts[c][0]; out[o+7]=verts[c][1]; out[o+8]=verts[c][2];
  }
  if (signedVolume6(out) < 0) {
    for (let i = 0; i < out.length; i += 9)
      for (let k = 0; k < 3; k++) { const tmp = out[i+3+k]; out[i+3+k] = out[i+6+k]; out[i+6+k] = tmp; }
  }
  return out;
}

// Ensure outward-facing normals: if signed volume is negative, swap winding.
function fixOrientation(p) {
  let vol = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax=p[i],ay=p[i+1],az=p[i+2];
    const bx=p[i+3],by=p[i+4],bz=p[i+5];
    const cx=p[i+6],cy=p[i+7],cz=p[i+8];
    // (a · (b × c)) / 6
    const crx = by*cz - bz*cy;
    const cry = bz*cx - bx*cz;
    const crz = bx*cy - by*cx;
    vol += (ax*crx + ay*cry + az*crz);
  }
  if (vol < 0) {
    for (let i = 0; i < p.length; i += 9) {
      // swap vertex b and c
      for (let k = 0; k < 3; k++) {
        const t = p[i+3+k]; p[i+3+k] = p[i+6+k]; p[i+6+k] = t;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2D loop generators (all returned CCW in XY)
// ---------------------------------------------------------------------------
// Rounded rectangle outline. Returns [[x,y],...] CCW, length = 4*(seg+1).
export function roundedRectLoop(halfX, halfY, r, seg) {
  r = Math.max(0, Math.min(r, Math.min(halfX, halfY) - 1e-4));
  const pts = [];
  // corner centers, CCW starting bottom-right
  const corners = [
    [ halfX - r, -(halfY - r), -Math.PI / 2, 0           ], // BR
    [ halfX - r,  (halfY - r),  0,            Math.PI / 2 ], // TR
    [-(halfX - r),(halfY - r),  Math.PI / 2,  Math.PI     ], // TL
    [-(halfX - r),-(halfY - r), Math.PI,      1.5*Math.PI ], // BL
  ];
  for (const [cx, cy, a0, a1] of corners) {
    for (let s = 0; s <= seg; s++) {
      const a = a0 + (a1 - a0) * (s / seg);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

// Circle, CW (so it acts as a hole when paired with a CCW outer loop).
function circleLoopCW(cx, cy, radius, seg) {
  const pts = [];
  for (let s = 0; s < seg; s++) {
    const a = -2 * Math.PI * (s / seg); // negative => CW
    pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return pts;
}

function to3(loop, z) { return loop.map(p => [p[0], p[1], z]); }

// ---------------------------------------------------------------------------
// Face builders
// ---------------------------------------------------------------------------
// Connect two equal-length 3D loops with a ring of quads.
// `flip` reverses winding (use for inward-facing surfaces).
function ring(mesh, lo, up, flip) {
  const n = lo.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (!flip) { mesh.quad(lo[i], up[i], up[j], lo[j]); }
    else       { mesh.quad(lo[i], lo[j], up[j], up[i]); }
  }
}

// Fan-triangulate a convex/near-convex loop to its centroid.
// faceUp=true -> normal +Z ; false -> normal -Z
function capFan(mesh, loop3d, faceUp) {
  let cx = 0, cy = 0; const z = loop3d[0][2];
  for (const p of loop3d) { cx += p[0]; cy += p[1]; }
  cx /= loop3d.length; cy /= loop3d.length;
  const c = [cx, cy, z];
  const n = loop3d.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (faceUp) mesh.tri(c, loop3d[i], loop3d[j]);
    else        mesh.tri(c, loop3d[j], loop3d[i]);
  }
}

// ---------------------------------------------------------------------------
// Polygon triangulation with holes (ear clipping + bridge elimination).
// Returns a list of 2D-coordinate triangles [[ [x,y],[x,y],[x,y] ], ...].
// outer: CCW loop. holes: array of CW loops fully inside outer.
// ---------------------------------------------------------------------------
function area2(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
// Public: triangulate outer(CCW) with holes(CW) -> coord triangles.
// Backed by the robust earcut algorithm (handles holes + slits reliably).
function triangulateWithHoles(outer, holes) {
  const data = [];
  for (const p of outer) data.push(p[0], p[1]);
  const holeIdx = [];
  if (holes) for (const h of holes) { holeIdx.push(data.length / 2); for (const p of h) data.push(p[0], p[1]); }
  const idx = earcut(data, holeIdx.length ? holeIdx : null, 2);
  const tris = [];
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k]*2, b = idx[k+1]*2, c = idx[k+2]*2;
    tris.push([[data[a],data[a+1]], [data[b],data[b+1]], [data[c],data[c+1]]]);
  }
  return tris;
}

// ---------------------------------------------------------------------------
// Solid builders
// ---------------------------------------------------------------------------
// Simple solid from a stack of {z, loop} layers (loops same length, CCW).
function solidFromLayers(layers) {
  const m = new Mesh();
  capFan(m, layers[0].l3, false);                 // bottom (-Z)
  for (let k = 0; k < layers.length - 1; k++) {
    ring(m, layers[k].l3, layers[k + 1].l3, false); // outward sides
  }
  capFan(m, layers[layers.length - 1].l3, true);  // top (+Z)
  return m.solid();
}

// A foot (single grid cell base) centered at (cx,cy), optionally with holes.
function makeFoot(cx, cy, seg, holes /* [{x,y,r}] */, holeDepth, holeSeg) {
  const profile = [
    { z: 0.0,            half: FOOT_FULL_HALF - B_CHAMFER1 - B_CHAMFER2, dr: -(B_CHAMFER1 + B_CHAMFER2) },
    { z: B_CHAMFER1,     half: FOOT_FULL_HALF - B_CHAMFER2,              dr: -(B_CHAMFER2) },
    { z: B_CHAMFER1 + B_STRAIGHT, half: FOOT_FULL_HALF - B_CHAMFER2,     dr: -(B_CHAMFER2) },
    { z: BASE_H,         half: FOOT_FULL_HALF,                            dr: 0 },
  ];
  const layers = profile.map(p => {
    const r = Math.max(0.1, OUTER_R + p.dr);
    const loop = roundedRectLoop(p.half, p.half, r, seg).map(pt => [pt[0] + cx, pt[1] + cy]);
    return { l3: to3(loop, p.z) };
  });

  if (!holes || holes.length === 0) return solidFromLayers(layers);

  // Foot with blind cylindrical holes opening from the bottom (z=0 up to holeDepth)
  const m = new Mesh();
  // sides + top cap as usual
  for (let k = 0; k < layers.length - 1; k++) ring(m, layers[k].l3, layers[k + 1].l3, false);
  capFan(m, layers[layers.length - 1].l3, true);
  // holey bottom cap (faces -Z)
  const outer = layers[0].l3.map(p => [p[0], p[1]]); // CCW
  const holeLoops2d = holes.map(h => circleLoopCW(cx + h.x, cy + h.y, h.r, holeSeg));
  const tris = triangulateWithHoles(outer, holeLoops2d);
  const z0 = layers[0].l3[0][2];
  for (const t of tris) {
    // bottom faces -Z -> reverse winding from the CCW source
    m.tri([t[0][0],t[0][1],z0], [t[2][0],t[2][1],z0], [t[1][0],t[1][1],z0]);
  }
  // each hole: cylinder wall (up) + blind top cap (faces -Z, into hole)
  for (let hi = 0; hi < holes.length; hi++) {
    const h = holes[hi];
    const loop2 = holeLoops2d[hi];
    const lo = to3(loop2, z0);
    const up = to3(loop2, z0 + holeDepth);
    ring(m, lo, up, true);          // wall normals point toward hole axis (outward of solid)
    capFan(m, up, false);           // hole ceiling faces down into hole
  }
  return m.solid();
}

// Sweep a sequence of concentric rounded-rect loops (each {off, z}) into a
// watertight tube, capping the first and last loop. `off` is the inward radial
// offset from the outer half-extents. Winding is fixed by makeConsistent().
function sweepLoops(levels, halfX, halfY, seg) {
  const m = new Mesh();
  const loops = levels.map(L => to3(
    roundedRectLoop(Math.max(0.5, halfX - L.off), Math.max(0.5, halfY - L.off),
      Math.max(0.3, OUTER_R - L.off), seg), L.z));
  capFan(m, loops[0], false);
  for (let k = 0; k < loops.length - 1; k++) ring(m, loops[k], loops[k + 1], false);
  capFan(m, loops[loops.length - 1], true);
  return m.solid();
}

// The body "cup": outer wall (with optional rounded reinforcement grooves),
// solid floor, inner cavity, and either a flat rim or a stacking lip with a
// flush inset-lid ledge. Built as one swept tube of concentric loops.
function makeCup(opts) {
  const { halfX, halfY, wall, total, cavityFloorZ, seg, indents, stackingLip, lidThk } = opts;

  const levels = [{ off: 0, z: BASE_H }];

  // rounded reinforcement grooves (circular-arc cross-section, radius-driven)
  if (indents && indents.count > 0) {
    const span = total - BASE_H;
    const rad = Math.max(0.4, indents.radius ?? 1.5);
    const depth = Math.min(rad, wall - 0.4, indents.depth ?? rad);
    if (depth > 0.05) {
      const h = Math.sqrt(Math.max(0, rad * rad - (rad - depth) * (rad - depth))); // half band height
      const M = 6;
      for (let k = 1; k <= indents.count; k++) {
        const zc = BASE_H + span * (k / (indents.count + 1));
        if (zc - h <= BASE_H + 0.4 || zc + h >= total - 0.4) continue;
        for (let s = -M; s <= M; s++) {
          const dz = h * (s / M);
          const inset = depth - rad + Math.sqrt(Math.max(0, rad * rad - dz * dz));
          levels.push({ off: Math.max(0, inset), z: zc + dz });
        }
      }
    }
  }

  levels.push({ off: 0, z: total }); // top of outer wall

  if (stackingLip) {
    const L = lipGeometry(halfX, halfY, wall, total, lidThk);
    const rimOff = L.cT + L.rimTopW;
    levels.push(
      { off: 0,               z: total + LIP_VERT },     // straight lip wall
      { off: L.cT,            z: L.lipTop },             // 45° outer top chamfer
      { off: rimOff,          z: L.lipTop },             // flat rim top -> inner edge
      { off: rimOff,          z: L.ledgeZ },             // overhang wall (= lid depth)
      { off: rimOff + L.support, z: L.ledgeZ },          // ledge shelf (lid rests here)
      { off: rimOff + L.support, z: L.ledgeZ - 0.8 },    // ledge front face
      { off: wall,            z: L.ledgeZ - 0.8 },       // back out to cavity wall
      { off: wall,            z: cavityFloorZ },         // down to floor
    );
  } else {
    levels.push(
      { off: wall, z: total },          // flat rim across
      { off: wall, z: cavityFloorZ },   // down cavity wall to floor
    );
  }

  return sweepLoops(levels, halfX, halfY, seg);
}

// Axis-aligned (rounded-free) box solid.
function boxSolid(cx, cy, z0, z1, sx, sy) {
  const hx = sx / 2, hy = sy / 2;
  const lo = [[cx-hx,cy-hy,z0],[cx+hx,cy-hy,z0],[cx+hx,cy+hy,z0],[cx-hx,cy+hy,z0]];
  const up = lo.map(p => [p[0], p[1], z1]);
  const m = new Mesh();
  capFan(m, lo, false); capFan(m, up, true);
  ring(m, lo, up, false);
  return m.solid();
}

// ---------------------------------------------------------------------------
// Public: build the bin (list of solids) and the lid (single solid)
// ---------------------------------------------------------------------------
export function buildBin(p) {
  const seg = p.cornerSegs ?? 8;
  const gx = p.gx, gy = p.gy;
  const total = p.heightUnits * HEIGHT_UNIT;
  const wall = p.wall;
  const halfX = (gx * GRID - CLEARANCE) / 2;
  const halfY = (gy * GRID - CLEARANCE) / 2;
  const cavityFloorZ = BASE_H + (p.floor ?? 1.2);
  const solids = [];

  // ---- feet ----
  let footHoles = null, holeDepth = 0, holeSeg = 16;
  if (p.holes && p.holes.enabled) {
    holeDepth = Math.min(p.holes.depth, BASE_H - 0.6);
    const off = 13; // hole offset from cell center (mm)
    const hr = p.holes.diameter / 2;
    footHoles = [
      { x:  off, y:  off, r: hr }, { x: -off, y:  off, r: hr },
      { x:  off, y: -off, r: hr }, { x: -off, y: -off, r: hr },
    ];
  }
  for (let i = 0; i < gx; i++) {
    for (let j = 0; j < gy; j++) {
      const cx = (i - (gx - 1) / 2) * GRID;
      const cy = (j - (gy - 1) / 2) * GRID;
      solids.push(makeFoot(cx, cy, seg, footHoles, holeDepth, holeSeg));
    }
  }

  // ---- body cup ----
  const lipOn = !!p.stackingLip;
  const lidThk = (p.lid && p.lid.topThickness) ?? 1.6;
  solids.push(makeCup({ halfX, halfY, wall, total, cavityFloorZ, seg,
    indents: p.indents, stackingLip: lipOn, lidThk }));

  // ---- dividers ----  (skipped in vase mode: spiral vase needs a single contour)
  const innerHalfX = halfX - wall, innerHalfY = halfY - wall;
  const dt = p.dividerThickness ?? wall;
  const dz0 = cavityFloorZ - 0.6;       // dip into floor to fuse
  const dz1 = total;                    // up to rim
  const cols = p.vaseMode ? 1 : Math.max(1, p.divX | 0);
  const rows = p.vaseMode ? 1 : Math.max(1, p.divY | 0);
  // vertical dividers (split along X) -> walls running in Y
  for (let c = 1; c < cols; c++) {
    const x = -innerHalfX + (2 * innerHalfX) * (c / cols);
    solids.push(boxSolid(x, 0, dz0, dz1, dt, innerHalfY * 2 + wall)); // overlap side walls
  }
  // horizontal dividers (split along Y) -> walls running in X
  for (let rr = 1; rr < rows; rr++) {
    const y = -innerHalfY + (2 * innerHalfY) * (rr / rows);
    solids.push(boxSolid(0, y, dz0, dz1, innerHalfX * 2 + wall, dt));
  }

  const meta = {
    halfX, halfY, r: OUTER_R,
    wallTop: total,
    total: lipOn ? total + LIP_H : total,    // full external height incl. lip
    cavityFloorZ,                            // top of the interior floor (for lid grip depth)
    stackingLip: lipOn,
    vaseMode: !!p.vaseMode,
  };
  if (lipOn) meta.lip = lipGeometry(halfX, halfY, wall, total, lidThk);
  return { solids, meta };
}

// Closed rounded-rect prism (used for the inset lid plate).
function platePrism(hx, hy, z0, z1, binHalfX, seg) {
  const r = Math.max(0.3, OUTER_R - (binHalfX - hx));
  const m = new Mesh();
  const bot = to3(roundedRectLoop(hx, hy, r, seg), z0);
  const top = to3(roundedRectLoop(hx, hy, r, seg), z1);
  capFan(m, bot, false); ring(m, bot, top, false); capFan(m, top, true);
  return m.solid();
}

// Closed annular stacking-lip "frame" sitting on top of a lid (so a bin can
// nest on a lidded box). Bottom dips below baseZ to fuse with the lid plate.
function makeLipRingOnTop(hx, hy, baseZ, seg) {
  const cT = LIP_TOP_CHAMFER, rimTopW = 1.0;
  const zb = baseZ - 0.6, zt = baseZ + LIP_H;   // dip bottom to fuse; top is full 4.4 above plate
  const mk = (off, z) => to3(roundedRectLoop(
    Math.max(0.6, hx - off), Math.max(0.6, hy - off), Math.max(0.3, OUTER_R - off), seg), z);
  const oOutB = mk(0, zb), oOutT = mk(0, zt - cT), oCham = mk(cT, zt),
        iRim = mk(cT + rimTopW, zt), iBot = mk(cT + rimTopW, zb);
  const m = new Mesh();
  ring(m, oOutB, oOutT, false); ring(m, oOutT, oCham, false); ring(m, oCham, iRim, false);
  ring(m, iRim, iBot, false);   ring(m, iBot, oOutB, false); // closed square torus
  return m.solid();
}

// Ellipse outline of `seg` points. cw=false -> CCW (outer), cw=true -> CW (hole).
function ellipseLoop(cx, cy, ax, by, seg, cw) {
  const pts = [];
  for (let s = 0; s < seg; s++) {
    const a = (cw ? -1 : 1) * 2 * Math.PI * (s / seg);
    pts.push([cx + ax * Math.cos(a), cy + by * Math.sin(a)]);
  }
  return pts;
}

// Vertical stack of concentric rounded-rect rings, capped top + bottom, with
// optional elliptical *through* openings punched in both caps (for the pinch
// wells). `levels` runs bottom -> top as [{hx,hy,z}, ...]; the radii may step
// (so this builds both the flat inset plate and the stepped stackable body).
// `holes` are CW ellipse loops; they pierce the body so a separate well-cup can
// hang through. Watertight on its own.
function ringStackSolid(levels, binHalfX, seg, holes) {
  const m = new Mesh();
  const loopOf = (L) =>
    roundedRectLoop(L.hx, L.hy, Math.max(0.3, OUTER_R - (binHalfX - L.hx)), seg);
  const lo = levels[0], hi = levels[levels.length - 1];
  const cap = (rect, z) => {
    if (holes && holes.length) {
      for (const t of triangulateWithHoles(rect, holes))
        m.tri([t[0][0], t[0][1], z], [t[1][0], t[1][1], z], [t[2][0], t[2][1], z]);
    } else {
      capFan(m, to3(rect, z), true);
    }
  };
  cap(loopOf(lo), lo.z);                                   // bottom face
  cap(loopOf(hi), hi.z);                                   // top face
  for (let k = 0; k < levels.length - 1; k++)              // outer side rings
    ring(m, to3(loopOf(levels[k]), levels[k].z), to3(loopOf(levels[k + 1]), levels[k + 1].z), false);
  if (holes) for (const h of holes)                        // straight tunnel per well
    ring(m, to3(h, lo.z), to3(h, hi.z), false);
  return m.solid();
}

// Triangulate a (possibly concave) 2D loop as a horizontal cap at height z.
function capLoop(mesh, loop2d, z) {
  for (const t of triangulateWithHoles(loop2d, []))
    mesh.tri([t[0][0], t[0][1], z], [t[1][0], t[1][1], z], [t[2][0], t[2][1], z]);
}

// Recessed two-finger pinch grip: two elliptical wells in the lid top whose
// FLOOR is curved along Z. Across each ellipse the depth sweeps a quarter
// circle — ~0 mm at the outer (far) edge, deepest (`depth`, ~15 mm) at the inner
// edge facing the other finger — so a fingertip slides in shallow and curls down
// to pinch the central web. Nothing protrudes above the lid. Returns the
// openings to cut in the lid top (`holes`) and the watertight cup solids (`cups`)
// that form the wells and seal the lid. centreHX/centreHY bound the flat area.
function pinchWells(centreHX, centreHY, topZ, depth, seg) {
  const N = Math.max(40, seg * 5);     // ellipse samples (smooth scoop)
  const tw = 1.6, floorTh = 1.5;
  const gap = Math.max(4, Math.min(7, centreHX * 0.18));    // central web
  // The depth gradient is a true quarter circle, so its radius R equals both the
  // max depth and the ellipse's full length along X (R = 2*ax). Fit R to the
  // available depth and the available width.
  let R = Math.min(depth, centreHX - gap / 2 - tw - 0.8);
  R = Math.max(5, R);
  const ax = R / 2;                                          // half-length along X
  const ay = Math.max(4, Math.min(R * 0.6, centreHY - tw - 0.8)); // half-width along Y
  const d  = ax + gap / 2;                                   // centre offset of each ellipse
  const holes = [], cups = [];
  for (const side of [1, -1]) {
    const cx = side * d;
    const farX = cx + side * ax;        // shallow (0) edge, on the OUTER side
    // floor height at x: quarter circle, depth 0 at farX -> R at the inner edge
    const zf = (x) => {
      let dep = R - Math.sqrt(Math.max(0, R * R - (x - farX) * (x - farX)));
      dep = Math.min(R, Math.max(0.15, dep));   // tiny min so the rim isn't degenerate
      return topZ - dep;
    };
    holes.push(ellipseLoop(cx, 0, ax + 0.3, ay + 0.3, N, true));   // cut in the lid top
    const m = new Mesh();
    const innerXY = ellipseLoop(cx, 0, ax, ay, N, false);          // well rim footprint
    const outerXY = ellipseLoop(cx, 0, ax + tw, ay + tw, N, false);// cup outer footprint
    const IR = innerXY.map(p => [p[0], p[1], topZ]);               // inner rim (flush top)
    const IF = innerXY.map(p => [p[0], p[1], zf(p[0])]);           // inner floor edge (curved)
    const OR = outerXY.map(p => [p[0], p[1], topZ]);               // outer rim
    const zBottom = topZ - R - floorTh;
    const OB = outerXY.map(p => [p[0], p[1], zBottom]);            // flat underside edge
    ring(m, IR, OR, false);          // flat rim annulus, flush with the lid top
    ring(m, OR, OB, false);          // outer wall (embeds into the plate, hangs below)
    capLoop(m, outerXY, zBottom);    // flat closed underside
    ring(m, IR, IF, false);          // inner curtain: rim down to the curved floor
    for (const t of triangulateWithHoles(innerXY, []))            // curved scoop floor
      m.tri([t[0][0], t[0][1], zf(t[0][0])],
            [t[1][0], t[1][1], zf(t[1][0])],
            [t[2][0], t[2][1], zf(t[2][0])]);
    cups.push(m.solid());
  }
  return { holes, cups };
}

// A single straight-edge locking rib: a chamfered bar that drops into the bin's
// stacking-lip recess and presses against the recess wall (the same wall the
// stacking lip uses), registering the lid. `edge` is 'x+|x-|y+|y-' (which wall);
// `Aperp` is the recess-wall coordinate; the rib spans +/-halfAlong along the
// edge; `ld` is the recess depth. Built as one watertight prism.
function lockRibSolid(edge, Aperp, halfAlong, ld) {
  const ribDepth = 1.8;                         // inward reach (overlaps the plate)
  const chamf = Math.min(0.8, ld * 0.5);        // bottom lead-in for easy insertion
  const sgn = edge[1] === '+' ? 1 : -1;
  const ax = edge[0];                           // perpendicular axis
  const wallP = sgn * Aperp, chamP = sgn * (Aperp - chamf), innerP = sgn * (Aperp - ribDepth);
  const cs = [[innerP, 0], [chamP, 0], [wallP, chamf], [wallP, ld], [innerP, ld]]; // (perp, z)
  const xyz = (perp, along, z) => (ax === 'y' ? [along, perp, z] : [perp, along, z]);
  const a0 = -halfAlong, a1 = halfAlong;
  const m = new Mesh();
  for (const t of triangulateWithHoles(cs, [])) {        // end caps
    m.tri(xyz(t[0][0], a0, t[0][1]), xyz(t[1][0], a0, t[1][1]), xyz(t[2][0], a0, t[2][1]));
    m.tri(xyz(t[0][0], a1, t[0][1]), xyz(t[1][0], a1, t[1][1]), xyz(t[2][0], a1, t[2][1]));
  }
  for (let i = 0; i < cs.length; i++) {                  // side walls
    const p0 = cs[i], p1 = cs[(i + 1) % cs.length];
    m.quad(xyz(p0[0], a0, p0[1]), xyz(p1[0], a0, p1[1]),
           xyz(p1[0], a1, p1[1]), xyz(p0[0], a1, p0[1]));
  }
  return m.solid();
}

// Locking ribs on the four STRAIGHT edges only; the rounded corners are left
// clear so the lid can move straight down/up without the corners binding.
function makeLockRibs(L, ld) {
  const cc = Math.max(OUTER_R + 2, 5);          // corner clearance (rib stops short of corners)
  const ribs = [];
  const hX = L.Ax - cc, hY = L.Ay - cc;
  if (hX > 2) { ribs.push(lockRibSolid('y+', L.Ay, hX, ld)); ribs.push(lockRibSolid('y-', L.Ay, hX, ld)); }
  if (hY > 2) { ribs.push(lockRibSolid('x+', L.Ax, hY, ld)); ribs.push(lockRibSolid('x-', L.Ax, hY, ld)); }
  return ribs;
}

// How far (mm) the recessed two-finger grip reaches down into the bin.
const PINCH_DEPTH = 15;   // 1.5 cm

export function buildLid(p, binMeta) {
  const seg = p.cornerSegs ?? 8;
  const lp = p.lid || {};
  const clr = lp.clearance ?? 0.25;
  const ld = Math.min(Math.max(lp.topThickness ?? 1.6, 0.8), 3.0);
  const pinch = !!lp.pinchHandle;
  const stackable = !!lp.stackable;
  const floorZ = binMeta.cavityFloorZ ?? (BASE_H + 1.2);
  const parts = [];
  let seatZ, lipTop, height, inset = false;

  // Depth the finger wells reach below the lid top (assembled), clamped so the
  // cups never dive through the bin's interior floor.
  const wellDepth = (topAssembledZ) =>
    Math.max(4, Math.min(PINCH_DEPTH, topAssembledZ - floorZ - 2));

  if (stackable && binMeta.lip) {
    // STACKABLE = flush inset that drops INTO the lip recess (not a cap around
    // the outside). A full-width flange sits flush on the rim and carries a
    // Gridfinity stacking lip on top, so another bin nests. Widest part = bin
    // width; the locating plug fits inside.
    const L = binMeta.lip;
    const { halfX, halfY } = binMeta;
    const plugHX = Math.max(1, L.Ax - clr), plugHY = Math.max(1, L.Ay - clr);
    const flangeTh = Math.max(ld, 1.2);
    const flangeTopZ = ld + flangeTh;        // local; = rim level + flange
    seatZ = L.ledgeZ;                        // plug bottom rests on the lip ledge
    const topAssembled = seatZ + flangeTopZ; // socket floor in assembled space

    let holes = null;
    if (pinch) {
      const reach = Math.min(plugHX, halfX - (LIP_TOP_CHAMFER + 1.0) - 1.5);
      const w = pinchWells(reach, Math.min(plugHY, halfY - (LIP_TOP_CHAMFER + 1.0) - 1.5),
                           flangeTopZ, wellDepth(topAssembled), seg);
      holes = w.holes;
      for (const c of w.cups) parts.push(c);
    }
    // stepped body: plug -> flush flange (full bin width), wells pierce both caps
    parts.push(ringStackSolid([
      { hx: plugHX,  hy: plugHY,  z: 0 },
      { hx: plugHX,  hy: plugHY,  z: ld },
      { hx: halfX,   hy: halfY,   z: ld },
      { hx: halfX,   hy: halfY,   z: flangeTopZ },
    ], halfX, seg, holes));
    parts.push(makeLipRingOnTop(halfX, halfY, flangeTopZ, seg)); // bin-width stacking lip
    for (const rib of makeLockRibs(L, ld)) parts.push(rib);      // straight-edge locks
    lipTop = seatZ + flangeTopZ + LIP_H; height = flangeTopZ + LIP_H; inset = true;

  } else if (stackable) {
    // Stackable requested but the bin has no lip: flush cap on the rim with a
    // locating plug inside, plus a bin-width stacking lip on top.
    const { halfX, halfY } = binMeta;
    const plugHX = Math.max(1, halfX - (lp.wall ?? 1.6) - clr);
    const plugHY = Math.max(1, halfY - (lp.wall ?? 1.6) - clr);
    const plugDrop = 4;                      // how far the plug reaches into the bin
    const flangeTh = Math.max(ld, 1.2);
    const flangeTopZ = plugDrop + flangeTh;
    seatZ = binMeta.wallTop - plugDrop;
    const topAssembled = seatZ + flangeTopZ;

    let holes = null;
    if (pinch) {
      const w = pinchWells(plugHX, plugHY, flangeTopZ, wellDepth(topAssembled), seg);
      holes = w.holes;
      for (const c of w.cups) parts.push(c);
    }
    parts.push(ringStackSolid([
      { hx: plugHX, hy: plugHY, z: 0 },
      { hx: plugHX, hy: plugHY, z: plugDrop },
      { hx: halfX,  hy: halfY,  z: plugDrop },
      { hx: halfX,  hy: halfY,  z: flangeTopZ },
    ], halfX, seg, holes));
    parts.push(makeLipRingOnTop(halfX, halfY, flangeTopZ, seg));
    lipTop = seatZ + flangeTopZ + LIP_H; height = flangeTopZ + LIP_H; inset = true;

  } else if (binMeta.lip) {
    // Flush inset lid: drops into the lip recess, top flush with the rim.
    const L = binMeta.lip;
    const plateHX = Math.max(1, L.Ax - clr), plateHY = Math.max(1, L.Ay - clr);
    seatZ = L.ledgeZ; lipTop = L.lipTop; height = ld; inset = true;
    const topAssembled = seatZ + ld;
    if (pinch) {
      const w = pinchWells(plateHX, plateHY, ld, wellDepth(topAssembled), seg);
      for (const c of w.cups) parts.push(c);
      parts.push(ringStackSolid([
        { hx: plateHX, hy: plateHY, z: 0 },
        { hx: plateHX, hy: plateHY, z: ld },
      ], binMeta.halfX, seg, w.holes));
    } else {
      parts.push(platePrism(plateHX, plateHY, 0, ld, binMeta.halfX, seg));
    }
    for (const rib of makeLockRibs(L, ld)) parts.push(rib);     // straight-edge locks

  } else {
    // Plain over-lid (no stacking lip on the bin): caps the rim with a skirt.
    const lidWall = lp.wall ?? 1.6, skirtH = lp.skirtHeight ?? 6;
    const { halfX, halfY } = binMeta;
    const pocketHX = halfX + clr, pocketHY = halfY + clr, pocketR = OUTER_R + clr;
    const outerHX = pocketHX + lidWall, outerHY = pocketHY + lidWall, outerR = pocketR + lidWall;
    const H = skirtH + ld;
    seatZ = binMeta.wallTop - skirtH; lipTop = binMeta.wallTop; height = H;
    const topAssembled = seatZ + H;

    let holes = null;
    if (pinch) {
      const w = pinchWells(pocketHX, pocketHY, H, wellDepth(topAssembled), seg);
      holes = w.holes;
      for (const c of w.cups) parts.push(c);
    }
    const m = new Mesh();
    const outerBot  = to3(roundedRectLoop(outerHX, outerHY, outerR, seg), 0);
    const outerTopL = roundedRectLoop(outerHX, outerHY, outerR, seg);
    const pocketBot = to3(roundedRectLoop(pocketHX, pocketHY, pocketR, seg), 0);
    const pocketCeilL = roundedRectLoop(pocketHX, pocketHY, pocketR, seg);
    // top face (+ wells punched through the solid top slab)
    if (holes) {
      for (const t of triangulateWithHoles(outerTopL, holes))
        m.tri([t[0][0],t[0][1],H], [t[1][0],t[1][1],H], [t[2][0],t[2][1],H]);
      for (const t of triangulateWithHoles(pocketCeilL, holes))
        m.tri([t[0][0],t[0][1],skirtH], [t[1][0],t[1][1],skirtH], [t[2][0],t[2][1],skirtH]);
      for (const h of holes) ring(m, to3(h, skirtH), to3(h, H), false); // tunnels in the slab
    } else {
      capFan(m, to3(outerTopL, H), true);
      capFan(m, to3(pocketCeilL, skirtH), false);
    }
    ring(m, outerBot, to3(outerTopL, H), false);
    ring(m, outerBot, pocketBot, false);
    ring(m, pocketBot, to3(pocketCeilL, skirtH), false);
    parts.push(m.solid());
  }

  return { solid: mergeSolids(parts), height, seatZ, lipTop, inset, stackable };
}

// ---------------------------------------------------------------------------
// Helpers for consumers
// ---------------------------------------------------------------------------
export function mergeSolids(solids) {
  let n = 0; for (const s of solids) n += s.positions.length;
  const out = new Float32Array(n);
  let o = 0; for (const s of solids) { out.set(s.positions, o); o += s.positions.length; }
  return { positions: out };
}

// Exposed for tests
export const __test = {
  roundedRectLoop, circleLoopCW, triangulateWithHoles,
  area2, makeFoot, makeCup, boxSolid, solidFromLayers, fixOrientation,
};
