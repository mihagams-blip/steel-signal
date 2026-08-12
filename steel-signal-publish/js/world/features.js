// STEEL SIGNAL — world/features.js
// Everything that stands on the steppe: poplar windbreaks, hay bales, dirt tracks
// and a paved road with blended shoulders, the animated Vovcha river, the rail
// line, villages / the town of Sokil with its grain elevator, and the strategic
// infrastructure objects with intact / damaged / destroyed visual states.
//
// Contract: export function populateFeatures(scene, terrain, scenario, rngFn) -> features
//   features.infrastructure = [{ id, kind, hex, mesh, hp, alive, name }]
//   features.damageInfrastructure(id, dmg)
//   features.setWreck(hex, unitClass)
// Extras (logged in INTEGRATION_NOTES.md): features.group, .update(dt), .dispose(),
// .infraById(id), .setObjectiveOwner(id, owner), `maxHp` / `state` on infra records.

import * as THREE from 'three';
import { Mat, Tex, applyLeafCardShader } from '../core/assets.js';
import { hexToWorld, worldToHex, hexNeighbors, HEX, OPEN_TYPES } from './terrain.js';
import { Game } from '../game/state.js';
import { VFX } from '../fx/vfx.js';
// ROUND-7 FIX A (critique r6 fix 11) — the pylon/lattice UV, handed to this file
// twice and dropped twice because it was filed against models.js. models.js owns
// no pylon; it owns the two FUNCTIONS, which have shipped on every vehicle since
// round 2. `models.js` imports THREE / assets.js / rng.js only, so this is not a
// cycle. See INTEGRATION_NOTES "ROUND-6 MODELS PASS — fix 11".
import { worldProjectUV, bakeMemberValue } from '../units/models.js';

// ---------------------------------------------------------------- helpers

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth01 = (t) => { const s = clamp01(t); return s * s * (3 - 2 * s); };

function css(hex, a = 1) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  return `rgba(${r},${g},${b},${a})`;
}

