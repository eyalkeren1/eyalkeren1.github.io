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

  // ---- dividers ----
  const innerHalfX = halfX - wall, innerHalfY = halfY - wall;
  const dt = p.dividerThickness ?? wall;
  const dz0 = cavityFloorZ - 0.6;       // dip into floor to fuse
  const dz1 = total;                    // up to rim
  const cols = Math.max(1, p.divX | 0), rows = Math.max(1, p.divY | 0);
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
    stackingLip: lipOn,
  };
  if (lipOn) meta.lip = lipGeometry(halfX, halfY, wall, total, lidThk);
  return { solids, meta };
}

export function buildLid(p, binMeta) {
  const seg = p.cornerSegs ?? 8;
  const clr = (p.lid && p.lid.clearance) ?? 0.25;

  // --- flush inset lid: drops into the stacking-lip recess, top flush with rim ---
  if (binMeta.lip) {
    const L = binMeta.lip;
    const plateHX = Math.max(1, L.Ax - clr), plateHY = Math.max(1, L.Ay - clr);
    const pr = Math.max(0.3, OUTER_R - (binMeta.halfX - plateHX));
    const ld = L.ld;
    const m = new Mesh();
    const bot = to3(roundedRectLoop(plateHX, plateHY, pr, seg), 0);
    const top = to3(roundedRectLoop(plateHX, plateHY, pr, seg), ld);
    capFan(m, bot, false);
    ring(m, bot, top, false);
    capFan(m, top, true);
    return { solid: m.solid(), height: ld, seatZ: L.ledgeZ, lipTop: L.lipTop, inset: true };
  }

  // --- fallback over-lid (shoebox) when the bin has no stacking lip ---
  const lidWall = (p.lid && p.lid.wall) ?? 1.6;
  const skirtH = (p.lid && p.lid.skirtHeight) ?? 6;
  const topThk = (p.lid && p.lid.topThickness) ?? 1.6;
  const { halfX, halfY, r } = binMeta;
  const pocketHX = halfX + clr, pocketHY = halfY + clr, pocketR = r + clr;
  const outerHX = pocketHX + lidWall, outerHY = pocketHY + lidWall, outerR = pocketR + lidWall;
  const H = skirtH + topThk;

  const m = new Mesh();
  const outerBot = to3(roundedRectLoop(outerHX, outerHY, outerR, seg), 0);
  const outerTop = to3(roundedRectLoop(outerHX, outerHY, outerR, seg), H);
  const pocketBot = to3(roundedRectLoop(pocketHX, pocketHY, pocketR, seg), 0);
  const pocketCeil = to3(roundedRectLoop(pocketHX, pocketHY, pocketR, seg), skirtH);
  capFan(m, outerTop, true);
  ring(m, outerBot, outerTop, false);
  ring(m, outerBot, pocketBot, true);
  ring(m, pocketBot, pocketCeil, false);
  capFan(m, pocketCeil, false);
  return { solid: m.solid(), height: H, seatZ: binMeta.wallTop - skirtH, lipTop: binMeta.wallTop, inset: false };
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
