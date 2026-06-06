# GRIDFORGE — parametric Gridfinity bin generator

A browser tool for designing [Gridfinity](https://gridfinity.xyz)-compatible storage
bins with a live 3D preview and one-click STL export. Beyond the usual parameters it
adds two requested features:

- **Fitted lid** — a matching over-lid sized to the bin you designed (adjustable
  clearance, wall, skirt depth, and top thickness), exportable as its own STL.
- **Reinforcement indents** — one or more recessed grooves wrapping the outer wall
  along the height to stiffen tall, thin-walled bins. They stay inside the footprint
  so bins still sit flush against their neighbours on a baseplate.

Plus the standard controls: grid footprint (X×Y), height in 7 mm units, wall and floor
thickness, row/column compartment dividers, and magnet/screw mounting holes in the feet.

## Running it

**Easiest:** open **`standalone.html`** — it inlines all the local code, so it works by
double-clicking the file (it still pulls three.js from a CDN, so you need internet on first
load).

**Split version (`index.html`):** uses ES modules, so it must be served over HTTP —
opening it directly via `file://` is blocked by the browser's module CORS rules. From this
folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works (`npx serve`, etc.).

If the 3D view ever fails to appear, the page now shows an on-screen diagnostic explaining
the likely cause (usually `file://` or a blocked CDN) instead of a blank canvas.

## Files

```
index.html        UI + styling + three.js import map
src/app.js        three.js scene, controls wiring, STL export
src/gridfinity.js  geometry core — builds watertight meshes (no dependencies)
src/earcut.js     polygon triangulation w/ holes (used for the magnet/screw holes)
```

`src/gridfinity.js` and `src/earcut.js` are pure JavaScript with no imports of three.js,
so they also run in plain Node. A geometry self-test (watertightness, winding
consistency, triangulation area conservation, bounding boxes) was used during
development; the generated bin, lid, dividers and feet are each individually watertight.

## How the geometry works

- The bin is emitted as a **list of individually watertight solids** (one per foot, the
  body "cup", and each divider). Slicers (Cura, PrusaSlicer, Bambu/Orca) automatically
  union overlapping closed solids, so the assembly prints as a single body.
- No CSG is used. Holes are baked directly into each foot (triangulated bottom face with
  circular holes + blind cylinder walls); indents are baked into the outer wall's vertical
  layer stack. Every face builder is run through a flood-fill that makes all adjacent
  triangle windings consistent, then orients normals outward.
- Coordinate system is **+Z up**, model centred in X/Y, base at z = 0 — which is also the
  natural print orientation the STL exports use.

## Known simplifications

- The top edge is a **flat rim**, not the true Gridfinity stacking lip — bins nest loosely
  via the rim and the lid fits regardless, but they won't click-stack like official bins.
- No scoop ramp or label tab yet.
- Dividers are plain square-cornered walls.
- Mounting holes are a single blind cylinder per corner (magnet *or* screw via the
  diameter/depth controls), not the concentric magnet-plus-screw counterbore.
- The lid is an **over-lid** (shoebox style) that hugs the outer walls, independent of any
  stacking lip.

These are the natural next steps if you want to extend it.