function makeCanvasTexture(size, painter, srgb = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  // grainPass() reads this context back with getImageData — without the hint
  // Chrome logs the Canvas2D warning at boot (CRITIQUE r2 fix 27).
  const g = c.getContext('2d', { willReadFrequently: true });
  painter(g, size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// mulberry32 — the module-scope painters run before populateFeatures' seeded
// RNG exists, so each one carries its own fixed seed and stays reproducible.
function seededRand(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// fine luminance noise — kills the flat-CG read on any painted surface
function grainPass(g, s, strength, rnd) {
  const img = g.getImageData(0, 0, s, s);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 2 * strength;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
}

// ==================== SURFACE RELIEF — ROUND-2 CRITIQUE FIX 1 ===============
// The round-2 live traverse counted 1210 material slots, 652 with a diffuse
// map, exactly ONE with a normalMap and ZERO with a roughnessMap, and named
// that single statistic as the entire "flat, plasticky, procedural" verdict.
// Every painted surface class in this file now ships a tangent-space normal map
// AND a roughness map.
//
// They are derived from the SAME canvas as the albedo wherever an albedo
// exists, because on every painter in this file the dark pixels ARE the
// recessed features: precast panel joints, mortar courses, stone gaps, form
// board lines. Relief taken from the albedo therefore cannot drift out of
// register with it — which is exactly what separately hand-authored height maps
// always eventually do.
//
// Three details make that honest rather than a hack:
//   • a HIGH PASS (luma minus a heavily blurred luma) is taken first, so
//     low-frequency albedo — the damp stain climbing a plinth, the rain streak
//     under a slab line — does not become a metre-wide bulge in the relief;
//   • every filter wraps modulo the tile, so the normal map tiles exactly like
//     the albedo it came from and no seam appears at a panel edge;
//   • surfaces that must keep a flat authored COLOUR (steel, earth, foliage)
//     get a purpose-painted grey height field instead, with the high pass off.
//
// Tangent frames: none of these geometries carry a tangent attribute, so three
// falls back to getTangentFrame() — screen-space UV derivatives. That requires
// UVs to be affine across each triangle, which BoxGeometry, PlaneGeometry,
// CylinderGeometry and IcosahedronGeometry all satisfy.

const wrapI = (i, n) => ((i % n) + n) % n;

// Roughness maps MULTIPLY material.roughness, so every one of them is painted
// around this mean and the material's scalar is divided by it. The authored
// roughness therefore survives as the MEAN of a real distribution instead of
// being a flat constant across an entire building.
const ROUGH_MEAN = 0.90;

function lumaField(g, s) {
  const d = g.getImageData(0, 0, s, s).data;
  const h = new Float32Array(s * s);
  for (let i = 0, p = 0; i < h.length; i++, p += 4) {
    h[i] = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) / 255;
  }
  return h;
}

// Separable running-sum box blur, wrapped. O(n) in the radius, which is what
// makes a 32-pixel low pass over a 512² tile affordable at boot.
function blurWrap(src, s, r, passes) {
  const w = 2 * r + 1;
  let cur = src;
  for (let p = 0; p < (passes || 1); p++) {
    const mid = new Float32Array(s * s);
    for (let y = 0; y < s; y++) {
      const row = y * s;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += cur[row + wrapI(k, s)];
      for (let x = 0; x < s; x++) {
        mid[row + x] = sum / w;
        sum -= cur[row + wrapI(x - r, s)];
        sum += cur[row + wrapI(x + r + 1, s)];
      }
    }
    const out = new Float32Array(s * s);
    for (let x = 0; x < s; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += mid[wrapI(k, s) * s + x];
      for (let y = 0; y < s; y++) {
        out[y * s + x] = sum / w;
        sum -= mid[wrapI(y - r, s) * s + x];
        sum += mid[wrapI(y + r + 1, s) * s + x];
      }
    }
    cur = out;
  }
  return cur;
}

// Painted canvas -> relief height in 0..1.
function reliefHeight(g, s, o) {
  const luma = lumaField(g, s);
  let h;
  if (o.highpass === false) {
    h = luma;
  } else {
    const lp = blurWrap(luma, s, Math.max(2, Math.round(s / 16)), 2);
    const gain = o.gain == null ? 2.2 : o.gain;
    h = new Float32Array(s * s);
    for (let i = 0; i < h.length; i++) {
      const v = 0.5 + (luma[i] - lp[i]) * gain;
      h[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  // one 1-pixel pass turns the albedo's per-pixel grain into readable relief
  // instead of a sandpaper normal that dissolves into aliasing at 60 units
  return o.smooth === 0 ? h : blurWrap(h, s, o.smooth || 1, 1);
}

// Height field -> tangent-space normal texture. Central differences are taken
// modulo the tile so the result wraps. Sign convention: the texture is uploaded
// with flipY, so v increases as canvas y DECREASES; N = (-dh/du, -dh/dv, 1)
// therefore encodes as (-dx, +dy, 1). Same convention as units/models.js.
function normalTexFrom(h, s, strength) {
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const img = g.createImageData(s, s);
  const d = img.data;
  for (let y = 0; y < s; y++) {
    const yr = y * s;
    const yn = wrapI(y - 1, s) * s;
    const yp = wrapI(y + 1, s) * s;
    for (let x = 0; x < s; x++) {
      const dx = (h[yr + wrapI(x + 1, s)] - h[yr + wrapI(x - 1, s)]) * strength;
      const dy = (h[yp + x] - h[yn + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (yr + x) * 4;
      d[o] = (-dx * inv * 0.5 + 0.5) * 255;
      d[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
      d[o + 2] = inv * 255;
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;     // NOT sRGB: this is vector data
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// Height field -> roughness texture around ROUGH_MEAN. Recessed pixels (joints,
// mortar, clod shadows) hold dirt and read rougher; proud faces are weathered
// smoother. That contrast is what makes a wall catch a highlight along its
// panel edges instead of rendering as one matte value.
function roughTexFrom(h, s, amp) {
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const img = g.createImageData(s, s);
  const d = img.data;
  const a = amp == null ? 0.14 : amp;
  for (let i = 0; i < h.length; i++) {
    let v = ROUGH_MEAN + a * (0.5 - h[i]) * 2;
    v = v < 0.30 ? 0.30 : v > 1 ? 1 : v;
    const b = Math.round(v * 255);
    const o = i * 4;
    d[o] = b; d[o + 1] = b; d[o + 2] = b; d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// Paint a tile ONCE and hand back its albedo plus its relief.
// `opts.albedo === false` drops the colour map (surfaces that keep an authored
// flat colour and only want relief — steel, earth, foliage).
function paintedSurface(size, painter, opts) {
  const o = opts || {};
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  painter(g, size);
  const h = reliefHeight(g, size, o);
  const out = {
    map: null,
    normal: normalTexFrom(h, size, o.strength == null ? 2.4 : o.strength),
    rough: roughTexFrom(h, size, o.rough),
  };
  if (o.albedo !== false) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
    out.map = t;
  }
  return out;
}

// Bind a relief pair onto a material. `scale` is the normalScale; `repeat`
// (optional) clones the maps so one relief tile can serve two world scales.
function bindRelief(mat, surf, scale, repeat) {
  if (!mat || !surf) return mat;
  let n = surf.normal;
  let r = surf.rough;
  if (repeat && repeat !== 1) {
    n = n.clone(); n.repeat.set(repeat, repeat); n.needsUpdate = true;
    r = r.clone(); r.repeat.set(repeat, repeat); r.needsUpdate = true;
  }
  mat.normalMap = n;
  mat.normalScale = new THREE.Vector2(scale, scale);
  mat.roughnessMap = r;
  mat.roughness = Math.min(1, mat.roughness / ROUGH_MEAN);
  mat.needsUpdate = true;
  return mat;
}

// ---- relief-only height painters -------------------------------------------
// These paint a GREY height field directly (high pass off), for materials whose
// albedo is an authored flat colour we must not disturb.

// Welded / bolted steel plate: rolling, two weld beads, a rivet line, a rib and
// dents. Bridges, pylons, tank farms, rolling stock — the dronecam flies past
// all of it at 30 m.
function paintSteelHeight(g, s) {
  const R2 = seededRand(0x77B3);
  g.fillStyle = '#808080';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 900; i++) {                    // mill rolling
    const v = R2() < 0.5 ? 150 : 112;
    g.strokeStyle = `rgba(${v},${v},${v},0.10)`;
    g.lineWidth = 1 + R2();
    const x = R2() * s, y = R2() * s, L = 40 + R2() * 150;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + L, y + (R2() - 0.5) * 4);
    g.stroke();
  }
  for (const p of [0.34, 0.78]) {                    // weld beads across
    const y = p * s;
    g.strokeStyle = 'rgba(60,60,60,0.85)';
    g.lineWidth = 4.2;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(s, y);
    g.stroke();
    g.strokeStyle = 'rgba(186,186,186,0.75)';
    g.lineWidth = 2.6;
    g.beginPath();
    for (let x = 0; x <= s; x += 6) g.lineTo(x, y - 2.4 + Math.sin(x * 0.22) * 0.9);
    g.stroke();
  }
  for (let i = 0; i < 22; i++) {                     // rivet line
    g.fillStyle = 'rgba(200,200,200,0.85)';
    g.beginPath();
    g.arc((i + 0.5) * (s / 22), s * 0.12, s * 0.012, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = 'rgba(178,178,178,0.55)';            // stiffener rib
  g.fillRect(s * 0.54, 0, s * 0.035, s);
  g.fillStyle = 'rgba(74,74,74,0.45)';
  g.fillRect(s * 0.575, 0, s * 0.012, s);
  for (let i = 0; i < 14; i++) {                     // dents
    const x = R2() * s, y = R2() * s, r = s * (0.015 + R2() * 0.035);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const v = R2() < 0.5 ? '96,96,96' : '154,154,154';
    grd.addColorStop(0, `rgba(${v},0.5)`);
    grd.addColorStop(1, `rgba(${v},0)`);
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  grainPass(g, s, 5, R2);
}

// Broken earth / hessian: clods and a coarse woven grain. Spoil heaps, revetted
// parapets and sandbag walls all read as extruded putty without it.
function paintGritHeight(g, s) {
  const R2 = seededRand(0x2C90);
  g.fillStyle = '#808080';
  g.fillRect(0, 0, s, s);
  const N = 30;                                       // hessian weave
  for (let i = 0; i < N; i++) {
    const p = i * (s / N);
    g.fillStyle = 'rgba(158,158,158,0.22)';
    g.fillRect(p, 0, s / N * 0.5, s);
    g.fillStyle = 'rgba(104,104,104,0.18)';
    g.fillRect(0, p, s, s / N * 0.5);
  }
  for (let i = 0; i < 620; i++) {                     // clods
    const x = R2() * s, y = R2() * s, r = s * (0.008 + R2() * 0.030);
    const grd = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    grd.addColorStop(0, 'rgba(196,196,196,0.55)');
    grd.addColorStop(0.6, 'rgba(140,140,140,0.30)');
    grd.addColorStop(1, 'rgba(58,58,58,0.34)');
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(x, y, r, r * (0.6 + R2() * 0.6), R2() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  grainPass(g, s, 9, R2);
}

// Leaf clusters: hundreds of small overlapping blades, lit-side proud. Bound at
// repeat 2.5 on the canopy blobs this is what stops a smooth-shaded ellipsoid
// from reading as a green balloon — the critique's exact objection.
function paintLeafHeight(g, s) {
  const R2 = seededRand(0x5A11);
  g.fillStyle = '#6E6E6E';
  g.fillRect(0, 0, s, s);

  // ROUND-4 FIX 4(a) — THE CLUMP SCALE, WHICH THIS TILE DID NOT HAVE.
  // Round 3 painted 1400 blades at ONE size. That is sandpaper: its energy sits
  // an octave below anything a mip filter keeps past ~30 units, so the canopy
  // went on rendering as a smooth solid with no internal form and the critique
  // read it as a paper cut-out. A crown is not a fuzz, it is a CLUSTER OF LEAF
  // MASSES with real shadow in the gaps between them. That scale is painted
  // first, and it is the one the eye actually reads:
  //   • 11 lobes at 0.18–0.30 of the tile. Bound at repeat 2.5 against the
  //     oblique canopy UVs below, one tile spans 0.4 of a canopy radius, so a
  //     lobe lands at 7–12 cm on a 2.5 u crown and there are 6–8 of them across
  //     a radius — the density the critique named.
  //   • every lobe is a DOME: lit crown toward the canvas −y/−x corner (which
  //     the normal encoder turns into a proud mass), dark collar around it.
  //     The collar is what puts a concavity between two clumps; a flat disc
  //     would only have made the fuzz coarser.
  const lobe = (x, y, r) => {
    // The stops are back-loaded on purpose. A linear dome spreads its height
    // change over the whole radius, and at 46 px per lobe that is a gradient of
    // ~0.01/px — a 3° tilt, which the blade layer on top buries. Holding the
    // crown flat to 0.58 and dropping it over the next quarter of the radius
    // puts the same height change into 12 px, i.e. a ~10° crease at the lobe
    // boundary. Clumps have to be separated by SHADOW, not by a soft ramp.
    const grd = g.createRadialGradient(x - r * 0.30, y - r * 0.34, r * 0.05, x, y, r);
    grd.addColorStop(0.00, 'rgba(220,220,220,0.88)');
    grd.addColorStop(0.58, 'rgba(196,196,196,0.80)');
    grd.addColorStop(0.84, 'rgba(46,46,46,0.66)');
    grd.addColorStop(1.00, 'rgba(46,46,46,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  for (let i = 0; i < 11; i++) {
    const x = R2() * s, y = R2() * s;
    const r = s * (0.18 + R2() * 0.12);
    const ox = x < r ? s : (x > s - r ? -s : 0);
    const oy = y < r ? s : (y > s - r ? -s : 0);
    lobe(x, y, r);
    if (ox) lobe(x + ox, y, r);
    if (oy) lobe(x, y + oy, r);
    if (ox && oy) lobe(x + ox, y + oy, r);
  }

  const leaf = (x, y, r, a, v) => {
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.fillStyle = `rgba(${v},${v},${v},0.62)`;
    g.beginPath();
    g.ellipse(0, 0, r, r * 0.44, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(40,40,40,0.52)';
    g.lineWidth = 1.2;
    g.stroke();
    g.restore();
  };
  // Two blade sizes, not one: the big ones are the sprays that hang off a
  // clump and catch the key, the small ones are the texture inside it.
  for (let i = 0; i < 1700; i++) {
    const x = R2() * s, y = R2() * s;
    const big = R2() < 0.26;
    const r = s * (big ? 0.034 + R2() * 0.034 : 0.010 + R2() * 0.024);
    const a = R2() * Math.PI * 2;
    const v = 104 + Math.floor(R2() * 126);
    // Seamless: a blade within its own reach of an edge is redrawn on the
    // opposite one (1 + 0..3 draws, rather than a 3×3 lattice for every blade).
    const ox = x < r * 2 ? s : (x > s - r * 2 ? -s : 0);
    const oy = y < r * 2 ? s : (y > s - r * 2 ? -s : 0);
    leaf(x, y, r, a, v);
    if (ox) leaf(x + ox, y, r, a, v);
    if (oy) leaf(x, y + oy, r, a, v);
    if (ox && oy) leaf(x + ox, y + oy, r, a, v);
  }
  grainPass(g, s, 7, R2);
}

// Alpha-tested leaf CARD: a ragged clump of blades on transparent black. Near
// white so the per-instance canopy tone drives the colour.
function paintLeafCard(g, s) {
  const R2 = seededRand(0x9E07);
  g.clearRect(0, 0, s, s);
  const cx = s / 2, cy = s / 2;
  // ROUND-4 FIX 4(a), second half. This card is the ONLY thing in the tree that
  // can put a notch in the OUTLINE — no normal map can, and the blob cluster is
  // still a union of convex lumps. Round 3 drew 240 fat blades over a fairly
  // round mass, so the card read as a second small blob rather than as fringe.
  // Three changes: 3× the blade count at half the size (a leaf reads as a leaf,
  // not as a paddle), a per-angle radial LOBE function so the silhouette has
  // real bays and spurs instead of a jittered circle, and a much harder density
  // falloff so the rim dissolves into individual leaves at the alphaTest.
  const lobeA = R2() * Math.PI * 2;
  const lobeB = R2() * Math.PI * 2;
  const edge = (a) => 0.86
    + 0.30 * Math.sin(a * 3 + lobeA)
    + 0.17 * Math.sin(a * 5 - lobeB)
    + 0.09 * Math.sin(a * 8 + lobeA * 1.7);
  for (let i = 0; i < 700; i++) {
    // rejection-sample a ragged elliptical mass, denser toward the middle
    const a = R2() * Math.PI * 2;
    const rr = Math.pow(R2(), 0.62) * s * 0.50;
    const x = cx + Math.cos(a) * rr * 1.06;
    const y = cy + Math.sin(a) * rr * 0.86;
    const lim = s * 0.50 * edge(a);
    if (rr > lim) continue;                           // ragged silhouette
    if (rr > lim * 0.72 && R2() < 0.52) continue;     // the rim thins to leaves
    const L = s * (0.022 + R2() * 0.046);
    const v = 190 + Math.floor(R2() * 60);
    g.save();
    g.translate(x, y);
    g.rotate(R2() * Math.PI * 2);
    g.fillStyle = `rgb(${Math.round(v * 0.94)},${v},${Math.round(v * 0.80)})`;
    g.beginPath();
    g.ellipse(0, 0, L, L * (0.30 + R2() * 0.20), 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = `rgba(${Math.round(v * 0.55)},${Math.round(v * 0.62)},${Math.round(v * 0.42)},0.75)`;
    g.lineWidth = 1.2;
    g.stroke();
    g.restore();
  }
  // a few twigs so the clump hangs off something
  g.strokeStyle = 'rgba(96,84,60,0.9)';
  g.lineWidth = s * 0.010;
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (R2() - 0.5) * 2.2;
    g.beginPath();
    g.moveTo(cx, cy + s * 0.10);
    g.lineTo(cx + Math.cos(a) * s * 0.34, cy + s * 0.10 + Math.sin(a) * s * 0.34);
    g.stroke();
  }
}

// Fired brick with a real mortar course. M.brick was a flat 0x8F5844 with no
// map at all — the one material in the settlement kit that had nothing.
function paintBrick(g, s) {
  const R2 = seededRand(0x1B4C);
  g.fillStyle = css(0x6E6154);                         // mortar bed
  g.fillRect(0, 0, s, s);
  const rows = 9;
  const bh = s / rows;
  const bw = s / 4;
  for (let r = 0; r < rows; r++) {
    const y = r * bh;
    const off = (r % 2) * bw * 0.5;
    for (let i = -1; i < 5; i++) {
      const x = i * bw + off;
      const t = 0.80 + R2() * 0.40;
      const base = R2() < 0.16 ? 0x7A4A3C : 0x8F5844;  // an under-fired brick
      const cr = Math.min(255, Math.round(((base >> 16) & 255) * t));
      const cg = Math.min(255, Math.round(((base >> 8) & 255) * t));
      const cb = Math.min(255, Math.round((base & 255) * t));
      g.fillStyle = `rgb(${cr},${cg},${cb})`;
      g.fillRect(x + 1.8, y + 1.8, bw - 3.6, bh - 3.6);
      for (let k = 0; k < 22; k++) {                   // face speckle
        g.fillStyle = css(R2() < 0.5 ? 0xA97565 : 0x6B3E32, 0.10 + R2() * 0.22);
        g.fillRect(x + 2.4 + R2() * (bw - 6), y + 2.4 + R2() * (bh - 6),
          1 + R2() * 2.4, 1 + R2() * 2);
      }
    }
  }
  for (let i = 0; i < 26; i++) {                       // lime bloom / soot
    const x = R2() * s, y = R2() * s, r = s * (0.05 + R2() * 0.10);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const light = R2() < 0.5;
    grd.addColorStop(0, css(light ? 0xC9BFAC : 0x4A3A32, light ? 0.24 : 0.20));
    grd.addColorStop(1, css(light ? 0xC9BFAC : 0x4A3A32, 0));
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  grainPass(g, s, 6, R2);
}

// Precast concrete trim — parapets, copings, footings, pylon bases. Painted at
// the mean of the colour it replaces (0x9A948A) so the material can go to white
// and nothing in the scene shifts value.
function paintConcrete(g, s) {
  const R2 = seededRand(0x33D1);
  g.fillStyle = css(0x9A948A);
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 4; i++) {                        // shuttering board lines
    const y = i * (s / 4);
    g.fillStyle = css(0x7C786F, 0.55);
    g.fillRect(0, y, s, Math.max(1, s * 0.006));
    g.fillStyle = css(0xB6B0A4, 0.42);
    g.fillRect(0, y + Math.max(1, s * 0.006), s, Math.max(1, s * 0.005));
  }
  for (let i = 0; i < 2400; i++) {                     // exposed aggregate
    g.fillStyle = css([0x8A857C, 0xB2ACA0, 0x767268][(R2() * 3) | 0], 0.16 + R2() * 0.22);
    g.fillRect(R2() * s, R2() * s, 0.9 + R2() * 1.8, 0.9 + R2() * 1.6);
  }
  for (let i = 0; i < 150; i++) {                      // blow holes
    g.fillStyle = css(0x5E5A53, 0.30 + R2() * 0.35);
    g.beginPath();
    g.arc(R2() * s, R2() * s, s * (0.004 + R2() * 0.007), 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 5; i++) {                        // form-tie cones
    const x = R2() * s, y = R2() * s, r = s * 0.022;
    g.fillStyle = css(0x87827A, 0.7);
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = css(0xB6B0A4, 0.5);
    g.lineWidth = 1.4;
    g.stroke();
  }
  grainPass(g, s, 5, R2);
}

// ---- ROUND-3 FIX 3: the metalwork is not black ------------------------------
// The round-3 critique measured feature materials at #201d1a (relative luminance
// 0.013) and #24241f (0.017) carrying no map and no normalMap, and called the
// transmission pylons, the comms mast and the yard posts "holes cut in the
// world". Nothing outdoors under a 4.4-intensity key is that dark: hot-dip
// galvanised lattice sits at an albedo of 0.30–0.45 and weathers UP toward a
// chalky zinc grey, never down toward soot. Both painters below exist so the
// structure can carry a REAL albedo plus relief instead of one flat void value.

// Hot-dip galvanised steel, a few winters old. Painted at a mean of ~0x8A8F8C
// (≈0.29 luminance, the middle of the real band) so the materials that use it
// can run at colour 0xFFFFFF and let the map own the value. Zinc spangle, mill
// scale, bolt heads with the rust run each one grows, and edge wear.
function paintGalv(g, s) {
  const R2 = seededRand(0x51A7);
  g.fillStyle = css(0x8A8F8C);
  g.fillRect(0, 0, s, s);
  // ---- ROUND-7 FIX A: the COARSE band ---------------------------------------
  // Everything that was here — spangle, mill grain, 4x4 bolt grid, the rust tear
  // under each bolt — is a FINE feature: 2 % to 6 % of the tile. Once the UVs are
  // world-scaled a tile is 1.82 u, so at a 26–90 u camera the whole tile is 8–30
  // px and every one of those features is at or under one pixel. The fine layer
  // is right and it is kept; what was missing is the 25–50 % band, which is what
  // still varies when the tile itself is resolving at a handful of pixels. Same
  // argument the brick fix made and the same instrument: broad washes, not more
  // speckle. Painted UNDER the fine layer so nothing already verified is lost.
  for (let i = 0; i < 5; i++) {                        // broad rust/weather washes
    const x = R2() * s, y = R2() * s, r = s * (0.26 + R2() * 0.26);
    const warm = R2() < 0.62;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0.00, css(warm ? 0x8A6242 : 0x6F756E, warm ? 0.30 : 0.24));
    grd.addColorStop(0.55, css(warm ? 0x8A6242 : 0x6F756E, warm ? 0.15 : 0.12));
    grd.addColorStop(1.00, css(warm ? 0x8A6242 : 0x6F756E, 0));
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  {                                                    // splash-dirt band, low
    const band = g.createLinearGradient(0, s * 0.62, 0, s);
    band.addColorStop(0, css(0x6B6A5C, 0));
    band.addColorStop(1, css(0x6B6A5C, 0.30));
    g.fillStyle = band;
    g.fillRect(0, s * 0.62, s, s * 0.38);
  }
  {                                                    // rain-washed zinc, high
    const band = g.createLinearGradient(0, 0, 0, s * 0.30);
    band.addColorStop(0, css(0xB9BDB6, 0.22));
    band.addColorStop(1, css(0xB9BDB6, 0));
    g.fillStyle = band;
    g.fillRect(0, 0, s, s * 0.30);
  }
  // zinc spangle — the crystal facets a hot-dip coat freezes into
  for (let i = 0; i < 260; i++) {
    const x = R2() * s, y = R2() * s, r = s * (0.012 + R2() * 0.045);
    const light = R2() < 0.55;
    g.fillStyle = css(light ? 0xA6ABA6 : 0x74796F, 0.16 + R2() * 0.20);
    g.beginPath();
    const n = 5 + ((R2() * 3) | 0);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + R2() * 0.4;
      const rr = r * (0.6 + R2() * 0.7);
      if (k === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
  }
  // mill grain along the member
  for (let i = 0; i < 420; i++) {
    const v = R2() < 0.5 ? 0xA2A79F : 0x70756C;
    g.strokeStyle = css(v, 0.08 + R2() * 0.10);
    g.lineWidth = 0.8 + R2() * 1.6;
    const y = R2() * s, L = s * (0.15 + R2() * 0.5);
    const x = R2() * s;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + L, y + (R2() - 0.5) * 3);
    g.stroke();
  }
  // bolt heads on a loose grid, each with the rust tear it grows underneath
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (R2() < 0.30) continue;
      const x = (c + 0.5) * (s / 4) + (R2() - 0.5) * s * 0.06;
      const y = (r + 0.5) * (s / 4) + (R2() - 0.5) * s * 0.06;
      const rr = s * 0.021;
      g.fillStyle = css(0x9CA199, 0.9);
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + 0.3;
        if (k === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
      g.strokeStyle = css(0x5E625B, 0.55);
      g.lineWidth = 1.1;
      g.stroke();
      if (R2() < 0.55) {
        const gd = g.createLinearGradient(0, y, 0, y + s * (0.09 + R2() * 0.14));
        gd.addColorStop(0, css(0x7A5334, 0.42));
        gd.addColorStop(1, css(0x7A5334, 0));
        g.fillStyle = gd;
        g.fillRect(x - rr * 0.8, y, rr * 1.6, s * 0.24);
      }
    }
  }
  // dirt caught in the angle, and bright edge wear where a member is handled
  for (let i = 0; i < 26; i++) {
    const x = R2() * s, y = R2() * s, r = s * (0.03 + R2() * 0.07);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = R2() < 0.6;
    grd.addColorStop(0, css(dark ? 0x6A6F66 : 0xB4B8B1, dark ? 0.24 : 0.20));
    grd.addColorStop(1, css(dark ? 0x6A6F66 : 0xB4B8B1, 0));
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // ROUND-7 FIX A, second half of the coarse band: long weathering runs. These
  // are 30–75 % of the tile on the long axis and 4–9 % across, which is the one
  // feature shape that stays legible when the tile is 10 px wide — a streak
  // still reads as a streak at 1 x 7 px, a bolt head does not read at all.
  for (let i = 0; i < 7; i++) {
    const x = R2() * s;
    const y0 = R2() * s * 0.5;
    const h = s * (0.30 + R2() * 0.45);
    const w = s * (0.04 + R2() * 0.05);
    const warm = R2() < 0.55;
    const st = g.createLinearGradient(x, y0, x + w, y0);
    st.addColorStop(0.00, css(warm ? 0x7E5836 : 0x686D66, 0));
    st.addColorStop(0.42, css(warm ? 0x7E5836 : 0x686D66, 0.20 + R2() * 0.16));
    st.addColorStop(1.00, css(warm ? 0x7E5836 : 0x686D66, 0));
    g.fillStyle = st;
    g.fillRect(x, y0, w, h);
  }
  grainPass(g, s, 6, R2);
}

// Silvered fence timber — a split post a few seasons into the weather. Mean
// ~0x8A7F6A: real sun-bleached softwood, not the near-black 0x3B3226 a yard
// post was inheriting from the tree-trunk material. Grain runs along canvas y,
// which is the long axis of every post box that uses it.
function paintTimber(g, s) {
  const R2 = seededRand(0x6D42);
  g.fillStyle = css(0x8A7F6A);
  g.fillRect(0, 0, s, s);
  // broad sapwood/heartwood banding across the face
  for (let i = 0; i < 7; i++) {
    const x = R2() * s, w = s * (0.05 + R2() * 0.14);
    g.fillStyle = css(R2() < 0.5 ? 0x9B9078 : 0x776C59, 0.22 + R2() * 0.18);
    g.fillRect(x, 0, w, s);
  }
  // grain lines
  for (let i = 0; i < 200; i++) {
    const x = R2() * s;
    const dark = R2() < 0.62;
    g.strokeStyle = css(dark ? 0x6B6152 : 0xA79C86, 0.16 + R2() * 0.26);
    g.lineWidth = 0.7 + R2() * 1.9;
    g.beginPath();
    g.moveTo(x, -4);
    for (let y = 0; y <= s + 4; y += 16) {
      g.lineTo(x + Math.sin((y / s) * 6.2 + i) * (1.4 + R2() * 1.2), y);
    }
    g.stroke();
  }
  // weather checks (splits) — the deep dark lines that make timber read as timber
  for (let i = 0; i < 9; i++) {
    const x = R2() * s;
    g.strokeStyle = css(0x4E4639, 0.42 + R2() * 0.3);
    g.lineWidth = 1.2 + R2() * 1.8;
    g.beginPath();
    g.moveTo(x, R2() * s * 0.4);
    g.lineTo(x + (R2() - 0.5) * 5, R2() * s * 0.4 + s * (0.3 + R2() * 0.5));
    g.stroke();
  }
  // knots, with the grain swirling round them
  for (let i = 0; i < 3; i++) {
    const x = R2() * s, y = R2() * s, r = s * (0.02 + R2() * 0.028);
    for (let k = 4; k >= 1; k--) {
      g.strokeStyle = css(0x5A5041, 0.18 + 0.16 * (5 - k));
      g.lineWidth = 1.6;
      g.beginPath();
      g.ellipse(x, y, r * k * 0.42, r * k * 0.72, 0.2, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = css(0x4A4133, 0.72);
    g.beginPath();
    g.ellipse(x, y, r * 0.42, r * 0.72, 0.2, 0, Math.PI * 2);
    g.fill();
  }
  // green algae bloom low on the post, where it sits in the wet grass
  for (let i = 0; i < 12; i++) {
    const x = R2() * s, y = s * (0.78 + R2() * 0.22), r = s * (0.03 + R2() * 0.06);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, css(0x6C7050, 0.24));
    grd.addColorStop(1, css(0x6C7050, 0));
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  grainPass(g, s, 6, R2);
}

// ROUND-3 FIX 2 (second half). Slip-formed grain-silo shell. The critique
// measured the elevator silos as "near-clipping-white cylinders with one seam
// line" and the brightest objects on the map. Base is 0xC9C4B8 exactly as
// asked, and the vertical structure — lift-line seams, rain streaks, a rust run
// under every fixing and a dirt line where the shell meets the apron — is
// painted in, so the high-pass relief pass turns it into a vertical roughness
// break as well. Cylinder side UVs put v = 0 at the base, and the texture is
// uploaded flipped, so canvas y = s IS the bottom of the silo.
function paintSilo(g, s) {
  const R2 = seededRand(0x2F17);
  g.fillStyle = css(0xC9C4B8);
  g.fillRect(0, 0, s, s);
  // slip-form lift lines: horizontal in canvas space => rings around the shell
  for (let i = 1; i < 6; i++) {
    const y = i * (s / 6) + (R2() - 0.5) * 3;
    g.fillStyle = css(0xA39C8E, 0.55);
    g.fillRect(0, y, s, Math.max(1, s * 0.005));
    g.fillStyle = css(0xDCD7C9, 0.40);
    g.fillRect(0, y + Math.max(1, s * 0.005), s, Math.max(1, s * 0.004));
  }
  // vertical form-panel joints
  for (let i = 0; i < 10; i++) {
    const x = (i + 0.5) * (s / 10) + (R2() - 0.5) * 4;
    g.fillStyle = css(0xB0A99A, 0.34);
    g.fillRect(x, 0, Math.max(1, s * 0.004), s);
  }
  // aggregate + blow holes
  for (let i = 0; i < 5200; i++) {
    g.fillStyle = css([0xBDB7A9, 0xD6D1C4, 0xADA79A][(R2() * 3) | 0], 0.14 + R2() * 0.20);
    g.fillRect(R2() * s, R2() * s, 0.9 + R2() * 1.7, 0.9 + R2() * 1.5);
  }
  for (let i = 0; i < 220; i++) {
    g.fillStyle = css(0x8E887C, 0.24 + R2() * 0.30);
    g.beginPath();
    g.arc(R2() * s, R2() * s, s * (0.003 + R2() * 0.006), 0, Math.PI * 2);
    g.fill();
  }
  // long rain streaks running DOWN the shell (canvas +y)
  for (let i = 0; i < 90; i++) {
    const x = R2() * s;
    const y0 = R2() * s * 0.55;
    const len = s * (0.25 + R2() * 0.6);
    const grd = g.createLinearGradient(0, y0, 0, y0 + len);
    const dark = R2() < 0.75;
    grd.addColorStop(0, css(dark ? 0x9B9486 : 0x7A5334, dark ? 0.30 : 0.26));
    grd.addColorStop(1, css(dark ? 0x9B9486 : 0x7A5334, 0));
    g.fillStyle = grd;
    g.fillRect(x, y0, 1.2 + R2() * 4.2, len);
  }
  // dirt line where the shell meets the apron (bottom of the canvas)
  {
    const grd = g.createLinearGradient(0, s, 0, s * 0.80);
    grd.addColorStop(0, css(0x8E866F, 0.52));
    grd.addColorStop(1, css(0x8E866F, 0));
    g.fillStyle = grd;
    g.fillRect(0, s * 0.80, s, s * 0.20);
  }
  grainPass(g, s, 6, R2);
}

// Window pane. Round 1 and round 3 both logged "flat painted rectangles with a
// pale-blue glyph": the pane was ONE unlit-looking flat colour behind a plaster
// reveal, so at close zoom a house had a sticker where a window belongs. This
// paints what a window actually is at 30 m — a dark room, a sky reflection that
// dies toward the sill, a mullion cross, and a net curtain in the lower half.
function paintWindow(g, s) {
  const R2 = seededRand(0x44B9);
  const room = g.createLinearGradient(0, 0, 0, s);
  room.addColorStop(0, css(0x2B3941));
  room.addColorStop(0.55, css(0x1B252B));
  room.addColorStop(1, css(0x141C21));
  g.fillStyle = room;
  g.fillRect(0, 0, s, s);
  // sky reflection: strongest at the head of the opening, gone by the sill
  const sky = g.createLinearGradient(0, 0, 0, s * 0.72);
  sky.addColorStop(0, css(0x9FB4C6, 0.62));
  sky.addColorStop(0.45, css(0x7E93A6, 0.26));
  sky.addColorStop(1, css(0x7E93A6, 0));
  g.fillStyle = sky;
  g.fillRect(0, 0, s, s * 0.72);
  // a couple of soft reflected bands so the glass is not one clean ramp
  for (let i = 0; i < 3; i++) {
    g.save();
    g.translate(s * 0.5, s * 0.5);
    g.rotate(-0.5);
    g.fillStyle = css(0xC6D2DC, 0.06 + R2() * 0.07);
    g.fillRect(-s, -s * (0.36 - i * 0.18), s * 2, s * (0.05 + R2() * 0.05));
    g.restore();
  }
  // net curtain, bottom two thirds
  const net = g.createLinearGradient(0, s * 0.34, 0, s);
  net.addColorStop(0, css(0xC8C2B2, 0));
  net.addColorStop(1, css(0xC8C2B2, 0.30));
  g.fillStyle = net;
  g.fillRect(0, s * 0.34, s, s * 0.66);
  // mullion: one vertical, one transom, in the same plaster the reveal uses
  g.fillStyle = css(0xB9B0A0, 0.95);
  g.fillRect(s * 0.47, 0, s * 0.06, s);
  g.fillRect(0, s * 0.40, s, s * 0.055);
  g.fillStyle = css(0x6F695C, 0.55);
  g.fillRect(s * 0.53, 0, s * 0.016, s);
  g.fillRect(0, s * 0.455, s, s * 0.014);
  // frame rebate around the opening
  g.strokeStyle = css(0x3A3B36, 0.75);
  g.lineWidth = Math.max(2, s * 0.035);
  g.strokeRect(0, 0, s, s);
  grainPass(g, s, 3, R2);
}

// ROUND-3 FIX 10 — round bale. The critique measured the bales as the most
// saturated object on the map: `map: Tex.wheat, color: 0xA8925F` under a warm
// key made bright orange drums that out-punched the stubble they stand in,
// which is inverted — a compacted bale is the SAME crop, darker, with a hard
// contact occlusion. Painted at 0x8E7A50, with the net-wrap rings that give the
// drum its relief. Cylinder v runs along the drum axis, so a horizontal canvas
// line IS a ring around the bale, and the dark bands at v≈0 / v≈1 land as the
// recessed rim of each cut end.
function paintBale(g, s) {
  const R2 = seededRand(0x7E3C);
  g.fillStyle = css(0x8E7A50);
  g.fillRect(0, 0, s, s);
  // packed straw: short strokes, mostly along the winding direction
  for (let i = 0; i < 2600; i++) {
    const x = R2() * s, y = R2() * s;
    const L = 3 + R2() * 14;
    const a = (R2() - 0.5) * 0.55;
    g.strokeStyle = css([0xA38C5C, 0x74633F, 0xB39C68, 0x5F5133][(R2() * 4) | 0],
      0.16 + R2() * 0.26);
    g.lineWidth = 0.7 + R2() * 1.3;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L);
    g.stroke();
  }
  // net wrap — the ribs the low sun actually catches on a round bale
  const rings = 9;
  for (let i = 0; i < rings; i++) {
    const y = (i + 0.5) * (s / rings);
    g.fillStyle = css(0x6B5A38, 0.42);
    g.fillRect(0, y - s * 0.010, s, s * 0.011);
    g.fillStyle = css(0xB0995F, 0.34);
    g.fillRect(0, y + s * 0.002, s, s * 0.009);
  }
  // shadowed hollows between the coils
  for (let i = 0; i < 60; i++) {
    const x = R2() * s, y = R2() * s, r = s * (0.02 + R2() * 0.05);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, css(0x4F4229, 0.26));
    grd.addColorStop(1, css(0x4F4229, 0));
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // recessed rim at both cut ends (v = 0 and v = 1)
  for (const [y0, y1] of [[0, s * 0.09], [s * 0.91, s]]) {
    const grd = g.createLinearGradient(0, y0 === 0 ? y1 : y0, 0, y0 === 0 ? y0 : y1);
    grd.addColorStop(0, css(0x4A3E27, 0));
    grd.addColorStop(1, css(0x4A3E27, 0.62));
    g.fillStyle = grd;
    g.fillRect(0, y0, s, y1 - y0);
  }
  grainPass(g, s, 5, R2);
}

// Town facade: a precast concrete panel block — panel joints, slab lines and
// weather staining. NO painted windows: the settlement builder now hangs real
// recessed glass + plaster reveals on every facade (CRITIQUE r1 fix 6), and a
// painted window grid underneath that reads as a double image. Box UVs put
// v = 1 at the top of the wall, i.e. canvas y = 0 is the parapet.
function paintTownWall(g, s) {
  const R2 = seededRand(0x9C31);
  g.fillStyle = css(0xB8A88C);
  g.fillRect(0, 0, s, s);

  // 3 × 4 precast panels, each very slightly its own value
  const pc = 3, pr = 4;
  for (let r = 0; r < pr; r++) {
    for (let c = 0; c < pc; c++) {
      const t = 0.955 + R2() * 0.09;
      g.fillStyle = `rgba(${Math.round(0xB8 * t)},${Math.round(0xA8 * t)},${Math.round(0x8C * t)},1)`;
      g.fillRect(c * (s / pc), r * (s / pr), s / pc, s / pr);
    }
  }
  // aggregate
  for (let i = 0; i < 5200; i++) {
    const v = [0xA79878, 0xC6B79B, 0x9C8E70][(R2() * 3) | 0];
    g.fillStyle = css(v, 0.22 + R2() * 0.24);
    g.fillRect(R2() * s, R2() * s, 0.8 + R2() * 1.6, 0.8 + R2() * 1.6);
  }
  // panel joints — recessed shadow line + light lip below it
  g.fillStyle = css(0x8A7C63, 0.85);
  for (let c = 1; c < pc; c++) g.fillRect(c * (s / pc) - 1.5, 0, 3, s);
  for (let r = 1; r < pr; r++) g.fillRect(0, r * (s / pr) - 1.5, s, 3);
  g.fillStyle = css(0xD8CDB6, 0.5);
  for (let r = 1; r < pr; r++) g.fillRect(0, r * (s / pr) + 1.5, s, 1.5);
  // rain staining below every slab line
  for (let r = 1; r < pr; r++) {
    const y = r * (s / pr);
    for (let i = 0; i < 16; i++) {
      const x = R2() * s;
      const grd = g.createLinearGradient(0, y, 0, y + 40 + R2() * 60);
      grd.addColorStop(0, css(0x7E7462, 0.34));
      grd.addColorStop(1, css(0x7E7462, 0));
      g.fillStyle = grd;
      g.fillRect(x, y, 2 + R2() * 5, 40 + R2() * 60);
    }
  }
  grainPass(g, s, 6, R2);
}

// ---- ribbon cross-section tiles -------------------------------------------
// Every ribbon maps u ACROSS the strip (0 = left edge, 1 = right edge) and v
// ALONG it, so these are painted as cross-sections: vertical bands. That is
// what lets one draw call carry an asphalt body, a centreline, dark edges and
// a verge — instead of the flat maroon ribbons with a hairline on them that
// round 1 shipped (CRITIQUE r1 fix 12).

function paintRoadPaved(g, s) {
  const R2 = seededRand(0x51A9);
  g.fillStyle = css(0x8A6F4D);                       // verge earth (art bible)
  g.fillRect(0, 0, s, s);
  g.fillStyle = css(0x6E675C);                       // gravel shoulder
  g.fillRect(s * 0.105, 0, s * 0.10, s);
  g.fillRect(s * 0.795, 0, s * 0.10, s);
  g.fillStyle = css(0x3A3835);                       // dark edge strip
  g.fillRect(s * 0.185, 0, s * 0.032, s);
  g.fillRect(s * 0.783, 0, s * 0.032, s);
  g.fillStyle = css(0x4C4A47);                       // asphalt body
  g.fillRect(s * 0.205, 0, s * 0.59, s);

  for (let i = 0; i < 3000; i++) {                   // aggregate
    const x = s * (0.205 + R2() * 0.59);
    g.fillStyle = css([0x3A3835, 0x5C5A56, 0x545149][(R2() * 3) | 0], 0.3 + R2() * 0.35);
    g.fillRect(x, R2() * s, 0.9 + R2() * 1.5, 0.9 + R2() * 1.5);
  }
  for (let i = 0; i < 7; i++) {                      // patch repairs
    const x = s * (0.21 + R2() * 0.48);
    const y = R2() * s;
    const w = s * (0.06 + R2() * 0.16);
    const h = 16 + R2() * 64;
    g.fillStyle = css(0x413F3C, 0.6);
    g.fillRect(x, y, w, h);
    g.fillStyle = css(0x2C2A28, 0.55);
    g.fillRect(x, y, w, 1.6);
    g.fillRect(x, y + h - 1.6, w, 1.6);
  }
  g.strokeStyle = css(0x2C2A28, 0.5);                // longitudinal cracking
  for (let i = 0; i < 9; i++) {
    g.lineWidth = 0.7 + R2() * 1.1;
    let x = s * (0.22 + R2() * 0.55), y = 0;
    g.beginPath();
    g.moveTo(x, y);
    while (y < s) { y += 14 + R2() * 30; x += (R2() - 0.5) * 9; g.lineTo(x, y); }
    g.stroke();
  }
  g.fillStyle = css(0x565350, 0.30);                 // polished wheel tracks
  g.fillRect(s * 0.295, 0, s * 0.10, s);
  g.fillRect(s * 0.605, 0, s * 0.10, s);
  g.fillStyle = css(0x8F8A80, 0.92);                 // broken centreline
  for (let i = 0; i < 4; i++) {
    g.fillRect(s * 0.486, (i + 0.18) * (s / 4), s * 0.028, (s / 4) * 0.5);
  }
  grainPass(g, s, 5, R2);
}

function paintRoadDirt(g, s) {
  const R2 = seededRand(0x2C71);
  g.fillStyle = css(0x8A6F4D);
  g.fillRect(0, 0, s, s);
  g.fillStyle = css(0x8A7355);                        // bible dirt-road body
  g.fillRect(s * 0.13, 0, s * 0.74, s);
  // twin ruts, wobbling on a whole number of cycles so the tile still wraps
  const seg = Math.max(2, s / 96);
  for (const cx of [0.285, 0.715]) {
    const ph = R2() * 6.283;
    for (let y = 0; y < s; y += seg) {
      const wob = Math.sin((y / s) * Math.PI * 4 + ph) * s * 0.012;
      g.fillStyle = css(0x6E5A41, 0.7);
      g.fillRect(s * (cx - 0.058) + wob, y, s * 0.116, seg + 1);
      g.fillStyle = css(0x5E4A33, 0.55);
      g.fillRect(s * (cx - 0.022) + wob, y, s * 0.044, seg + 1);
    }
  }
  g.fillStyle = css(0x7A7D45, 0.45);                  // grassed crown
  for (let y = 0; y < s; y += seg) {
    const wob = Math.sin((y / s) * Math.PI * 2 + 1.1) * s * 0.01;
    g.fillRect(s * 0.452 + wob, y, s * 0.094, seg + 1);
  }
  for (let i = 0; i < 900; i++) {                     // stones and dry ruts
    g.fillStyle = css([0x9C845F, 0x5E4A33, 0xA79274][(R2() * 3) | 0], 0.3 + R2() * 0.4);
    g.fillRect(s * (0.1 + R2() * 0.8), R2() * s, 1 + R2() * 2.4, 1 + R2() * 2.4);
  }
  grainPass(g, s, 7, R2);
}

// PHASE 2 — the farm lane. Not a road: two bare wheel ruts with a GRASSED
// crown that is still a crop margin, weeds at both edges, and no graded
// shoulder anywhere. Cross-section runs across the tile's x axis, exactly as
// paintRoadDirt does, because the ribbon builder maps col → u.
function paintFarmTrack(g, s) {
  const R2 = seededRand(0x5A19);
  g.fillStyle = css(0x8F8A55);                        // weedy verge
  g.fillRect(0, 0, s, s);
  g.fillStyle = css(0x9C9560);
  g.fillRect(s * 0.16, 0, s * 0.68, s);
  const seg = Math.max(2, s / 110);
  // the two ruts — pale dry earth with a compacted darker core
  for (const cx of [0.315, 0.685]) {
    const ph = R2() * 6.283;
    for (let y = 0; y < s; y += seg) {
      const wob = Math.sin((y / s) * Math.PI * 6 + ph) * s * 0.008;
      g.fillStyle = css(0xA3855D, 0.86);
      g.fillRect(s * (cx - 0.072) + wob, y, s * 0.144, seg + 1);
      g.fillStyle = css(0x7A6340, 0.72);
      g.fillRect(s * (cx - 0.030) + wob, y, s * 0.060, seg + 1);
    }
  }
  // the crown between the ruts stays green — this is what says "farm track"
  // rather than "small road" at 180 units
  g.fillStyle = css(0x6E7A3E, 0.82);
  for (let y = 0; y < s; y += seg) {
    const wob = Math.sin((y / s) * Math.PI * 2 + 0.6) * s * 0.012;
    g.fillRect(s * 0.432 + wob, y, s * 0.136, seg + 1);
  }
  for (let i = 0; i < 700; i++) {                     // grass tufts and stones
    g.fillStyle = css([0x8A7355, 0x5E6136, 0xA79274, 0x6E5A41][(R2() * 4) | 0],
      0.22 + R2() * 0.4);
    g.fillRect(s * (0.12 + R2() * 0.76), R2() * s, 1 + R2() * 2.2, 1 + R2() * 2.6);
  }
  grainPass(g, s, 7, R2);
}

// PHASE 2 — a field drain. Reeds on the lip, wet churned mud on the batter, a
// dark standing-water thread down the middle. Read from above at RTS range it
// is a thin dark line with a green rim, which is exactly what a drainage ditch
// is in an aerial photograph.
function paintDitch(g, s) {
  const R2 = seededRand(0x61C4);
  g.fillStyle = css(0x6E7A42);                        // rank lip
  g.fillRect(0, 0, s, s);
  g.fillStyle = css(0x5C6B33);                        // reeds
  g.fillRect(s * 0.14, 0, s * 0.72, s);
  g.fillStyle = css(0x54452F);                        // wet batter
  g.fillRect(s * 0.30, 0, s * 0.40, s);
  g.fillStyle = css(0x2E3A30);                        // standing water
  g.fillRect(s * 0.435, 0, s * 0.13, s);
  const seg = Math.max(2, s / 120);
  for (let y = 0; y < s; y += seg) {                  // the thread wanders
    const wob = Math.sin((y / s) * Math.PI * 4 + 1.9) * s * 0.016;
    g.fillStyle = css(0x24302A, 0.75);
    g.fillRect(s * 0.468 + wob, y, s * 0.064, seg + 1);
  }
  for (let i = 0; i < 520; i++) {                     // reed blades on the lip
    const side = R2() < 0.5 ? 0.16 : 0.66;
    g.fillStyle = css([0x6E8038, 0x4A5A2C, 0x8A9350][(R2() * 3) | 0], 0.3 + R2() * 0.45);
    g.fillRect(s * (side + R2() * 0.18), R2() * s, 1 + R2() * 1.6, 2 + R2() * 4);
  }
  grainPass(g, s, 6, R2);
}

function paintBallast(g, s) {
  const R2 = seededRand(0x3B5D);
  g.fillStyle = css(0x8A6F4D);                        // earth beyond the shoulder
  g.fillRect(0, 0, s, s);
  g.fillStyle = css(0x5E584E);                        // shoulder slope
  g.fillRect(s * 0.10, 0, s * 0.80, s);
  g.fillStyle = css(0x6E675C);                        // bible ballast
  g.fillRect(s * 0.18, 0, s * 0.64, s);
  for (let i = 0; i < 5000; i++) {                    // crushed stone
    const x = s * (0.10 + R2() * 0.80);
    const r = 1.2 + R2() * 2.6;
    g.fillStyle = css([0x847C6F, 0x565046, 0x9A9082, 0x6E675C][(R2() * 4) | 0], 0.55 + R2() * 0.4);
    g.beginPath();
    g.ellipse(x, R2() * s, r, r * (0.6 + R2() * 0.6), R2() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = css(0x4A443B, 0.35);                  // oil-dark centre between the rails
  g.fillRect(s * 0.42, 0, s * 0.16, s);
  grainPass(g, s, 6, R2);
}

// Riverbank strip: u = 0 at the waterline, u = 1 at the top of the bank.
//
// ROUND-5 FIX 7(b) — this tile is the BANK MATERIAL the critique asked for, and
// round 4's version was working against itself. It opened at #2C2A22 (luma
// 0.16) and closed the first 5 % with a 35 %-alpha #1E1C18 wash, so the two
// metres of ground immediately behind the waterline — the two metres the eye
// actually looks at in `08-tree-closeup` — were painted at an effective luma of
// about 0.12 before the light ever reached them, on a face already turned away
// from a 14–25° key. That is most of "an untextured near-black vertical
// polygon". Three changes:
//   • the wet end opens at #4C4335 and the black wash is replaced by a wet
//     SHEEN: saturated silt at a low sun is a mirror, so the waterline reads
//     cooler and BRIGHTER than the dry bank above it, not darker;
//   • slump scars — the pale vertical calving streaks a cut bank always has —
//     give the strip real mid-frequency structure instead of one gradient;
//   • the shingle and the reed line are pushed apart so the tile reads as three
//     zones (wet silt / shingle berm / vegetated bank), which is what a river
//     margin is, rather than as a smooth wash from black to tan.
function paintShore(g, s) {
  const R2 = seededRand(0x77B1);
  const grd = g.createLinearGradient(0, 0, s, 0);
  grd.addColorStop(0.00, css(0x4C4335));              // waterlogged silt, lit
  grd.addColorStop(0.09, css(0x5A4A34));
  grd.addColorStop(0.26, css(0x6E5C42));
  grd.addColorStop(0.52, css(0x846E4C));              // bible bank
  grd.addColorStop(0.78, css(0x93805A));
  grd.addColorStop(1.00, css(0x8F7C57));
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  // slump scars: fresh subsoil where the bank has calved into the channel.
  // Authored at 3–9 % of the tile width so they survive minification at the
  // 44–90 u cameras, which is where the bank reads as a blank wall.
  for (let i = 0; i < 34; i++) {
    const y = R2() * s;
    const h = s * (0.06 + R2() * 0.16);
    const x0 = s * (0.10 + R2() * 0.42);
    const w = s * (0.03 + R2() * 0.06);
    const sc = g.createLinearGradient(x0, 0, x0 + w, 0);
    sc.addColorStop(0, css(0xA2916E, 0));
    sc.addColorStop(0.4, css(0xA2916E, 0.30 + R2() * 0.22));
    sc.addColorStop(1, css(0x6B5B41, 0));
    g.fillStyle = sc;
    g.beginPath();
    g.ellipse(x0 + w * 0.5, y, w * 0.5, h * 0.5, 0, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 2600; i++) {                    // shingle berm, off the water
    const t = Math.pow(R2(), 1.35);
    const x = s * 0.05 + t * s * 0.58;
    const r = 1 + R2() * 2.4;
    g.fillStyle = css([0x9A9078, 0x6A5F4C, 0xB0A388][(R2() * 3) | 0], 0.28 + R2() * 0.4);
    g.beginPath();
    g.ellipse(x, R2() * s, r, r * 0.7, R2() * 3, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 320; i++) {                     // reeds / tufts up the bank
    const x = s * (0.42 + R2() * 0.58);
    const y = R2() * s;
    g.strokeStyle = css(R2() < 0.5 ? 0x5C6136 : 0x7A7D45, 0.5 + R2() * 0.4);
    g.lineWidth = 1 + R2() * 1.4;
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (R2() - 0.5) * 10, y + (R2() - 0.5) * 14);
      g.stroke();
    }
  }
  // ===== ROUND-7 FIX B — THE WET BAND WAS UNDER THE WATER ===================
  // "No shoreline transition." There was one; it was invisible, and the reason
  // is arithmetic rather than art. The strip is laid with
  // `offFn = sgn * (shoreAt(z) - 1.0 + c * 11.5)`, so tile u = 0 sits 1.0 unit
  // INSIDE the waterline and the water sheet — opaque, depthWrite on, drawn out
  // to shoreAt + 1.2 — covers everything up to u = 1.0/11.5 = **0.087**. The
  // round-5 wet margin ran 0.000 → 0.085. Every pixel of it was submerged.
  // The band now spans u 0.06 → 0.26, i.e. from just under the waterline out to
  // 2.3 u of dry bank, which puts ~1.7 u of visible wet silt above the water —
  // the ~1.5 u the critique asked for, in the place it is actually seen.
  const wet = g.createLinearGradient(0, 0, s * 0.26, 0);
  wet.addColorStop(0.00, css(0x8FA0A2, 0.30));
  wet.addColorStop(0.33, css(0x7E8F92, 0.40));   // ← the visible waterline
  wet.addColorStop(0.55, css(0x6E7B78, 0.26));
  wet.addColorStop(1.00, css(0x5A5548, 0));
  g.fillStyle = wet;
  g.fillRect(0, 0, s * 0.26, s);
  // Drift line: the foam, straw and silt scum a river leaves at its own level.
  // Broken along the tile's v so it reads as a deposit and not as a drawn rule,
  // and it is the one thing on the bank that marks WHERE the water stops.
  for (let i = 0; i < 210; i++) {
    const x = s * (0.085 + Math.pow(R2(), 1.6) * 0.075);
    const y = R2() * s;
    const w = 2 + R2() * 7;
    const pale = R2() < 0.55;
    g.fillStyle = css(pale ? 0xC6C4B4 : 0x6B6350, 0.18 + R2() * 0.30);
    g.beginPath();
    g.ellipse(x, y, w * 0.5, 0.9 + R2() * 1.6, R2() * 3, 0, Math.PI * 2);
    g.fill();
  }
  grainPass(g, s, 7, R2);
}

// Near-white flow variation for the river albedo: the water COLOUR is carried
// by the material (0x35544E), so the map must not darken it a second time.
function paintRiverFlow(g, s) {
  const R2 = seededRand(0x1D4F);
  g.fillStyle = 'rgb(242,244,242)';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 90; i++) {                      // streamlines along v
    const x = R2() * s;
    const w = 4 + R2() * 26;
    g.fillStyle = `rgba(${210 + ((R2() * 40) | 0)},${216 + ((R2() * 36) | 0)},${212 + ((R2() * 40) | 0)},${0.10 + R2() * 0.16})`;
    g.beginPath();
    g.ellipse(x, R2() * s, w * 0.5, s * (0.16 + R2() * 0.4), 0, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 1400; i++) {                    // fine silt speckle
    const v = 226 + ((R2() * 26) | 0);
    g.fillStyle = `rgba(${v},${v},${v},0.20)`;
    g.fillRect(R2() * s, R2() * s, 1 + R2() * 2, 1 + R2() * 2);
  }
  grainPass(g, s, 4, R2);
}

// Trench cut, laid as a ground decal along each leg: a dark excavated channel
// with a shadowed west wall and a spoil lip, alpha-faded on every edge so the
// legs overlap without seams.
function paintTrench(g, s) {
  const R2 = seededRand(0x5D93);
  const cut = g.createLinearGradient(0, 0, s, 0);
  cut.addColorStop(0.00, css(0x4A3B2A, 0));
  cut.addColorStop(0.16, css(0x5C4A33, 0.55));
  cut.addColorStop(0.30, css(0x2A2118, 0.95));
  cut.addColorStop(0.52, css(0x1C1610, 0.98));
  cut.addColorStop(0.68, css(0x362A1E, 0.92));
  cut.addColorStop(0.84, css(0x6B5B41, 0.55));
  cut.addColorStop(1.00, css(0x8A6F4D, 0));
  g.fillStyle = cut;
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 700; i++) {                 // dug earth + duckboard specks
    const x = s * (0.18 + R2() * 0.66);
    g.fillStyle = css([0x2A2118, 0x4A3B2A, 0x6B5B41][(R2() * 3) | 0], 0.25 + R2() * 0.4);
    g.fillRect(x, R2() * s, 1 + R2() * 3, 1 + R2() * 3);
  }
  for (let i = 0; i < 12; i++) {                  // revetment boards across the cut
    const y = R2() * s;
    g.fillStyle = css(0x4A3E30, 0.5);
    g.fillRect(s * 0.30, y, s * 0.36, 1.6 + R2() * 2.2);
  }
  // fade the two ends so consecutive legs blend
  const fade = g.createLinearGradient(0, 0, 0, s);
  fade.addColorStop(0, 'rgba(0,0,0,1)');
  fade.addColorStop(0.10, 'rgba(0,0,0,0)');
  fade.addColorStop(0.90, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = fade;
  g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'source-over';
}

// Base course under every building: rough stone in 0xB8A88C with damp
// splash-back at the bottom, so nothing meets the ground at a razor edge.
function paintPlinth(g, s) {
  const R2 = seededRand(0x4E22);
  g.fillStyle = css(0xB8A88C);
  g.fillRect(0, 0, s, s);
  const rows = 4;
  for (let r = 0; r < rows; r++) {
    const y = r * (s / rows);
    const off = (r % 2) * s * 0.07;
    for (let x = -off; x < s; x += s * 0.14) {
      const t = 0.88 + R2() * 0.22;
      g.fillStyle = `rgba(${(0xB8 * t) | 0},${(0xA8 * t) | 0},${(0x8C * t) | 0},1)`;
      g.fillRect(x + 1.6, y + 1.6, s * 0.14 - 3.2, s / rows - 3.2);
    }
  }
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = css([0xA3906F, 0xC6B79B, 0x8A7A60][(R2() * 3) | 0], 0.25 + R2() * 0.3);
    g.fillRect(R2() * s, R2() * s, 1 + R2() * 2, 1 + R2() * 2);
  }
  const damp = g.createLinearGradient(0, s, 0, s * 0.45);
  damp.addColorStop(0, css(0x6E6250, 0.45));
  damp.addColorStop(1, css(0x6E6250, 0));
  g.fillStyle = damp;
  g.fillRect(0, s * 0.45, s, s * 0.55);
  grainPass(g, s, 7, R2);
}

// Shell crater: 0x362A1E churned ring with an 0x8A6F4D ejecta rim
// (ART_DIRECTION.md line 112), alpha-faded to nothing at the tile edge.
function paintCrater(g, s) {
  const R2 = seededRand(0x6A17);
  const c = s / 2;
  const ej = g.createRadialGradient(c, c, s * 0.20, c, c, s * 0.50);
  ej.addColorStop(0, css(0x8A6F4D, 0.85));
  ej.addColorStop(0.55, css(0x8A6F4D, 0.40));
  ej.addColorStop(1, css(0x8A6F4D, 0));
  g.fillStyle = ej;
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 220; i++) {                     // thrown spoil
    const a = R2() * Math.PI * 2;
    const rr = s * (0.20 + Math.pow(R2(), 0.6) * 0.28);
    g.fillStyle = css(R2() < 0.5 ? 0x8A6F4D : 0x5E4A33, 0.2 + R2() * 0.5);
    g.beginPath();
    g.ellipse(c + Math.cos(a) * rr, c + Math.sin(a) * rr,
      1.5 + R2() * 5, 1.5 + R2() * 4, a, 0, Math.PI * 2);
    g.fill();
  }
  const bowl = g.createRadialGradient(c - s * 0.03, c - s * 0.03, s * 0.02, c, c, s * 0.235);
  bowl.addColorStop(0, css(0x1C1610, 0.96));
  bowl.addColorStop(0.55, css(0x362A1E, 0.94));
  bowl.addColorStop(0.86, css(0x4A3B2A, 0.80));
  bowl.addColorStop(1, css(0x5C4A33, 0));
  g.fillStyle = bowl;
  g.beginPath();
  g.ellipse(c, c, s * 0.235, s * 0.215, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = css(0x2A2118, 0.5);                 // radial scour marks
  for (let i = 0; i < 30; i++) {
    const a = R2() * Math.PI * 2;
    g.lineWidth = 1 + R2() * 2.4;
    g.beginPath();
    g.moveTo(c + Math.cos(a) * s * 0.20, c + Math.sin(a) * s * 0.20);
    g.lineTo(c + Math.cos(a) * s * (0.30 + R2() * 0.16), c + Math.sin(a) * s * (0.30 + R2() * 0.16));
    g.stroke();
  }
}

function paintScorch(g, s) {
  const gr = g.createRadialGradient(s / 2, s / 2, s * 0.04, s / 2, s / 2, s * 0.5);
  gr.addColorStop(0, 'rgba(24,20,17,0.92)');
  gr.addColorStop(0.45, 'rgba(40,32,25,0.66)');
  gr.addColorStop(0.78, 'rgba(70,56,42,0.26)');
  gr.addColorStop(1, 'rgba(70,56,42,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 44; i++) {
    const a = (i / 44) * Math.PI * 2 + (i % 5) * 0.31;
    const r = s * (0.14 + ((i * 13) % 30) / 100);
    g.fillStyle = `rgba(28,23,19,${0.14 + ((i * 7) % 30) / 90})`;
    g.beginPath();
    g.ellipse(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r,
      3 + (i % 11), 2 + (i % 7), a, 0, Math.PI * 2);
    g.fill();
  }
}

// gable roof prism: unit footprint, ridge along local X, apex at y = 1.
//
// ROUND-3 FIX 2. The prism used to be ONE mesh — two sloped roof planes AND the
// two vertical end triangles — so whatever material the roof took was also
// painted on the wall gable above the masonry. That is the critique's "the near
// plane is flat blue-grey and the front gable is brick-patterned": one object,
// two surfaces that belong to different trades. `parts` now selects which half
// you get, so the settlement builder can hang the roof planes off a roof
// material and the end triangles off the SAME wall material (and the same UV
// scale) as the storey underneath them.
//   'all'   — unchanged prism, for the sheds and depot roofs that want it
//   'roof'  — the two sloped planes only
//   'ends'  — the two vertical gable triangles only
function gableGeometry(parts) {
  const want = parts || 'all';
  const p = [], uv = [];
  const quad = (a, b, c, d) => {
    p.push(...a, ...b, ...c, ...a, ...c, ...d);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  };
  // The end triangle is masonry, so its UV must run at the WALL's density, not
  // stretched over its own bounding box: v is scaled by GABLE_V, the typical
  // roof-rise / storey-height ratio, which lands a brick course on the gable at
  // the same pitch as the course on the wall below it.
  const GABLE_V = 0.55;
  const tri = (a, b, c) => {
    p.push(...a, ...b, ...c);
    uv.push(0, 0, 0.5, GABLE_V, 1, 0);
  };
  if (want !== 'ends') {
    quad([-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, 0], [-0.5, 1, 0]);
    quad([0.5, 0, 0.5], [-0.5, 0, 0.5], [-0.5, 1, 0], [0.5, 1, 0]);
  }
  if (want !== 'roof') {
    tri([-0.5, 0, 0.5], [-0.5, 1, 0], [-0.5, 0, -0.5]);
    tri([0.5, 0, -0.5], [0.5, 1, 0], [0.5, 0, 0.5]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// Objective flag cloth: hoist at local x = 0, drooping and waving toward the
// fly, with a dark accent band baked into vertex colour so the marker is
// two-tone and LIT instead of the unlit saturated quad round 1 shipped.
function clothGeometry() {
  const geo = new THREE.PlaneGeometry(1, 1, 14, 7);
  geo.translate(0.5, 0, 0);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const droop = -0.26 * x * x;
    const wave = Math.sin(x * 7.4 + 0.6) * 0.10 * x + Math.sin(y * 3.1) * 0.02 * x;
    pos.setXYZ(i, x, y + droop, wave);
    const band = y < -0.16;
    const fold = 0.86 + 0.20 * (0.5 + 0.5 * Math.cos(x * 7.4 + 0.6));
    const k = band ? 0.30 : 1.0;
    col[i * 3] = k * fold;
    col[i * 3 + 1] = (band ? 0.32 : 1.0) * fold;
    col[i * 3 + 2] = (band ? 0.28 : 1.0) * fold;
  }
  pos.needsUpdate = true;
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

// one transformed box, ready to be merged into a lattice
function partBox(w, h, d, x, y, z, rx, ry, rz) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rz) g.rotateZ(rz);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

// minimal geometry merge (position / normal / uv / colour, non-indexed output)
//
// ROUND-7 FIX A, FOOTGUN 2 (flagged by the models pass and it is real): this
// used to copy position/normal/uv only, so a `color` attribute baked onto a
// member by `bakeMemberValue()` was silently dropped at merge time and the whole
// per-member value spread — the half of the fix that survives minification —
// was a no-op. Colour is carried through now, and a part that does not have one
// contributes 1.0 so a mixed list still merges to a valid partition.
function mergeGeos(list) {
  const parts = [];
  let count = 0;
  let anyColor = false;
  for (const g of list) {
    if (!g) continue;
    const ng = g.index ? g.toNonIndexed() : g;
    if (!ng.attributes.position || !ng.attributes.normal || !ng.attributes.uv) continue;
    if (ng.attributes.color) anyColor = true;
    parts.push(ng);
    count += ng.attributes.position.count;
  }
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const col = anyColor ? new Float32Array(count * 3).fill(1) : null;
  let o3 = 0, o2 = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o3);
    nor.set(g.attributes.normal.array, o3);
    uv.set(g.attributes.uv.array, o2);
    if (col) {
      const ca = g.attributes.color;
      // itemSize 4 is legal on a BufferGeometry colour; the lattice bake writes
      // 3, but stride defensively rather than corrupting the buffer if it ever
      // gets an RGBA part.
      if (ca && ca.itemSize === 3) col.set(ca.array, o3);
      else if (ca && ca.itemSize === 4) {
        for (let i = 0; i < ca.count; i++) {
          col[o3 + i * 3] = ca.array[i * 4];
          col[o3 + i * 3 + 1] = ca.array[i * 4 + 1];
          col[o3 + i * 3 + 2] = ca.array[i * 4 + 2];
        }
      }
    }
    o3 += g.attributes.position.count * 3;
    o2 += g.attributes.position.count * 2;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

// ============ ROUND-7 FIX A — WORLD-SCALE STEELWORK =========================
// One tile of `paintGalv()` is authored at LAT_UV repeats per world unit, i.e.
// ~1.82 u across, which puts a bolt head (0.021 of the tile) at ~3.8 cm and the
// zinc spangle at ~2 cm. That is plant-steel scale. Before this, `partBox()`
// handed every face a 0..1 box UV regardless of its world size, so a
// `partBox(0.45, 15, 0.45)` pylon leg ran 569 texels/u across and 17 along —
// a 33:1 anisotropy whose mip chain resolves to the tile's own mean, 0x8A8F8C,
// which is exactly the "pale grey stick" the critique photographed at every
// range from 26 to 90 u.
const LAT_UV = 0.55;

// Per-call member counter: `bakeMemberValue` hashes it, so the ±16 % spread is
// deterministic for a given build order and does not need an RNG draw.
let _latMember = 0;

// Build one merged, world-UV'd, per-member-valued lattice geometry from a list
// of `partBox()` results. `opts.y0/.y1` are the member's own local Y band — the
// bake runs a splash-dirt-to-rain-washed-zinc gradient along it, which is the
// one gradient a 3 px member can still show because it runs along its length.
function latGeo(parts, opts) {
  const o = opts || {};
  const list = [];
  for (const p of parts) {
    if (!p) continue;
    const s = ++_latMember;
    // 25 % of members take the warm rust bias; the test is a hash of the same
    // counter, so it is stable and does not correlate with the value spread.
    const h = (Math.imul(s ^ 0x2545F491, 2246822519) >>> 0) % 1000;
    bakeMemberValue(p, {
      seed: s * 2654435761,
      y0: o.y0 === undefined ? 0 : o.y0,
      y1: o.y1 === undefined ? 15 : o.y1,
      rust: h < 250,
      dirt: o.dirt === undefined ? 0.22 : o.dirt,
    });
    list.push(p);
  }
  const g = mergeGeos(list);
  worldProjectUV(g, o.uv || LAT_UV);
  return g;
}

// ------------------------------------------------------------------ main

export function populateFeatures(scene, terrain, scenario, rngFn) {
  const R = typeof rngFn === 'function' ? rngFn : Math.random;
  // ROUND-7 FIX A — reset the member counter per build so a second
  // populateFeatures() in the same page session (scenario switch) reproduces
  // the same steelwork values as the first. Build order is deterministic, so
  // this makes the whole per-member spread deterministic too.
  _latMember = 0;
  const sc = scenario || {};
  const L = (terrain && terrain.layout) || null;
  const heightAt = (terrain && typeof terrain.heightAt === 'function')
    ? terrain.heightAt : () => 0;
  const tiles = (terrain && terrain.tiles) || new Map();

  const group = new THREE.Group();
  group.name = 'features';
  if (scene) scene.add(group);

  const rand = (a, b) => a + R() * (b - a);
  const wpos = (h) => hexToWorld(h.q, h.r);
  const WATER_Y = (L && L.waterY != null) ? L.waterY : -1.15;

  const trash = [];
  const track = (o) => { trash.push(o); return o; };

  // ------------------------------------------------------------ materials
  // ROUND-2 CRITIQUE FIX 1 — the relief bank. Each entry paints its tile once
  // and yields { map, normal, rough }; `paintedSurface` reuses the albedo canvas
  // as the height source wherever an albedo exists (see the block above).
  // Boot cost is ~120 ms of canvas work behind the loading screen, once.
  const surfWall = paintedSurface(512, paintTownWall, { strength: 2.6, gain: 2.4, rough: 0.16 });
  const surfPlinth = paintedSurface(256, paintPlinth, { strength: 3.0, gain: 2.6, rough: 0.18 });
  const surfBrick = paintedSurface(256, paintBrick, { strength: 3.2, gain: 2.8, rough: 0.18 });
  const surfConcrete = paintedSurface(256, paintConcrete, { strength: 1.9, gain: 2.0, rough: 0.12 });
  const surfSteel = paintedSurface(256, paintSteelHeight,
    { albedo: false, highpass: false, strength: 2.2, rough: 0.20 });
  const surfGrit = paintedSurface(256, paintGritHeight,
    { albedo: false, highpass: false, strength: 2.8, rough: 0.10 });
  const surfLeaf = paintedSurface(256, paintLeafHeight,
    { albedo: false, highpass: false, strength: 2.6, rough: 0.08 });
  // ROUND-3 relief bank additions. All three carry a real ALBEDO as well as the
  // relief, because the round-3 critique's two criticals were both "this object
  // has no map at all": galvanised structure, weathered yard timber, the silo
  // shell, the window pane and the round bale.
  const surfGalv = paintedSurface(256, paintGalv, { strength: 2.4, gain: 2.2, rough: 0.20 });
  const surfTimber = paintedSurface(256, paintTimber, { strength: 2.8, gain: 2.6, rough: 0.18 });
  const surfSilo = paintedSurface(512, paintSilo, { strength: 2.0, gain: 2.2, rough: 0.20 });
  const surfBale = paintedSurface(256, paintBale, { strength: 3.0, gain: 2.6, rough: 0.14 });
  for (const sfc of [surfWall, surfPlinth, surfBrick, surfConcrete, surfSteel, surfGrit, surfLeaf,
    surfGalv, surfTimber, surfSilo, surfBale]) {
    track(sfc.normal);
    track(sfc.rough);
    if (sfc.map) track(sfc.map);
  }
  const texLeafCard = track(makeCanvasTexture(256, paintLeafCard));
  texLeafCard.wrapS = texLeafCard.wrapT = THREE.ClampToEdgeWrapping;
  texLeafCard.needsUpdate = true;

  const texTownWall = surfWall.map;
  const texScorch = track(makeCanvasTexture(256, paintScorch));
  const texRoadPaved = track(makeCanvasTexture(512, paintRoadPaved));
  const texRoadDirt = track(makeCanvasTexture(512, paintRoadDirt));
  const texFarmTrack = track(makeCanvasTexture(256, paintFarmTrack));
  const texDitch = track(makeCanvasTexture(256, paintDitch));
  const texBallast = track(makeCanvasTexture(512, paintBallast));
  const texShore = track(makeCanvasTexture(512, paintShore));
  const texRiverFlow = track(makeCanvasTexture(512, paintRiverFlow));
  const texCrater = track(makeCanvasTexture(256, paintCrater));
  const texPlinth = surfPlinth.map;
  const texTrench = track(makeCanvasTexture(256, paintTrench));
  const texWindow = track(makeCanvasTexture(128, paintWindow));

  const M = {
    // ---- ROUND-3 FIX 3: structural metal --------------------------------
    // All three of these ran as flat authored colours with a grey height field
    // and no albedo at all; the two darkest (0x33352F and 0x201D1A) are the
    // materials the critique measured at 0.017 / 0.013 relative luminance and
    // called "physically impossible black". Every one of them now takes the
    // galvanised albedo and runs its value through `color`, so the map owns the
    // texture and the multiplier owns the class:
    //   steel      ≈ 0x818681   clean structural / plant steel
    //   lattice    ≈ 0x8A8F8C   galvanised tower, pylon, mast, handrail (the
    //                           critique's requested 0x8A8F8C, r 0.55, m 0.25)
    //   darkSteel  ≈ 0x6E736D   shaded ironwork, running gear, brackets
    //   charred    ≈ 0x3A362F   burnt-out plant: soot, NOT a hole in the world
    steel: new THREE.MeshStandardMaterial({
      map: surfGalv.map, color: 0xEBEDE8, roughness: 0.58, metalness: 0.32 }),
    // ROUND-7 FIX A. Two changes, both consequences of the UV fix rather than
    // taste calls:
    //   • the multiplier comes off white. At `sun.intensity` 7.6 a 0.55-luma
    //     tile at colour 1.0 made the towers among the brightest structural
    //     objects in `09-mid-tactical`; 0xE4E7E2 is a 0.894 pull and the new
    //     coarse rust/dirt band in paintGalv carries the rest.
    //   • `latticeVC` is a SEPARATE material, not a flag on this one. Setting
    //     `vertexColors` here would declare USE_COLOR on the plain `G.box` /
    //     `G.cyl8` / torus meshes that share it, whose disabled colour attribute
    //     reads back as (0,0,0) — every one of them would render pure black.
    //     Only geometry that actually carries a baked `color` gets `latticeVC`.
    lattice: new THREE.MeshStandardMaterial({
      map: surfGalv.map, color: 0xE4E7E2, roughness: 0.55, metalness: 0.25 }),
    latticeVC: new THREE.MeshStandardMaterial({
      map: surfGalv.map, color: 0xE4E7E2, roughness: 0.55, metalness: 0.25,
      vertexColors: true }),
    darkSteel: new THREE.MeshStandardMaterial({
      map: surfGalv.map, color: 0xC6CAC3, roughness: 0.62, metalness: 0.28 }),
    paint: new THREE.MeshStandardMaterial({ color: 0xADB2A8, roughness: 0.58, metalness: 0.3 }),
    charred: new THREE.MeshStandardMaterial({
      map: surfGalv.map, color: 0x6E6A62, roughness: 0.95, metalness: 0.10 }),
    // weathered yard timber — posts, palings, stakes. Replaces the tree-trunk
    // material a fence post was borrowing (0x3B3226: bark, in shade, indoors).
    timber: new THREE.MeshStandardMaterial({
      map: surfTimber.map, color: 0xFFFFFF, roughness: 0.94, metalness: 0 }),
    // slip-formed silo shell, base 0xC9C4B8 per the critique
    silo: new THREE.MeshStandardMaterial({
      map: surfSilo.map, color: 0xFFFFFF, roughness: 0.88, metalness: 0.02 }),
    townWall: new THREE.MeshStandardMaterial({ map: texTownWall, roughness: 0.9, metalness: 0 }),
    scorch: new THREE.MeshBasicMaterial({
      map: texScorch, transparent: true, opacity: 0.92,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
    }),
    // Objective colours follow the counter chips, not the HUD's phosphor green:
    // an unlit saturated quad was the most saturated pixel in several round-1
    // frames (CRITIQUE r1 fix 27). Cloth is lit, two-tone and drooped.
    flagBlue: new THREE.MeshStandardMaterial({
      color: 0x4E86C6, roughness: 0.92, metalness: 0,
      side: THREE.DoubleSide, vertexColors: true,
    }),
    flagRed: new THREE.MeshStandardMaterial({
      color: 0xC4443A, roughness: 0.92, metalness: 0,
      side: THREE.DoubleSide, vertexColors: true,
    }),
    beacon: new THREE.MeshStandardMaterial({
      color: 0x992018, emissive: 0xFF3B30, emissiveIntensity: 1.6, roughness: 0.5,
    }),
    // ROUND-3 FIX 3: an aluminium conductor against a lit sky is a bright
    // hairline, not a black one. 0x24241F was the second material the critique
    // measured as impossible-black; a lower opacity keeps it from thickening.
    wire: new THREE.LineBasicMaterial({ color: 0x5E625A, transparent: true, opacity: 0.68, fog: true }),
    // ROUND-5 FIX 15 — the transmission conductors are MESH now, not lines.
    // A LineBasicMaterial is unlit, so 0x5E625A went through the tone map as a
    // fixed value regardless of where the sun was: the critic read them as
    // "perfectly straight 1-px near-white lines" and nearly filed them as a
    // rendering seam. A conductor is weathered aluminium — it takes the light,
    // it sits DARKER than the sky it crosses, and it has a width. This is that
    // material; the catenary and the 17 cm section are in buildPowerLine.
    conductor: new THREE.MeshStandardMaterial({
      color: 0x4E534E, roughness: 0.64, metalness: 0.30 }),

    // ---- buildings (CRITIQUE r1 fix 6)
    plinth: new THREE.MeshStandardMaterial({ map: texPlinth, roughness: 0.95, metalness: 0 }),
    reveal: new THREE.MeshStandardMaterial({
      map: surfConcrete.map, color: 0xE4DCCB, roughness: 0.9, metalness: 0 }),
    // ROUND-3 FIX 2: the pane was one flat colour, which is why a window
    // resolved at close zoom as "a flat painted rectangle with a pale-blue
    // glyph". It is now a real pane — dark room, sky reflection dying toward
    // the sill, mullion cross, net curtain — and the sheen is dialled back off
    // 0.2/0.6 so a village window stops reading as a mirror tile.
    glass: new THREE.MeshStandardMaterial({
      map: texWindow, color: 0xFFFFFF, roughness: 0.30, metalness: 0.30, envMapIntensity: 0.75,
    }),
    // ROUND-2 FIX 1: both of these were flat colours with no map of any kind.
    // concreteTrim's canvas is painted AT the mean of the 0x9A948A it replaces,
    // so the material can go to white with nothing in the scene shifting value;
    // brick's canvas is a real mortar-and-stretcher course, which reads a shade
    // duller than the old flat 0x8F5844 on purpose.
    concreteTrim: new THREE.MeshStandardMaterial({
      map: surfConcrete.map, color: 0xFFFFFF, roughness: 0.86, metalness: 0.05,
    }),
    brick: new THREE.MeshStandardMaterial({
      map: surfBrick.map, color: 0xFFFFFF, roughness: 0.93, metalness: 0,
    }),
    vent: new THREE.MeshStandardMaterial({ color: 0x6E6A61, roughness: 0.7, metalness: 0.4 }),
    markRed: new THREE.MeshStandardMaterial({ color: 0xB0402E, roughness: 0.82, metalness: 0.1 }),

    // ---- vegetation: ONE canopy material, four tones carried per instance
    // roughness 0.95 → 0.88: a leaf has a waxy cuticle and a 14° key lays a
    // sheen along the lit face of a crown. At 0.95 the canopy had no specular
    // response at all, which is half of why it read as matte paper.
    canopy: new THREE.MeshStandardMaterial({
      color: 0xFFFFFF, roughness: 0.88, metalness: 0,
      flatShading: false, vertexColors: true,
    }),

    // ---- rail / shore / battle damage
    tie: new THREE.MeshStandardMaterial({ color: 0x4A3E30, roughness: 0.95, metalness: 0 }),
    rail: new THREE.MeshStandardMaterial({ color: 0x8C8C8C, roughness: 0.42, metalness: 0.72 }),
    earth: new THREE.MeshStandardMaterial({ color: 0x4A3B2A, roughness: 0.97, metalness: 0 }),
    sandbag: new THREE.MeshStandardMaterial({ color: 0x8A7355, roughness: 0.97, metalness: 0 }),
    // ROUND-4 FIX 12 — borrow-pit spoil. Pale chalk-and-clay, deliberately the
    // highest-value ground material on the map after concrete: the whole point
    // of a quarry as a terrain type is that it is a bright, hard-edged hole in
    // an ochre-and-green landscape, and it is worth its one draw call precisely
    // because nothing else in the frame reads like it.
    // `vertexColors: true` is load-bearing, not decoration: three.js gates
    // InstancedMesh `instanceColor` behind USE_COLOR, so without it every heap
    // and boulder would render at one identical value. G.hedge already carries
    // a per-vertex gradient, which on stone reads as top-lit weathering.
    spoil: new THREE.MeshStandardMaterial({
      color: 0xB4AC9C, roughness: 0.96, metalness: 0, vertexColors: true }),
    crater: new THREE.MeshBasicMaterial({
      map: texCrater, transparent: true, opacity: 0.95, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, fog: true,
    }),
    trench: new THREE.MeshBasicMaterial({
      map: texTrench, transparent: true, opacity: 0.96, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -7, fog: true,
    }),
    // ROUND-3 FIX 3, same reasoning: 0x2E2B26 was the third impossible-black.
    // Rusted barbed wire is a warm mid grey-brown at this distance.
    barbed: new THREE.LineBasicMaterial({ color: 0x6E6759, transparent: true, opacity: 0.62, fog: true }),
  };
  for (const k in M) track(M[k]);

  // ROUND-2 CRITIQUE FIX 1 — the BINDING half. The relief bank above paints
  // the maps; these calls are what actually put a normalMap + roughnessMap on
  // every named material (the four the critique listed by name first). The
  // normalScale values are authored per material class: masonry relief is real
  // and deep, precast concrete is shallow, steel is shallower still, and the
  // canopy's leaf clusters are bound at repeat 2.5 so a blade is ~15 cm on a
  // 2.5 u canopy blob rather than one giant leaf per tree.
  // assets.js's shared materials (Mat.urbanWall, Mat.roofRust, …) are owned by
  // another module and are deliberately NOT touched here.
  bindRelief(M.townWall, surfWall, 0.85);
  bindRelief(M.plinth, surfPlinth, 0.95);
  bindRelief(M.brick, surfBrick, 0.80);
  bindRelief(M.concreteTrim, surfConcrete, 0.60);
  bindRelief(M.reveal, surfConcrete, 0.45);
  // The structural metals now take the GALVANISED relief, which is registered
  // with the albedo they carry (spangle, bolt heads, rust runs) rather than the
  // generic plate height field — a bolt head that is not where the shading says
  // it is reads worse than no bolt head. surfSteel still drives M.paint, whose
  // albedo stays an authored flat colour.
  bindRelief(M.steel, surfGalv, 0.60);
  bindRelief(M.lattice, surfGalv, 0.62);
  // Bound from the same authored 0.55 roughness, NOT cloned from M.lattice after
  // its bind: bindRelief divides the scalar by ROUGH_MEAN, so a clone-then-bind
  // would divide twice and ship the steelwork at roughness 0.68.
  bindRelief(M.latticeVC, surfGalv, 0.62);
  bindRelief(M.darkSteel, surfGalv, 0.55);
  bindRelief(M.charred, surfGalv, 0.75);
  bindRelief(M.timber, surfTimber, 0.95);
  bindRelief(M.silo, surfSilo, 0.55);
  bindRelief(M.paint, surfSteel, 0.45);
  bindRelief(M.earth, surfGrit, 0.90);
  bindRelief(M.sandbag, surfGrit, 0.80);
  bindRelief(M.spoil, surfGrit, 1.05);
  // 0.90 → 1.35: the leaf tile now carries a CLUMP scale as well as a blade
  // scale (see paintLeafHeight), and 0.90 was tuned against the blade-only tile
  // where a stronger scale only bought aliasing.
  bindRelief(M.canopy, surfLeaf, 1.35, 2.5);
  // the repeat-2.5 bind clones its textures — track the clones for dispose()
  track(M.canopy.normalMap);
  track(M.canopy.roughnessMap);

  // ===================== ROUND-4 FIX 4(d) — CANOPY SKY TRANSMISSION =========
  // The measured cause of "flat black paper cut-outs", in order of size:
  //   1. the authored tone. 0x2F4224 is a 4.7 % LINEAR albedo — darker than
  //      fresh asphalt — and the vertex dapple took its underside to 2.5 %.
  //      Fixed above (dapple floor) and below (CANOPY_TONES).
  //   2. a canopy is not an opaque solid. A leaf transmits 5–15 % of what hits
  //      it and a crown scatters that light through itself many times, so real
  //      foliage NEVER goes to the value a Lambert solid of the same albedo
  //      would. Nothing in the round-3 build modelled that, so a canopy lit by
  //      fill alone landed at a linear radiance of ~0.002 — display luma ≈0.03
  //      after the grade, i.e. the floor. That is the black.
  //
  // This adds the missing term, and it is deliberately NOT bought by raising
  // the scene fill (which is the engine's fix 1 and would lift the whole world):
  // the canopy re-emits a fixed fraction of its own albedo as sky-scattered
  // light, weighted by how much sky the surface can see. Because it is added to
  // `totalEmissiveRadiance` it survives the shadow map — which is correct, a
  // crown in the shade of the crown next to it is still under an open sky — and
  // because it is multiplied by `diffuseColor` it carries the per-instance tone
  // and the per-vertex dapple instead of washing them into one grey.
  //
  // SIZING (all figures are scene-linear radiance, solved back through ACES at
  // exposure 1.50 + the grade from the critique's own measured pixels):
  //   shaded ground measures display 0.046  →  L ≈ 0.0183
  //   the critique's floor, display 0.10    →  L ≈ 0.0243
  //   canopy at the new albedo, fill only   →  L ≈ 0.0045
  //   needed addition                       →  ≈ 0.019
  //   0.115 (new albedo luma) × 0.22 × 0.72 (mean sky weight) = 0.0182  ✓
  // so uLeafSky is authored at luminance 0.22, in the hemisphere's own blue, and
  // a fill-only canopy should land at display 0.09–0.11 on THIS build and
  // 0.12–0.15 once the engine's fill rebuild lands. Sunlit crowns gain the same
  // absolute 0.018 on a direct term of ~0.13, i.e. +14 %: no blow-out, and the
  // key-to-fill read across a crown stays intact.
  const canopySky = new THREE.Color(0.185, 0.225, 0.255);
  function applyLeafSky(mat, cacheKey) {
    mat.customProgramCacheKey = () => cacheKey;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uLeafSky = { value: canopySky };
      if (shader.fragmentShader.indexOf('#include <lights_fragment_end>') < 0) return;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uLeafSky;')
        .replace('#include <lights_fragment_end>', [
          '#include <lights_fragment_end>',
          '{',
          // dot( viewMatrix[i].xyz, n ) reads the i-th WORLD component of a
          // view-space normal — the same identity terrain.js uses for its
          // world-space ground relief. Component 1 is world up.
          '  float ssSky = 0.5 + 0.5 * dot( viewMatrix[ 1 ].xyz, geometryNormal );',
          '  totalEmissiveRadiance += diffuseColor.rgb * uLeafSky * ( 0.42 + 0.58 * ssSky );',
          '}',
        ].join('\n'));
    };
    return mat;
  }
  applyLeafSky(M.canopy, 'ss-canopy-sky-v1');

  const G = {
    box: new THREE.BoxGeometry(1, 1, 1),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 12),
    cyl8: new THREE.CylinderGeometry(1, 1, 1, 8),
    // 7 sides made a visible heptagon on the rail-yard water-tower cap at the
    // close zoom the build now supports; 12 costs 10 triangles and removes it.
    cone: new THREE.ConeGeometry(1, 1, 12),
    gable: gableGeometry(),
    // ROUND-3 FIX 2 — split prism: roof planes and masonry gable are separate
    // meshes so they can take separate (correct) materials.
    gableRoof: gableGeometry('roof'),
    gableEnd: gableGeometry('ends'),
    plane: new THREE.PlaneGeometry(1, 1),
    // trunk: half the old radius (CRITIQUE r1 fix 7), tapered, and long enough
    // to run up INTO the canopy instead of stopping under it
    trunk: new THREE.CylinderGeometry(0.6, 1.0, 1, 6),
  };

  // ROUND-3 FIX 7 — the canopy stops being one ellipsoid.
  //
  // The critique's verdict was "faceted broccoli at anything closer than RTS
  // range": an IcosahedronGeometry(1, 1) blob is a CONVEX solid of revolution,
  // and no normal map can put a concavity into a silhouette that has none. Both
  // failure modes it named come from that single fact — the outline is a visible
  // 42-vertex polygon, and the smooth crown-to-underside vertex ramp bands
  // across triangles that are 20 px each at vehicle zoom.
  //
  // A canopy is now a CLUMP CLUSTER: one subdivision-1 core plus three
  // subdivision-0 satellites merged into a single shared geometry, each lump
  // displaced on its own noise phase. That buys a genuinely non-convex outline
  // with real notches between the lumps, and — because each lump carries its own
  // vertex-colour dapple centred on its own axis — kills the global ramp that
  // was banding. 140 faces against the old 80; three per tree, and the far-field
  // treelines were moved off this geometry onto the 20-face hedge lump to pay
  // for it (see the horizon block).
  //
  // Deterministic: one seeded builder, one geometry, shared by every instance.
  // The per-instance yaw and the new per-instance tilt hide the repeat.
  function clumpCanopy(lumps) {
    const pos = [], nor = [], uvs = [], cols = [];
    const v = new THREE.Vector3();
    for (const L2 of lumps) {
      // IcosahedronGeometry is already non-indexed in r170; calling
      // toNonIndexed() on it logs a console warning once per lump (eight per
      // boot). Guard it the same way the other two call sites do.
      const ico = new THREE.IcosahedronGeometry(1, L2.detail);
      const src = ico.index ? ico.toNonIndexed() : ico;
      const sp = src.attributes.position;
      for (let i = 0; i < sp.count; i++) {
        v.fromBufferAttribute(sp, i);
        // per-lump noise phase: no two lumps deform the same way.
        // ROUND-4 FIX 4: the amplitudes are up roughly 60 % and a fourth, higher
        // octave is added. Round 3's ±0.39 left every lump a recognisable
        // sphere, and a union of spheres reads as a polygon the moment the
        // object is dark — which the whole round it was. ±0.62 with a 9.4-period
        // term puts real bays in the outline at the SILHOUETTE scale, which is
        // the only scale a black object has.
        const k = 1
          + 0.24 * Math.sin(v.x * 3.1 + v.y * 2.3 + L2.ph)
          + 0.19 * Math.sin(v.z * 4.2 - v.y * 1.7 + L2.ph * 1.7)
          + 0.13 * Math.sin(v.x * 6.7 - v.z * 5.3 + L2.ph * 2.3)
          + 0.06 * Math.sin(v.z * 9.4 + v.x * 8.1 - L2.ph * 3.1)
          - 0.08 * Math.max(0, -v.y);
        v.multiplyScalar(k * L2.r);
        // the lump's own outward normal, taken BEFORE it is translated, so each
        // lump stays smooth-shaded about its own centre and the seams between
        // lumps read as real creases instead of as one blended sphere
        const len = Math.max(1e-4, v.length());
        const nx = v.x / len, ny = v.y / len, nz = v.z / len;
        // ---- dapple ------------------------------------------------------
        // ROUND-4 FIX 4(c). The floor was 0.54 and the tone it multiplies had a
        // linear luminance of 0.047, so the underside of a canopy carried a
        // 2.5 % linear albedo — darker than fresh asphalt, and with the fog gone
        // that is precisely the black paper cut-out the critique measured. The
        // floor is now 0.70 (the shaded side of a crown is lit by the sky, not
        // by nothing) and the ramp is shortened to match, so the range is
        // 0.70–1.16 instead of 0.54–1.16 — LESS value swing carried by the
        // vertex colour, more carried by the light, which is the right split.
        // The two extra sine terms are the clump-scale mottle the flat 0.07 term
        // could not produce; they are what stops a lump reading as one wash.
        const up = 0.5 + 0.5 * ny;
        const d = (0.70 + 0.46 * up
          + 0.085 * Math.sin(v.x * 7.3 + v.z * 6.1 + L2.ph)
          + 0.055 * Math.sin(v.y * 5.1 - v.x * 4.4 + L2.ph * 2.2)) * L2.tint;
        pos.push(v.x + L2.x, v.y + L2.y, v.z + L2.z);
        nor.push(nx, ny, nz);
        // ---- UVs ---------------------------------------------------------
        // IcosahedronGeometry's own equirectangular UVs have a wrap seam and two
        // poles, so the leaf-cluster relief smeared into streaks at the top and
        // bottom of every crown and mirrored across the seam — a defect that is
        // invisible while the object is black and obvious the moment it is not.
        // An oblique LINEAR projection of the lump-local position has neither:
        // it is affine across every triangle (which is also what getTangentFrame
        // needs), it tiles continuously, and because it is taken in local space
        // the leaf size scales with the tree instead of being one size for a
        // 1.2 u scrub and a 3.4 u poplar crown.
        uvs.push(
          (v.x * 0.7071 + v.z * 0.7071) * 0.5 + 0.5,
          (v.y * 0.8000 - (v.x - v.z) * 0.2475) * 0.5 + 0.5);
        cols.push(d, d * 1.02, d * 0.94);
      }
      src.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.computeBoundingSphere();
    return geo;
  }
  G.blob = clumpCanopy([
    { detail: 1, r: 0.80, x: 0.00, y: 0.04, z: 0.00, ph: 0.0, tint: 1.00 },
    { detail: 0, r: 0.50, x: 0.46, y: 0.30, z: -0.22, ph: 1.9, tint: 1.07 },
    { detail: 0, r: 0.46, x: -0.42, y: 0.16, z: 0.36, ph: 3.4, tint: 0.93 },
    { detail: 0, r: 0.44, x: 0.08, y: -0.30, z: 0.44, ph: 5.1, tint: 0.86 },
  ]);
  // PHASE 2 — hedgerow bush. A hedge is read from 180 units as a dark broken
  // line, never as individual plants, so it gets the CHEAP polyhedron (20 faces
  // against the tree canopy's 80): ~640 of them cost 12.8 k triangles in one
  // instanced draw, and the thing that actually sells them is the long shadow
  // the 14° sun throws off the line, not their silhouette.
  G.hedge = (() => {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const n = pos.count;
    const col = new Float32Array(n * 3);
    const uvA = new Float32Array(n * 2);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      const k = 1 + 0.20 * Math.sin(v.x * 4.7 + v.z * 3.1) - 0.10 * Math.max(0, -v.y);
      v.multiplyScalar(k);
      pos.setXYZ(i, v.x, v.y, v.z);
      const len = Math.max(1e-4, v.length());
      nor.setXYZ(i, v.x / len, v.y / len, v.z / len);
      // ROUND-4 FIX 4(c), same correction as the tree canopy: a 0.48 floor over
      // a 0.047-luminance tone is a black hole with a hedge-shaped outline.
      const d = 0.70 + 0.44 * (0.5 + 0.5 * (v.y / len));
      col[i * 3] = d; col[i * 3 + 1] = d * 1.03; col[i * 3 + 2] = d * 0.90;
      // the same oblique local projection the canopy uses, so the shared leaf
      // relief lands on a hedge without the icosahedron's pole smear
      uvA[i * 2] = (v.x * 0.7071 + v.z * 0.7071) * 0.5 + 0.5;
      uvA[i * 2 + 1] = (v.y * 0.8 - (v.x - v.z) * 0.2475) * 0.5 + 0.5;
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvA, 2));
    geo.computeBoundingSphere();
    return geo;
  })();
  // ============ ROUND-4 FIX 4(e) — THE LEAF CARD WAS NEVER TINTED ==========
  // Found while zooming the critique's own `04` at 1:1. Round 2 added leaf
  // cards, wrote "the card texture is near-white so the per-instance canopy
  // tone drives the colour, exactly as it does on the blobs", and called
  // `setColorAt` on them. It never did anything: three.js gates `instanceColor`
  // behind `USE_COLOR`, and `USE_COLOR` is `material.vertexColors`, which the
  // card material did not set (see `color_fragment` — `diffuseColor.rgb *=
  // vColor` is inside `#elif defined( USE_COLOR )`). So every leaf card on the
  // map has been rendering at the raw near-white texture, and the only reason
  // nobody saw a white blotch on every tree is the SECOND half of the bug: the
  // cards were positioned within ±0.45 of a blob radius and reach ~0.9 radii,
  // i.e. entirely buried inside the blob they were supposed to be fringing.
  // Two invisible bugs cancelling is not two triangles well spent.
  //
  // Fix 4(a) pushes them out onto the silhouette, which makes the colour bug
  // load-bearing — so the card gets its own geometry carrying a constant white
  // vertex colour, and the material turns `vertexColors` on. The attribute has
  // to exist: with `vertexColors: true` and no `color` attribute, WebGL feeds
  // the shader a default of (0,0,0) and every card renders pure black, which
  // is the one outcome worse than white.
  G.card = (() => {
    const geo = new THREE.PlaneGeometry(1, 1);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  })();
  // flat ring — handrails, tank rims, dish mounts
  G.ring = new THREE.TorusGeometry(1, 0.028, 5, 22);
  G.ring.rotateX(Math.PI / 2);
  G.cloth = clothGeometry();
  G.decal = new THREE.PlaneGeometry(1, 1);
  G.decal.rotateX(-Math.PI / 2);
  // ROUND-3 FIX 10: 10 radial segments faceted visibly on a 1.5 m drum at the
  // zoom this build supports. 16 costs 24 triangles per bale and rounds it.
  G.bale = new THREE.CylinderGeometry(1, 1, 1, 16);
  G.bale.rotateZ(Math.PI / 2);
  // window reveal: a plaster frame with a sill, hollow in the middle so the
  // recessed glass shows through it
  G.reveal = (() => {
    const T = 0.14, D = 0.16;
    const parts = [
      partBox(1.28, T, D, 0, 0.5 + T * 0.5, 0),          // lintel
      partBox(1.28, T * 1.5, D * 1.7, 0, -0.5 - T * 0.75, 0.03),  // sill (proud)
      partBox(T, 1.0 + T * 2, D, -0.5 - T * 0.5, 0, 0),  // jambs
      partBox(T, 1.0 + T * 2, D, 0.5 + T * 0.5, 0, 0),
    ];
    return mergeGeos(parts);
  })();

  // ---- ROUND-7 FIX A: the world-sized steel primitives ---------------------
  // Everything above this line is a UNIT primitive that `mk()` scales on the
  // MESH, which is why its 0..1 face UVs are independent of world size by
  // construction and why no amount of repainting `paintGalv` could ever have
  // fixed the pale-grey sticks. These five are built at their real size, UV'd in
  // world space once, and placed at scale 1.
  const worldGeo = (src, scale) => {
    const out = worldProjectUV(src, scale === undefined ? LAT_UV : scale);
    if (out !== src) src.dispose();
    return out;
  };
  G.latArm = worldGeo(new THREE.BoxGeometry(0.16, 0.16, 1.62));   // dish stand-off
  G.latAnt = worldGeo(new THREE.BoxGeometry(0.22, 5.2, 0.22));    // mast aerial
  G.latPole = worldGeo(new THREE.CylinderGeometry(0.11, 0.11, 7.2, 8));
  G.latRingTank = worldGeo((() => {
    const t = new THREE.TorusGeometry(3.9, 0.109, 5, 26);
    t.rotateX(Math.PI / 2);
    return t;
  })());
  G.latRingDish = worldGeo((() => {
    const t = new THREE.TorusGeometry(1.36, 0.038, 5, 20);
    t.rotateX(Math.PI / 2);
    return t;
  })());
  for (const k in G) track(G[k]);

  // One-off world-sized steel box. Same defect class as the lattice: `mk(G.box,
  // M.steel, …)` scales a shared unit cube, so a 26 u conveyor gantry and a
  // 0.24 u vent stack sampled the same tile at a 100:1 density ratio.
  function steelBox(w, h, d, x, y, z, mat, ry) {
    const g = track(worldGeo(new THREE.BoxGeometry(w, h, d)));
    const m = new THREE.Mesh(g, mat || M.steel);
    m.position.set(x, y, z);
    if (ry) m.rotation.y = ry;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // A lattice assembly: merged, world-UV'd, per-member value baked, on the
  // vertex-colour clone. `keep` is the caller's own tracker (`track` or
  // `keepGeo`) so disposal ownership does not move.
  function latMesh(parts, opts, keep) {
    const g = latGeo(parts, opts);
    (keep || track)(g);
    const m = new THREE.Mesh(g, M.latticeVC);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // mesh factory — geometries are unit-sized and shared
  function mk(geo, mat, x, y, z, sx, sy, sz, ry) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz);
    if (ry) m.rotation.y = ry;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
  // Orientation that lays a flat quad ON the ground rather than through it: a
  // 10-unit decal on a 6° slope otherwise buries one edge and floats the other.
  const _qUp = new THREE.Vector3(0, 1, 0);
  const _qN = new THREE.Vector3();
  const _qYaw = new THREE.Quaternion();
  const _qEu = new THREE.Euler();
  function groundQuat(out, x, z, ry, e) {
    const ee = e || 2.5;
    const dx = (heightAt(x + ee, z) - heightAt(x - ee, z)) / (2 * ee);
    const dz = (heightAt(x, z + ee) - heightAt(x, z - ee)) / (2 * ee);
    _qN.set(-dx, 1, -dz).normalize();
    out.setFromUnitVectors(_qUp, _qN);
    _qEu.set(0, ry || 0, 0);
    _qYaw.setFromEuler(_qEu);
    return out.multiply(_qYaw);
  }

  // ground-hugging burn/scorch decal
  function decal(x, z, size, y) {
    const m = new THREE.Mesh(G.decal, M.scorch);
    m.position.set(x, (y === undefined ? heightAt(x, z) : y) + 0.07, z);
    m.scale.set(size, 1, size);
    m.rotation.y = R() * 6.28;
    m.renderOrder = 3;
    return m;
  }

  // ------------------------------------------------------------- shoreline
  // True lateral half-width from the centreline out to where the carved bank
  // crosses the water plane. terrain.js computes it from the actual carve; the
  // fallback keeps this module standalone if an older layout turns up.
  const shoreAt = (L && L.river && typeof L.river.shoreHalfWidth === 'function')
    ? (z) => L.river.shoreHalfWidth(z)
    : (z) => ((L && L.river && typeof L.river.halfWidth === 'function')
      ? L.river.halfWidth(z) * 1.06 + 0.5 : 9);

  // ------------------------------------------------------ bridge decks
  const decks = [];
  if (L && L.bridges) {
    for (const b of L.bridges) {
      const p = wpos(b.anchor);
      let dxdz = 0;
      if (L.river && typeof L.river.centerX === 'function') {
        dxdz = (L.river.centerX(p.z + 5) - L.river.centerX(p.z - 5)) / 10;
      }
      const fl = Math.hypot(dxdz, 1);
      const axis = { x: 1 / fl, z: -dxdz / fl };            // perpendicular to the flow
      const halfW = (L.river && typeof L.river.halfWidth === 'function')
        ? L.river.halfWidth(p.z) : 9;
      const shore = shoreAt(p.z);
      const halfLen = Math.max(shore + 9.5, halfW * 1.5 + 8);
      const yA = heightAt(p.x + axis.x * halfLen, p.z + axis.z * halfLen);
      const yB = heightAt(p.x - axis.x * halfLen, p.z - axis.z * halfLen);
      const deckY = Math.max(yA, yB, WATER_Y + 1.5) + 0.45;
      // Where does the carved bank actually rise to meet the underside of the
      // deck? That is where the abutment goes — round 1 left a wedge of
      // daylight between the water and the deck with nothing holding it up
      // (CRITIQUE r1 fix 5). March out along the axis on each side and take the
      // first sample that reaches the soffit.
      const soffit = deckY - 0.95;
      const abut = [];
      for (const sgn of [1, -1]) {
        let dist = shore;
        for (let t = shore; t <= halfLen + 4; t += 0.5) {
          dist = t;
          if (heightAt(p.x + axis.x * sgn * t, p.z + axis.z * sgn * t) >= soffit) break;
        }
        // the deck always runs at least 1.5 units past the abutment
        const at = Math.min(dist, halfLen - 1.6);
        abut.push({
          sgn,
          dist: at,
          y: heightAt(p.x + axis.x * sgn * at, p.z + axis.z * sgn * at),
        });
      }
      decks.push({
        def: b, x: p.x, z: p.z, axis, halfLen, halfW, shore, abut,
        y: deckY,
      });
    }
  }
  function deckAdjust(x, z, y) {
    let out = y;
    for (const d of decks) {
      const dd = Math.hypot(x - d.x, z - d.z);
      const inner = d.halfLen * 0.72;
      const reach = d.halfLen + 12;
      if (dd > reach) continue;
      const k = 1 - smooth01((dd - inner) / (reach - inner));
      out = out * (1 - k) + d.y * k;
    }
    return out;
  }
  const deckFor = (hex) => decks.find((d) =>
    d.def.anchor.q === hex.q && d.def.anchor.r === hex.r) || decks[0] || null;

  // --------------------------------------------------------- ribbon mesh
  // Surface strip that follows a hex path and hugs the terrain, with alpha-faded
  // shoulders so roads blend into the field instead of ending in a hard edge.
  const ROAD_COLS = [[-1, 0], [-0.70, 1], [0.70, 1], [1, 0]];
  const FLAT_COLS = [[-1, 1], [0, 1], [1, 1]];
  // PHASE 2 — a farm lane and a field drain are worn INTO the crop, so they
  // never reach full opacity and their flanks fade over a wider band than a
  // graded road's do.
  const TRACK_COLS = [[-1, 0], [-0.56, 0.86], [0.56, 0.86], [1, 0]];
  const DITCH_COLS = [[-1, 0], [-0.50, 0.94], [0.50, 0.94], [1, 0]];

  function ribbonGeometry(points, opts) {
    if (!points || points.length < 2) return null;
    const o = opts || {};
    const cols = o.cols || ROAD_COLS;
    const step = o.step || 3.0;
    const lift = o.lift || 0;
    const vScale = o.vScale || 1 / 9;
    const uScale = o.uScale || 1;
    const lateral = o.lateral || 0;
    const halfFn = o.halfFn || (() => (o.width || 7) * 0.5);

    const pts = points.map((p) => new THREE.Vector3(p.x, 0, p.z));
    let curve;
    try {
      curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    } catch (err) { return null; }
    const len = curve.getLength();
    if (!(len > 1)) return null;
    const n = Math.max(2, Math.min(1400, Math.ceil(len / step)));
    const samples = curve.getSpacedPoints(n);

    const C = cols.length;
    const vcount = (n + 1) * C;
    const pos = new Float32Array(vcount * 3);
    const uv = new Float32Array(vcount * 2);
    const col = new Float32Array(vcount * 4);
    let dist = 0;
    const tan = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
      const p = samples[i];
      const a = samples[Math.max(0, i - 1)];
      const b = samples[Math.min(n, i + 1)];
      tan.set(b.x - a.x, 0, b.z - a.z);
      if (tan.lengthSq() < 1e-8) tan.set(0, 0, 1);
      tan.normalize();
      const nx = -tan.z, nz = tan.x;
      if (i > 0) dist += Math.hypot(p.x - samples[i - 1].x, p.z - samples[i - 1].z);
      const hw = halfFn(p.z, p.x);
      for (let c = 0; c < C; c++) {
        // `offFn` lets a strip sit OFF the centreline with a z-varying inner
        // edge — that is how the two riverbank strips follow the shoreline. It
        // is handed `nx` as well so a caller can tell WHICH BANK a column lands
        // on (world displacement is nx·off) and ask the terrain for that bank's
        // own measured shoreline; the two banks of the Vovcha differ by up to
        // 4.8 units and fitting both to one of them is what put water over dry
        // ground on one side and left a dry channel on the other.
        const off = o.offFn ? o.offFn(cols[c][0], p.z, p.x, nx) : cols[c][0] * hw + lateral;
        const x = p.x + nx * off;
        const z = p.z + nz * off;
        const vi = i * C + c;
        const baseY = o.yFn
          ? o.yFn(x, z)
          : ((o.flatY !== undefined && o.flatY !== null)
            ? o.flatY
            : (o.useDeck === false ? heightAt(x, z) : deckAdjust(x, z, heightAt(x, z))));
        pos[vi * 3] = x;
        pos[vi * 3 + 1] = baseY + lift;
        pos[vi * 3 + 2] = z;
        uv[vi * 2] = (o.uMap ? o.uMap(cols[c][0]) : (cols[c][0] + 1) * 0.5) * uScale;
        uv[vi * 2 + 1] = dist * vScale;
        const tint = o.tint ? o.tint(cols[c][0]) : null;
        col[vi * 4] = tint ? tint[0] : 1;
        col[vi * 4 + 1] = tint ? tint[1] : 1;
        col[vi * 4 + 2] = tint ? tint[2] : 1;
        col[vi * 4 + 3] = cols[c][1];
      }
    }
    const idx = [];
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < C - 1; c++) {
        const a = i * C + c, b = a + 1, d = (i + 1) * C + c, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    geo.setIndex(idx.length > 65535
      ? new THREE.BufferAttribute(new Uint32Array(idx), 1)
      : new THREE.BufferAttribute(new Uint16Array(idx), 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  function surfaceMaterial(map, opts) {
    const o = opts || {};
    const m = new THREE.MeshStandardMaterial({
      map, color: o.color === undefined ? 0xffffff : o.color,
      roughness: o.roughness === undefined ? 0.94 : o.roughness,
      metalness: o.metalness === undefined ? 0 : o.metalness,
      transparent: true, depthWrite: false, vertexColors: true,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    return track(m);
  }

  function addRibbon(points, mat, opts) {
    const geo = ribbonGeometry(points, opts);
    if (!geo) return null;
    track(geo);
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    m.castShadow = false;
    m.renderOrder = (opts && opts.renderOrder) || 1;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);
    return m;
  }

  // PHASE 2. There are ~14 farm lanes and ~10 field drains; one mesh each
  // would be 24 draw calls for a decorative layer on a frame that is already
  // fill-rate bound. `mergeGeos` above cannot be reused — it drops the 4-
  // component vertex colour the ribbon's alpha shoulder lives in — so this is
  // the ribbon-shaped merge: same attributes, indices rebased, one draw call.
  function mergeRibbonGeos(list) {
    const use = [];
    for (const g of list) if (g && g.index) use.push(g);
    if (!use.length) return null;
    if (use.length === 1) return use[0];
    let vc = 0, ic = 0;
    for (const g of use) { vc += g.attributes.position.count; ic += g.index.count; }
    const pos = new Float32Array(vc * 3);
    const nor = new Float32Array(vc * 3);
    const uv = new Float32Array(vc * 2);
    const col = new Float32Array(vc * 4);
    const idx = new Uint32Array(ic);
    let vo = 0, io = 0;
    for (const g of use) {
      const n = g.attributes.position.count;
      pos.set(g.attributes.position.array, vo * 3);
      nor.set(g.attributes.normal.array, vo * 3);
      uv.set(g.attributes.uv.array, vo * 2);
      col.set(g.attributes.color.array, vo * 4);
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
      io += src.length;
      vo += n;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('color', new THREE.BufferAttribute(col, 4));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  }

  function addMergedRibbons(paths, mat, opts) {
    const geos = [];
    for (const pts of paths) {
      const g = ribbonGeometry(pts, opts);
      if (g) geos.push(g);
    }
    const merged = mergeRibbonGeos(geos);
    if (!merged) return null;
    track(merged);
    const m = new THREE.Mesh(merged, mat);
    m.receiveShadow = true;
    m.castShadow = false;
    m.renderOrder = (opts && opts.renderOrder) || 1;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);
    return m;
  }

  // ------------------------------------------------------------- river
  let water = null;
  if (L && L.river) {
    const b = L.bounds || { minZ: 0, maxZ: 260 };
    const pts = [];
    for (let z = b.minZ - 340; z <= b.maxZ + 340; z += 9) {
      pts.push({ x: L.river.centerX(z), z });
    }
    // CRITIQUE r1 fix 4 — round 1 shipped a MIRROR, not a river. At
    // envMapIntensity 2.6 the surface was reflecting the sky dome at nearly
    // three times its radiance, so the same water rendered navy from one angle,
    // white-blotched from another and leopard-spotted from a third. The albedo
    // map is replaced too: Tex.water is a DARK tile, and multiplying a dark map
    // by the bible's dark water colour lands on black — the flow map is now
    // near-white so the material colour is the only thing setting the hue.
    const waterMat = Mat.water ? Mat.water.clone() : new THREE.MeshStandardMaterial({});
    waterMat.map = texRiverFlow;
    if (waterMat.normalMap) { waterMat.normalMap = waterMat.normalMap.clone(); waterMat.normalMap.needsUpdate = true; }
    // ============ ROUND-5 FIX 7(a) — WATER IS NOT PAINT =====================
    // "No reflection model, no surface normal animation, no shoreline
    //  transition, no foam, no depth gradient... Ours is a colour swatch."
    //
    // ROUGHNESS — the biggest single thing wrong here, and it is a stacking bug
    // rather than a taste call. assets.js paints `Tex.waterRough` at a mean of
    // 0.17 with a glint mask running down to 0.07, and `bindSurface` then SOLVES
    // the material scalar against that map's MEASURED mean so the effective
    // roughness across the sheet lands at roughly 0.043–0.182 — broken, varied,
    // and exactly the surface ART_DIRECTION §3 rule 6 asks for. Round 4 then
    // assigned `roughness = 0.26` on top. three.js MULTIPLIES the scalar by the
    // map, it does not replace it, so the river actually ran at an effective
    // **0.010–0.044**. At that roughness the PMREM samples its sharpest mip —
    // one flat sky colour with no structure in it — and the sun's specular lobe
    // subtends about two degrees, a sub-pixel dot that never lands in frame.
    // "No reflection model" was the correct read of a material that was too
    // specular to show one. So: do not touch the scalar. The only case that
    // needs a number is the fallback where the shared material is missing, and
    // that number is the map's own authored mean.
    if (!waterMat.roughnessMap) waterMat.roughness = 0.14;
    // envMapIntensity 0.55 → 1.05. The round-4 note is still on the file: at
    // 0.55 x ENV_INTENSITY 0.52 the river was returning 29 % of the sky it is
    // pointed at. A river returns the sky. With the roughness unstacked there is
    // now a real, structured reflection for it to return. The Fresnel-weighted
    // sky term below is separate and additive; this is the environment side.
    // metalness stays 0 — water IS a dielectric, and the critique's "metalness
    // 0" was an observation, not the defect. The defect was that nothing else
    // supplied a reflection.
    waterMat.metalness = 0.0;
    // ===== ROUND-7 FIX B — RE-METER THE ENVIRONMENT =========================
    // INTEGRATION_NOTES §0 of the round-6 engine pass: `scene.environmentIntensity`
    // was cut 0.52 → 0.115 and the integrator re-raised it to the shipped
    // **0.160**. three scales indirect diffuse and indirect specular with that
    // one number, so there was no way to cut the diffuse and keep the mirror.
    // The 1.05 above was solved on THIS line against ENV 0.52 — the comment
    // three lines up says so — for an effective weight of 1.05 × 0.52 = 0.546.
    // Two independent derivations of what "stand still" costs now:
    //     ours   1.05 × 0.52  / 0.160 = 3.41
    //     engine 4.50 × 0.115 / 0.160 = 3.23   (their figure, re-based off 0.115)
    // 3.30 sits between them at an effective 3.30 × 0.160 = 0.528. Both the
    // critique and engine.js:169 record this material as "already 39 % off",
    // which is the 0.160/0.115 ratio and assumes the solve was made at 0.115;
    // it was not, and the real shortfall was 3.25x. Stated so the next round
    // re-derives from the code and not from the note.
    waterMat.envMapIntensity = 3.30;
    waterMat.side = THREE.DoubleSide;
    waterMat.normalScale = new THREE.Vector2(0.30, 0.30);   // source normal is 256 px
    // "A flat pale mint plane." Mint is what a light, desaturated blue-green
    // becomes under ACES plus a grade whose toe now sits at uFloor 0.105 — the
    // lift is applied hardest exactly where this surface lives. The answer is
    // not more value, it is more CHROMA and a real depth range: the deep water
    // goes down and cool, the shallows and the new foam carry the top. Linear
    // luma 0.0968 → 0.0652, chroma ratio (max/min channel) 2.39 → 2.79.
    waterMat.color = new THREE.Color(0x2E4E4A);
    waterMat.emissive = new THREE.Color(0x000000);

    // ============ ROUND-4 FIX 6 — WATER IN SHADE IS STILL WATER =============
    // Measured at the village camera: the river read rgb(6,7,11) = luma 0.028,
    // and disabling the shadow map took the same pixel to 0.141 — a 5.1× penalty
    // for being in shade on the single most reflective surface in the scene. The
    // cause is structural, not a tuning slip:
    //   • the Vovcha runs 7.75 units below the steppe datum in an incised
    //     channel, and the sun is at 14–25°, so the WHOLE river is in the bank's
    //     shadow for most of the board;
    //   • everything the material had was shadowed. Its diffuse is shadowed by
    //     definition; its only sky term is the PMREM, and that arrives at
    //     `envMapIntensity` 0.55 × `scene.environmentIntensity` 0.42 = **0.231
    //     effective**, on a dielectric whose F0 is 0.04. A river was reflecting
    //     less than a quarter of the sky it is pointed at.
    //     (INTEGRATION r4: `ENV_INTENSITY` is 0.52 now, not 0.42, so the
    //     effective weight this arithmetic describes is 0.286. The conclusion
    //     is unchanged and the fix below is unchanged; the constant is only
    //     recorded here so nobody re-derives from a stale number. Measured
    //     after both changes: the shaded river reads p50 0.304 against 0.386
    //     unshadowed — a 1.27x penalty for being in shade, from 5.1x.)
    // Physically, a river seen from a 52° camera is not mostly a mirror — the
    // Fresnel term at that incidence is ~2 % — it is mostly the WATER BODY and
    // the bed, lit by the sky, seen through the surface. Neither of those cares
    // whether the sun reaches the water, which is exactly why the shadow must
    // not be allowed to take them.
    //
    // So: a sky term added to `totalEmissiveRadiance`, i.e. AFTER the shadow and
    // after AO, in two parts —
    //   body : a flat sky-lit volume/bed term, on at every angle;
    //   spec : a Schlick lobe that runs from F0 at 52° up to a bright rim at
    //          grazing, which is the low-sun specular streak ART_DIRECTION §3
    //          rule 6 asks for and never got.
    // SIZING, solved back through ACES @ exposure 1.50 + the grade from the
    // critique's own pixels: shaded water is at L ≈ 0.0163, and display
    // 0.10–0.13 needs L ≈ 0.024–0.028. The body term is authored at luminance
    // 0.0082 and the near-normal specular adds ~0.004, landing shaded water at
    // L ≈ 0.028 → **display ≈ 0.11–0.13, a 4× lift, with sunlit water moving
    // only 0.141 → ~0.19**. The grazing rim tops out at 0.055 luminance added,
    // which is below sunlit ground (0.090) — the river gets a silver band at the
    // horizon and never becomes the brightest object in the frame.
    // The hue is the hemisphere's own sky blue, so shaded water reads COOL
    // against the warm ochre bank instead of reading as a black gash.
    const waterSky = new THREE.Color(0.150, 0.205, 0.268);   // linear, luma 0.204
    // ===== ROUND-7 FIX B — THE TREE SHADOWS ON THE RIVER ====================
    // "It receives tree shadows as if it were solid ground." It does, and the
    // reason is that a LAMBERTIAN ALBEDO is the wrong model for water. Measured
    // through the shipped rig (sun 7.6 at 14°, hemi 0.40, env 0.160, this
    // material's albedo x the near-white flow tile) the terms come out:
    //     direct diffuse (SHADOWED)  0.0362      indirect diffuse  0.0079
    //     sky Fresnel    0.0066      body 0.0100      indirect specular 0.0065
    // — 60 % of the surface's radiance was on the one term a shadow deletes, so
    // a poplar drew a hard-edged 1.8x stencil on it. Real water does not work
    // that way: what you see is body scatter and reflection, neither of which
    // cares whether the sun reaches that square metre; only the GLINT does, and
    // the glint SHOULD be shadowed.
    // So the direct diffuse is cut to 0.45 (below, at lights_fragment_end, where
    // the shadow has already been applied) and the constant body term carries
    // the value back. It is also made cooler and more saturated, because the
    // body term is now the largest single contributor and it is what sets the
    // river's hue. luma 0.0100 → 0.0212.
    // MODEL PREDICTION, not a measurement — nothing here has been rendered:
    //     sunlit 0.0810 → 0.0644, shaded 0.0448 → 0.0534,
    //     shade : sunlit 0.553 → 0.829, i.e. a 1.81x shadow becomes 1.21x.
    const waterBody = new THREE.Color(0.0118, 0.0238, 0.0230); // linear, luma 0.0212
    const SS_WATER_DIRECT = 0.45;
    // Silt lit through 30 cm of water at the margin: warm, and the ONE place a
    // river is brighter than the field beside it. Linear, added not multiplied,
    // so it survives being in the bank's shadow — which the whole channel is.
    const waterBed = new THREE.Color(0.0345, 0.0300, 0.0182); // linear, luma 0.0305
    // Foam: near-achromatic and bright, ADDED not multiplied so it stays white
    // in the bank's shadow — foam is a scatterer, it returns the sky whether or
    // not the sun is on it, and the whole channel is in shade.
    // Sized against the r4-measured sunlit ground (linear 0.090), MODEL
    // PREDICTION: a fully-lit foam scallop lands at 0.0644 + 0.0378 = 0.102,
    // i.e. 1.13x sunlit ground — whitewater IS one of the brightest things in a
    // landscape — and a SHADED one at 0.0534 + 0.0378 = 0.091, about equal to
    // sunlit ground, which is the whole point: the shoreline stays legible
    // inside the bank's shadow. Anything near the earlier 0.059 draft made the
    // river margin the brightest object in the frame and it was cut.
    const waterFoam = new THREE.Color(0.0352, 0.0384, 0.0400); // linear, luma 0.0378
    const waterTime = { value: 0 };
    waterMat.customProgramCacheKey = () => 'ss-water-flow-v3';
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uWaterSky = { value: waterSky };
      shader.uniforms.uWaterBody = { value: waterBody };
      shader.uniforms.uWaterBed = { value: waterBed };
      shader.uniforms.uWaterFoam = { value: waterFoam };
      shader.uniforms.uTime = waterTime;
      if (shader.fragmentShader.indexOf('#include <lights_fragment_end>') < 0) return;
      // ---- the depth parameter, carried from the ribbon's own columns ------
      // `aShore` is 0 mid-channel and 1 at the drawn edge. The ribbon has ELEVEN
      // columns now (round 4 had three, round 5 nine), so the gradient is
      // resolved rather than being a straight lerp from the centreline to the
      // bank — see the WATER_COLS note for why the last two were added.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', [
          '#include <common>',
          'attribute float aShore;',
          'varying float vShore;',
          'varying vec2 vWpos;',
        ].join('\n'))
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          'vShore = aShore;',
          'vWpos = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;',
        ].join('\n'));
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', [
          '#include <common>',
          'uniform vec3 uWaterSky; uniform vec3 uWaterBody; uniform vec3 uWaterBed;',
          'uniform vec3 uWaterFoam;',
          'uniform float uTime;',
          'varying float vShore;',
          'varying vec2 vWpos;',
        ].join('\n'))
        // ---- ROUND-5 FIX 7(a): DEPTH ------------------------------------
        // A river is not one value. It is dark and cool over the thalweg, warm
        // and pale over the point bars, and it silts to nearly the colour of
        // the bank in the last two metres. The ramp is noise-broken in world
        // space so the shallows are not a clean parallel offset of the
        // centreline — that offset read as a canal in round 1 and it would
        // read as one again drawn straight in the albedo.
        .replace('#include <map_fragment>', [
          '#include <map_fragment>',
          // ===== ROUND-7 FIX B: THE WATERLINE IS DRAWN, NOT CUT ==============
          // "A hard straight edge against the bank." The sheet's GEOMETRIC edge
          // has to stay where it is — `offFn` puts it 1.2 u past the carved
          // waterline precisely so it tucks under the bank and never floats over
          // dry ground — so moving it is not available. What is available is to
          // stop letting the geometric edge BE the visible edge: the apparent
          // waterline is the shallow ramp and the foam, and both are keyed on
          // ssD, so warping ssD moves the waterline without moving one vertex.
          // Three octaves at ~22 / 7.7 / 3.2 u, gated by smoothstep(0.16,0.70)
          // so the thalweg stays smooth and only the margin wanders: ±0.283 of
          // a ~10 u half-width is a waterline meandering ±2.8 u, which is
          // roughly half a hex and is what kills the parallel-canal read.
          // The floor on the last line is load-bearing — without it a negative
          // excursion at the outermost column would draw DEEP water hard against
          // the bank, which is the same hard edge with the colours swapped.
          'float ssWarp = 0.150 * sin( vWpos.x * 0.286 + vWpos.y * 0.207 + 1.3 )',
          '            + 0.085 * sin( vWpos.y * 0.815 - vWpos.x * 0.594 - 0.4 )',
          '            + 0.048 * sin( vWpos.x * 1.930 - vWpos.y * 1.470 + 2.2 );',
          'float ssD = clamp( vShore + ssWarp * smoothstep( 0.16, 0.70, vShore ), 0.0, 1.0 );',
          'ssD = max( ssD, smoothstep( 0.88, 1.00, vShore ) * 0.82 );',
          'float ssShal = smoothstep( 0.34, 0.98, ssD );',
          'float ssEdge = smoothstep( 0.79, 1.00, ssD );',
          // ---- ROUND-7 FIX B: THE DEPTH GRADIENT --------------------------
          // The round-5 ramp only ever went one way: everything from the
          // centreline outward got LIGHTER and WARMER, so the deepest water was
          // simply the material colour and the whole sheet read as one value
          // with a pale rim. A river's thalweg is its darkest, coolest, most
          // saturated third; giving it its own multiplier is what turns the
          // ramp into a gradient with two ends instead of one.
          'float ssDeep = 1.0 - smoothstep( 0.00, 0.42, ssD );',
          'diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.58, 0.74, 0.86 ), ssDeep );',
          // the bed reads through: warmer, paler, less saturated
          'diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.42, 1.30, 1.10 ), ssShal );',
          // and the last two metres are wetted gravel, not water
          'diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.30, 1.24, 1.12 ), ssEdge );',
          // ---- ROUND-7 FIX B: FOAM ----------------------------------------
          // "No foam." A shore band alone would be a drawn line, i.e. the hard
          // edge again. Foam is a PRODUCT of two things: a band that follows the
          // (already warped) waterline, and a moving lace that breaks it up —
          // the product is zero wherever either is, so the foam appears in
          // scallops that travel, never as a continuous rim. Three cosine
          // products, no fetches, and it cannot tile: the headings are
          // irrational multiples and the phase runs on uTime.
          'float ssLace = sin( vWpos.x * 0.94 + vWpos.y * 0.61 + uTime * 0.55 )',
          '             * sin( vWpos.y * 1.63 - vWpos.x * 1.11 - uTime * 0.37 )',
          '             + 0.55 * sin( vWpos.x * 2.71 - vWpos.y * 2.16 + uTime * 0.90 );',
          'float ssFoam = smoothstep( 0.66, 0.95, ssD )',
          '             * ( 1.0 - 0.45 * smoothstep( 0.965, 1.0, ssD ) )',
          '             * smoothstep( -0.10, 0.80, ssLace );',
        ].join('\n'))
        // Foam is not a mirror. Without this the scallops would still carry the
        // sheet's 0.04-0.18 roughness and take a specular glint, which is what
        // makes CG whitewater read as spilled paint.
        .replace('#include <roughnessmap_fragment>', [
          '#include <roughnessmap_fragment>',
          'roughnessFactor = mix( roughnessFactor, 0.88, ssFoam * 0.85 );',
        ].join('\n'))
        // ---- ROUND-5 FIX 7(a): FLOW ---------------------------------------
        // The round-4 surface had one scrolling normal tile, which animates the
        // texture but not the WATER: a scrolling bitmap has no wave direction,
        // no dispersion and no crossing trains, so the sheet reads as paper on
        // a conveyor. Three world-space wave trains at 10.1 / 4.8 / 2.3 u,
        // travelling on three different headings at three different speeds,
        // give the surface real crossing chop. Costs three cosines, no fetches,
        // cannot tile (world space, irrational headings) and — because it
        // perturbs `normal` and the Fresnel below reads `normal` — it is what
        // breaks the sky reflection into moving glints instead of one flat
        // sheet of sky. Amplitude is sized so the peak surface slope is 0.17,
        // i.e. a working river, not a sea.
        .replace('#include <normal_fragment_maps>', [
          '#include <normal_fragment_maps>',
          '{',
          '  vec2 d1 = vec2(  0.863,  0.505 );',
          '  vec2 d2 = vec2( -0.421,  0.907 );',
          '  vec2 d3 = vec2(  0.316, -0.949 );',
          '  vec2 rip = d1 * ( 0.062 * cos( dot( vWpos, d1 ) * 0.622 + uTime * 1.35 ) )',
          '           + d2 * ( 0.059 * cos( dot( vWpos, d2 ) * 1.309 - uTime * 0.90 ) )',
          '           + d3 * ( 0.049 * cos( dot( vWpos, d3 ) * 2.704 + uTime * 2.20 ) );',
          // chop dies away in the shallows, where the bed holds the surface flat
          '  rip *= 1.0 - 0.55 * ssEdge;',
          '  vec3 wN = vec3( dot( viewMatrix[ 0 ].xyz, normal ),',
          '                  dot( viewMatrix[ 1 ].xyz, normal ),',
          '                  dot( viewMatrix[ 2 ].xyz, normal ) );',
          '  wN = normalize( wN + vec3( rip.x, 0.0, rip.y ) );',
          '  normal = normalize( viewMatrix[ 0 ].xyz * wN.x',
          '                    + viewMatrix[ 1 ].xyz * wN.y',
          '                    + viewMatrix[ 2 ].xyz * wN.z );',
          '}',
        ].join('\n'))
        .replace('#include <lights_fragment_end>', [
          '#include <lights_fragment_end>',
          '{',
          // ROUND 5: read the RIPPLED normal, not `geometryNormal`. Round 4
          // took the Fresnel off the flat geometric normal, which is why the
          // sky term was one even wash over the whole ribbon however the
          // surface moved — half of "flat teal plane".
          // ===== ROUND-7 FIX B: THE SHADOW MUST NOT OWN THE RIVER ==========
          // `reflectedLight.directDiffuse` is in scope here and the shadow has
          // already been folded into it by <lights_fragment_begin>, so scaling
          // it is exactly "make the shadow matter less" — no second shadow
          // lookup, no reconstruction, no extra sampler. The SPECULAR is left
          // alone on purpose: a poplar genuinely does block the sun glint, and
          // that is the one water shadow a viewer reads as correct.
          '  reflectedLight.directDiffuse *= ' + SS_WATER_DIRECT.toFixed(3) + ';',
          '  float ndv = clamp( dot( normal, geometryViewDir ), 0.0, 1.0 );',
          '  float fres = pow( 1.0 - ndv, 5.0 );',
          // 0.030 is water's F0 folded together with the fraction of the sky
          // dome this ribbon can actually see out of a cut channel; the 0.28
          // grazing gain is deliberately under a third of the physical 0.974 so
          // the far bank does not turn into a mirror the moment the camera
          // lowers. Both up from round 4 (0.026 / 0.24) with the ripple now
          // spreading them over a moving surface rather than a plate.
          '  totalEmissiveRadiance += uWaterSky * ( 0.030 + 0.28 * fres )',
          '    + uWaterBody + uWaterBed * ssShal + uWaterFoam * ssFoam;',
          '}',
        ].join('\n'));
    };
    track(waterMat);

    // Fitted to the carve: out to the waterline plus 1.2 units, so the sheet
    // tucks UNDER the bank instead of stopping short and leaving a rim of dry
    // channel showing. Vertex tint lifts the outer columns toward the bible's
    // shallow water (0x4F6B58) so the edges silt up instead of ending flat.
    // ROUND-5 FIX 7(a) — THREE COLUMNS IS NOT A DEPTH GRADIENT. Round 4 drew
    // the sheet on FLAT_COLS: centreline and two edges, so "shallow water at
    // the margins" was one linear lerp across the whole half-width and the
    // shelf, the point bar and the silted margin all sat on the same ramp.
    // Nine columns put a control point every ~12 % of the width, which is what
    // lets the thalweg stay dark while the last two metres silt up. `aShore`
    // (|c|, added below) carries the same parameter into the fragment stage.
    // ROUND-7 FIX B — 9 columns → 11. The two new ones sit at |c| = 0.96, i.e.
    // ~0.4 u inside the drawn edge, because the foam band and the wetted-gravel
    // ramp both live in the last 10 % of the half-width and a Gouraud-free
    // fragment term is still sampled at the vertex for `aShore`: with the old
    // 0.90 → 1.00 gap the whole foam scallop had to be reconstructed from two
    // control points 1 u apart.
    const WATER_COLS = [
      [-1, 1], [-0.96, 1], [-0.90, 1], [-0.74, 1], [-0.48, 1], [0, 1],
      [0.48, 1], [0.74, 1], [0.90, 1], [0.96, 1], [1, 1],
    ];
    const SHALLOW = [1.62, 1.36, 1.14];
    water = addRibbon(pts, waterMat, {
      offFn: (c, z) => c * (shoreAt(z) + 1.2),
      tint: (c) => {
        const k = Math.abs(c);
        // k^2.4 rather than k^2: the thalweg is a THIRD of the channel and the
        // shoaling happens fast at the toe of the bar, so a square is too soft.
        const t = Math.pow(k, 2.4);
        return [1 + (SHALLOW[0] - 1) * t, 1 + (SHALLOW[1] - 1) * t, 1 + (SHALLOW[2] - 1) * t];
      },
      cols: WATER_COLS, flatY: WATER_Y, step: 5, vScale: 1 / 26, uScale: 1.6,
      useDeck: false, renderOrder: 0,
    });
    if (water) {
      water.name = 'river';
      water.material.transparent = false;
      water.material.depthWrite = true;
      water.material.polygonOffset = false;
      water.material.vertexColors = true;
      water.receiveShadow = true;
      // aShore = |column| ∈ [0, 1]. ribbonGeometry lays vertices out as
      // i * C + c, so the column index is simply the vertex index modulo C.
      {
        const C = WATER_COLS.length;
        const vn = water.geometry.attributes.position.count;
        const sa = new Float32Array(vn);
        for (let vi = 0; vi < vn; vi++) sa[vi] = Math.abs(WATER_COLS[vi % C][0]);
        water.geometry.setAttribute('aShore', new THREE.BufferAttribute(sa, 1));
      }
      const wm = water.material;
      water.onBeforeRender = () => {
        const t = performance.now() * 0.001;
        waterTime.value = t;
        // Two scroll rates on the one tile: the normal runs with the current,
        // the albedo drifts slower and slightly across it, so the flow lines
        // and the surface chop never lock into one moving pattern.
        if (wm.normalMap) wm.normalMap.offset.set(t * 0.021, -t * 0.062);
        if (wm.map) wm.map.offset.set(-t * 0.004, -t * 0.017);
      };
    }

    // Both banks get a finely-sampled shore strip laid over the coarse ground:
    // wet silt at the waterline through shingle to dry earth, alpha-faded into
    // the field. This is what kills the stretched, hard-edged trench wall of
    // C05 — the ground mesh cannot carry a 9-unit bank at a 3.4-unit cell, but
    // a ribbon sampled every 3 units can.
    const shoreMat = surfaceMaterial(texShore, { roughness: 0.96 });
    // ROUND-5 FIX 7(b) — five columns over 11.5 units is a control point every
    // 2.9 u on the one surface in the game with an 11.5 u rise across it, and
    // the ribbon is what has to hide the ground mesh's 3.4 u faceting, not
    // repeat it. Nine columns (1.4 u apart, tightest at the waterline where the
    // profile bends hardest) plus a 2.4 u longitudinal step take the strip from
    // 2 810 vertices to ~6 750 — cheap, one draw call each, and it is the
    // difference between a smooth bank and a polygon outline.
    const SHORE_COLS = [
      [0, 1], [0.10, 1], [0.22, 1], [0.36, 1], [0.52, 1],
      [0.68, 1], [0.82, 0.94], [0.92, 0.58], [1, 0],
    ];
    // The west bank's columns are walked in reverse so BOTH strips wind the
    // same way — otherwise computeVertexNormals hands one bank a downward
    // normal and it renders black.
    const SHORE_COLS_REV = SHORE_COLS.slice().reverse();
    for (const sgn of [1, -1]) {
      addRibbon(pts, shoreMat, {
        cols: sgn > 0 ? SHORE_COLS : SHORE_COLS_REV,
        offFn: (c, z) => sgn * (shoreAt(z) - 1.0 + c * 11.5),
        uMap: (c) => c,
        step: 2.4, lift: 0.05, vScale: 1 / 15, uScale: 1,
        useDeck: false, renderOrder: 1,
      });
    }
  }

  // ------------------------------------------------------------- roads
  // A hex-centre chain zigzags by 60° at every step; a Catmull-Rom straight
  // through it wobbles and mitres. Two passes of a [1,2,1] filter turn the
  // staircase into a road alignment before the curve ever sees it, which is
  // what rounds the corners (CRITIQUE r1 fix 12).
  function smoothChain(points, passes = 2) {
    let out = points.map((p) => ({ x: p.x, z: p.z }));
    for (let k = 0; k < passes; k++) {
      const next = out.map((p, i) => {
        if (i === 0 || i === out.length - 1) return { x: p.x, z: p.z };
        const a = out[i - 1], b = out[i + 1];
        return { x: a.x * 0.25 + p.x * 0.5 + b.x * 0.25, z: a.z * 0.25 + p.z * 0.5 + b.z * 0.25 };
      });
      out = next;
    }
    return out;
  }
  // ±15 % width along the run — a graded road is never a constant ribbon
  const wobbleWidth = (half, f = 1) =>
    (z, x) => half * (1 + 0.15 * Math.sin(x * 0.083 * f + z * 0.061 * f));

  // The blend shoulder keeps its faded edges; the road SURFACES are now
  // cross-section tiles (verge → gravel shoulder → dark edge → asphalt with a
  // broken centreline), so one draw call carries the whole road section
  // instead of a flat maroon ribbon with a hairline painted on it.
  const matShoulder = surfaceMaterial(Tex.dirtRoad, { color: 0x9C8B71, roughness: 0.96 });
  const matAsphalt = surfaceMaterial(texRoadPaved, { roughness: 0.9 });
  const matDirtRoad = surfaceMaterial(texRoadDirt, { roughness: 0.95 });

  const pavedKeys = new Set();
  if (L && L.roads) {
    for (const rd of L.roads) {
      if (rd.kind !== 'paved') continue;
      for (const h of rd.hexes) pavedKeys.add(`${h.q},${h.r}`);
    }
    for (const rd of L.roads) {
      if (rd.kind === 'paved') {
        const pts = smoothChain(rd.hexes.map(wpos));
        addRibbon(pts, matShoulder, {
          halfFn: wobbleWidth(7.6), lift: 0.05, step: 2.4, vScale: 1 / 14, renderOrder: 1,
        });
        addRibbon(pts, matAsphalt, {
          halfFn: wobbleWidth(4.7), lift: 0.13, step: 2.4, vScale: 1 / 13, renderOrder: 2,
        });
      } else {
        // dirt tracks yield to asphalt where the two share hexes
        let run = [];
        const flush = () => {
          if (run.length > 1) {
            const pts = smoothChain(run.map(wpos));
            addRibbon(pts, matShoulder, {
              halfFn: wobbleWidth(4.8, 1.4), lift: 0.05, step: 2.4, vScale: 1 / 10, renderOrder: 1,
            });
            addRibbon(pts, matDirtRoad, {
              halfFn: wobbleWidth(3.5, 1.4), lift: 0.10, step: 2.4, vScale: 1 / 9, renderOrder: 2,
            });
          }
          run = [];
        };
        for (const h of rd.hexes) {
          if (pavedKeys.has(`${h.q},${h.r}`)) { flush(); continue; }
          run.push(h);
        }
        flush();
      }
    }
  }

  // -------------------------------------------------------------- rail
  // At RTS zoom round 1's rail was a double hairline on a tan ribbon —
  // indistinguishable from a road. It now carries a proper ballast section
  // (0x6E675C crown with graded shoulders) and cross-ties at 0.6-unit spacing,
  // which is what makes a railway read as a railway from altitude.
  if (L && L.rail && L.rail.hexes && L.rail.hexes.length > 1) {
    const pts = smoothChain(L.rail.hexes.map(wpos));
    const matBallastBlend = surfaceMaterial(Tex.dirt, { color: 0x8E8578, roughness: 0.98 });
    const matBallast = surfaceMaterial(texBallast, { roughness: 0.98 });
    addRibbon(pts, matBallastBlend, { width: 12.0, lift: 0.05, step: 2.4, vScale: 1 / 12, renderOrder: 1 });
    addRibbon(pts, matBallast, { width: 8.2, lift: 0.16, step: 2.4, vScale: 1 / 7, renderOrder: 2 });

    const matRailTop = new THREE.MeshStandardMaterial({
      color: 0x9A9A98, roughness: 0.4, metalness: 0.75, side: THREE.DoubleSide,
      transparent: true, depthWrite: false, vertexColors: true,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
    });
    track(matRailTop);
    for (const off of [-0.74, 0.74]) {
      addRibbon(pts, matRailTop, {
        width: 0.34, lift: 0.62, step: 2.2, vScale: 1 / 3, lateral: off,
        cols: FLAT_COLS, renderOrder: 3,
      });
    }
    // cross-ties, 0.6 units apart
    const sleepers = [];
    const curve = new THREE.CatmullRomCurve3(
      pts.map((p) => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal', 0.5);
    const total = curve.getLength();
    const nS = Math.max(2, Math.min(4000, Math.floor(total / 0.6)));
    const sp = curve.getSpacedPoints(nS);
    for (let i = 0; i < sp.length; i++) {
      const p = sp[i];
      const a = sp[Math.max(0, i - 1)], b = sp[Math.min(sp.length - 1, i + 1)];
      const ang = Math.atan2(b.x - a.x, b.z - a.z);
      sleepers.push({
        x: p.x, y: deckAdjust(p.x, p.z, heightAt(p.x, p.z)) + 0.36, z: p.z,
        ry: ang + rand(-0.02, 0.02), s: rand(0.94, 1.06),
      });
    }
    const sleeperMesh = new THREE.InstancedMesh(G.box, M.tie, sleepers.length);
    const mtx = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const eu = new THREE.Euler();
    const sv = new THREE.Vector3();
    const pv = new THREE.Vector3();
    const scol = new THREE.Color();
    sleepers.forEach((s, i) => {
      eu.set(0, s.ry, 0);
      qt.setFromEuler(eu);
      pv.set(s.x, s.y, s.z);
      sv.set(0.30 * s.s, 0.24, 3.1 * s.s);
      mtx.compose(pv, qt, sv);
      sleeperMesh.setMatrixAt(i, mtx);
      const t = 0.82 + R() * 0.36;                 // creosote varies tie to tie
      scol.setRGB(t, t * 0.97, t * 0.92);
      sleeperMesh.setColorAt(i, scol);
    });
    sleeperMesh.instanceMatrix.needsUpdate = true;
    if (sleeperMesh.instanceColor) sleeperMesh.instanceColor.needsUpdate = true;
    sleeperMesh.castShadow = true;
    sleeperMesh.receiveShadow = true;
    group.add(sleeperMesh);
  }

  // --------------------------------------------------- poplar windbreaks
  // CRITIQUE r1 fixes 7 + 8. Round 1 drew ONE flat-shaded 20-face icosahedron
  // per tree, scattered evenly inside every forest hex: green crystals standing
  // in a ruler-straight line. Now every canopy is THREE smooth 80-face blobs at
  // jittered offsets, scales and yaw, in one of four tones; trunks are half the
  // old radius and run up INTO the canopy; and the belts are laid out as RUNS
  // along the field seam with lateral jitter, ±35 % spacing jitter, a 12 % skip
  // chance and 2–3 deliberate gaps — a real shelterbelt is ragged.
  // ROUND-4 FIX 4(b) — THE TONES, IN LINEAR LUMINANCE, WHICH IS THE UNIT THAT
  // MATTERS. The round-3 set measured 0.047 / 0.078 / 0.093 / 0.097 linear and
  // averaged 0.079; multiplied by the vertex dapple it delivered an effective
  // 0.066, i.e. **6.6 % reflectance for a summer canopy**. Real deciduous
  // foliage aggregates around 0.10–0.15, and every one of those old values is
  // below fresh asphalt. The set below measures 0.086 / 0.123 / 0.152 / 0.175,
  // mean 0.134, effective 0.122 after the (now higher-floored) dapple — an
  // 85 % lift that puts foliage back in its physical band.
  //
  // The art bible's "windbreaks are the darkest thing on the map" survives and
  // is the reason the lift stops here: a wheat field is 0.404 linear, so a belt
  // still sits 2.4–4.7× below the ground it crosses and the dark-line-on-gold
  // signature is untouched. What is gone is the claim that it should be 8×
  // below, which is not a windbreak, it is a hole.
  // (superseded: 0x2F4224 / 0x3E5530 / 0x4A5B32 / 0x5A5A34.)
  const CANOPY_TONES = [0x3F5A31, 0x50693A, 0x5E7440, 0x6E7A45];
  {
    const trunks = [];
    const canopy = [];
    const cards = [];
    const toneCol = new THREE.Color();
    // ROUND-3 FIX 8 — per-instance hue jitter. Four discrete tones over a
    // hundred-tree belt is four repeating clones, not a hundred trees, and the
    // critique read the row as exactly that. Every tree now rotates its tone by
    // up to ±6° of hue with a small saturation/lightness wobble on top, which is
    // the variation a real windbreak has (species mix, age, how much water that
    // stretch of the ditch gets) without leaving the art bible's canopy family.
    const hueJitter = new THREE.Color();
    function jitterTone(hex) {
      hueJitter.setHex(hex);
      hueJitter.offsetHSL((R() - 0.5) * 0.0333, (R() - 0.5) * 0.16, (R() - 0.5) * 0.055);
      return hueJitter.getHex();
    }

    // `opts.size` scales the whole tree (FIX 8 asks for 0.7–1.35), `opts.scrub`
    // plants a low bush with no trunk — what a real shelterbelt tails off into
    // instead of ending on a full-height poplar.
    function plantTree(x, z, poplar, opts) {
      const o = opts || {};
      const y = heightAt(x, z);
      const size = o.size == null ? 1 : o.size;
      const scrub = !!o.scrub;
      // FIX 8: a wind-worked tree does not stand plumb. ±0.35 rad of lean,
      // carried by the trunk AND the canopy so the two never disagree.
      const tiltA = (o.tilt == null ? rand(-0.35, 0.35) : o.tilt);
      // ROUND-4 FIX 12: an authored `tilt` now governs BOTH axes. It did not,
      // which meant an orchard row asked to stand plumb still leaned ±0.28 rad
      // across the row and the lattice — the only reason the type reads — was
      // lost in the wobble.
      const tiltB = (o.tilt == null ? rand(-0.28, 0.28) : o.tilt * rand(-1, 1))
        * (scrub ? 0.4 : 1);
      const th = (scrub ? rand(1.6, 3.0) : (poplar ? rand(9.0, 14.6) : rand(6.0, 9.6))) * size;
      const spread = (scrub ? rand(1.0, 1.8) : (poplar ? rand(1.15, 1.95) : rand(2.1, 3.3))) * size;
      const trunkH = th * (scrub ? 0.30 : (poplar ? 0.74 : 0.62));
      if (!scrub) {
        trunks.push({
          x, y, z, h: trunkH, tx: tiltA, tz: tiltB,
          r: (poplar ? rand(0.10, 0.15) : rand(0.13, 0.19)) * size,
        });
      }
      const tone = jitterTone(CANOPY_TONES[(R() * CANOPY_TONES.length) | 0]);
      const shade = (0.88 + R() * 0.26) * (scrub ? 0.86 : 1);
      const crownBase = y + trunkH * (poplar && !scrub ? 0.42 : 0.52);
      const crownH = th - trunkH * (poplar && !scrub ? 0.42 : 0.52);
      // `opts.blobs` lets a small tree pay less. A 2.5 u orchard crown does not
      // need the three-blob stack a 14 u poplar does, and fix 12 plants a lot
      // of them: two blobs and three cards instead of three and six halves the
      // orchard's share of the canopy instance buffer for no visible loss.
      const nBlobs = scrub ? 2 : (o.blobs || 3);
      for (let b = 0; b < nBlobs; b++) {
        const t = nBlobs > 1 ? b / (nBlobs - 1) : 0.5;
        const cy = (poplar && !scrub)
          ? crownBase + crownH * (0.26 + t * 0.56)
          : crownBase + crownH * (0.36 + (R() - 0.5) * 0.36);
        const rr = (poplar && !scrub)
          ? spread * (1.06 - Math.abs(t - 0.45) * 0.5)
          : spread * rand(0.74, 1.06);
        // the crown leans WITH the trunk: offset the blob along the lean by how
        // far up the tree it sits, so a tilted tree is one object, not a
        // straight crown balanced on a slanted pole
        const lift = cy - y;
        canopy.push({
          x: x + rand(-spread * 0.36, spread * 0.36) + Math.sin(tiltB) * lift,
          y: cy,
          z: z + rand(-spread * 0.36, spread * 0.36) - Math.sin(tiltA) * lift,
          rx: rr * rand(0.75, 1.15),
          ry: ((poplar && !scrub) ? crownH * rand(0.30, 0.42) : rr * rand(0.80, 1.35)),
          rz: rr * rand(0.75, 1.15),
          ry2: R() * 6.283,
          tx: tiltA * rand(0.6, 1.1),
          tz: tiltB * rand(0.6, 1.1),
          tone,
          shade: shade * rand(0.94, 1.06),
        });
      }
      // ROUND-2 CRITIQUE FIX 1 — alpha-tested LEAF-CARD variation. The smooth
      // blobs carry the mass and the leaf-cluster normal map; these ragged
      // cards break the ellipsoid SILHOUETTE, which no normal map can do. Two
      // to three per tree, hung off the blobs just planted, oversized ~1.6× so
      // their ragged edge reads outside the blob's own outline.
      // ROUND-4 FIX 4(a). Round 3 scattered 3–4 cards at RANDOM offsets inside
      // the blob and oversized them 1.4–1.85×, so most of them landed behind the
      // blob they were meant to be fringing and the ones that did not read as a
      // second, smaller blob. A fringe card only earns its two triangles if it
      // sits ON THE OUTLINE, so each one is now pushed out along its own bearing
      // to 0.72–1.05 of the blob radius and sized 0.95–1.35× — smaller cards,
      // more of them, all of them at the silhouette. Cost is 2 triangles each.
      const nCards = (scrub || size < 0.70) ? 3 : (5 + ((R() * 2) | 0));
      const first = canopy.length - nBlobs;
      for (let cI = 0; cI < nCards; cI++) {
        const ref = canopy[first + ((R() * nBlobs) | 0)];
        const bear = R() * 6.283;
        const push = 0.72 + R() * 0.33;
        cards.push({
          x: ref.x + Math.cos(bear) * ref.rx * push,
          y: ref.y + rand(-0.42, 0.52) * ref.ry,
          z: ref.z + Math.sin(bear) * ref.rz * push,
          s: Math.max(ref.rx, ref.rz) * rand(0.95, 1.35),
          // yaw stays free. A card on the rim is seen face-on when its plane is
          // TANGENTIAL to the crown at the screen silhouette, and the camera
          // orbits, so there is no single correct yaw — a spread of seven
          // bearings guarantees two or three of them are working from any
          // heading, and the double-sided material means none of them is wasted.
          yaw: R() * 6.283,
          tilt: rand(-0.45, 0.45),
          tone,
          shade: shade * rand(0.90, 1.10),
        });
      }
    }

    // ---- group the forest hexes into belts / woods
    const forest = (L && L.forest) || [];
    const fkey = (h) => `${h.q},${h.r}`;
    const fset = new Map();
    for (const h of forest) {
      const p = wpos(h);
      fset.set(fkey(h), { q: h.q, r: h.r, x: p.x, z: p.z });
    }
    const seenF = new Set();
    const comps = [];
    for (const k0 of fset.keys()) {
      if (seenF.has(k0)) continue;
      seenF.add(k0);
      const stack = [fset.get(k0)];
      const comp = [];
      while (stack.length) {
        const cur = stack.pop();
        comp.push(cur);
        for (const nb of hexNeighbors(cur)) {
          const nk = fkey(nb);
          if (fset.has(nk) && !seenF.has(nk)) { seenF.add(nk); stack.push(fset.get(nk)); }
        }
      }
      comps.push(comp);
    }

    for (const comp of comps) {
      let mx = 0, mz = 0;
      for (const c of comp) { mx += c.x; mz += c.z; }
      mx /= comp.length; mz /= comp.length;
      let sxx = 0, szz = 0, sxz = 0;
      for (const c of comp) {
        const dx = c.x - mx, dz = c.z - mz;
        sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
      }
      const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
      const ax = Math.cos(ang), az = Math.sin(ang);
      let minA = Infinity, maxA = -Infinity, minP = Infinity, maxP = -Infinity;
      let sa = 0, sp = 0, saa = 0, sap = 0;
      for (const c of comp) {
        const dx = c.x - mx, dz = c.z - mz;
        const a = dx * ax + dz * az;
        const pp = -dx * az + dz * ax;
        if (a < minA) minA = a;
        if (a > maxA) maxA = a;
        if (pp < minP) minP = pp;
        if (pp > maxP) maxP = pp;
        sa += a; sp += pp; saa += a * a; sap += a * pp;
      }
      const spanA = maxA - minA, spanP = maxP - minP;
      const isBelt = comp.length >= 3 && spanA > Math.max(22, spanP * 1.9);

      if (isBelt) {
        // least-squares centreline of the belt in (along, across) space
        const nC = comp.length;
        const den = nC * saa - sa * sa;
        const slope = Math.abs(den) > 1e-6 ? (nC * sap - sa * sp) / den : 0;
        const icept = (sp - slope * sa) / nC;
        // ROUND-3 FIX 8 — the belt is planted in CLUMPS, not on a metronome.
        //
        // Round 2 stepped a fixed 2.45 u with ±35 % jitter and a flat 12 % skip.
        // That is a uniform distribution with holes in it, and uniform-with-holes
        // is exactly what the critique read as "a conga line of identical clones
        // at near-identical spacing" — the eye locks onto the mean pitch and the
        // jitter never breaks it. Planting is now: a clump of 3–7 at a TIGHT
        // 1.6–2.4 u pitch, then a gap of 1.5–3 tree widths, repeat. That gives
        // the row a rhythm at the clump scale, which is what a hedgerow that
        // grew from a seed line and got thinned actually looks like. Every clump
        // also tails off into low scrub at both ends, so the belt never
        // terminates on a full-height poplar standing alone.
        const CLUMP_PITCH = 2.0;
        let t = minA - 2.0;
        let guard = 0;
        while (t <= maxA + 2.0 && guard++ < 400) {
          const nInClump = 3 + Math.floor(R() * 5);        // 3–7
          for (let ci = 0; ci < nInClump && t <= maxA + 2.0; ci++) {
            const endOfClump = (ci === 0 || ci === nInClump - 1);
            t += CLUMP_PITCH * (0.80 + R() * 0.40);
            if (R() < 0.08) continue;                      // the odd missing tree
            const rr2 = R();                               // belts are 1–3 deep
            const rows = rr2 < 0.14 ? 3 : (rr2 < 0.52 ? 2 : 1);
            for (let rI = 0; rI < rows; rI++) {
              const off = icept + slope * t + rand(-1.4, 1.4)
                + (rI === 0 ? 0 : (rI === 1 ? rand(1.5, 2.6) : -rand(1.5, 2.6)));
              const x = mx + ax * t - az * off;
              const z = mz + az * t + ax * off;
              const hh = worldToHex(x, z);
              if (!fset.has(fkey(hh)) && R() < 0.5) continue; // ragged edge, not a spray
              // FIX 8's 0.7–1.35 scale band, biased small at the clump ends so
              // the row reads as older in the middle and younger at the breaks
              const size = endOfClump ? rand(0.70, 1.02) : rand(0.82, 1.35);
              plantTree(x, z, true, { size });
            }
          }
          // scrub at the tail of the clump, then the gap
          const scrubN = 1 + Math.floor(R() * 3);
          for (let si = 0; si < scrubN; si++) {
            const st3 = t + rand(0.4, 2.2);
            const off = icept + slope * st3 + rand(-2.6, 2.6);
            plantTree(mx + ax * st3 - az * off, mz + az * st3 + ax * off, false,
              { scrub: true, size: rand(0.7, 1.25) });
          }
          t += CLUMP_PITCH * rand(1.5, 3.0);               // the gap between clumps
        }
      } else {
        // a wood: scatter, denser toward the middle of each hex
        for (const c of comp) {
          const n = 5 + Math.floor(R() * 4);
          for (let i = 0; i < n; i++) {
            const a = R() * Math.PI * 2;
            const rr = Math.sqrt(R()) * (HEX.size * 0.84);
            plantTree(c.x + Math.cos(a) * rr, c.z + Math.sin(a) * rr, R() < 0.35,
              { size: rand(0.70, 1.35) });
          }
          // understorey: a wood floor is not bare between the trunks
          const nS = 2 + Math.floor(R() * 4);
          for (let i = 0; i < nS; i++) {
            const a = R() * Math.PI * 2;
            const rr = Math.sqrt(R()) * (HEX.size * 0.88);
            plantTree(c.x + Math.cos(a) * rr, c.z + Math.sin(a) * rr, false,
              { scrub: true, size: rand(0.7, 1.3) });
          }
        }
      }
    }

    // orchard/yard trees loitering around the settlements
    for (const s of ((L && L.settlements) || [])) {
      const c = wpos(s.center);
      const n = s.kind === 'town' ? 16 : 8;
      for (let i = 0; i < n; i++) {
        const a = R() * Math.PI * 2;
        const rr = rand(HEX.size * 0.9, HEX.size * (s.kind === 'town' ? 2.6 : 1.7));
        plantTree(c.x + Math.cos(a) * rr, c.z + Math.sin(a) * rr, false,
          { size: rand(0.75, 1.30) });
      }
    }

    // ================= ROUND-4 FIX 12 — THE ORCHARD BLOCKS ==================
    // A new terrain TYPE is a label until something stands on it. terrain.js now
    // publishes `layout.surfaces.orchard`, and this is what makes those hexes
    // read as an orchard from 180 units: not the tint, the GRID. Everything else
    // vegetated on this map is deliberately irregular — the windbreaks were
    // rebuilt twice to stop reading as a conga line — so a stand of trees in a
    // dead-straight lattice is the one silhouette on the board that says
    // "planted by a person", and it reads instantly against the ragged belts
    // beside it. That contrast is the whole value of the type.
    //
    // Rows run along the mosaic's v axis (the same axis the drill runs on), at a
    // 4.8 u row pitch and a 3.9 u tree pitch, which is a real semi-dwarf apple
    // spacing at this map's scale. The lattice is laid in WORLD space across the
    // whole block, not per hex, so a two-hex orchard is one orchard and not two
    // patches that happen to touch. Trees are small (0.42–0.60 of a poplar),
    // low-crowned and unleaned — a maintained tree stands plumb — and every
    // fifth position is a gap, because no orchard is ever fully stocked.
    // Cost: zero new draw calls. These go into the same three instanced meshes
    // (trunk, canopy blob, leaf card) as every other tree on the map.
    {
      const orch = (L && L.surfaces && L.surfaces.orchard) || [];
      if (orch.length) {
        const AU = (L && L.fieldAxis && L.fieldAxis.u) || { x: 1, z: 0 };
        const AV = (L && L.fieldAxis && L.fieldAxis.v) || { x: 0, z: 1 };
        const inOrchard = new Set(orch.map((h) => `${h.q},${h.r}`));
        // one lattice for the whole map, phase-locked to the mosaic frame, so
        // adjacent orchard hexes share their rows instead of each starting over
        const ROWP = 4.8, TREEP = 3.9;
        const ph0 = R() * ROWP, ph1 = R() * TREEP;
        for (const h of orch) {
          const c = wpos(h);
          const cu = c.x * AU.x + c.z * AU.z;
          const cv = c.x * AV.x + c.z * AV.z;
          const u0 = Math.ceil((cu - HEX.size - ph0) / ROWP) * ROWP + ph0;
          const v0 = Math.ceil((cv - HEX.size - ph1) / TREEP) * TREEP + ph1;
          for (let uu = u0; uu <= cu + HEX.size; uu += ROWP) {
            for (let vv = v0; vv <= cv + HEX.size; vv += TREEP) {
              const px = uu * AU.x + vv * AV.x;
              const pz = uu * AU.z + vv * AV.z;
              // the lattice is world-wide, so keep only what lands in THIS hex
              const hh = worldToHex(px, pz);
              if (!inOrchard.has(`${hh.q},${hh.r}`)) continue;
              if (R() < 0.20) continue;                    // the missing tree
              plantTree(px + rand(-0.30, 0.30), pz + rand(-0.30, 0.30), false, {
                size: rand(0.42, 0.60),
                tilt: rand(-0.06, 0.06),                   // pruned, staked, plumb
                blobs: 2,
              });
            }
          }
        }
      }
    }

    const mtx = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const eu = new THREE.Euler();
    const pv = new THREE.Vector3();
    const sv = new THREE.Vector3();

    if (trunks.length) {
      const tm = new THREE.InstancedMesh(G.trunk, Mat.treeTrunk || M.timber, trunks.length);
      trunks.forEach((t, i) => {
        // FIX 8's lean is applied about the BASE of the trunk, not its centre —
        // composing a tilt around the mid-point lifts the butt out of the soil
        // by h/2·sin(θ), which at 0.35 rad on a 9-unit poplar is 1.5 units of
        // floating tree.
        eu.set(t.tx || 0, 0, t.tz || 0);
        qt.setFromEuler(eu);
        pv.set(0, t.h * 0.5, 0).applyQuaternion(qt);
        pv.set(t.x + pv.x, t.y + pv.y, t.z + pv.z);
        sv.set(t.r, t.h, t.r);
        mtx.compose(pv, qt, sv);
        tm.setMatrixAt(i, mtx);
      });
      tm.instanceMatrix.needsUpdate = true;
      tm.castShadow = true;
      tm.receiveShadow = true;
      group.add(tm);
    }
    if (canopy.length) {
      const im = new THREE.InstancedMesh(G.blob, Mat.treeCanopy || M.canopy, canopy.length);
      canopy.forEach((t, i) => {
        pv.set(t.x, t.y, t.z);
        sv.set(t.rx, t.ry, t.rz);
        eu.set(t.tx || 0, t.ry2, t.tz || 0);
        qt.setFromEuler(eu);
        mtx.compose(pv, qt, sv);
        im.setMatrixAt(i, mtx);
        toneCol.setHex(t.tone).multiplyScalar(t.shade);
        im.setColorAt(i, toneCol);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      group.add(im);
    }
    if (cards.length) {
      // One draw call for every leaf card on the map. The card texture is
      // near-white so the per-instance canopy tone drives the colour, exactly
      // as it does on the blobs — a card can never mismatch its own tree.
      //   transparent: true — honours the AO prepass contract (transparent
      //     surfaces are excluded), so a card cannot stamp its square QUAD as
      //     an occluder into the AO buffer;
      //   depthWrite: true + alphaTest — the card still occludes per-TEXEL, so
      //     cards inter-sort against blobs and each other without artefacts;
      //   customDepthMaterial — the shadow pass alpha-tests too: the cast
      //     shadow is a ragged leaf mass, not a rectangle.
      // ROUND-4 FIX 4(e): `vertexColors: true` + the white `color` attribute on
      // G.card is what finally makes `setColorAt` below do anything at all. See
      // the note on G.card. Roughness follows M.canopy off 0.92 to 0.88 so a
      // card and the blob it hangs on cannot catch the low sun differently.
      const cardMat = track(new THREE.MeshStandardMaterial({
        map: texLeafCard,
        color: 0xFFFFFF,
        vertexColors: true,
        roughness: 0.88,
        metalness: 0,
        alphaTest: 0.38,
        transparent: true,
        depthWrite: true,
        side: THREE.DoubleSide,
      }));
      // the same sky transmission the blobs get — a card and the blob it hangs
      // on must not part company in the shade, which is where the whole fix is
      applyLeafCardShader(cardMat, 'ss-leafcard-tone-v2');
      const cm = new THREE.InstancedMesh(G.card, cardMat, cards.length);
      cm.customDepthMaterial = track(new THREE.MeshDepthMaterial({
        map: texLeafCard,
        alphaTest: 0.38,
        depthPacking: THREE.RGBADepthPacking,
      }));
      cards.forEach((t, i) => {
        pv.set(t.x, t.y, t.z);
        sv.set(t.s, t.s * 0.82, 1);
        eu.set(t.tilt, t.yaw, 0);
        qt.setFromEuler(eu);
        mtx.compose(pv, qt, sv);
        cm.setMatrixAt(i, mtx);
        toneCol.setHex(t.tone).multiplyScalar(t.shade);
        cm.setColorAt(i, toneCol);
      });
      cm.instanceMatrix.needsUpdate = true;
      if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
      cm.castShadow = true;
      cm.receiveShadow = false;
      group.add(cm);
    }
  }

  // ============ ROUND-4 FIX 12 — SCRUB, REED BED AND BORROW PIT ============
  // The other three new surfaces, and the same argument as the orchard: a type
  // that is only a tint is a tint. Each of these gets the ONE piece of geometry
  // that identifies it and nothing else, on three shared instanced draws for
  // the whole map:
  //   scrub — thorn on ground that stopped being farmed. Clustered, never
  //           evenly spread (that is what separates scrub from a mown sward at
  //           range), with a few bleached dead bushes and loose stone.
  //   marsh — reed. Tall, thin, straw-pale, standing in dense stands along the
  //           low water margin, and the one place on this map where vegetation
  //           is BRIGHTER than the ground it stands in.
  //   spoil — the borrow pit: two or three graded heaps of pale chalk-clay per
  //           hex with boulders at their toes. The heaps are cones on their own
  //           material because a spoil heap is the one landform on this board
  //           with a repose angle, and it reads as machinery from any camera.
  // Vegetation shares M.canopy, so it inherits the same sky-transmission term
  // the trees got in fix 4 and cannot come back as another set of black lumps.
  {
    const SURF = (L && L.surfaces) || {};
    const scrubHex = SURF.scrub || [];
    const marshHex = SURF.marsh || [];
    const spoilHex = SURF.spoil || [];
    // dusty grey-green thorn, and the bleached skeleton of one that died
    const SCRUB_TONES = [0x6E7A55, 0x7A8460, 0x5F6B4A, 0x8A8A6A];
    // late-August reed: straw with the green going out of it
    const REED_TONES = [0x7E874F, 0x8C9459, 0x6E7A46, 0x98A067];
    const veg = [];
    const stones = [];
    const heaps = [];

    for (const h of scrubHex) {
      const c = wpos(h);
      // clumped, not scattered: two or three thickets per hex with bare ground
      // between them. An even spread is exactly what a lawn looks like.
      const nClump = 2 + ((R() * 2) | 0);
      for (let ci = 0; ci < nClump; ci++) {
        const ca = R() * 6.283;
        const cr = Math.sqrt(R()) * HEX.size * 0.62;
        const cxp = c.x + Math.cos(ca) * cr;
        const czp = c.z + Math.sin(ca) * cr;
        const n = 3 + ((R() * 4) | 0);
        for (let i = 0; i < n; i++) {
          const a = R() * 6.283;
          const rr = Math.sqrt(R()) * 2.6;
          const s = 0.62 + R() * 0.95;
          const dead = R() < 0.16;
          veg.push({
            x: cxp + Math.cos(a) * rr, z: czp + Math.sin(a) * rr,
            rx: s * rand(0.90, 1.35), ry: s * rand(0.55, 0.95), rz: s * rand(0.90, 1.35),
            yaw: R() * 6.283, lift: 0.74,
            tone: dead ? SCRUB_TONES[3] : SCRUB_TONES[(R() * 3) | 0],
            shade: dead ? 1.10 : (0.84 + R() * 0.32),
          });
        }
      }
      for (let i = 0; i < 2 + ((R() * 3) | 0); i++) {
        const a = R() * 6.283, rr = Math.sqrt(R()) * HEX.size * 0.8;
        const s = 0.30 + R() * 0.55;
        stones.push({
          x: c.x + Math.cos(a) * rr, z: c.z + Math.sin(a) * rr,
          rx: s * rand(1.0, 1.7), ry: s * rand(0.40, 0.70), rz: s * rand(1.0, 1.7),
          yaw: R() * 6.283, lift: 0.42, shade: 0.80 + R() * 0.34,
        });
      }
    }

    for (const h of marshHex) {
      const c = wpos(h);
      const n = 9 + ((R() * 7) | 0);
      for (let i = 0; i < n; i++) {
        const a = R() * 6.283;
        const rr = Math.sqrt(R()) * HEX.size * 0.86;
        const s = 0.42 + R() * 0.40;
        veg.push({
          x: c.x + Math.cos(a) * rr, z: c.z + Math.sin(a) * rr,
          // a reed clump is a vertical brush: narrow footprint, 2–3 u of stem
          rx: s * rand(0.80, 1.20), ry: s * rand(2.6, 4.4), rz: s * rand(0.80, 1.20),
          yaw: R() * 6.283, lift: 0.52,
          tone: REED_TONES[(R() * REED_TONES.length) | 0],
          shade: 0.86 + R() * 0.30,
        });
      }
    }

    for (const h of spoilHex) {
      const c = wpos(h);
      const n = 1 + ((R() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const a = R() * 6.283;
        const rr = Math.sqrt(R()) * HEX.size * 0.55;
        const rad = 2.2 + R() * 2.9;
        heaps.push({
          x: c.x + Math.cos(a) * rr, z: c.z + Math.sin(a) * rr,
          // ~33° repose angle: height is about 0.62 of the base radius
          rad, h: rad * (0.50 + R() * 0.26),
          yaw: R() * 6.283, shade: 0.86 + R() * 0.28,
        });
      }
      for (let i = 0; i < 4 + ((R() * 5) | 0); i++) {
        const a = R() * 6.283, rr = Math.sqrt(R()) * HEX.size * 0.9;
        const s = 0.34 + R() * 0.72;
        stones.push({
          x: c.x + Math.cos(a) * rr, z: c.z + Math.sin(a) * rr,
          rx: s * rand(1.0, 1.8), ry: s * rand(0.42, 0.78), rz: s * rand(1.0, 1.8),
          yaw: R() * 6.283, lift: 0.44, shade: 0.82 + R() * 0.32,
        });
      }
    }

    const mtx = new THREE.Matrix4(), qt = new THREE.Quaternion(), eu = new THREE.Euler();
    const pv = new THREE.Vector3(), sv = new THREE.Vector3();
    const cc = new THREE.Color();
    const lumps = (list, mat, tone) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(G.hedge, mat, list.length);
      list.forEach((b, i) => {
        pv.set(b.x, heightAt(b.x, b.z) + b.ry * b.lift, b.z);
        sv.set(b.rx, b.ry, b.rz);
        eu.set(0, b.yaw, 0);
        qt.setFromEuler(eu);
        mtx.compose(pv, qt, sv);
        im.setMatrixAt(i, mtx);
        cc.setHex(b.tone == null ? tone : b.tone).multiplyScalar(b.shade);
        im.setColorAt(i, cc);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      group.add(im);
    };
    lumps(veg, Mat.treeCanopy || M.canopy, 0x6E7A55);
    // G.hedge carries a vertex colour authored for foliage; on the stone
    // material that reads as a plausible weathered top-lit rubble gradient, so
    // the pale rubble reuses it rather than paying for a second geometry.
    lumps(stones, M.spoil, 0xFFFFFF);
    if (heaps.length) {
      // Its own cone, not G.cone: M.spoil declares `vertexColors`, and a
      // geometry without a `color` attribute would hand the shader WebGL's
      // default (0,0,0) and render every heap pure black. Since it is being
      // built anyway it also gets a lateral wobble and a slightly rounded
      // shoulder — a tipped heap slumps, it is not a traffic cone.
      const heapGeo = track((() => {
        const geo = new THREE.ConeGeometry(1, 1, 11);
        const pos = geo.attributes.position;
        const nrm = geo.attributes.normal;
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i);
          const up = v.y + 0.5;                               // 0 at base, 1 at tip
          const k = 1 + 0.13 * Math.sin(v.x * 5.3 + v.z * 4.1) + 0.08 * Math.sin(v.z * 8.7);
          v.x *= k; v.z *= k;
          v.y -= 0.10 * up * (1 - up) * 4;                    // slumped shoulder
          pos.setXYZ(i, v.x, v.y, v.z);
        }
        pos.needsUpdate = true;
        geo.computeVertexNormals();
        void nrm;
        const col = new Float32Array(pos.count * 3).fill(1);
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geo.computeBoundingSphere();
        return geo;
      })());
      const im = new THREE.InstancedMesh(heapGeo, M.spoil, heaps.length);
      heaps.forEach((b, i) => {
        pv.set(b.x, heightAt(b.x, b.z) + b.h * 0.46, b.z);
        sv.set(b.rad, b.h, b.rad);
        eu.set(0, b.yaw, 0);
        qt.setFromEuler(eu);
        mtx.compose(pv, qt, sv);
        im.setMatrixAt(i, mtx);
        cc.setHex(0xFFFFFF).multiplyScalar(b.shade);
        im.setColorAt(i, cc);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      group.add(im);
    }
  }

  // ------------------------------------------------------ hay bale rows
  // CRITIQUE r1 fix 9: round 1's bales were 2 m × 3.5 m drums at a 7.5 % spawn
  // rate, in the brightest colour on the map, sitting on road verges and inside
  // the village. Real round bales, a third of the spawn rate, off the verges.
  //
  // PHASE 2: bales now go WHERE THE CROP WAS CUT. terrain.js's mosaic carries a
  // stubble kind, and a bale standing in standing wheat is the kind of detail
  // that makes a viewer distrust everything else in the frame. Stubble parcels
  // spawn at 0.30, a just-cut wheat parcel at 0.05, and nothing else spawns at
  // all — which lands ~60 bales instead of ~38 and clusters them, so the extra
  // incident reads as harvest rather than as scatter. Same single draw call.
  const cropAt = (L && typeof L.fieldInfo === 'function')
    ? (x, z) => { try { return L.fieldInfo(x, z).crop; } catch (err) { return 'wheat'; } }
    : () => 'wheat';
  {
    const bales = [];
    const tileAtHex = (h) => tiles.get(`${h.q},${h.r}`) || null;
    for (const t of tiles.values()) {
      // ROUND-4 FIX 12 follow-through. This test was `t.type !== 'field'`, and
      // a cut-wheat parcel now classifies as `stubble` — so left alone, the one
      // surface that spawns bales at 0.30 would have stopped spawning them
      // entirely and the harvest would have vanished from the map on the round
      // it gained a type for itself.
      if (t.type !== 'field' && t.type !== 'stubble') continue;
      if (t.rail || t.bridge || t.settlement) continue;
      const c = (t.x !== undefined) ? { x: t.x, z: t.z } : wpos(t);
      const crop = cropAt(c.x, c.z);
      const p = crop === 'stubble' ? 0.30 : (crop === 'wheat' ? 0.05 : 0);
      if (p <= 0 || R() > p) continue;
      let clear = true;
      for (const nb of hexNeighbors(t)) {
        const n = tileAtHex(nb);
        if (n && (n.type === 'road' || n.type === 'town' || n.rail || n.settlement)) { clear = false; break; }
      }
      if (!clear) continue;
      const ang = R() * Math.PI * 2;
      const n = 2 + Math.floor(R() * 2);
      for (let i = 0; i < n; i++) {
        const x = c.x + Math.cos(ang) * (i * 2.7 - 2.4) + rand(-0.6, 0.6);
        const z = c.z + Math.sin(ang) * (i * 2.7 - 2.4) + rand(-0.6, 0.6);
        bales.push({ x, z, ry: ang + rand(-0.2, 0.2), s: rand(0.88, 1.08) });
      }
    }
    if (bales.length) {
      // ROUND-3 FIX 10. Round 2 shipped `map: Tex.wheat, color: 0xA8925F` — a
      // STANDING-crop albedo, tinted UP, on a compacted object. Under the warm
      // key at exposure 1.50 that made the bales the most saturated thing on the
      // map, out-punching the stubble they stand in, which is the wrong way
      // round: a bale is the same crop pressed to a third of its volume, so it
      // is darker than the field and it sits in a hard contact shadow.
      // `surfBale` is painted at the requested 0x8E7A50 and carries its own
      // net-wrap relief, so the drum ends read as recessed and the low sun finds
      // the winding ribs instead of a smooth orange cylinder.
      const mat = new THREE.MeshStandardMaterial({
        map: surfBale.map, color: 0xFFFFFF, roughness: 0.97, metalness: 0,
      });
      bindRelief(mat, surfBale, 0.85);
      track(mat);
      const im = new THREE.InstancedMesh(G.bale, mat, bales.length);
      const mtx = new THREE.Matrix4(), qt = new THREE.Quaternion(), eu = new THREE.Euler();
      const pv = new THREE.Vector3(), sv = new THREE.Vector3();
      const bc = new THREE.Color();
      bales.forEach((b, i) => {
        // G.bale is pre-rotated: local X is the drum axis, Y/Z carry the radius
        const rr = 0.72 * b.s;
        // settle each bale into the stubble rather than balancing it on the
        // ground plane, and let it lean a few degrees off the field's fall line
        pv.set(b.x, heightAt(b.x, b.z) + rr * 0.88, b.z);
        sv.set(1.15 * b.s, rr, rr);
        eu.set(rand(-0.06, 0.06), b.ry, rand(-0.05, 0.05));
        qt.setFromEuler(eu);
        mtx.compose(pv, qt, sv);
        im.setMatrixAt(i, mtx);
        // ±8 % weathering jitter, biased DOWN: a bale that has stood a week in
        // the sun greys off, it does not brighten
        const j = 0.86 + R() * 0.18;
        bc.setRGB(j, j * 0.99, j * 0.96);
        im.setColorAt(i, bc);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      group.add(im);
    }
  }

  // =========================================== FIELD FURNITURE (PHASE 2) ====
  // "The default RTS frame is ~45 % empty ochre with no incident. Every PC2
  // gallery shot is packed edge to edge." What fills real farmland is not more
  // trees, it is THE INFRASTRUCTURE OF FARMING: the lane the machinery uses,
  // the hedge that grew along it, the drain that takes the water off the field
  // and the transmission line that walks across the lot. All four are laid out
  // either in the MOSAIC frame (u across the strips, v along them) or on the
  // FALL LINE — never on hex centres — so this layer is also the answer to
  // "terrain-type boundaries snap to hex edges as razor-straight cuts": it puts
  // long continuous lines across the map at angles the grid does not contain.
  //
  // Budget: 3 extra draw calls here (merged lanes, merged drains, instanced
  // hedge) + 2 for the second transmission line. ~13 k triangles total.
  {
    const FA_U = (L && L.fieldAxis && L.fieldAxis.u) || { x: 1, z: 0 };
    const FA_V = (L && L.fieldAxis && L.fieldAxis.v) || { x: 0, z: 1 };
    const mU = (x, z) => x * FA_U.x + z * FA_U.z;
    const mV = (x, z) => x * FA_V.x + z * FA_V.z;
    const mXZ = (u, v) => ({
      x: u * FA_U.x + v * FA_V.x,
      z: u * FA_U.z + v * FA_V.z,
    });
    const B = (L && L.bounds) || { minX: -150, maxX: 150, minZ: -130, maxZ: 130 };
    const seamAt = (L && typeof L.fieldInfo === 'function')
      ? (x, z) => { try { return L.fieldInfo(x, z).seam; } catch (err) { return 99; } }
      : () => 99;
    const riverD = (L && L.river && typeof L.river.dist === 'function')
      ? L.river.dist : () => 999;
    const riverHW = (L && L.river && typeof L.river.halfWidth === 'function')
      ? L.river.halfWidth : () => 8;

    const tileAtWorld = (x, z) => {
      const h = worldToHex(x, z);
      return tiles.get(`${h.q},${h.r}`) || null;
    };
    // A lane may cross a dirt road; it may not cross the river, the town, a
    // wood or the rail formation.
    const openAt = (x, z) => {
      const t = tileAtWorld(x, z);
      if (!t) return false;
      if (t.rail || t.bridge || t.settlement) return false;
      // ROUND-4 FIX 12: OPEN_TYPES is terrain.js's own list of every surface
      // that was `field` or `grass` before this round, so the lanes, hedges and
      // drains cross exactly the ground they crossed before. `yard` and `spoil`
      // are excluded here on purpose — a machinery lane does not run through a
      // substation compound or a borrow pit.
      return OPEN_TYPES.has(t.type) && t.type !== 'yard' && t.type !== 'spoil';
    };
    const steepAt = (x, z) => {
      const e = 4;
      const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
      const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
      return Math.hypot(dx, dz) > 0.62;               // > ~32°: no machinery
    };

    // ---- 1. the lanes ---------------------------------------------------
    // One run per band pair, straight down the strips with a slow three-octave
    // wander, and pushed clear of any windbreak seam it drifts into (a lane
    // buried in a treeline is invisible and a lane ON a seam competes with it).
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const px of [B.minX, B.maxX]) {
      for (const pz of [B.minZ, B.maxZ]) {
        const uu = mU(px, pz), vv = mV(px, pz);
        if (uu < uMin) uMin = uu; if (uu > uMax) uMax = uu;
        if (vv < vMin) vMin = vv; if (vv > vMax) vMax = vv;
      }
    }
    // Each entry is a polyline: an array of { x, z }. Lanes are kept separate
    // from spurs because only the lanes get a hedge.
    const laneRuns = [];
    const spurRuns = [];

    function traceRun(sample, n, out) {
      let run = [];
      const flush = () => {
        if (run.length >= 6) out.push(run);
        run = [];
      };
      for (let i = 0; i < n; i++) {
        const p = sample(i);
        if (!p || !openAt(p.x, p.z) || steepAt(p.x, p.z)) { flush(); continue; }
        run.push(p);
      }
      flush();
    }

    {
      const STEP = 5.5;
      const nV = Math.max(4, Math.ceil((vMax - vMin + 24) / STEP));
      let u0 = uMin + 14 + R() * 26;
      let guard = 0;
      while (u0 < uMax - 12 && guard++ < 40) {
        const ph0 = R() * 6.283, ph1 = R() * 6.283, ph2 = R() * 6.283;
        const uBase = u0;
        traceRun((i) => {
          const v = vMin - 12 + i * STEP;
          let u = uBase
            + 4.4 * Math.sin(v * 0.0182 + ph0)
            + 1.9 * Math.sin(v * 0.0631 + ph1)
            + 0.8 * Math.sin(v * 0.1710 + ph2);
          // stand off the windbreak: sample both sides and walk to the open one
          const c = mXZ(u, v);
          if (seamAt(c.x, c.z) < 8) {
            const a = mXZ(u - 3.5, v), b = mXZ(u + 3.5, v);
            u += (seamAt(b.x, b.z) >= seamAt(a.x, a.z)) ? 6.5 : -6.5;
          }
          return mXZ(u, v);
        }, nV, laneRuns);
        // one lane per ~51 units of u, i.e. one per 3–4 hexes across the
        // strips: about four crossing the default 185 u frame, which is
        // incident without clutter. The u-extent of the mosaic frame is much
        // wider than the board, so the outermost one or two lanes clip away to
        // nothing — that is expected, not a bug.
        u0 += 36 + R() * 30;
      }
      // cross spurs: the headland links between two lanes
      for (let s = 0; s < 10; s++) {
        const v0 = vMin + 20 + R() * Math.max(1, vMax - vMin - 40);
        const uStart = uMin + 10 + R() * Math.max(1, uMax - uMin - 70);
        const len = 46 + R() * 52;
        const nU = Math.max(4, Math.ceil(len / 5.0));
        const phv = R() * 6.283;
        traceRun((i) => {
          const u = uStart + (len * i) / (nU - 1);
          const v = v0 + 2.6 * Math.sin(u * 0.041 + phv);
          return mXZ(u, v);
        }, nU, spurRuns);
      }
    }

    const matFarmTrack = surfaceMaterial(texFarmTrack, { roughness: 0.97 });
    const allTracks = laneRuns.concat(spurRuns);
    if (allTracks.length) {
      addMergedRibbons(allTracks, matFarmTrack, {
        halfFn: wobbleWidth(2.15, 2.4), lift: 0.075, step: 3.2,
        vScale: 1 / 6, cols: TRACK_COLS, renderOrder: 2,
      });
    }

    // ---- 2. the hedgerows ------------------------------------------------
    // Field margins that do not follow the hex grid, planted alongside the
    // lanes. Ragged by construction: ±30 % spacing jitter, a 15 % skip and
    // occasional multi-plant gaps, because a continuous hedge reads as a wall.
    // Nothing is planted within 5.5 u of a windbreak seam — terrain.js already
    // classifies those hexes as forest and stands 10-metre poplars on them, and
    // a hedge inside a shelterbelt is invisible geometry with a shadow cost.
    // ROUND-4 FIX 4(b), same correction: the old set measured 0.047–0.070
    // linear. A hedge is a shade darker than a poplar crown, not a silhouette.
    // (superseded: 0x33421F / 0x3D4A26 / 0x2C3A1E / 0x44502A.)
    const HEDGE_TONES = [0x455530, 0x4E5C37, 0x3C4C2A, 0x57643B];
    {
      const bushes = [];
      const MAXB = 760;
      for (let li = 0; li < laneRuns.length && bushes.length < MAXB; li++) {
        if (R() < 0.34) continue;                     // not every lane has one
        const run = laneRuns[li];
        const side = R() < 0.5 ? -1 : 1;
        const off = side * (4.8 + R() * 1.9);
        let gapUntil = -1;
        let t = 0;
        while (t < run.length - 1 && bushes.length < MAXB) {
          const i = Math.floor(t);
          const f = t - i;
          const a = run[i], b = run[i + 1];
          const px = a.x + (b.x - a.x) * f;
          const pz = a.z + (b.z - a.z) * f;
          // lateral direction = the mosaic u axis, so the hedge is parallel to
          // the lane whatever the lane is doing locally
          const hx = px + FA_U.x * off;
          const hz = pz + FA_U.z * off;
          t += 0.42 * (0.70 + R() * 0.60);
          if (t < gapUntil) continue;
          if (R() < 0.06) { gapUntil = t + 1.4 + R() * 1.2; continue; }
          if (R() < 0.15) continue;
          if (!openAt(hx, hz)) continue;
          if (seamAt(hx, hz) < 5.5) continue;         // the poplars own that line
          const s = 1.05 + R() * 0.85;
          bushes.push({
            x: hx + rand(-0.5, 0.5), z: hz + rand(-0.5, 0.5),
            rx: s * rand(0.85, 1.25), ry: s * rand(0.72, 1.15), rz: s * rand(0.85, 1.25),
            yaw: R() * 6.283,
            tone: HEDGE_TONES[(R() * HEDGE_TONES.length) | 0],
            shade: 0.86 + R() * 0.30,
          });
        }
      }
      if (bushes.length) {
        const im = new THREE.InstancedMesh(G.hedge, Mat.treeCanopy || M.canopy, bushes.length);
        const mtx = new THREE.Matrix4(), qt = new THREE.Quaternion(), eu = new THREE.Euler();
        const pv = new THREE.Vector3(), sv = new THREE.Vector3();
        const hc = new THREE.Color();
        bushes.forEach((b, i) => {
          pv.set(b.x, heightAt(b.x, b.z) + b.ry * 0.78, b.z);
          sv.set(b.rx, b.ry, b.rz);
          eu.set(0, b.yaw, 0);
          qt.setFromEuler(eu);
          mtx.compose(pv, qt, sv);
          im.setMatrixAt(i, mtx);
          hc.setHex(b.tone).multiplyScalar(b.shade);
          im.setColorAt(i, hc);
        });
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.castShadow = true;
        im.receiveShadow = true;
        group.add(im);
      }
    }

    // ---- 3. the field drains ---------------------------------------------
    // Traced down the FALL LINE of the new landform rather than laid out in the
    // mosaic frame, because that is what a drainage ditch is: the line water
    // takes to the river. The heading is smoothed 55/45 so the cut is graded
    // rather than a noise walk, and every run stops at the floodplain — which
    // means the drains all point at the Vovcha and quietly explain the valley.
    {
      const runs = [];
      for (let seed = 0; seed < 40 && runs.length < 11; seed++) {
        const sx = B.minX + 24 + R() * Math.max(1, B.maxX - B.minX - 48);
        const sz = B.minZ + 24 + R() * Math.max(1, B.maxZ - B.minZ - 48);
        if (!openAt(sx, sz)) continue;
        if (riverD(sx, sz) < riverHW(sz) + 46) continue;
        let x = sx, z = sz, dirX = 0, dirZ = 0;
        const pts = [{ x, z }];
        for (let k = 0; k < 26; k++) {
          const e = 9;
          const gx = -(heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
          const gz = -(heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
          const gl = Math.hypot(gx, gz);
          if (gl < 2e-3) break;
          dirX = dirX * 0.55 + (gx / gl) * 0.45;
          dirZ = dirZ * 0.55 + (gz / gl) * 0.45;
          const dl = Math.hypot(dirX, dirZ);
          if (dl < 1e-4) break;
          x += (dirX / dl) * 7.5;
          z += (dirZ / dl) * 7.5;
          if (!openAt(x, z)) break;
          pts.push({ x, z });
          if (riverD(x, z) < riverHW(z) + 11) break;
        }
        if (pts.length >= 5) runs.push(pts);
      }
      if (runs.length) {
        const matDitch = surfaceMaterial(texDitch, { roughness: 0.86 });
        // 4.4 u overall: the dark water thread lands at 0.57 u ≈ 3 px at the
        // 185 u boot camera on a 720p frame, which is the thinnest a line can
        // be and still read, and the reed lips carry the rest of the width.
        addMergedRibbons(runs, matDitch, {
          halfFn: wobbleWidth(2.2, 3.1), lift: 0.055, step: 2.8,
          vScale: 1 / 5, cols: DITCH_COLS, renderOrder: 2,
        });
      }
    }

    // ---- 4. a second transmission line -----------------------------------
    // The map had exactly one power line, a short spur from the substation to
    // the town. A 110 kV line walking the full width of the frame is the single
    // cheapest piece of vertical incident available: 15-unit lattice towers put
    // a rhythm of hard verticals and long shadows across the empty middle
    // third. `buildPowerLine` is a hoisted declaration further down the file.
    {
      const mid = { x: (B.minX + B.maxX) * 0.5, z: (B.minZ + B.maxZ) * 0.5 };
      const zOff = (B.maxZ - B.minZ) * 0.235;
      buildPowerLine(
        worldToHex(B.minX - 22, mid.z - zOff),
        worldToHex(B.maxX + 22, mid.z + zOff));
    }
  }

  // ------------------------------------------------- villages & the town
  // CRITIQUE r1 fix 6. Round 1 shipped untextured cream boxes with black
  // rectangles painted on for windows, interpenetrating each other and meeting
  // the ground at a razor edge. Every building now gets: a rotated-AABB
  // placement test that includes the roof overhang (the L-block in C07 was
  // Z-fighting the block behind it), a 0.25-unit stone plinth, REAL windows —
  // a 0.12-unit recessed 0x1E2B33 glass pane inside a 0xCFC5B0 plaster reveal
  // with a proud sill — ridge caps, parapets and vents on flat roofs, 1–4
  // chimneys, and ±6 % per-instance colour jitter over plaster / brick.
  {
    // ROUND-3 FIX 2 — the buildings finally opt in to the materials that were
    // built for them. `js/core/assets.js:1428–1429` creates `Mat.brickWall` and
    // `Mat.roofSlate`, binds both to full normal/roughness/AO surface sets at
    // `:1690` and `:1692`, and this file referenced NEITHER: every wall in the
    // game was `Mat.urbanWall` or `Mat.concrete`, which is why the critique's
    // frame-that-kills-the-build is a street of untextured cream slabs.
    //
    // Walls now split by construction rather than by tint:
    //   vWalls  plastered village house      → Mat.urbanWall (rendered plaster)
    //   bWalls  brick house / brick town block → Mat.brickWall (course + mortar)
    //   tWalls  precast panel block          → M.townWall  (panel joints)
    // and roofs by covering: clay tile, grey slate, corrugated tin.
    const vWalls = [], bWalls = [], tWalls = [], fences = [];
    const gableRoofs = [], slateRoofs = [], metalRoofs = [], flatRoofs = [];
    // the masonry gable above the eaves — same material and UV scale as the wall
    // it stands on, which is the "two roof planes drawn with unrelated
    // materials" defect the critique photographed
    const vGables = [], bGables = [];
    const plinths = [], ridges = [], slateRidges = [], metalRidges = [];
    const parapets = [], chimneys = [], caps = [], vents = [];
    const glassPanes = [], reveals = [];
    const placed = [];

    // Oriented-box overlap by separating axis. An axis-aligned test was tried
    // first and is what the critique asked for, but at HEX.size 6 a rotated
    // 10 × 11 block reserves a 15-unit AABB and a town hex is only 12 across —
    // it rejected four placements in five and left three buildings standing in
    // a fifteen-hex town. SAT rejects exactly the real overlaps and nothing
    // else, which is the same guarantee with a town still in it.
    const boxOf = (x, z, w, d, ry, pad) => ({
      x, z, hw: w * 0.5 + pad, hd: d * 0.5 + pad,
      ux: [Math.cos(ry), -Math.sin(ry)],
      uz: [Math.sin(ry), Math.cos(ry)],
    });
    const radiusOn = (r, ax) =>
      r.hw * Math.abs(ax[0] * r.ux[0] + ax[1] * r.ux[1])
      + r.hd * Math.abs(ax[0] * r.uz[0] + ax[1] * r.uz[1]);
    function overlaps(a, b) {
      const dx = b.x - a.x, dz = b.z - a.z;
      const axes = [a.ux, a.uz, b.ux, b.uz];
      for (let i = 0; i < 4; i++) {
        const ax = axes[i];
        if (Math.abs(dx * ax[0] + dz * ax[1]) >= radiusOn(a, ax) + radiusOn(b, ax)) return false;
      }
      return true;
    }
    function fits(x, z, w, d, ry, pad) {
      const box = boxOf(x, z, w, d, ry, pad);
      for (let i = 0; i < placed.length; i++) if (overlaps(placed[i], box)) return null;
      return box;
    }

    // local (lx, ly, lz) on a building rotated by ry → world
    const lx2wx = (b, lx, lz) => b.x + lx * Math.cos(b.ry) + lz * Math.sin(b.ry);
    const lz2wz = (b, lx, lz) => b.z - lx * Math.sin(b.ry) + lz * Math.cos(b.ry);

    // Windows on all four facades. `ww`/`wh` are the opening size, `sill` the
    // height of the first row above the building base, `floorH` the storey
    // pitch. Glass is inset 0.12; the reveal sits proud of the wall.
    function addWindows(b, ww, wh, sill, floorH, floors, doorFace) {
      const faces = [
        { ang: 0, span: b.w, off: b.d * 0.5, ax: 1 },
        { ang: Math.PI, span: b.w, off: b.d * 0.5, ax: 1 },
        { ang: Math.PI / 2, span: b.d, off: b.w * 0.5, ax: 0 },
        { ang: -Math.PI / 2, span: b.d, off: b.w * 0.5, ax: 0 },
      ];
      for (let f = 0; f < faces.length; f++) {
        const fc = faces[f];
        const cols = Math.max(1, Math.floor((fc.span - 1.0) / (ww + 1.15)));
        const pitch = fc.span / (cols + 1);
        for (let c = 0; c < cols; c++) {
          const t = (c + 1) * pitch - fc.span * 0.5;
          for (let fl = 0; fl < floors; fl++) {
            if (R() < 0.06) continue;                    // a boarded-up opening
            const ly = sill + fl * floorH + wh * 0.5;
            let lx, lz;
            if (fc.ax === 1) { lx = t; lz = (fc.ang === 0 ? fc.off : -fc.off); }
            else { lx = (fc.ang > 0 ? fc.off : -fc.off); lz = t; }
            const nx = Math.sin(b.ry + fc.ang), nz = Math.cos(b.ry + fc.ang);
            const wx = lx2wx(b, lx, lz), wz = lz2wz(b, lx, lz);
            const rot = b.ry + fc.ang;
            glassPanes.push({
              x: wx - nx * 0.12, y: b.y + ly, z: wz - nz * 0.12,
              ry: rot, w: ww * 0.94, h: wh * 0.94,
            });
            reveals.push({
              x: wx + nx * 0.02, y: b.y + ly, z: wz + nz * 0.02,
              ry: rot, w: ww, h: wh,
            });
          }
        }
        // one door, centred, on the nominated facade
        if (doorFace === f) {
          const nx = Math.sin(b.ry + fc.ang), nz = Math.cos(b.ry + fc.ang);
          const lx = fc.ax === 1 ? rand(-fc.span * 0.16, fc.span * 0.16) : (fc.ang > 0 ? fc.off : -fc.off);
          const lz = fc.ax === 1 ? (fc.ang === 0 ? fc.off : -fc.off) : rand(-fc.span * 0.16, fc.span * 0.16);
          const wx = lx2wx(b, lx, lz), wz = lz2wz(b, lx, lz);
          glassPanes.push({
            x: wx - nx * 0.10, y: b.y + 1.05, z: wz - nz * 0.10,
            ry: b.ry + fc.ang, w: 1.0, h: 2.0, door: true,
          });
          reveals.push({
            x: wx + nx * 0.02, y: b.y + 1.05, z: wz + nz * 0.02,
            ry: b.ry + fc.ang, w: 1.12, h: 2.1,
          });
        }
      }
    }

    for (const s of ((L && L.settlements) || [])) {
      const isTown = s.kind === 'town';
      const baseAng = R() * Math.PI;
      for (const h of s.hexes) {
        const c = wpos(h);
        const want = isTown ? 3 + Math.floor(R() * 2) : 2 + Math.floor(R() * 2);
        let made = 0;
        for (let attempt = 0; attempt < want * 14 && made < want; attempt++) {
          const a = R() * Math.PI * 2;
          const rr = Math.sqrt(R()) * HEX.size * 0.86;
          const x = c.x + Math.cos(a) * rr;
          const z = c.z + Math.sin(a) * rr;
          const ry = baseAng + (R() < 0.7 ? rand(-0.16, 0.16) : Math.PI / 2 + rand(-0.16, 0.16));
          const townBlock = isTown && R() < 0.62;
          // footprints trimmed to the hex: a 10 × 12 block filled a whole town
          // hex on its own, which is why round 1 had to let them intersect
          const w = townBlock ? rand(6.4, 9.2) : rand(4.2, 5.9);
          const d = townBlock ? rand(6.8, 10.4) : rand(4.8, 7.2);
          // roof overhang counts: gable roofs are w+1.0 × d+1.0
          const slot = fits(x, z, w + (townBlock ? 0.8 : 1.2), d + (townBlock ? 0.8 : 1.2), ry, 0.35);
          if (!slot) continue;
          placed.push(slot);
          made++;
          const y = heightAt(x, z);
          if (townBlock) {
            const floors = 2 + Math.floor(R() * 2);
            const hh = 1.1 + floors * 3.05;
            const b = { x, y, z, w, h: hh, d, ry };
            // a quarter of the blocks are painted — Soviet estates are not all
            // bare precast, and it is the cheapest legitimate colour variety
            const paint = R();
            b.rgb = paint < 0.10 ? [1.06, 0.99, 0.86]
              : paint < 0.18 ? [0.89, 0.95, 0.96]
                : paint < 0.25 ? [0.92, 0.99, 0.89]
                  : [1, 1, 1];
            const j = 0.94 + R() * 0.12;
            b.rgb = [b.rgb[0] * j, b.rgb[1] * j * 0.995, b.rgb[2] * j * 0.985];
            // a third of the town stock is pre-war load-bearing brick, not
            // precast panel — a real Donbas town centre is both, and it is what
            // finally puts Mat.brickWall's course, mortar and AO on screen
            if (R() < 0.32) {
              b.rgb = [0.99 * j, 0.97 * j, 0.95 * j];
              bWalls.push(b);
            } else {
              tWalls.push(b);
            }
            plinths.push({ x, y, z, ry, w: w + 0.6, d: d + 0.6 });
            flatRoofs.push({ x, y: y + hh, z, w: w + 0.4, d: d + 0.4, ry, rgb: [0.74, 0.74, 0.72] });
            // parapet ring
            const pw = w + 0.4, pd = d + 0.4;
            for (const [lx, lz, sx, sz] of [
              [0, pd * 0.5, pw, 0.3], [0, -pd * 0.5, pw, 0.3],
              [pw * 0.5, 0, 0.3, pd], [-pw * 0.5, 0, 0.3, pd],
            ]) {
              parapets.push({
                x: lx2wx(b, lx, lz), y: y + hh + 0.62, z: lz2wz(b, lx, lz),
                ry, w: sx, d: sz,
              });
            }
            const nCh = 2 + Math.floor(R() * 3);
            for (let i = 0; i < nCh; i++) {
              const clx = rand(-w * 0.32, w * 0.32), clz = rand(-d * 0.32, d * 0.32);
              const cx = lx2wx(b, clx, clz), cz = lz2wz(b, clx, clz);
              if (R() < 0.45) {
                chimneys.push({ x: cx, y: y + hh + 0.9, z: cz, ry, w: 0.62, h: 1.8, d: 0.62 });
                caps.push({ x: cx, y: y + hh + 1.86, z: cz, ry, w: 0.86, d: 0.86 });
              } else {
                vents.push({ x: cx, y: y + hh + 0.5, z: cz, ry, r: 0.42, h: 1.0 });
              }
            }
            addWindows(b, 1.25, 1.6, 1.6, 3.05, floors, (R() * 4) | 0);
          } else {
            const hh = rand(3.2, 4.2);
            const b = { x, y, z, w, h: hh, d, ry };
            // ROUND-3 FIX 2: brick is a MATERIAL now, not a brown tint painted
            // over the plaster tile. Both buckets keep a ±6 % per-instance
            // jitter so a street is not one repeated stamp.
            const brick = R() < 0.42;
            const j = 0.94 + R() * 0.12;
            b.rgb = brick
              ? [1.0 * j, 0.98 * j, 0.96 * j]         // Mat.brickWall carries the hue
              : [1.0 * j, 0.995 * j, 0.985 * j];      // 0xCFC5B0 plaster
            (brick ? bWalls : vWalls).push(b);
            plinths.push({ x, y, z, ry, w: w + 0.55, d: d + 0.55 });
            const roofH = rand(1.7, 2.5);
            const roof = { x, y: y + hh, z, w: w + 1.0, h: roofH, d: d + 1.0, ry };
            // FIX 2: the masonry gable sits at the WALL footprint (the roof
            // planes overhang it by 0.5 all round, which is what an eave is),
            // 1.5 % short of the ridge so it can never break the roof plane.
            (brick ? bGables : vGables).push({
              x, y: y + hh, z, ry, w, h: roofH * 0.985, d, rgb: b.rgb,
            });
            const cover = R();
            if (cover < 0.34) {
              // corrugated tin, the rusty half of the metal roofs
              roof.rgb = [1.0, 0.92, 0.86];
              metalRoofs.push(roof);
              metalRidges.push({ x, y: y + hh + roofH, z, ry, w: (w + 1.0) * 0.99 });
            } else if (cover < 0.66) {
              // grey slate — Mat.roofSlate, the second material the critique
              // named as created, surface-bound and never referenced
              roof.rgb = [rand(0.92, 1.06), rand(0.94, 1.06), rand(0.96, 1.08)];
              slateRoofs.push(roof);
              slateRidges.push({ x, y: y + hh + roofH, z, ry, w: (w + 1.0) * 0.99 });
            } else {
              roof.rgb = [rand(0.92, 1.06), rand(0.88, 1.0), rand(0.84, 0.96)];
              gableRoofs.push(roof);
              ridges.push({ x, y: y + hh + roofH, z, ry, w: (w + 1.0) * 0.99 });
            }
            // stove chimney, off-centre on the ridge
            const clx = rand(-w * 0.3, w * 0.3);
            chimneys.push({
              x: lx2wx(b, clx, rand(-0.5, 0.5)), y: y + hh + roofH * 0.75, z: lz2wz(b, clx, rand(-0.5, 0.5)),
              ry, w: 0.5, h: 1.5, d: 0.5,
            });
            addWindows(b, 1.05, 1.15, 1.55, 2.6, 1, (R() * 4) | 0);
            // yard fencing
            if (R() < 0.8) {
              for (let f = 0; f < 2 + Math.floor(R() * 2); f++) {
                const fa = ry + (f % 2 ? Math.PI / 2 : 0) + rand(-0.1, 0.1);
                const fd = (d + w) * 0.42;
                const fx = x + Math.cos(fa + 1.57) * fd + rand(-1, 1);
                const fz = z + Math.sin(fa + 1.57) * fd + rand(-1, 1);
                fences.push({ x: fx, y: heightAt(fx, fz), z: fz, ry: fa });
              }
            }
          }
        }
      }

      // grain elevator anchors the town silhouette
      if (isTown) {
        const c = wpos(s.center);
        const ex = c.x + Math.cos(baseAng) * HEX.size * 2.4;
        const ez = c.z + Math.sin(baseAng) * HEX.size * 2.4;
        const ey = heightAt(ex, ez);
        const silo = new THREE.Group();
        silo.position.set(ex, ey, ez);
        silo.rotation.y = baseAng;
        // ROUND-3 FIX 2: the silos were `Mat.concrete` at colour white and read
        // as near-clipping-white cylinders with one seam line — the brightest
        // objects in the frame and the first thing the eye went to. `M.silo` is
        // painted at the requested 0xC9C4B8 with the vertical structure a
        // slip-formed shell has: lift lines, form-panel joints, rain streaks,
        // rust runs and the dirt line at the apron.
        for (let i = 0; i < 4; i++) {
          silo.add(mk(G.cyl, M.silo, (i - 1.5) * 5.6, 8.6, 0, 2.75, 17.2, 2.75));
          silo.add(mk(G.cyl, M.steel, (i - 1.5) * 5.6, 17.5, 0, 2.85, 0.6, 2.85));
        }
        // hopper skirt at the base — a silo does not meet its apron at a razor
        silo.add(mk(G.box, M.concreteTrim, -1.4, 0.55, 0, 24.5, 1.1, 6.6));
        silo.add(mk(G.box, M.townWall, 12.6, 11.0, 0, 6.4, 22, 6.4));   // head house
        silo.add(mk(G.gable, Mat.roofSlate || M.steel, 12.6, 22.0, 0, 7.0, 1.7, 7.0));
        silo.add(steelBox(26, 1.3, 3.0, 0, 19.4, 0));                   // conveyor housing
        // ===== ROUND-7 FIX A — THE SILO CATWALKS AND THE GANTRY TRUSS ========
        // The worst two anisotropies in the file were here. The discharge spout
        // was `mk(G.box, M.lattice, …, 0.9, 15.4, 0.28)` — one 512 tile stretched
        // 15.4 u one way and 0.28 u the other, 55:1 — and the "gantry truss" was
        // a single 25.4 x 0.5 x 3.6 SLAB, 51:1, which is also why it read as a
        // grey plank rather than as a truss. Both are real steelwork now, merged
        // into ONE mesh (the spouts alone used to cost a draw call each) and
        // world-UV'd, so the tile runs at 0.55 repeats/u on every member.
        {
          const parts = [];
          for (let i = 0; i < 4; i += 2) {
            const cx = (i - 1.5) * 5.6;
            parts.push(partBox(0.42, 15.4, 0.30, cx, 8.6, 2.94));         // spout trunk
            parts.push(partBox(0.10, 15.4, 0.10, cx - 0.44, 8.6, 3.18));  // cage stringers
            parts.push(partBox(0.10, 15.4, 0.10, cx + 0.44, 8.6, 3.18));
            for (let k = 0; k < 12; k++) {                                // cage hoops
              parts.push(partBox(0.98, 0.08, 0.08, cx, 2.0 + k * 1.30, 3.18));
            }
          }
          const BAY = 10, L0 = -12.7, BW = 25.4 / BAY;
          const dg = Math.hypot(BW, 1.56), da = Math.atan2(BW, 1.56);
          for (const s of [-1, 1]) {
            parts.push(partBox(25.4, 0.26, 0.26, 0, 19.28, s * 1.7));     // chords
            parts.push(partBox(25.4, 0.26, 0.26, 0, 17.72, s * 1.7));
            for (let k = 0; k <= BAY; k++) {                              // posts
              parts.push(partBox(0.22, 1.56, 0.22, L0 + k * BW, 18.5, s * 1.7));
            }
            for (let k = 0; k < BAY; k++) {                               // diagonals
              parts.push(partBox(0.18, dg, 0.18, L0 + (k + 0.5) * BW, 18.5, s * 1.7,
                0, 0, (k % 2 ? 1 : -1) * da));
            }
          }
          for (let k = 0; k <= BAY; k += 2) {                             // cross bracing
            parts.push(partBox(0.20, 0.20, 3.4, L0 + k * BW, 19.28, 0));
          }
          silo.add(latMesh(parts, { y0: 1.0, y1: 20.0 }));
        }
        group.add(silo);
      }
    }

    const mtx = new THREE.Matrix4(), qt = new THREE.Quaternion(), eu = new THREE.Euler();
    const pv = new THREE.Vector3(), sv = new THREE.Vector3();
    const col = new THREE.Color();

    const instance = (list, geo, mat, place) => {
      if (!list.length) return null;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((b, i) => {
        place(b, pv, sv);
        eu.set(0, b.ry || 0, 0);
        qt.setFromEuler(eu);
        mtx.compose(pv, qt, sv);
        im.setMatrixAt(i, mtx);
        if (b.tint !== undefined) {
          col.setRGB(b.tint, b.tint * 0.985, b.tint * 0.95);
          im.setColorAt(i, col);
        } else if (b.rgb) {
          col.setRGB(b.rgb[0], b.rgb[1], b.rgb[2]);
          im.setColorAt(i, col);
        }
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      group.add(im);
      return im;
    };

    // walls are sunk 0.5 into the ground so nothing floats on a slope; the
    // plinth course covers the join
    instance(vWalls, G.box, Mat.urbanWall || M.townWall,
      (b, p, s) => { p.set(b.x, b.y + b.h * 0.5 - 0.25, b.z); s.set(b.w, b.h + 0.5, b.d); });
    // ROUND-3 FIX 2 — Mat.brickWall, referenced for the first time.
    instance(bWalls, G.box, Mat.brickWall || Mat.urbanWall || M.townWall,
      (b, p, s) => { p.set(b.x, b.y + b.h * 0.5 - 0.25, b.z); s.set(b.w, b.h + 0.5, b.d); });
    instance(tWalls, G.box, M.townWall,
      (b, p, s) => { p.set(b.x, b.y + b.h * 0.5 - 0.25, b.z); s.set(b.w, b.h + 0.5, b.d); });
    // the masonry gable takes the SAME material as the wall under it
    instance(vGables, G.gableEnd, Mat.urbanWall || M.townWall,
      (b, p, s) => { p.set(b.x, b.y, b.z); s.set(b.w, b.h, b.d); });
    instance(bGables, G.gableEnd, Mat.brickWall || Mat.urbanWall || M.townWall,
      (b, p, s) => { p.set(b.x, b.y, b.z); s.set(b.w, b.h, b.d); });
    instance(plinths, G.box, M.plinth,
      (b, p, s) => { p.set(b.x, b.y - 0.18, b.z); s.set(b.w, 0.86, b.d); });
    // roofs are the SLOPED PLANES ONLY now (G.gableRoof) — the end triangles
    // went to the wall buckets above
    instance(gableRoofs, G.gableRoof, Mat.roofTile || M.paint,
      (b, p, s) => { p.set(b.x, b.y, b.z); s.set(b.w, b.h, b.d); });
    // ROUND-3 FIX 2 — Mat.roofSlate, referenced for the first time.
    instance(slateRoofs, G.gableRoof, Mat.roofSlate || Mat.roofTile || M.paint,
      (b, p, s) => { p.set(b.x, b.y, b.z); s.set(b.w, b.h, b.d); });
    instance(metalRoofs, G.gableRoof, Mat.roofRust || M.steel,
      (b, p, s) => { p.set(b.x, b.y, b.z); s.set(b.w, b.h, b.d); });
    instance(flatRoofs, G.box, Mat.concrete || M.paint,
      (b, p, s) => { p.set(b.x, b.y + 0.28, b.z); s.set(b.w, 0.56, b.d); });
    instance(ridges, G.box, Mat.roofTile || M.paint,
      (b, p, s) => { p.set(b.x, b.y + 0.08, b.z); s.set(b.w, 0.26, 0.44); });
    instance(slateRidges, G.box, Mat.roofSlate || Mat.roofTile || M.paint,
      (b, p, s) => { p.set(b.x, b.y + 0.08, b.z); s.set(b.w, 0.24, 0.42); });
    instance(metalRidges, G.box, M.steel,
      (b, p, s) => { p.set(b.x, b.y + 0.08, b.z); s.set(b.w, 0.22, 0.40); });
    instance(parapets, G.box, M.concreteTrim,
      (b, p, s) => { p.set(b.x, b.y, b.z); s.set(b.w, 0.62, b.d); });
    instance(chimneys, G.box, M.brick,
      (b, p, s) => { p.set(b.x, b.y + b.h * 0.5, b.z); s.set(b.w, b.h, b.d); });
    instance(caps, G.box, M.concreteTrim,
      (b, p, s) => { p.set(b.x, b.y, b.z); s.set(b.w, 0.16, b.d); });
    instance(vents, G.cyl8, M.vent,
      (b, p, s) => { p.set(b.x, b.y + b.h * 0.5, b.z); s.set(b.r, b.h, b.r); });
    // ROUND-4 FIX 7 (assets) — the window materials finally exist, so bind them.
    // `Mat.windowReveal` is map-free on purpose: G.reveal's widest member is
    // 0.15 m and a box-face UV runs 0..1 across it, so any tile is magnified
    // ~40x into a smear. `Mat.windowGlass` carries a four-light sash (glass at
    // roughness 0.09, joinery at 0.80, painted soffit/jamb shadow), which is
    // wrong on a DOOR — so the door panes, which ride the same list under
    // `door: true`, keep the old flat glass.
    instance(reveals, G.reveal, Mat.windowReveal || M.reveal,
      (b, p, s) => { p.set(b.x, b.y, b.z); s.set(b.w, b.h, 1); });
    instance(glassPanes.filter((g) => !g.door), G.box, Mat.windowGlass || M.glass,
      (b, p, s) => { p.set(b.x, b.y, b.z); s.set(b.w, b.h, 0.08); });
    instance(glassPanes.filter((g) => g.door), G.box, M.glass,
      (b, p, s) => { p.set(b.x, b.y, b.z); s.set(b.w, b.h, 0.08); });
    // ROUND-3 FIX 3: a yard fence was borrowing Mat.treeTrunk — bark, 0x3B3226,
    // authored for a shaded forest trunk — and read as a black bar standing in
    // a lit garden. M.timber is silvered, split, algae-stained softwood.
    instance(fences, G.box, M.timber,
      (b, p, s) => { p.set(b.x, b.y + 0.62, b.z); s.set(0.16, 1.24, 4.4); });
  }

  // ------------------------------------------------- power line + pylons
  function buildPowerLine(fromHex, toHex) {
    if (!fromHex || !toHex) return;
    const a = wpos(fromHex), b = wpos(toHex);
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 30) return;
    const n = Math.max(3, Math.round(len / 30));
    const ux = dx / len, uz = dz / len;
    const ang = Math.atan2(ux, uz);

    // ===== ROUND-7 FIX A — THE PYLON ========================================
    // This is the object the critique photographed. Two things changed and the
    // geometry is untouched:
    //   • `latGeo` world-projects the merged UVs at 0.55 repeats/u, so the
    //     0.45 u leg and the 9.5 u crossarm sample the galvanised tile at the
    //     SAME texel density instead of 569 : 17 texels/u;
    //   • every member carries its own baked value — ±16 % between members, a
    //     splash-dirt-to-washed-zinc gradient up its length, and a warm rust
    //     bias on 25 % of them. That is the half that survives minification: at
    //     26–90 u a leg is 2–4 px wide and no texture feature can save it, but
    //     its own MEAN can still differ from the leg beside it.
    // Bracing added while here — a four-leg tower with two crossarms and no
    // diagonals reads as a goalpost. 20 face braces at 0.22 u is 240 triangles
    // per tower and it is the difference between a stick and a lattice.
    const pylonGeo = latGeo((() => {
      const parts = [
        partBox(0.45, 15, 0.45, -1.5, 7.5, -1.5),
        partBox(0.45, 15, 0.45, 1.5, 7.5, -1.5),
        partBox(0.45, 15, 0.45, -1.5, 7.5, 1.5),
        partBox(0.45, 15, 0.45, 1.5, 7.5, 1.5),
        partBox(9.5, 0.42, 0.42, 0, 11.4, 0),
        partBox(7.2, 0.42, 0.42, 0, 14.2, 0),
        partBox(3.6, 0.35, 0.35, 0, 6.5, 0),
        partBox(0.35, 4.6, 0.35, 0, 9.0, 0, 0, 0, 0.5),
      ];
      // four faces x five panels of X-bracing, alternating hand up the tower
      for (let p = 0; p < 5; p++) {
        const ya = 0.6 + p * 2.85, yb = ya + 2.85;
        const ym = (ya + yb) * 0.5, hh = yb - ya;
        const diag = Math.hypot(3.0, hh) * 0.99;
        const ang = Math.atan2(3.0, hh);
        for (const s of [-1, 1]) {
          // faces normal to Z (members run along X), then normal to X
          parts.push(partBox(0.22, diag, 0.22, 0, ym, s * 1.5, 0, 0, (p % 2 ? 1 : -1) * ang));
          parts.push(partBox(0.22, diag, 0.22, s * 1.5, ym, 0, (p % 2 ? -1 : 1) * ang, 0, 0));
        }
        parts.push(partBox(3.22, 0.20, 0.20, 0, yb, -1.5));
        parts.push(partBox(3.22, 0.20, 0.20, 0, yb, 1.5));
      }
      return parts;
    })(), { y0: 0, y1: 15.4 });
    track(pylonGeo);
    // PHASE 2 — a tower may not stand in the river, in the town or on a rail
    // formation. Collect the candidate stations first, drop the ones that
    // cannot carry a tower, and size the InstancedMesh to what survives: the
    // wire simply spans the gap, which is what a real crossing looks like.
    const px0 = -uz, pz0 = ux;                       // perpendicular in-plane
    const stations = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = a.x + dx * t, z = a.z + dz * t;
      const hh = worldToHex(x, z);
      const tl = tiles.get(`${hh.q},${hh.r}`) || null;
      // ROUND-4 FIX 12: `marsh` and `spoil` join the block list. Nobody founds a
      // transmission pylon in a reed bed or on the floor of a working borrow
      // pit, and both are now real hexes that a run can cross.
      const blocked = !!tl && (tl.type === 'water' || tl.type === 'town'
        || tl.type === 'road' || tl.type === 'marsh' || tl.type === 'spoil'
        || tl.rail || tl.bridge || tl.settlement);
      const y = heightAt(x, z);
      const top = [
        new THREE.Vector3(x + px0 * 4.6, y + 11.4, z + pz0 * 4.6),
        new THREE.Vector3(x - px0 * 4.6, y + 11.4, z - pz0 * 4.6),
        new THREE.Vector3(x + px0 * 3.5, y + 14.2, z + pz0 * 3.5),
        new THREE.Vector3(x - px0 * 3.5, y + 14.2, z - pz0 * 3.5),
      ];
      // the first and last station always stand: they terminate the line
      if (blocked && i > 0 && i < n) continue;
      stations.push({ x, y, z, top });
    }
    if (stations.length < 2) return;

    // ROUND-3 FIX 3 — the transmission pylons. These were the single most
    // conspicuous artefact in the default RTS frame: near-black lattice towers
    // standing in a lit field, pulling the eye to the least interesting objects
    // on the map. Galvanised lattice, with a real albedo and relief.
    const im = new THREE.InstancedMesh(pylonGeo, M.latticeVC, stations.length);
    const mtx = new THREE.Matrix4(), qt = new THREE.Quaternion(), eu = new THREE.Euler();
    const pv = new THREE.Vector3(), sv = new THREE.Vector3(1, 1, 1);
    const pcol = new THREE.Color();
    const tops = [];
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      pv.set(st.x, st.y, st.z);
      eu.set(0, ang, 0);
      qt.setFromEuler(eu);
      mtx.compose(pv, qt, sv);
      im.setMatrixAt(i, mtx);
      // ROUND-7 FIX A — ±10 % between towers, warmer on the older ones, so a
      // six-tower run is six objects and not one object drawn six times. This
      // works only because the material is `latticeVC`: three gates
      // `instanceColor` behind USE_COLOR exactly as it gates vertex colour, and
      // the round-4 note on `M.spoil` in this file is the same finding.
      let t = (Math.sin(i * 12.9898 + 4.1414) * 43758.5453) % 1;
      if (t < 0) t += 1;
      const k = 0.90 + 0.20 * t;              // value, ±10 %
      const warm = (t - 0.5) * 0.10;          // and a small correlated hue tilt
      pcol.setRGB(k * (1 + warm), k, k * (1 - warm));
      im.setColorAt(i, pcol);
      tops.push(st.top);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = true;
    group.add(im);

    // ===== ROUND-5 FIX 15 — THE CONDUCTORS ==================================
    // Round 4's wires were four-segment polylines drawn with LineBasicMaterial.
    // Three separate faults, and the critic hit all three in one sentence:
    //   • "no catenary sag" — there WAS a sag term, but a 4-segment chord of a
    //     half-sine over a 30 u span deviates from the straight line by under
    //     0.4 u at the quarter points, which at RTS range is under a pixel. The
    //     curve existed in the arithmetic and not on the screen;
    //   • "1-px" — a GL line is one pixel at every distance by definition, so
    //     the conductors could not thicken as the camera came in and read as a
    //     rendering artefact rather than as objects;
    //   • "near-white" — LineBasicMaterial is unlit. The value was fixed and
    //     could not sit in the frame's light.
    // All three are answered by making them geometry: a 3-sided prism of 17 cm
    // section swept along a TRUE catenary at 14 segments per span, on a lit
    // aluminium material. 4 conductors x ~6 spans x 14 x 3 sides is ~1 000
    // triangles per line and one draw call; they do not cast shadows, because a
    // 17 cm section at a 4096 map is shadow acne and nothing else.
    const CAB_R = 0.085;
    const CAB_SEG = 14;
    const CAB_K = 1.8;                       // catenary shape parameter
    const CAB_CH = Math.cosh(CAB_K);
    const cPos = [];
    const cIdx = [];
    const upV = new THREE.Vector3(0, 1, 0);
    const tanV = new THREE.Vector3(), rgtV = new THREE.Vector3(), nrmV = new THREE.Vector3();
    const prevP = new THREE.Vector3(), curP = new THREE.Vector3();
    for (let i = 0; i < tops.length - 1; i++) {
      // sag scales with the span, so a river crossing dips like a river
      // crossing instead of holding the 30-unit droop of a normal bay
      const span = Math.hypot(
        tops[i + 1][0].x - tops[i][0].x, tops[i + 1][0].z - tops[i][0].z);
      const sagAmp = Math.min(6.0, 0.9 + 1.35 * (span / 30));
      for (let w = 0; w < 4; w++) {
        const p0 = tops[i][w], p1 = tops[i + 1][w];
        const base = cPos.length / 3;
        for (let s = 0; s <= CAB_SEG; s++) {
          const t = s / CAB_SEG;
          const m = t * 2 - 1;
          // y = -sag · (cosh k − cosh km)/(cosh k − 1): zero at both supports,
          // −sag at mid-span, and FULLER near the towers than a sine, which is
          // the shape that reads as a hanging cable rather than as an arc.
          const dy = -sagAmp * (CAB_CH - Math.cosh(CAB_K * m)) / (CAB_CH - 1);
          curP.set(
            p0.x + (p1.x - p0.x) * t,
            p0.y + (p1.y - p0.y) * t + dy,
            p0.z + (p1.z - p0.z) * t);
          if (s === 0) {
            const t2 = 1 / CAB_SEG, m2 = t2 * 2 - 1;
            tanV.set(
              (p1.x - p0.x) * t2,
              (p1.y - p0.y) * t2 - sagAmp * (CAB_CH - Math.cosh(CAB_K * m2)) / (CAB_CH - 1) - dy,
              (p1.z - p0.z) * t2);
          } else {
            tanV.subVectors(curP, prevP);
          }
          if (tanV.lengthSq() < 1e-10) tanV.set(0, 0, 1);
          tanV.normalize();
          rgtV.crossVectors(tanV, upV);
          if (rgtV.lengthSq() < 1e-8) rgtV.set(1, 0, 0);
          rgtV.normalize();
          nrmV.crossVectors(rgtV, tanV).normalize();
          for (let k = 0; k < 3; k++) {
            const a = (k / 3) * Math.PI * 2;
            const ca = Math.cos(a) * CAB_R, sa = Math.sin(a) * CAB_R;
            cPos.push(
              curP.x + rgtV.x * ca + nrmV.x * sa,
              curP.y + rgtV.y * ca + nrmV.y * sa,
              curP.z + rgtV.z * ca + nrmV.z * sa);
          }
          prevP.copy(curP);
          if (s > 0) {
            const r0 = base + (s - 1) * 3, r1 = base + s * 3;
            for (let k = 0; k < 3; k++) {
              const k2 = (k + 1) % 3;
              cIdx.push(r0 + k, r1 + k, r0 + k2, r0 + k2, r1 + k, r1 + k2);
            }
          }
        }
      }
    }
    if (cIdx.length) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(cPos, 3));
      wg.setIndex(cPos.length / 3 > 65535
        ? new THREE.BufferAttribute(new Uint32Array(cIdx), 1)
        : new THREE.BufferAttribute(new Uint16Array(cIdx), 1));
      wg.computeVertexNormals();
      wg.computeBoundingSphere();
      track(wg);
      const cm = new THREE.Mesh(wg, M.conductor);
      cm.castShadow = false;
      cm.receiveShadow = false;
      cm.matrixAutoUpdate = false;
      cm.updateMatrix();
      group.add(cm);
    }
  }

  // ------------------------------------------------------ infrastructure
  const infrastructure = [];
  const infraGeos = [];
  const keepGeo = (g) => { infraGeos.push(g); track(g); return g; };

  function stateGroups(parent) {
    const s = {
      intact: new THREE.Group(),
      damaged: new THREE.Group(),
      destroyed: new THREE.Group(),
    };
    s.damaged.visible = false;
    s.destroyed.visible = false;
    parent.add(s.intact, s.damaged, s.destroyed);
    return s;
  }

  function buildBridgeMesh(site) {
    const d = deckFor(site.hex);
    const g = new THREE.Group();
    const isRail = site.kind === 'rail_bridge';
    if (!d) {
      const p = wpos(site.hex);
      g.position.set(p.x, WATER_Y, p.z);
      return { group: g, states: stateGroups(g) };
    }
    g.position.set(d.x, 0, d.z);
    g.rotation.y = Math.atan2(d.axis.x, d.axis.z);
    const st = stateGroups(g);

    const HL = d.halfLen;
    const W = isRail ? 7.2 : 8.4;
    const deckMat = Mat.concrete || M.paint;
    const segLen = HL * 0.62;
    const midLen = HL * 0.9;

    const addTo = (grp, m) => { grp.add(m); return m; };
    // approach spans (present in every state)
    for (const grp of [st.intact, st.damaged, st.destroyed]) {
      addTo(grp, mk(G.box, deckMat, 0, d.y - 0.45, HL - segLen * 0.5, W, 0.9, segLen));
      addTo(grp, mk(G.box, deckMat, 0, d.y - 0.45, -(HL - segLen * 0.5), W, 0.9, segLen));
    }
    // centre span
    st.intact.add(mk(G.box, deckMat, 0, d.y - 0.45, 0, W, 0.9, midLen));
    const tilted = mk(G.box, deckMat, 0, d.y - 1.5, 0.6, W, 0.9, midLen * 0.55);
    tilted.rotation.x = 0.22;
    st.damaged.add(tilted);
    st.damaged.add(mk(G.box, deckMat, 0, d.y - 0.45, -midLen * 0.34, W, 0.9, midLen * 0.35));
    for (let i = 0; i < 2; i++) {
      const slab = mk(G.box, M.charred, rand(-1.6, 1.6), WATER_Y - 0.2 + i * 0.5,
        (i ? 1 : -1) * midLen * 0.28, W * 0.9, 0.85, midLen * 0.42);
      slab.rotation.set(rand(0.4, 0.8) * (i ? -1 : 1), rand(-0.3, 0.3), rand(-0.25, 0.25));
      st.destroyed.add(slab);
    }
    // piers
    const pierH = d.y - 1.0 - (WATER_Y - 2.6);
    for (const s of [-1, 1]) {
      const px = s * HL * 0.42;
      const pier = () => mk(G.box, deckMat, 0, WATER_Y - 2.6 + pierH * 0.5, px, 3.0, pierH, 2.4);
      st.intact.add(pier());
      st.damaged.add(pier());
      const stub = mk(G.box, M.charred, 0, WATER_Y - 2.6 + pierH * 0.32, px, 3.0, pierH * 0.64, 2.4);
      st.destroyed.add(stub);
    }
    // Abutments (CRITIQUE r1 fix 5). The deck used to hang over a wedge of
    // daylight between the water and the rising bank with nothing under it. A
    // concrete abutment sits exactly where the carved bank reaches the soffit
    // — computed per side when the deck was laid out — with a wing wall
    // stepping down toward the water and rip-rap at its toe. Present in all
    // three states: dropping the span does not remove the abutments.
    {
      const soffit = d.y - 0.9;
      for (const ab of (d.abut || [])) {
        const zc = ab.sgn * ab.dist;
        const base = ab.y - 1.8;
        const hgt = Math.max(1.0, soffit - base);
        for (const grp of [st.intact, st.damaged, st.destroyed]) {
          grp.add(mk(G.box, deckMat, 0, base + hgt * 0.5, zc, W + 1.7, hgt, 3.0));
          // wing wall stepping toward the channel
          const wz = zc - ab.sgn * 2.6;
          const wBase = Math.max(WATER_Y - 0.6, base - 0.6);
          const wH = Math.max(0.8, (soffit - 0.55) - wBase);
          grp.add(mk(G.box, deckMat, 0, wBase + wH * 0.5, wz, W + 0.6, wH, 2.4));
          for (let i = 0; i < 4; i++) {
            grp.add(mk(G.blob, M.plinth,
              rand(-W * 0.5, W * 0.5), WATER_Y + rand(-0.15, 0.35), wz - ab.sgn * rand(1.1, 2.4),
              rand(0.5, 0.95), rand(0.35, 0.62), rand(0.5, 0.95), R() * 3.14));
          }
        }
      }
    }
    // railings / truss
    if (isRail) {
      // ROUND-7 FIX A — same treatment as the pylon: the chords are 2·HL long
      // and 0.32 u thick, so a box-face UV ran them at ~125:1.
      const trussMesh = latMesh((() => {
        const parts = [];
        for (const s of [-1, 1]) {
          parts.push(partBox(0.32, 0.5, HL * 2, s * (W * 0.5 + 0.2), 3.1, 0));
          parts.push(partBox(0.32, 0.5, HL * 2, s * (W * 0.5 + 0.2), 0.4, 0));
          const bays = 8;
          for (let i = 0; i < bays; i++) {
            const z = -HL + (i + 0.5) * (2 * HL / bays);
            parts.push(partBox(0.28, 3.6, 0.28, s * (W * 0.5 + 0.2), 1.75, z));
            parts.push(partBox(0.24, 4.4, 0.24, s * (W * 0.5 + 0.2), 1.75,
              z + HL / bays, 0.62, 0, 0));
          }
        }
        return parts;
      })(), { y0: 0, y1: 3.6 }, keepGeo);
      trussMesh.position.y = d.y;
      st.intact.add(trussMesh);
      const trussDam = trussMesh.clone();
      st.damaged.add(trussDam);
    } else {
      // ROUND-7 FIX A — a road-bridge parapet is a top rail, a knee rail and
      // posts. It was one 0.22 x 0.85 x 2·HL plank per side, i.e. a tile run
      // 0.22 u across and ~40 u along, which is the same 180:1 stretch as the
      // pylon leg and rendered as the same pale grey stick. World-sized parts,
      // world UV, per-member value, one merged mesh for both sides.
      const railParts = (len, zc) => {
        const parts = [];
        const N = Math.max(3, Math.round(len / 2.6));
        for (const s of [-1, 1]) {
          const px = s * (W * 0.5 - 0.2);
          parts.push(partBox(0.16, 0.14, len, px, 0.86, zc));       // top rail
          parts.push(partBox(0.12, 0.10, len, px, 0.50, zc));       // knee rail
          for (let i = 0; i <= N; i++) {
            parts.push(partBox(0.14, 0.92, 0.14, px, 0.46,
              zc - len * 0.5 + i * (len / N)));
          }
        }
        return parts;
      };
      const railIntact = latMesh(railParts(HL * 2, 0), { y0: 0, y1: 1.0 }, keepGeo);
      railIntact.position.y = d.y;
      st.intact.add(railIntact);
      const railDam = latMesh(railParts(HL * 1.24, HL * 0.62), { y0: 0, y1: 1.0 }, keepGeo);
      railDam.position.y = d.y;
      st.damaged.add(railDam);
    }
    st.damaged.add(decal(0, 0, 16, d.y - 0.9));
    st.destroyed.add(decal(0, 0, 20, d.y - 1.2));
    return { group: g, states: st };
  }

  function buildSubstation(site) {
    const p = wpos(site.hex);
    const y = heightAt(p.x, p.z);
    const g = new THREE.Group();
    g.position.set(p.x, y, p.z);
    g.rotation.y = R() * Math.PI;
    const st = stateGroups(g);

    for (const grp of [st.intact, st.damaged, st.destroyed]) {
      grp.add(mk(G.box, Mat.concrete || M.paint, 0, 0.2, 0, 27, 0.4, 21));
    }
    // ROUND-7 FIX A — world UV + per-member value on the busbar gantries.
    const frameGeo = keepGeo(latGeo((() => {
      const parts = [];
      for (const s of [-1, 1]) {
        parts.push(partBox(0.4, 10.5, 0.4, s * 3.4, 5.25, 0));
        parts.push(partBox(0.32, 8.2, 0.32, s * 3.4, 4.1, 0, 0, 0, 0.28));
      }
      parts.push(partBox(8.0, 0.45, 0.45, 0, 10.3, 0));
      parts.push(partBox(7.4, 0.35, 0.35, 0, 7.9, 0));
      for (let i = -1; i <= 1; i++) parts.push(partBox(0.5, 1.5, 0.5, i * 2.6, 11.2, 0));
      return parts;
    })(), { y0: 0, y1: 11.9 }));

    const transformer = (gx, gz) => {
      const gg = new THREE.Group();
      gg.position.set(gx, 0, gz);
      gg.add(mk(G.box, M.paint, 0, 2.4, 0, 4.4, 4.4, 5.2));
      gg.add(steelBox(4.6, 3.6, 0.5, 0, 2.4, 2.9));   // radiator bank
      for (let i = 0; i < 3; i++) {
        gg.add(mk(G.cyl8, Mat.concrete || M.paint, -1.4 + i * 1.4, 5.4, 0, 0.42, 1.9, 0.42));
      }
      return gg;
    };

    for (let i = 0; i < 3; i++) {
      const tx = -8 + i * 8;
      st.intact.add(transformer(tx, 4.5));
      const frame = new THREE.Mesh(frameGeo, M.latticeVC);
      frame.position.set(tx, 0, -5.5);
      frame.castShadow = true;
      st.intact.add(frame);

      if (i === 1) {
        const t = transformer(tx, 4.5);
        t.traverse((o) => { if (o.isMesh) o.material = M.charred; });
        t.rotation.z = 0.14;
        st.damaged.add(t);
      } else {
        st.damaged.add(transformer(tx, 4.5));
        const f2 = new THREE.Mesh(frameGeo, M.latticeVC);
        f2.position.set(tx, 0, -5.5);
        st.damaged.add(f2);
      }
      const dead = transformer(tx, 4.5);
      dead.traverse((o) => { if (o.isMesh) o.material = M.charred; });
      dead.rotation.set(rand(-0.2, 0.2), 0, rand(-0.4, 0.4));
      dead.scale.y = 0.7;
      st.destroyed.add(dead);
      const fd = new THREE.Mesh(frameGeo, M.charred);
      fd.position.set(tx, 0.4, -5.5);
      fd.rotation.z = rand(1.1, 1.5) * (i % 2 ? -1 : 1);
      st.destroyed.add(fd);
    }
    // perimeter fence
    const fenceGeo = keepGeo(latGeo((() => {
      const parts = [];
      for (let i = -6; i <= 6; i++) {
        parts.push(partBox(0.18, 2.6, 0.18, i * 2.2, 1.3, -10.4));
        parts.push(partBox(0.18, 2.6, 0.18, i * 2.2, 1.3, 10.4));
      }
      for (let i = -4; i <= 4; i++) {
        parts.push(partBox(0.18, 2.6, 0.18, -13.4, 1.3, i * 2.4));
        parts.push(partBox(0.18, 2.6, 0.18, 13.4, 1.3, i * 2.4));
      }
      parts.push(partBox(27, 0.14, 0.14, 0, 2.5, -10.4));
      parts.push(partBox(27, 0.14, 0.14, 0, 2.5, 10.4));
      return parts;
    })(), { y0: 0, y1: 2.6, dirt: 0.34 }));
    for (const grp of [st.intact, st.damaged]) {
      const f = new THREE.Mesh(fenceGeo, M.latticeVC);
      f.castShadow = true;
      f.receiveShadow = true;
      grp.add(f);
    }
    st.damaged.add(decal(0, 4.5, 13, 0.25));
    st.destroyed.add(decal(0, 0, 26, 0.25));
    return { group: g, states: st, powerFrom: site.hex };
  }

  function buildFuelDepot(site) {
    const p = wpos(site.hex);
    const y = heightAt(p.x, p.z);
    const g = new THREE.Group();
    g.position.set(p.x, y, p.z);
    g.rotation.y = R() * Math.PI;
    const st = stateGroups(g);

    // CRITIQUE r1 fix 28 — round 1 was three white cylinders on a bare brown
    // pad. A tank farm has a bund wall that would hold its contents, a gravel
    // apron, access ladders and stairs, a pipe manifold and bollards.
    const spots = [[-8, -4], [4, -6], [-1, 6]];
    for (const grp of [st.intact, st.damaged, st.destroyed]) {
      // gravel apron under the whole site
      grp.add(mk(G.box, Mat.dirt || M.paint, -1.5, 0.12, 0, 34, 0.24, 28));
      for (const s of spots) {
        grp.add(mk(G.cyl, Mat.concrete || M.paint, s[0], 0.34, s[1], 5.6, 0.68, 5.6));
      }
      grp.add(mk(G.box, Mat.concrete || M.paint, 11, 0.25, 7, 8, 0.5, 7));
      // bund wall: a low concrete rectangle enclosing the tank farm
      const bund = [
        [-1.5, -11.5, 30, 1.0], [-1.5, 11.0, 30, 1.0],
        [-16.0, -0.25, 1.0, 22.5], [13.0, -0.25, 1.0, 22.5],
      ];
      for (const b of bund) {
        grp.add(mk(G.box, Mat.concrete || M.paint, b[0], 0.85, b[1], b[2], 1.7, b[3]));
      }
      // bollards along the pipe run (one merged mesh, not six)
      const bol = [];
      for (let i = 0; i < 6; i++) bol.push(partBox(0.44, 1.25, 0.44, -13 + i * 4.6, 0.62, -9.6));
      grp.add(new THREE.Mesh(keepGeo(mergeGeos(bol)), M.vent));
    }
    const tank = (mat, crush) => {
      const gg = new THREE.Group();
      const h = 7.2 * (crush || 1);
      gg.add(mk(G.cyl, mat, 0, h * 0.5, 0, 4.3, h, 4.3));
      gg.add(mk(G.cyl, mat, 0, h + 0.25, 0, 4.4, 0.5, 4.4));
      gg.add(mk(G.box, mat, 4.4, h * 0.5, 0, 0.6, h, 0.35));
      // dark service band low on the shell
      gg.add(mk(G.cyl, M.vent, 0, h * 0.12, 0, 4.36, h * 0.16, 4.36));
      // cage ladder + roof handrail stanchions, merged into ONE mesh — 19 draw
      // calls per tank across three states is not worth a ladder
      const rig = [];
      for (let i = 0; i < 9; i++) rig.push(partBox(0.1, 0.06, 0.68, -4.36, 0.45 + i * (h - 0.6) / 9, 0.34));
      rig.push(partBox(0.08, h, 0.08, -4.5, h * 0.5, 0.68));
      rig.push(partBox(0.08, h, 0.08, -4.5, h * 0.5, 0.0));
      for (const a of [0, 1.05, 2.1, 3.14, 4.19, 5.24]) {
        rig.push(partBox(0.09, 1.1, 0.09, Math.cos(a) * 3.9, h + 0.9, Math.sin(a) * 3.9));
      }
      gg.add(latMesh(rig, { y0: 0, y1: h + 1.5, dirt: 0.30 }, keepGeo));
      // ROUND-7 FIX A — the roof handrail is a world-sized torus now. `G.ring`
      // is a unit torus scaled x3.9 on the MESH, so its 0..1 UV ran one tile
      // round a 24.5 u circumference; `G.latRingTank` is built at 3.9 u radius
      // and box-projected at 0.55 repeats/u like every other member.
      {
        const ring = new THREE.Mesh(G.latRingTank, M.lattice);
        ring.position.set(0, h + 1.45, 0);
        ring.castShadow = true;
        ring.receiveShadow = true;
        gg.add(ring);
      }
      // vent stack
      gg.add(mk(G.cyl8, M.steel, 1.6, h + 0.9, -1.2, 0.24, 1.5, 0.24));
      return gg;
    };
    spots.forEach((s, i) => {
      const t = tank(M.paint);
      t.position.set(s[0], 0, s[1]);
      st.intact.add(t);
      const dm = (i === 0) ? tank(M.charred, 0.82) : tank(M.paint);
      dm.position.set(s[0], 0, s[1]);
      if (i === 0) dm.rotation.z = 0.1;
      st.damaged.add(dm);
      const de = tank(M.charred, 0.34);
      de.position.set(s[0], 0, s[1]);
      de.rotation.set(rand(-0.16, 0.16), R() * 3, rand(-0.3, 0.3));
      st.destroyed.add(de);
    });
    // pump house + pipes
    const pipes = keepGeo(mergeGeos([
      partBox(0.5, 0.5, 18, -2, 1.4, 0),
      partBox(20, 0.5, 0.5, 0, 1.4, -4),
      partBox(0.4, 2.8, 0.4, -8, 1.4, -4),
      partBox(0.4, 2.8, 0.4, 4, 1.4, -4),
      partBox(0.4, 2.8, 0.4, -1, 1.4, 6),
    ]));
    for (const grp of [st.intact, st.damaged]) {
      const pm = new THREE.Mesh(pipes, M.steel);
      pm.castShadow = true;
      grp.add(pm);
      grp.add(mk(G.box, Mat.brickWall || Mat.urbanWall || M.townWall, 11, 1.8, 7, 5, 3.6, 4.4));
      grp.add(mk(G.gable, Mat.roofRust || M.steel, 11, 3.6, 7, 5.6, 1.5, 5.0));
    }
    const pd = new THREE.Mesh(pipes, M.charred);
    pd.rotation.z = 0.2;
    st.destroyed.add(pd);
    st.destroyed.add(mk(G.box, M.charred, 11, 1.0, 7, 5, 2.0, 4.4));
    st.damaged.add(decal(-8, -4, 15, 0.3));
    st.destroyed.add(decal(-2, 0, 30, 0.3));
    return { group: g, states: st };
  }

  function buildRailYard(site) {
    const p = wpos(site.hex);
    const y = heightAt(p.x, p.z);
    const g = new THREE.Group();
    g.position.set(p.x, y, p.z);
    // align with the rail line
    if (L && L.rail && L.rail.hexes.length > 1) {
      let bi = 0, bd = Infinity;
      L.rail.hexes.forEach((h, i) => {
        const w = wpos(h);
        const dd = (w.x - p.x) * (w.x - p.x) + (w.z - p.z) * (w.z - p.z);
        if (dd < bd) { bd = dd; bi = i; }
      });
      const a = wpos(L.rail.hexes[Math.max(0, bi - 1)]);
      const b = wpos(L.rail.hexes[Math.min(L.rail.hexes.length - 1, bi + 1)]);
      g.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
    }
    const st = stateGroups(g);

    for (const grp of [st.intact, st.damaged, st.destroyed]) {
      grp.add(mk(G.box, Mat.concrete || M.paint, 6.5, 0.55, 0, 8, 1.1, 34));
    }
    const shed = (mat, roofMat, gx, gz, collapse) => {
      const gg = new THREE.Group();
      gg.position.set(gx, 0, gz);
      const h = collapse ? 2.4 : 5.2;
      gg.add(mk(G.box, mat, 0, h * 0.5, 0, 11, h, 15));
      const roof = mk(G.gable, roofMat, 0, h, 0, 12, collapse ? 0.8 : 2.6, 16);
      if (collapse) roof.rotation.z = 0.16;
      gg.add(roof);
      return gg;
    };
    st.intact.add(shed(Mat.urbanWall || M.townWall, Mat.roofRust || M.steel, -8, -8));
    st.intact.add(shed(Mat.brickWall || Mat.urbanWall || M.townWall, Mat.roofSlate || M.steel, -8, 12));
    st.damaged.add(shed(Mat.urbanWall || M.townWall, Mat.roofRust || M.steel, -8, -8, true));
    st.damaged.add(shed(Mat.brickWall || Mat.urbanWall || M.townWall, Mat.roofSlate || M.steel, -8, 12));
    st.destroyed.add(shed(M.charred, M.charred, -8, -8, true));
    st.destroyed.add(shed(M.charred, M.charred, -8, 12, true));

    const wagon = (mat, gz, tilt) => {
      const gg = new THREE.Group();
      gg.position.set(0, 0, gz);
      gg.rotation.z = tilt || 0;
      gg.add(mk(G.box, mat, 0, 2.1, 0, 3.4, 2.8, 9.2));
      gg.add(mk(G.box, M.darkSteel, 0, 0.7, 0, 3.0, 0.7, 9.6));
      for (const s of [-1, 1]) {
        gg.add(mk(G.cyl8, M.darkSteel, 0, 0.55, s * 3.2, 0.62, 3.2, 0.62));
        gg.children[gg.children.length - 1].rotation.z = Math.PI / 2;
      }
      return gg;
    };
    for (let i = 0; i < 3; i++) {
      st.intact.add(wagon(M.steel, -11 + i * 11));
      st.damaged.add(wagon(i === 1 ? M.charred : M.steel, -11 + i * 11));
      st.destroyed.add(wagon(M.charred, -11 + i * 11, rand(0.12, 0.4) * (i % 2 ? -1 : 1)));
    }
    // water tower
    const tower = (mat) => {
      const gg = new THREE.Group();
      gg.position.set(14, 0, -13);
      // ROUND-7 FIX A — the four legs were `mk(G.box, mat, …, 0.4, 8.4, 0.4)`,
      // a 21:1 stretch of the galvanised tile, and a water tower with four bare
      // posts and no bracing reads as a table. Merged, world-UV'd, per-member.
      {
        const parts = [];
        for (const s of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) {
          parts.push(partBox(0.4, 8.4, 0.4, s[0], 4.2, s[1]));
        }
        for (const yb of [2.6, 5.8]) {
          for (const s of [-1, 1]) {
            parts.push(partBox(3.2, 0.16, 0.16, 0, yb, s * 1.6));
            parts.push(partBox(0.16, 0.16, 3.2, s * 1.6, yb, 0));
          }
        }
        const dg = Math.hypot(3.2, 3.2), da = Math.atan2(3.2, 3.2);
        for (const s of [-1, 1]) {
          parts.push(partBox(0.14, dg, 0.14, 0, 4.2, s * 1.6, 0, 0, da * s));
          parts.push(partBox(0.14, dg, 0.14, s * 1.6, 4.2, 0, da * s, 0, 0));
        }
        gg.add(latMesh(parts, { y0: 0, y1: 8.4, dirt: 0.30 }, keepGeo));
      }
      gg.add(mk(G.cyl, mat, 0, 10.2, 0, 3.1, 4.2, 3.1));
      gg.add(mk(G.cone, mat, 0, 13.2, 0, 3.3, 2.0, 3.3));
      return gg;
    };
    st.intact.add(tower(M.steel));
    st.damaged.add(tower(M.steel));
    st.destroyed.add(decal(0, 0, 34, 0.3));
    st.damaged.add(decal(-8, -8, 15, 0.3));
    return { group: g, states: st };
  }

  function buildCommsTower(site) {
    const p = wpos(site.hex);
    const y = heightAt(p.x, p.z);
    const g = new THREE.Group();
    g.position.set(p.x, y, p.z);
    g.rotation.y = R() * Math.PI;
    const st = stateGroups(g);

    const lattice = (h0, h1, w0, w1) => {
      const parts = [];
      const SEC = 5;
      for (let i = 0; i < SEC; i++) {
        const t0 = i / SEC, t1 = (i + 1) / SEC;
        const ya = h0 + (h1 - h0) * t0, yb = h0 + (h1 - h0) * t1;
        const wa = w0 + (w1 - w0) * t0, wb = w0 + (w1 - w0) * t1;
        const wm = (wa + wb) * 0.5;
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            parts.push(partBox(0.3, yb - ya, 0.3, sx * wm, (ya + yb) * 0.5, sz * wm));
          }
        }
        for (const sx of [-1, 1]) {
          parts.push(partBox(wb * 2, 0.22, 0.22, 0, yb, sx * wb));
          parts.push(partBox(0.22, 0.22, wb * 2, sx * wb, yb, 0));
          parts.push(partBox(0.2, (yb - ya) * 1.35, 0.2, sx * wm, (ya + yb) * 0.5, wm, 0, 0, 0.45));
          parts.push(partBox(0.2, (yb - ya) * 1.35, 0.2, sx * wm, (ya + yb) * 0.5, -wm, 0, 0, -0.45));
        }
      }
      return parts;
    };
    // ROUND-7 FIX A — the tallest lattice on the map. 0.3 u legs carrying a
    // 0..1 face UV over a 3.6 u section length is the same 12:1 stretch the
    // pylon had, and the mast is read at every camera distance in the build.
    const lowerGeo = keepGeo(latGeo(lattice(0, 18, 2.2, 1.2), { y0: 0, y1: 18 }));
    const upperGeo = keepGeo(latGeo(lattice(0, 9, 1.2, 0.7), { y0: 0, y1: 9 }));

    // CRITIQUE r1 fix 28 — round 1 was a white lattice with white dishes at odd
    // angles, floating on bare ground with no cables. Dishes now sit on real
    // stand-off mounts and aim OUTWARD (a microwave link points at the horizon,
    // not at the sky), the mast is banded red/white aviation marking near the
    // top, and the structure is tied down with guy wires, a cable run, a ladder
    // and an equipment shelter on a gravel pad.
    const dishes = (parent, yOff) => {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.4;
        const yy = yOff + 3 + i * 3.4;
        const rMount = 1.35;
        // stand-off arm
        parent.add(mk(G.latArm, M.lattice,
          Math.cos(a) * rMount * 0.6, yy, Math.sin(a) * rMount * 0.6,
          1, 1, 1, a + Math.PI / 2));
        const dish = mk(G.cyl, M.paint,
          Math.cos(a) * (rMount + 0.5), yy, Math.sin(a) * (rMount + 0.5), 1.35, 0.3, 1.35);
        // cylinder axis is +Y; tip it to horizontal, then swing it to face out
        dish.rotation.order = 'YXZ';
        dish.rotation.set(Math.PI / 2 - 0.10, a + Math.PI / 2, 0);
        parent.add(dish);
        parent.add(mk(G.latRingDish, M.lattice,
          Math.cos(a) * (rMount + 0.62), yy, Math.sin(a) * (rMount + 0.62), 1, 1, 1));
      }
      const ant = mk(G.latAnt, M.lattice, 0, yOff + 11, 0, 1, 1, 1);
      parent.add(ant);
      // sector antennas on the mast face
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 1.9;
        parent.add(mk(G.box, M.paint,
          Math.cos(a) * 1.1, yOff + 8.4, Math.sin(a) * 1.1, 0.28, 2.2, 0.6, a));
      }
    };

    // cable run + ladder up the lower mast, and the aviation bands near the top
    const towerRig = (parent) => {
      // ladder, its stringers and the compound fence — one merged mesh
      const rig = [];
      for (let i = 0; i < 22; i++) rig.push(partBox(0.72, 0.07, 0.07, 1.65, 0.9 + i * 0.78, 0));
      rig.push(partBox(0.09, 18.4, 0.09, 1.35, 9.4, 0.28));
      rig.push(partBox(0.09, 18.4, 0.09, 1.95, 9.4, 0.28));
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        rig.push(partBox(0.14, 1.9, 0.14, Math.cos(a) * 7.4, 0.95, Math.sin(a) * 7.4));
        rig.push(partBox(0.06, 0.06, 3.9, Math.cos(a + 0.26) * 7.4, 1.75, Math.sin(a + 0.26) * 7.4,
          0, a + 0.26 + Math.PI / 2, 0));
      }
      parent.add(latMesh(rig, { y0: 0, y1: 18.6, dirt: 0.30 }, keepGeo));
      parent.add(mk(G.box, M.vent, -1.7, 8.0, 0, 0.36, 16.0, 0.5));       // cable tray
      // equipment shelter + gravel pad
      parent.add(mk(G.box, Mat.dirt || M.paint, 0, 0.1, 0, 17, 0.2, 15));
      parent.add(mk(G.box, Mat.concrete || M.paint, 4.6, 0.22, 4.4, 6.4, 0.44, 5.2));
      parent.add(mk(G.box, Mat.brickWall || Mat.urbanWall || M.townWall, 4.6, 1.65, 4.4, 4.6, 2.6, 3.6));
      parent.add(steelBox(5.0, 0.24, 4.0, 4.6, 3.05, 4.4));   // shelter roof
      parent.add(mk(G.box, M.vent, 6.4, 1.5, 2.5, 0.9, 1.1, 0.5));        // aircon unit
    };
    // three guy wires from the mast head down to ground anchors
    const guyWires = (parent, topY) => {
      const pts = [];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.9;
        const ax = Math.cos(a) * 12.5, az = Math.sin(a) * 12.5;
        for (const ty of [topY, topY * 0.62]) {
          const SEG = 3;
          for (let s2 = 0; s2 < SEG; s2++) {
            const t0 = s2 / SEG, t1 = (s2 + 1) / SEG;
            const sag = (t) => -Math.sin(t * Math.PI) * 0.5;
            pts.push(
              ax * t0, ty + (0 - ty) * t0 + sag(t0), az * t0,
              ax * t1, ty + (0 - ty) * t1 + sag(t1), az * t1);
          }
        }
        parent.add(mk(G.box, M.concreteTrim, ax, 0.35, az, 1.1, 0.7, 1.1));
      }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      track(wg);
      parent.add(new THREE.LineSegments(wg, M.wire));
    };

    const lowerIntact = new THREE.Mesh(lowerGeo, M.latticeVC);
    lowerIntact.castShadow = true;
    st.intact.add(lowerIntact);
    const upperIntact = new THREE.Mesh(upperGeo, M.latticeVC);
    upperIntact.position.y = 18;
    upperIntact.castShadow = true;
    st.intact.add(upperIntact);
    dishes(st.intact, 6);
    towerRig(st.intact);
    guyWires(st.intact, 25.0);
    for (let i = 0; i < 4; i++) {                     // aviation marking bands
      st.intact.add(mk(G.box, i % 2 ? M.paint : M.markRed,
        0, 19.4 + i * 1.9, 0, 1.5 - i * 0.12, 0.9, 1.5 - i * 0.12));
    }
    const beacon = mk(G.cyl8, M.beacon, 0, 27.6, 0, 0.32, 0.6, 0.32);
    st.intact.add(beacon);

    const lowerDam = new THREE.Mesh(lowerGeo, M.latticeVC);
    st.damaged.add(lowerDam);
    const upperDam = new THREE.Mesh(upperGeo, M.charred);
    upperDam.position.set(1.2, 17.6, 0);
    upperDam.rotation.z = -0.72;
    st.damaged.add(upperDam);
    dishes(st.damaged, 6);
    st.damaged.add(decal(0, 0, 9, 0.2));

    const lowerDead = new THREE.Mesh(lowerGeo, M.charred);
    lowerDead.rotation.z = -1.44;
    lowerDead.position.set(2.2, 1.1, 0);
    st.destroyed.add(lowerDead);
    const upperDead = new THREE.Mesh(upperGeo, M.charred);
    upperDead.rotation.set(0, 0.6, -1.62);
    upperDead.position.set(19.5, 0.8, 2.4);
    st.destroyed.add(upperDead);
    st.destroyed.add(decal(0, 0, 16, 0.2));
    for (let i = 0; i < 7; i++) {
      st.destroyed.add(mk(G.box, M.charred, rand(-6, 16), 0.4, rand(-5, 5),
        rand(0.6, 1.8), rand(0.4, 0.9), rand(0.6, 2.2), R() * 3));
    }
    return { group: g, states: st };
  }

  const BUILDERS = {
    bridge: buildBridgeMesh,
    rail_bridge: buildBridgeMesh,
    substation: buildSubstation,
    fuel_depot: buildFuelDepot,
    rail_yard: buildRailYard,
    comms_tower: buildCommsTower,
  };

  const INFRA_LABEL = {
    bridge: 'BRIDGE', rail_bridge: 'RAIL BRIDGE', substation: 'SUBSTATION',
    fuel_depot: 'FUEL DEPOT', rail_yard: 'RAIL YARD', comms_tower: 'COMMS TOWER',
  };

  for (const site of ((L && L.infrastructure) || [])) {
    const build = BUILDERS[site.kind];
    if (!build) continue;
    let built = null;
    try { built = build(site); } catch (err) {
      console.warn('[features] infrastructure build failed:', site.kind, err);
      continue;
    }
    if (!built) continue;
    built.group.name = `infra-${site.id}`;
    group.add(built.group);
    const rec = {
      id: site.id,
      kind: site.kind,
      name: site.name || INFRA_LABEL[site.kind] || site.id,
      hex: { q: site.hex.q, r: site.hex.r },
      mesh: built.group,
      hp: site.hp,
      maxHp: site.hp,
      alive: true,
      state: 'intact',
      _states: built.states,
    };
    infrastructure.push(rec);
    if (site.kind === 'substation') {
      const town = (L.settlements || []).find((s) => s.kind === 'town');
      buildPowerLine(site.hex, town ? town.center : site.hex);
    }
  }

  function setInfraState(rec, state) {
    if (!rec || !rec._states || rec.state === state) return;
    rec.state = state;
    rec._states.intact.visible = state === 'intact';
    rec._states.damaged.visible = state === 'damaged';
    rec._states.destroyed.visible = state === 'destroyed';
  }

  function infraWorldPos(rec) {
    const p = wpos(rec.hex);
    let y = heightAt(p.x, p.z);
    if (rec.kind === 'bridge' || rec.kind === 'rail_bridge') {
      const d = deckFor(rec.hex);
      if (d) y = d.y;
    }
    return { x: p.x, y: y + 1.6, z: p.z };
  }

  // ------------------------------------------------------ objective flags
  const objectiveMarkers = [];
  {
    const objs = (L && L.objectives && L.objectives.length) ? L.objectives : (sc.objectives || []);
    for (const o of objs) {
      if (!o || !o.hex) continue;
      const p = wpos(o.hex);
      const y = heightAt(p.x, p.z);
      const g = new THREE.Group();
      g.position.set(p.x, y, p.z);
      const pole = mk(G.latPole, M.lattice, 0, 3.6, 0, 1, 1, 1);
      g.add(pole);
      g.add(mk(G.cyl8, M.concreteTrim, 0, 0.22, 0, 0.55, 0.44, 0.55));   // footing
      g.add(mk(G.cyl8, M.steel, 0, 7.32, 0, 0.16, 0.24, 0.16));          // finial
      const cloth = new THREE.Mesh(G.cloth, o.owner === 'blue' ? M.flagBlue : M.flagRed);
      cloth.scale.set(3.0, 1.7, 1);
      cloth.position.set(0.06, 6.35, 0);
      cloth.rotation.y = rand(-0.35, 0.35);
      cloth.castShadow = true;
      cloth.receiveShadow = true;
      g.add(cloth);
      // a breeze: the whole flag swings a few degrees off the hoist. Cheap
      // (one Euler write per visible flag per frame) and it stops the marker
      // reading as a decal stuck to the pole.
      const ph = R() * 6.283;
      cloth.onBeforeRender = () => {
        const t = performance.now() * 0.001;
        cloth.rotation.y = Math.sin(t * 0.9 + ph) * 0.20 + Math.sin(t * 2.3 + ph) * 0.05;
      };
      group.add(g);
      objectiveMarkers.push({ id: o.id, hex: o.hex, group: g, cloth });
    }
  }
  function setObjectiveOwner(id, owner) {
    const m = objectiveMarkers.find((x) => x.id === id);
    if (!m) return;
    m.cloth.material = owner === 'blue' ? M.flagBlue : M.flagRed;
  }
  try {
    Game.on('objectiveTaken', (o) => {
      if (o && o.id) setObjectiveOwner(o.id, o.owner || o.faction || 'blue');
    });
  } catch (err) { /* state stub without an event bus — ignore */ }

  // -------------------------------------------------------------- wrecks
  const wrecks = [];
  const MAX_WRECKS = 44;

  function buildWreck(unitClass) {
    const g = new THREE.Group();
    const cls = String(unitClass || 'armor');
    if (cls === 'infantry') {
      for (let i = 0; i < 5; i++) {
        g.add(mk(G.box, M.charred, rand(-2, 2), 0.22, rand(-2, 2),
          rand(0.4, 1.1), rand(0.2, 0.5), rand(0.4, 1.1), R() * 3));
      }
    } else if (cls === 'drone') {
      g.add(mk(G.box, M.charred, 0, 0.25, 0, 1.8, 0.4, 1.8, R() * 3));
      for (let i = 0; i < 3; i++) {
        g.add(mk(G.box, M.charred, rand(-2, 2), 0.18, rand(-2, 2), 0.9, 0.14, 0.25, R() * 3));
      }
    } else {
      const hull = mk(G.box, Mat.wreck || M.charred, 0, 0.75, 0, 3.1, 1.4, 5.0);
      hull.rotation.set(rand(-0.06, 0.06), R() * 3.14, rand(-0.08, 0.08));
      g.add(hull);
      const turret = mk(G.box, Mat.wreck || M.charred, rand(-2.6, 2.6), 0.55, rand(-2.6, 2.6),
        1.9, 0.9, 2.1, R() * 3.14);
      turret.rotation.z = rand(-0.5, 0.5);
      g.add(turret);
      if (cls === 'artillery' || cls === 'armor') {
        const barrel = mk(G.cyl8, M.charred, 0, 0.6, 0, 0.16, 4.4, 0.16, R() * 3.14);
        barrel.rotation.z = Math.PI / 2 - 0.15;
        barrel.position.set(rand(-3, 3), 0.5, rand(-3, 3));
        g.add(barrel);
      }
      for (let i = 0; i < 4; i++) {
        g.add(mk(G.box, M.charred, rand(-4, 4), 0.2, rand(-4, 4),
          rand(0.3, 1.0), rand(0.2, 0.5), rand(0.3, 1.0), R() * 3));
      }
    }
    return g;
  }

  function setWreck(hex, unitClass) {
    if (!hex) return null;
    const p = wpos(hex);
    const y = heightAt(p.x, p.z);
    const g = new THREE.Group();
    g.position.set(p.x, y, p.z);
    g.add(decal(0, 0, 13, 0));
    g.children[0].position.set(0, 0.07, 0);
    g.add(buildWreck(unitClass));
    group.add(g);
    const rec = { hex: { q: hex.q, r: hex.r }, unitClass, group: g };
    wrecks.push(rec);
    while (wrecks.length > MAX_WRECKS) {
      const old = wrecks.shift();
      group.remove(old.group);   // geometries/materials are shared — nothing to free
    }
    try {
      VFX.smokeColumn({ x: p.x, y: y + 1.0, z: p.z }, { persistent: true, scale: 1.0, flames: true });
    } catch (err) { /* VFX not initialised yet — the wreck still stands */ }
    return rec;
  }

  // ------------------------------------------------------------- horizon
  // CRITIQUE r1 fix 13. terrain.js now undulates the far skirt; this hangs the
  // things that make a horizon read as a country at war rather than a cut edge:
  // three distant treeline strips, a silhouetted settlement mass, and two smoke
  // columns standing over the far side of the front. Everything out here is
  // pushed most of the way to the haze colour on top of the fog it already
  // takes, so it reads as depth and never competes with the play area.
  let farSmokeTimer = null;
  {
    const bb = (L && L.bounds) ? L.bounds : { minX: 0, maxX: 300, minZ: 0, maxZ: 260 };
    const cxm = (bb.minX + bb.maxX) * 0.5;
    const czm = (bb.minZ + bb.maxZ) * 0.5;
    const farH = (L && typeof L.farHeight === 'function') ? L.farHeight : heightAt;

    const haze = new THREE.Color(0xC2C4C0);
    if (scene && scene.fog && scene.fog.color) haze.copy(scene.fog.color);
    const hazeMix = (hex, k) => haze.clone().lerp(new THREE.Color(hex), k);
    const matFarTree = track(new THREE.MeshStandardMaterial({
      color: hazeMix(0x2F4224, 0.34), roughness: 1.0, metalness: 0, fog: true,
    }));
    const matFarBuild = track(new THREE.MeshStandardMaterial({
      color: hazeMix(0x8A8578, 0.30), roughness: 1.0, metalness: 0, fog: true,
    }));

    // three arcs of distant woodland at 470–760 units
    const strips = [
      { r: 480, a0: -1.15, a1: 0.55, n: 120, s: 5.2 },
      { r: 640, a0: 1.05, a1: 2.75, n: 130, s: 6.4 },
      { r: 760, a0: 3.05, a1: 4.95, n: 130, s: 7.6 },
    ];
    const farTrees = [];
    for (const st2 of strips) {
      for (let i = 0; i < st2.n; i++) {
        const a = st2.a0 + (st2.a1 - st2.a0) * (i / st2.n) + rand(-0.006, 0.006);
        const rr = st2.r + rand(-26, 26);
        const x = cxm + Math.cos(a) * rr;
        const z = czm + Math.sin(a) * rr;
        farTrees.push({
          x, y: farH(x, z), z,
          rx: st2.s * rand(0.8, 1.5), ry: st2.s * rand(0.85, 1.6), rz: st2.s * rand(0.8, 1.5),
          ry2: R() * 6.283,
        });
      }
    }
    if (farTrees.length) {
      // ROUND-3 FIX 7 pays for itself here. A tree at 480–760 units is 3–6 px
      // tall; it needs mass and a broken top edge, not a clump cluster. Moving
      // the 380 horizon trees onto the 20-face hedge lump returns ~23 k
      // triangles, which is more than the richer canopy costs on the ~500 trees
      // the player can actually see.
      const im = new THREE.InstancedMesh(G.hedge, matFarTree, farTrees.length);
      const mtx = new THREE.Matrix4(), qt = new THREE.Quaternion(), eu = new THREE.Euler();
      const pv = new THREE.Vector3(), sv = new THREE.Vector3();
      farTrees.forEach((t, i) => {
        pv.set(t.x, t.y + t.ry * 0.55, t.z);
        sv.set(t.rx, t.ry, t.rz);
        eu.set(0, t.ry2, 0);
        qt.setFromEuler(eu);
        mtx.compose(pv, qt, sv);
        im.setMatrixAt(i, mtx);
      });
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = false;
      im.receiveShadow = false;
      group.add(im);
    }

    // one silhouetted town out on the plain
    {
      const a = 2.15, rr = 690;
      const sx = cxm + Math.cos(a) * rr, sz = czm + Math.sin(a) * rr;
      const parts = [];
      for (let i = 0; i < 18; i++) {
        const bh = rand(7, 20);
        parts.push(partBox(rand(9, 20), bh, rand(9, 20),
          rand(-56, 56), bh * 0.5, rand(-34, 34), 0, R() * 3.14, 0));
      }
      for (let i = 0; i < 4; i++) parts.push(partBox(6.8, 34, 6.8, -46 + i * 7.4, 17, 22));
      parts.push(partBox(7, 42, 7, 40, 21, -18));                 // chimney stack
      const town = new THREE.Mesh(track(mergeGeos(parts)), matFarBuild);
      town.position.set(sx, farH(sx, sz), sz);
      town.rotation.y = R() * Math.PI;
      town.castShadow = false;
      town.receiveShadow = false;
      group.add(town);
    }

    // two static columns over the far side of the front. VFX is initialised
    // AFTER features (main.js boot order), so this polls a frame at a time
    // until the pools exist, then keeps them alive: VFX evicts the oldest
    // burner when a busy turn fills its 24 slots.
    const farSmoke = [
      { x: cxm + Math.cos(-0.34) * 600, z: czm + Math.sin(-0.34) * 600, scale: 3.4, burner: null },
      { x: cxm + Math.cos(0.52) * 720, z: czm + Math.sin(0.52) * 720, scale: 4.2, burner: null },
    ];
    for (const s of farSmoke) s.y = farH(s.x, s.z) + 2.0;
    const seedFarSmoke = () => {
      let ok = true;
      for (const s of farSmoke) {
        if (s.burner && s.burner.alive) continue;
        let bn = null;
        try {
          bn = VFX.smokeColumn({ x: s.x, y: s.y, z: s.z },
            { persistent: true, scale: s.scale, flames: false, color: 0x6A6560 });
        } catch (err) { bn = null; }
        if (bn) s.burner = bn; else ok = false;
      }
      return ok;
    };
    let smokeTries = 0;
    const pumpFarSmoke = () => {
      if (seedFarSmoke() || smokeTries++ > 900) return;
      requestAnimationFrame(pumpFarSmoke);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(pumpFarSmoke);
    if (typeof setInterval === 'function') farSmokeTimer = setInterval(seedFarSmoke, 20000);
  }

  // --------------------------------------------- pre-battle scarring
  // CRITIQUE r1 fix 29: turn 1 opened on a pristine agricultural landscape in a
  // Donbas-front wargame. The ground has been fought over before the player
  // arrives — craters with ejecta rims, cold burnt-out hulls in the treeline
  // shadow, and dug-in trench lines with wire on the RED bank.
  {
    const bnd = (L && L.bounds) || { minX: 0, maxX: 300 };
    const eastOf = (t) => ((L && L.river && typeof L.river.centerX === 'function')
      ? t.x > L.river.centerX(t.z) : t.x > (bnd.minX + bnd.maxX) * 0.5);
    // ROUND-4 FIX 12: same substitution as `openAt` above — the pre-battle
    // craters, trench lines and cold hulls keep the exact hex pool they had.
    const openTile = (t) => t && OPEN_TYPES.has(t.type)
      && t.type !== 'yard' && t.type !== 'marsh'
      && !t.settlement && !t.rail && !t.bridge;
    const pool = [];
    for (const t of tiles.values()) if (openTile(t)) pool.push(t);
    const pick = () => pool.length ? pool[(R() * pool.length) | 0] : null;

    // ---- craters
    const craters = [];
    const nCr = 8 + Math.floor(R() * 7);
    for (let i = 0; i < nCr && pool.length; i++) {
      const t = pick();
      if (!t) break;
      const cluster = 1 + Math.floor(R() * 3);
      for (let c = 0; c < cluster && craters.length < 26; c++) {
        const x = t.x + rand(-HEX.size * 0.9, HEX.size * 0.9);
        const z = t.z + rand(-HEX.size * 0.9, HEX.size * 0.9);
        craters.push({ x, y: heightAt(x, z) + 0.06, z, s: rand(4.5, 10.5), ry: R() * 6.283 });
      }
    }
    if (craters.length) {
      const im = new THREE.InstancedMesh(G.decal, M.crater, craters.length);
      const mtx = new THREE.Matrix4(), qt = new THREE.Quaternion(), eu = new THREE.Euler();
      const pv = new THREE.Vector3(), sv = new THREE.Vector3();
      craters.forEach((c, i) => {
        pv.set(c.x, c.y, c.z);
        sv.set(c.s, 1, c.s);
        groundQuat(qt, c.x, c.z, c.ry, c.s * 0.4);
        mtx.compose(pv, qt, sv);
        im.setMatrixAt(i, mtx);
      });
      im.instanceMatrix.needsUpdate = true;
      im.renderOrder = 2;
      im.castShadow = false;
      im.receiveShadow = false;
      group.add(im);
      // thrown spoil so a crater has a third dimension at close zoom
      const spoil = [];
      for (const c of craters) {
        const n = 3 + Math.floor(R() * 4);
        for (let i = 0; i < n; i++) {
          const a = R() * 6.283;
          const rr = c.s * rand(0.28, 0.52);
          const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
          spoil.push({ x, y: heightAt(x, z), z, s: rand(0.35, 0.9), ry: R() * 6.283 });
        }
      }
      const sm = new THREE.InstancedMesh(G.blob, M.earth, spoil.length);
      const mtx2 = new THREE.Matrix4(), qt2 = new THREE.Quaternion(), eu2 = new THREE.Euler();
      const pv2 = new THREE.Vector3(), sv2 = new THREE.Vector3();
      spoil.forEach((s2, i) => {
        pv2.set(s2.x, s2.y + s2.s * 0.28, s2.z);
        sv2.set(s2.s * 1.5, s2.s * 0.55, s2.s * 1.3);
        eu2.set(0, s2.ry, 0);
        qt2.setFromEuler(eu2);
        mtx2.compose(pv2, qt2, sv2);
        sm.setMatrixAt(i, mtx2);
      });
      sm.instanceMatrix.needsUpdate = true;
      sm.castShadow = true;
      sm.receiveShadow = true;
      group.add(sm);
    }

    // ---- cold burnt-out hulls, hugging the treelines
    const forestList = (L && L.forest) || [];
    const nHulls = 3 + Math.floor(R() * 3);
    for (let i = 0; i < nHulls; i++) {
      let x, z;
      if (forestList.length) {
        const h = forestList[(R() * forestList.length) | 0];
        const c = wpos(h);
        const a = R() * 6.283;
        const rr = rand(HEX.size * 0.9, HEX.size * 1.8);
        x = c.x + Math.cos(a) * rr;
        z = c.z + Math.sin(a) * rr;
      } else {
        const t = pick();
        if (!t) break;
        x = t.x; z = t.z;
      }
      const y = heightAt(x, z);
      const g2 = new THREE.Group();
      g2.position.set(x, y, z);
      g2.rotation.y = R() * 6.283;
      const d2 = decal(0, 0, 11, 0);
      d2.position.set(0, 0.07, 0);
      g2.add(d2);
      g2.add(buildWreck(R() < 0.7 ? 'armor' : 'truck'));
      group.add(g2);
    }

    // ---- trench lines on the RED bank
    const trenchSpots = [];
    for (const t of tiles.values()) {
      if (!openTile(t) || !eastOf(t)) continue;
      const rd = (L && L.river && typeof L.river.dist === 'function')
        ? L.river.dist(t.x, t.z) : 999;
      if (rd < 14 || rd > 46) continue;
      trenchSpots.push(t);
    }
    const nTr = Math.min(trenchSpots.length, 3 + Math.floor(R() * 2));
    const usedTr = [];
    const berms = [], bags = [], stakes = [];
    for (let i = 0; i < nTr; i++) {
      let t = null;
      for (let a = 0; a < 24; a++) {
        const cand = trenchSpots[(R() * trenchSpots.length) | 0];
        if (!cand) break;
        if (usedTr.some((u) => Math.hypot(u.x - cand.x, u.z - cand.z) < 46)) continue;
        t = cand;
        break;
      }
      if (!t) continue;
      usedTr.push(t);
      // a zig-zag of 3–4 legs, roughly parallel to the river (i.e. facing west)
      const baseAng = Math.PI / 2 + rand(-0.5, 0.5);
      let px = t.x, pz = t.z;
      const wirePts = [];
      for (let leg = 0; leg < 3 + Math.floor(R() * 2); leg++) {
        const ang = baseAng + (leg % 2 ? rand(0.35, 0.7) : rand(-0.7, -0.35));
        const len = rand(7, 11);
        const mxp = px + Math.cos(ang) * len * 0.5;
        const mzp = pz + Math.sin(ang) * len * 0.5;
        const yy = heightAt(mxp, mzp);
        // the cut. A mesh's local +Z lands on (sin ry, cos ry), so aligning it
        // with a heading of `ang` in (cos, sin) form needs ry = π/2 − ang.
        const legRy = Math.PI / 2 - ang;
        const cut = mk(G.decal, M.trench, mxp, yy + 0.06, mzp, 3.2, 1, len + 1.2, legRy);
        groundQuat(cut.quaternion, mxp, mzp, legRy, len * 0.4);
        cut.renderOrder = 3;
        cut.castShadow = false;
        cut.receiveShadow = false;
        group.add(cut);
        // spoil parapet on the enemy side (west)
        const nx = Math.cos(ang + Math.PI / 2), nz = Math.sin(ang + Math.PI / 2);
        const side = (nx < 0) ? 1 : -1;
        for (let s2 = 0; s2 < 5; s2++) {
          const tt = (s2 + 0.5) / 5;
          const bx = px + Math.cos(ang) * len * tt + nx * side * 1.5;
          const bz = pz + Math.sin(ang) * len * tt + nz * side * 1.5;
          berms.push({
            x: bx, y: heightAt(bx, bz) + 0.26, z: bz, ry: legRy + rand(-0.2, 0.2),
            w: rand(1.5, 2.4), h: rand(0.42, 0.7), d: rand(1.6, 2.6),
          });
          if (R() < 0.4) {
            bags.push({
              x: bx + rand(-0.6, 0.6), y: heightAt(bx, bz) + 0.66, z: bz + rand(-0.6, 0.6),
              ry: legRy + rand(-0.3, 0.3),
            });
          }
        }
        // stakes + wire, one bound further out
        for (let s2 = 0; s2 <= 3; s2++) {
          const tt = s2 / 3;
          const wx = px + Math.cos(ang) * len * tt + nx * side * 4.6;
          const wz = pz + Math.sin(ang) * len * tt + nz * side * 4.6;
          const wy = heightAt(wx, wz);
          stakes.push({ x: wx, y: wy + 0.55, z: wz, ry: legRy });
          wirePts.push(wx, wy + 0.95, wz);
          wirePts.push(wx + (R() - 0.5) * 0.4, wy + 0.35, wz + (R() - 0.5) * 0.4);
          if (s2 > 0) {
            wirePts.push(wx, wy + 0.85, wz);
            wirePts.push(px + Math.cos(ang) * len * ((s2 - 1) / 3) + nx * side * 4.6,
              heightAt(px + Math.cos(ang) * len * ((s2 - 1) / 3) + nx * side * 4.6,
                pz + Math.sin(ang) * len * ((s2 - 1) / 3) + nz * side * 4.6) + 0.85,
              pz + Math.sin(ang) * len * ((s2 - 1) / 3) + nz * side * 4.6);
          }
        }
        px += Math.cos(ang) * len;
        pz += Math.sin(ang) * len;
      }
      if (wirePts.length) {
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', new THREE.Float32BufferAttribute(wirePts, 3));
        track(wg);
        group.add(new THREE.LineSegments(wg, M.barbed));
      }
    }
    // parapet spoil, sandbags and wire stakes across every trench: three
    // instanced meshes rather than ~150 individual ones
    {
      const mtx = new THREE.Matrix4(), qt = new THREE.Quaternion(), eu = new THREE.Euler();
      const pv = new THREE.Vector3(), sv = new THREE.Vector3();
      const put = (list, geo, mat, size) => {
        if (!list.length) return;
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        list.forEach((b, i) => {
          pv.set(b.x, b.y, b.z);
          size(b, sv);
          eu.set(0, b.ry || 0, 0);
          qt.setFromEuler(eu);
          mtx.compose(pv, qt, sv);
          im.setMatrixAt(i, mtx);
        });
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = true;
        im.receiveShadow = true;
        group.add(im);
      };
      put(berms, G.box, M.earth, (b, s) => s.set(b.w, b.h, b.d));
      put(bags, G.box, M.sandbag, (b, s) => s.set(0.6, 0.34, 1.0));
      put(stakes, G.box, M.tie, (b, s) => s.set(0.14, 1.1, 0.14));
    }
  }

  // ----------------------------------------------------------------- API
  function infraById(id) {
    return infrastructure.find((o) => o.id === id) || null;
  }

  function damageInfrastructure(id, dmg) {
    const obj = infraById(id);
    if (!obj) return null;
    if (!obj.alive) return obj;
    obj.hp = Math.max(0, obj.hp - Math.max(0, dmg || 0));
    const frac = obj.maxHp > 0 ? obj.hp / obj.maxHp : 0;
    const pos = infraWorldPos(obj);
    if (obj.hp <= 0) {
      obj.alive = false;
      setInfraState(obj, 'destroyed');
      // VFX's own infraDestroyed hook adds the blast; this is the persistent column
      try {
        VFX.smokeColumn(pos, { persistent: true, scale: 1.6, flames: true });
      } catch (err) { /* pre-init */ }
      try { Game.emit('infraDestroyed', obj); } catch (err) { /* stub bus */ }
    } else if (frac <= 0.67) {
      if (obj.state !== 'damaged') {
        setInfraState(obj, 'damaged');
        try { VFX.smokeColumn(pos, { duration: 18, scale: 1.0 }); } catch (err) { /* pre-init */ }
      }
    }
    return obj;
  }

  function update() { /* water + overlays animate from onBeforeRender */ }

  function dispose() {
    if (farSmokeTimer !== null && typeof clearInterval === 'function') {
      clearInterval(farSmokeTimer);
      farSmokeTimer = null;
    }
    if (scene) scene.remove(group);
    for (const o of trash) { if (o && typeof o.dispose === 'function') o.dispose(); }
    trash.length = 0;
  }

  const features = {
    group,
    infrastructure,
    objectiveMarkers,
    water,
    infraById,
    damageInfrastructure,
    setWreck,
    setObjectiveOwner,
    setInfraState: (id, state) => setInfraState(infraById(id), state),
    update,
    dispose,
  };
  return features;
}
