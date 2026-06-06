# GRIDFORGE — parametric Gridfinity bin generator

A browser tool for designing [Gridfinity](https://gridfinity.xyz)-compatible storage
bins with a live 3D preview and one-click STL export. Beyond the usual parameters it
adds these requested features:

- **Stacking lip** — a toggleable Gridfinity stacking lip on the top (the canonical
  4.4 mm profile with a 45° outer chamfer), so bins stack and nest like standard bins.
- **Flush inset lid** — when the stacking lip is on, the matching lid is an inset that
  drops into the lip recess and sits flush with the bin's top rim (rather than wrapping
  the outside). With the lip off, it falls back to an over-lid that caps the outside.
- **Rounded reinforcement indents** — one or more circular-arc grooves wrapping the outer
  wall to stiffen tall, thin bins, with a **radius** control for how round the channel is
  and a depth control (clamped to just under the wall so it never breaks through).

Plus the standard controls: grid footprint (X×Y), height in 7 mm units, wall and floor
thickness, row/column compartment dividers, and magnet/screw holes in the feet.

### Vase mode

A toggle that makes the bin a single continuous contour (it drops the dividers) so it can
be printed in your slicer's **Spiralize Outer Contour / Spiral Vase** mode: one single-wall
perimeter, solid bottom layers, open top. Set the wall to about one line width (0.8–1.2 mm)
and turn on spiral vase in the slicer. The stacking lip is kept as a solid connector at the
top — it isn't part of the spiral, matching how vase-mode Gridfinity bins are printed.

### Lid options

- **Pinch grip** — two curved finger wells recessed *down into* the lid (about 15 mm into the
  bin). The wells curve toward each other like a pinching thumb and finger; nothing protrudes
  above the lid top. You press a finger into each well and pinch the web between them to lift.
- **Lid lock** — every lid for a bin with a stacking lip locks into that lip's recess (the same
  wall the stacking mechanism uses) with ribs on the four **straight edges only**. The rounded
  **corners are left clear**, so the lid moves straight down to seat and straight up to release
  without the corners binding against the lip.
- **Stackable lid** — stays a flush inset: it drops into the lip recess (the widest part equals
  the bin width, rather than wrapping around the outside) and carries a Gridfinity stacking lip
  on top, so another bin nests onto the closed box. Combining it with the pinch grip carves the
  finger wells into the socket floor, so they remain usable through the stacking lip.

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

- The stacking lip uses the canonical 4.4 mm height and a clean chamfered profile; the
  micro-fillets differ slightly from the official Fusion model (a known difference shared
  by most open-source generators) but bins still stack.
- No scoop ramp or label tab yet.
- Dividers are plain square-cornered walls.
- Mounting holes are a single blind cylinder per corner (magnet *or* screw via the
  diameter/depth controls), not the concentric magnet-plus-screw counterbore.
- The inset lid rests on an internal ledge in the lip; the small ledge underside is a
  short bridgeable overhang when printed.

These are the natural next steps if you want to extend it.
