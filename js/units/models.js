// STEEL SIGNAL — units/models.js
// Procedural PBR unit models. Zero external assets: every vehicle is built from
// primitive BufferGeometry, merged per-material, with AO-ish darkening baked into
// vertex colours and box-projected UVs so the camo canvas texture from assets.js
// tiles at a consistent world scale on every panel.
//
// Contract (ARCHITECTURE.md §units/models.js):
//   export function buildUnitMesh(typeId, faction) -> THREE.Group
//   export function buildGhostMesh(typeId)         -> THREE.Group
// Named children (read by fx/vfx.js and fx/dronecam.js):
//   'turret'  — traversable mount            (mbt, ifv, apc, spg, mlrs, aa, atgm_team, loiter)
//   'barrel'  — gun/launcher; vfx.muzzle() flashes at its world pos + 1.7 forward
//               and recoils it along -normalize(barrel.position), so a barrel node
//               ALWAYS sits forward (+x) of its parent's origin.
//   'props'   — drone rotor hub; vfx.droneProps() spins each child about its local Y.
//               Fixed-wing/pusher hubs carry rotation.z = -90° so that local Y maps
//               to the airframe's +X (thrust axis).
// Forward is +X, up is +Y (units.js faces BLUE at ry 0, RED at ry PI).
//
// Geometry is built once per unit type and cached; instances share it and differ
// only by material (per-instance camo offset/rotation + hue/wear jitter), so a
// full order of battle costs a handful of draw calls per unit, not hundreds.

import * as THREE from 'three';
import * as Assets from '../core/assets.js';
import { rng } from '../core/rng.js';

// PHASE-2: the shared relief library (normal / roughness / AO for 23 surface
// classes) now lives in core/assets.js and this file ADOPTS it — see
// `applySurface()`. The import is a NAMESPACE import on purpose: a named import
// of a symbol that a given build of assets.js does not export is a module-LOAD
// error, and models.js must still boot against an older asset library. Every
// access below is guarded and falls back to this file's own local painters.
const Mat = Assets.Mat || null;
const Surf = Assets.Surf || null;
const bindSurface = typeof Assets.bindSurface === 'function' ? Assets.bindSurface : null;

const DEG = Math.PI / 180;
const UV_SCALE = 0.34;          // world units -> camo texture repeats
const WHITE = new THREE.Color(0xffffff);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;

// ======================================================== roughness contract
// CRITIQUE ROUND-3 FIX 14. `MeshStandardMaterial.roughness` is a [0,1] quantity:
// three's `lights_physical_fragment` computes
//     material.roughness = min( max( roughnessMap.g * roughness, 0.0525 )
//                               + geometryRoughness, 1.0 )
// so the FINAL value saturates at 1. A scalar above 1 is therefore a number the
// renderer cannot represent — and, worse, it is silently *lossy in one
// direction*: it does nothing at all on the low texels of the roughness map and
// gets flattened onto the ceiling on the high ones and on high-curvature texels,
// so the top of a per-instance spread partly disappears and every instance in it
// converges on the same surface. The round-3 traverse found armour materials at
// **1.0291 / 1.0070 / 1.0008** out of an authored centre of 0.9731 ± 0.06 —
// i.e. the top 28 % of the authored paint-batch band was living out of contract.
//
// Every roughness this file assigns now goes through `roughJit()` / `roughJitMul()`.
// They clamp the SOLVED CENTRE into the band with the jitter's own half-span held
// back as headroom, and only then apply the jitter — so the authored spread always
// survives whole and only its centre moves, and it only moves when the solve asked
// for something outside [0,1] in the first place.
//
// Consequence, stated honestly: where the ceiling bites, the rendered MEAN drifts
// down by the amount the centre was moved. For `armor` that is a solved centre of
// 0.9731 → 0.94, i.e. an as-rendered mean roughness of 0.72 → 0.696 (−3.4 %),
// which is well inside the ±8 % vehicle-to-vehicle spread it buys back. See
// INTEGRATION_NOTES "round-3 models pass".
const ROUGH_MIN = 0.04;         // below this, ACES + a 4.4 sun gives a mirror
const ROUGH_MAX = 1.00;         // the shader's own ceiling

// centre ± half, kept inside [ROUGH_MIN, ROUGH_MAX] without ever losing span.
function roughJit(centre, j, half) {
  const h = clamp(Math.abs(half || 0), 0, (ROUGH_MAX - ROUGH_MIN) * 0.5);
  return clamp(clamp(centre, ROUGH_MIN + h, ROUGH_MAX - h) + (j || 0),
    ROUGH_MIN, ROUGH_MAX);
}

// Same contract for a MULTIPLICATIVE jitter, where `k` rides in 1 ± half.
function roughJitMul(centre, k, half) {
  const h = clamp(Math.abs(half || 0), 0, 0.45);
  return clamp(clamp(centre, ROUGH_MIN / (1 - h), ROUGH_MAX / (1 + h)) * k,
    ROUGH_MIN, ROUGH_MAX);
}

// ======================================================== procedural surfaces
// CRITIQUE ROUND-2 FIX 1. The live traverse counted 1210 material slots, 652
// with a diffuse map, exactly ONE with a normalMap and ZERO with a
// roughnessMap — which is the whole of the "flat, plasticky" verdict. Every
// material this file hands to a mesh now carries a tiling tangent-space normal
// map AND a roughness map.
//
// PHASE 2: those maps now come from the SHARED library in core/assets.js
// (`Surf` / `bindSurface`, kinds `vehicle` / `track` / `cloth`) instead of from
// this file, so a hull plate, a bridge girder and a wreck are lit by the same
// weld beads and there is exactly one GPU upload for all of them. The library
// also carries an **aoMap**, which nothing in the scene had before — that is the
// contact darkening in every hatch rim and panel recess.
// The painters below are kept as a LAZY, PER-KEY fallback: they are only
// executed for a map the shared library could not supply (today that is just
// the track LINK-PITCH tile, whose shoe/hinge/bolt pattern the shared rubber
// tile does not carry), or for every map if assets.js is an older build.
//
// Why it works without tangent attributes: three's `normal_fragment_maps`
// falls back to `getTangentFrame()` (screen-space derivatives) when no tangent
// attribute is present. That fallback needs the UVs to be affine ACROSS EACH
// TRIANGLE, which is why `projectUV()` below picks its projection axis from the
// FACE normal rather than the vertex normal — see the note there.
//
// Scale contract: UVs are box-projected at UV_SCALE = 0.34 repeats per world
// unit, so a texture at repeat 1 covers 1/0.34 ≈ 2.94 world units — roughly one
// rolled hull plate. Every `nr` (normal repeat) below is expressed against that.

const SURF = 512;

function surfCtx(size) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c.getContext('2d', { willReadFrequently: true });
}

// Draw `fn` nine times on a 3×3 lattice so any primitive that crosses an edge
// reappears on the opposite one — the tile is genuinely seamless, which matters
// because these maps repeat every ~2.9 units on a 5-unit hull. `fn` must be
// deterministic (all randomness is pre-rolled into arrays before the call).
function tileDraw(g, size, fn) {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      g.save();
      g.translate(ox * size, oy * size);
      fn();
      g.restore();
    }
  }
}

// Seamless draw for a SMALL primitive: the 3×3 tileDraw above is correct but
// costs 9× for every dot, and these fields run to thousands of dots. A dot only
// needs a wrapped copy when it is within its own radius of an edge, so this
// draws 1 + (0–3) times instead of 9. Same result, ~8× cheaper at boot.
function wrapDot(S, x, y, r, draw) {
  draw(x, y);
  const lx = x < r ? S : (x > S - r ? -S : 0);
  const ly = y < r ? S : (y > S - r ? -S : 0);
  if (lx) draw(x + lx, y);
  if (ly) draw(x, y + ly);
  if (lx && ly) draw(x + lx, y + ly);
}

// Wobbly polyline through a straight run — a hand-laid weld is never a ruler
// line, and a ruler line is exactly what makes procedural panels read as CAD.
function seamPath(vertical, p, size, amp, R) {
  const pts = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * size;
    const j = (R() - 0.5) * 2 * amp;
    pts.push(vertical ? [p + j, t] : [t, p + j]);
  }
  return pts;
}

function strokePath(g, pts, w, style, cap) {
  g.strokeStyle = style;
  g.lineWidth = w;
  g.lineCap = cap || 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke();
}

// Grey-scale height canvas -> tangent-space normal texture. Central differences
// are modulo the canvas size, so the normal map tiles exactly like its source.
function heightToNormal(g, strength, blurR) {
  if (!g) return null;
  const size = g.canvas.width;
  const src = g.getImageData(0, 0, size, size).data;
  let h = new Float32Array(size * size);
  for (let i = 0, p = 0; i < h.length; i++, p += 4) {
    h[i] = (src[p] * 0.299 + src[p + 1] * 0.587 + src[p + 2] * 0.114) / 255;
  }
  if (blurR > 0) {
    const tmp = new Float32Array(size * size);
    const w = blurR * 2 + 1;
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let k = -blurR; k <= blurR; k++) s += h[row + ((x + k + size) % size)];
        tmp[row + x] = s / w;
      }
    }
    const out = new Float32Array(size * size);
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        let s = 0;
        for (let k = -blurR; k <= blurR; k++) s += tmp[((y + k + size) % size) * size + x];
        out[y * size + x] = s / w;
      }
    }
    h = out;
  }
  const dst = surfCtx(size);
  if (!dst) return null;
  const img = dst.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const yr = y * size;
    const yn = ((y - 1 + size) % size) * size;
    const yp = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const xn = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const dx = (h[yr + xp] - h[yr + xn]) * strength;
      const dy = (h[yp + x] - h[yn + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (yr + x) * 4;
      d[o] = (-dx * inv * 0.5 + 0.5) * 255;
      d[o + 1] = (dy * inv * 0.5 + 0.5) * 255;   // +Y up: canvas Y runs down
      d[o + 2] = inv * 255;
      d[o + 3] = 255;
    }
  }
  dst.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(dst.canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// Non-colour data texture (roughness). Deliberately NOT tagged sRGB.
function dataTex(g) {
  if (!g) return null;
  const t = new THREE.CanvasTexture(g.canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// ---- height painters -------------------------------------------------------

// Rolled armour plate: primer orange-peel, recessed plate seams with raised
// weld beads beside them, bolt rows, two hatch rims, lifting eyes, louvres,
// and a handful of dents. This is the map the critique asked for by name.
function paintArmorHeight(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);

  for (let i = 0; i < 1500; i++) {
    const px = R() * S, py = R() * S, pr = 1.4 + R() * 4.4;
    const v = R() < 0.5 ? 143 : 116;
    g.fillStyle = `rgba(${v},${v},${v},0.085)`;
    wrapDot(S, px, py, pr, (x, y) => {
      g.beginPath();
      g.arc(x, y, pr, 0, TAU);
      g.fill();
    });
  }

  // plate seams
  const seams = [];
  for (let i = 0; i < 3; i++) {
    seams.push({
      pts: seamPath(true, (i + 0.28 + R() * 0.42) * (S / 3), S, 2.2, R),
      bead: R() < 0.8, bolts: i === 1,
    });
  }
  for (let i = 0; i < 2; i++) {
    seams.push({
      pts: seamPath(false, (i + 0.32 + R() * 0.36) * (S / 2), S, 2.6, R),
      bead: R() < 0.7, bolts: i === 0,
    });
  }
  const bolts = [];
  for (const s of seams) {
    if (!s.bolts) continue;
    for (let i = 0; i < 16; i++) {
      const t = (i + 0.5) / 16 * (s.pts.length - 1);
      const a = s.pts[Math.floor(t)];
      const b = s.pts[Math.min(s.pts.length - 1, Math.floor(t) + 1)];
      const f = t - Math.floor(t);
      bolts.push([a[0] + (b[0] - a[0]) * f + 7, a[1] + (b[1] - a[1]) * f + 7]);
    }
  }

  // hatches, pads, louvre groups, dents — pre-rolled so the 9 passes agree
  const hatches = [];
  for (let i = 0; i < 2; i++) hatches.push([R() * S, R() * S, 26 + R() * 16]);
  const pads = [];
  for (let i = 0; i < 7; i++) pads.push([R() * S, R() * S, 14 + R() * 22, 9 + R() * 12, R() * TAU]);
  const louvres = [];
  for (let i = 0; i < 3; i++) {
    louvres.push([R() * S, R() * S, 40 + R() * 46, R() < 0.5 ? 0 : Math.PI / 2]);
  }
  const dents = [];
  for (let i = 0; i < 9; i++) dents.push([R() * S, R() * S, 9 + R() * 14, R() < 0.55]);

  tileDraw(g, S, () => {
    for (const s of seams) {
      strokePath(g, s.pts, 3.4, 'rgba(72,72,72,0.95)');
      if (s.bead) strokePath(g, s.pts, 2.6, 'rgba(176,176,176,0.85)');
    }
    for (const b of bolts) {
      g.fillStyle = 'rgba(196,196,196,0.9)';
      g.beginPath();
      g.arc(b[0], b[1], 2.9, 0, TAU);
      g.fill();
      g.strokeStyle = 'rgba(92,92,92,0.7)';
      g.lineWidth = 1.1;
      g.stroke();
    }
    for (const h of hatches) {
      g.strokeStyle = 'rgba(70,70,70,0.9)';
      g.lineWidth = 3.2;
      g.beginPath();
      g.arc(h[0], h[1], h[2], 0, TAU);
      g.stroke();
      g.strokeStyle = 'rgba(178,178,178,0.8)';
      g.lineWidth = 2.0;
      g.beginPath();
      g.arc(h[0], h[1], h[2] + 3.2, 0, TAU);
      g.stroke();
      g.strokeStyle = 'rgba(190,190,190,0.85)';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(h[0] - h[2] * 0.42, h[1] + h[2] * 0.5);
      g.lineTo(h[0] + h[2] * 0.42, h[1] + h[2] * 0.5);
      g.stroke();
    }
    for (const p of pads) {
      g.save();
      g.translate(p[0], p[1]);
      g.rotate(p[4]);
      g.fillStyle = 'rgba(160,160,160,0.55)';
      g.fillRect(-p[2] / 2, -p[3] / 2, p[2], p[3]);
      g.strokeStyle = 'rgba(96,96,96,0.5)';
      g.lineWidth = 1.4;
      g.strokeRect(-p[2] / 2, -p[3] / 2, p[2], p[3]);
      g.restore();
    }
    for (const L of louvres) {
      g.save();
      g.translate(L[0], L[1]);
      g.rotate(L[3]);
      for (let i = 0; i < 6; i++) {
        const y = -L[2] / 2 + (i + 0.5) * (L[2] / 6);
        g.fillStyle = 'rgba(56,56,56,0.85)';
        g.fillRect(-L[2] * 0.34, y - 1.6, L[2] * 0.68, 3.2);
        g.fillStyle = 'rgba(172,172,172,0.5)';
        g.fillRect(-L[2] * 0.34, y + 1.6, L[2] * 0.68, 1.6);
      }
      g.restore();
    }
    for (const d of dents) {
      const grd = g.createRadialGradient(d[0], d[1], 0, d[0], d[1], d[2]);
      const v = d[3] ? '90,90,90' : '150,150,150';
      grd.addColorStop(0, `rgba(${v},0.55)`);
      grd.addColorStop(1, `rgba(${v},0)`);
      g.fillStyle = grd;
      g.beginPath();
      g.arc(d[0], d[1], d[2], 0, TAU);
      g.fill();
    }
  });
  return g;
}

// Track band: four link pitches across the tile, each a raised shoe with a
// chamfered leading edge, a recessed hinge gap, connector bolts and a rubber
// pad panel. Bound at repeat 4.3 this lands a ~0.17 u link pitch on the belt.
function paintTrackHeight(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  const N = 4;
  const pitch = S / N;
  g.fillStyle = '#5C5C5C';
  g.fillRect(0, 0, S, S);
  tileDraw(g, S, () => {
    for (let i = 0; i < N; i++) {
      const x0 = i * pitch;
      // shoe body
      const grd = g.createLinearGradient(x0, 0, x0 + pitch * 0.82, 0);
      grd.addColorStop(0, '#8E8E8E');
      grd.addColorStop(0.16, '#C6C6C6');
      grd.addColorStop(0.84, '#B4B4B4');
      grd.addColorStop(1, '#6E6E6E');
      g.fillStyle = grd;
      g.fillRect(x0 + pitch * 0.06, -4, pitch * 0.78, S + 8);
      // rubber pad inset down the middle of the shoe
      g.fillStyle = 'rgba(120,120,120,0.85)';
      g.fillRect(x0 + pitch * 0.20, -4, pitch * 0.50, S + 8);
      // hinge gap
      g.fillStyle = '#3E3E3E';
      g.fillRect(x0 + pitch * 0.86, -4, pitch * 0.14, S + 8);
      // connector bolts, two rows
      for (let k = 0; k < 8; k++) {
        const y = (k + 0.5) * (S / 8);
        for (const bx of [x0 + pitch * 0.13, x0 + pitch * 0.77]) {
          g.fillStyle = '#DADADA';
          g.beginPath();
          g.arc(bx, y, 3.4, 0, TAU);
          g.fill();
          g.strokeStyle = 'rgba(70,70,70,0.8)';
          g.lineWidth = 1.2;
          g.stroke();
        }
      }
    }
  });
  for (let i = 0; i < 1600; i++) {
    const px = R() * S, py = R() * S, pr = 1 + R() * 3;
    const v = R() < 0.5 ? 150 : 96;
    g.fillStyle = `rgba(${v},${v},${v},0.10)`;
    wrapDot(S, px, py, pr, (x, y) => {
      g.beginPath();
      g.arc(x, y, pr, 0, TAU);
      g.fill();
    });
  }
  return g;
}

// Machined / cast steel: fine longitudinal brushing, a couple of weld beads,
// bolt heads and casting pits. Used on barrels, cages, mounts.
function paintMetalHeight(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);
  const brush = [];
  for (let i = 0; i < 420; i++) brush.push([R() * S, R() * S, 40 + R() * 180, R() < 0.5 ? 150 : 112]);
  const beads = [];
  for (let i = 0; i < 2; i++) beads.push(seamPath(false, (i + 0.4) * (S / 2), S, 2.0, R));
  const pits = [];
  for (let i = 0; i < 260; i++) pits.push([R() * S, R() * S, 1.5 + R() * 4]);
  const heads = [];
  for (let i = 0; i < 24; i++) heads.push([R() * S, R() * S, 2.6 + R() * 2.2]);
  tileDraw(g, S, () => {
    for (const b of brush) {
      g.strokeStyle = `rgba(${b[3]},${b[3]},${b[3]},0.14)`;
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(b[0], b[1]);
      g.lineTo(b[0] + b[2], b[1]);
      g.stroke();
    }
    for (const p of beads) {
      strokePath(g, p, 4.2, 'rgba(150,150,150,0.55)');
      strokePath(g, p, 1.6, 'rgba(96,96,96,0.55)');
    }
    for (const p of pits) {
      g.fillStyle = 'rgba(96,96,96,0.35)';
      g.beginPath();
      g.arc(p[0], p[1], p[2], 0, TAU);
      g.fill();
    }
    for (const h of heads) {
      g.fillStyle = 'rgba(184,184,184,0.7)';
      g.beginPath();
      g.arc(h[0], h[1], h[2], 0, TAU);
      g.fill();
    }
  });
  return g;
}

// Heavy canvas / webbing: a real over-under weave plus wrinkles and stitching.
function paintClothHeight(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  const N = 26;
  const step = S / N;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);
  const wrinkles = [];
  for (let i = 0; i < 9; i++) {
    const pts = [];
    let x = R() * S;
    let y = R() * S;
    const dx = (R() - 0.5) * 60;
    const dy = (R() - 0.5) * 60;
    for (let k = 0; k < 7; k++) {
      pts.push([x, y]);
      x += dx + (R() - 0.5) * 34;
      y += dy + (R() - 0.5) * 34;
    }
    wrinkles.push(pts);
  }
  tileDraw(g, S, () => {
    for (let i = 0; i < N; i++) {
      const p = i * step;
      g.fillStyle = 'rgba(178,178,178,0.42)';
      g.fillRect(p, 0, step * 0.5, S);
      g.fillStyle = 'rgba(96,96,96,0.30)';
      g.fillRect(p + step * 0.5, 0, step * 0.5, S);
    }
    for (let i = 0; i < N; i++) {
      const p = i * step;
      g.fillStyle = 'rgba(180,180,180,0.34)';
      g.fillRect(0, p + step * 0.5, S, step * 0.5);
      g.fillStyle = 'rgba(92,92,92,0.26)';
      g.fillRect(0, p, S, step * 0.5);
    }
    for (const w of wrinkles) {
      strokePath(g, w, 7, 'rgba(196,196,196,0.30)');
      strokePath(g, w, 3, 'rgba(78,78,78,0.34)');
    }
  });
  return g;
}

// Moulded composite / airframe plastic: fine speckle, a light carbon weave and
// two panel joints. Deliberately shallow — drones are smooth objects.
function paintCompositeHeight(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);
  const joints = [seamPath(true, S * 0.32, S, 1.2, R), seamPath(false, S * 0.68, S, 1.2, R)];
  tileDraw(g, S, () => {
    for (let i = 0; i < 64; i++) {
      const p = i * (S / 64);
      g.fillStyle = 'rgba(150,150,150,0.10)';
      g.fillRect(p, 0, S / 128, S);
      g.fillStyle = 'rgba(110,110,110,0.10)';
      g.fillRect(0, p, S, S / 128);
    }
    for (const j of joints) strokePath(g, j, 2.4, 'rgba(84,84,84,0.75)');
  });
  for (let i = 0; i < 2200; i++) {
    const px = R() * S, py = R() * S, pr = 0.8 + R() * 2.0;
    const v = R() < 0.5 ? 152 : 108;
    g.fillStyle = `rgba(${v},${v},${v},0.16)`;
    wrapDot(S, px, py, pr, (x, y) => {
      g.beginPath();
      g.arc(x, y, pr, 0, TAU);
      g.fill();
    });
  }
  return g;
}

// ---- optics ----------------------------------------------------------------
// CRITIQUE ROUND-3 FIX 18. `#optics` was the one surface on an otherwise
// well-detailed hull with no normal map: a flat 0x223038 gloss quad. That was a
// defensible exclusion at RTS range (a weld bead on a 4 cm sight block is
// specular noise) and it stopped being defensible the moment the build started
// supporting vehicle-closeup framing, because a sight block is the one part of a
// tank a viewer's eye is *trained* to look at.
//
// What this paints: an armoured sight hood with a bolted bezel, a rubber gasket,
// a laminated pane recessed behind it, a wiper sweep, chips at the pane edge and
// the hairline scratch field every real vision block carries. NOT weld beads —
// the whole point of a separate optics map is that the vehicle tile's plate
// seams are wrong here.
//
// SCALE, which is what makes this read at both ends of the zoom. The material
// binds at nr 6.0 against UV_SCALE 0.34, so one tile covers 1/(0.34·6) ≈ 0.49
// world units ≈ 49 cm. The 2×2 cell layout therefore puts a ~24 cm vision block
// in each quadrant — correct for a commander's periscope or a driver's block —
// while a 4 cm gunner's sight samples a fraction of one pane and shows laminate
// grooves and scratches only, which is exactly the right read at that size.
// Every structural element is inset inside its own quadrant, so the tile is
// seamless without paying tileDraw's 9× for the frame; only the wrapping fields
// (brushing, scratches, pits) go through tileDraw/wrapDot.
function paintOpticsHeight(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  const C = S / 2;                    // cell pitch — 2×2 blocks per tile
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);

  // ---- housing web: fine machined brushing between the blocks ---------------
  const brush = [];
  for (let i = 0; i < 300; i++) {
    brush.push([R() * S, R() * S, 26 + R() * 150, R() < 0.5 ? 146 : 112]);
  }
  tileDraw(g, S, () => {
    for (const b of brush) {
      g.strokeStyle = `rgba(${b[3]},${b[3]},${b[3]},0.12)`;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(b[0], b[1]);
      g.lineTo(b[0] + b[2], b[1]);
      g.stroke();
    }
  });

  // ---- drain / demist slots in the web -------------------------------------
  // The web is the full cross at x≈C and y≈C plus the tile border, so these sit
  // clear of every pane and clear of the tile edge.
  const slot = (x, y, w, h) => {
    g.fillStyle = greyOf(0.34);
    g.fillRect(x - w / 2, y - h / 2, w, h);
    g.fillStyle = greyOf(0.66);       // the pressed lip above the slot
    g.fillRect(x - w / 2, y - h / 2 - 3, w, 3);
  };
  for (let i = 0; i < 5; i++) slot(C, 48 + i * 104, 9, 36);
  for (let i = 0; i < 5; i++) if (i !== 2) slot(48 + i * 104, C, 36, 9);

  // ---- the vision blocks ---------------------------------------------------
  const HOOD = 22;                    // hood outer inset inside its quadrant
  const W = C - HOOD * 2;             // 212 px ≈ 20 cm of armoured hood
  const cell = (ox, oy, wiper) => {
    const x0 = ox + HOOD, y0 = oy + HOOD;
    // armoured hood, then its chamfered top face 6 px in
    g.fillStyle = greyOf(0.68);
    g.fillRect(x0, y0, W, W);
    g.fillStyle = greyOf(0.76);
    g.fillRect(x0 + 6, y0 + 6, W - 12, W - 12);
    // rubber gasket: a soft ridge on the shoulder of the aperture
    g.strokeStyle = greyOf(0.60);
    g.lineWidth = 8;
    g.lineJoin = 'round';
    g.strokeRect(x0 + 22, y0 + 22, W - 44, W - 44);
    // the pane, recessed behind the gasket
    const px = x0 + 28, py = y0 + 28, pw = W - 56;
    g.fillStyle = greyOf(0.40);
    g.fillRect(px, py, pw, pw);
    // laminate / prism lines: ~9 px pitch ≈ 8 mm, the optical signature that
    // survives any crop down to a 4 cm sight face
    for (let y = 4; y < pw - 2; y += 9) {
      g.fillStyle = greyOf(0.355);
      g.fillRect(px, py + y, pw, 2);
      g.fillStyle = greyOf(0.455);
      g.fillRect(px, py + y + 2, pw, 1);
    }
    // wiper sweep: a shallow polished groove hinged at the lower-left corner
    if (wiper) {
      g.save();
      g.beginPath();
      g.rect(px, py, pw, pw);
      g.clip();
      g.strokeStyle = greyOf(0.335);
      g.lineWidth = 5;
      g.beginPath();
      g.arc(px + 4, py + pw - 4, pw * 0.86, -Math.PI * 0.5, 0);
      g.stroke();
      g.strokeStyle = greyOf(0.47);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(px + 4, py + pw - 4, pw * 0.86 + 3.5, -Math.PI * 0.5, 0);
      g.stroke();
      g.restore();
    }
    // chips at the pane edge — a vision block that has been in the field
    for (let i = 0; i < 4; i++) {
      const e = (R() * 4) | 0;
      const t = 0.12 + R() * 0.76;
      const cx = e === 0 ? px + pw * t : e === 1 ? px + pw : e === 2 ? px + pw * t : px;
      const cy = e === 0 ? py : e === 1 ? py + pw * t : e === 2 ? py + pw : py + pw * t;
      const cr = 3 + R() * 6;
      g.fillStyle = greyOf(0.30);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + cr, cy + cr * 0.5);
      g.lineTo(cx + cr * 0.4, cy + cr * 1.3);
      g.closePath();
      g.fill();
    }
    // bezel bolts, one per hood corner, each with a driven slot
    const bo = 13;
    for (let i = 0; i < 4; i++) {
      const bx = x0 + (i & 1 ? W - bo : bo);
      const by = y0 + (i & 2 ? W - bo : bo);
      g.fillStyle = greyOf(0.90);
      g.beginPath();
      g.arc(bx, by, 6.5, 0, TAU);
      g.fill();
      g.strokeStyle = greyOf(0.52);
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(bx - 4.5, by);
      g.lineTo(bx + 4.5, by);
      g.stroke();
    }
  };
  cell(0, 0, false);
  cell(C, 0, true);
  cell(0, C, true);
  cell(C, C, false);

  // ---- hairline scratches over everything ----------------------------------
  const nicks = [];
  for (let i = 0; i < 110; i++) {
    const a = R() * TAU;
    const len = 7 + R() * 44;
    nicks.push([R() * S, R() * S, Math.cos(a) * len, Math.sin(a) * len,
      R() < 0.5 ? 158 : 100]);
  }
  tileDraw(g, S, () => {
    for (const n of nicks) {
      g.strokeStyle = `rgba(${n[4]},${n[4]},${n[4]},0.30)`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(n[0], n[1]);
      g.lineTo(n[0] + n[2], n[1] + n[3]);
      g.stroke();
    }
  });

  // ---- pitting: sand-blast on the hood, water spots on the pane -------------
  for (let i = 0; i < 1100; i++) {
    const px = R() * S, py = R() * S, pr = 0.7 + R() * 1.9;
    const v = R() < 0.5 ? 150 : 104;
    g.fillStyle = `rgba(${v},${v},${v},0.13)`;
    wrapDot(S, px, py, pr, (x, y) => {
      g.beginPath();
      g.arc(x, y, pr, 0, TAU);
      g.fill();
    });
  }
  return g;
}

// ---- roughness painters ----------------------------------------------------
// A roughness map MULTIPLIES material.roughness, so each painter is authored
// around a known mean (`base`) and the material's scalar is set to
// target / base. That keeps the art-bible roughness values (paint 0.72, ERA
// rubber 0.9, glass 0.15, tracks 0.85) as the MEANS of a real distribution
// instead of as flat constants.

function greyOf(v) {
  const b = Math.round(clamp(v, 0, 1) * 255);
  return `rgb(${b},${b},${b})`;
}

function paintRough(base, R, kind) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  g.fillStyle = greyOf(base);
  g.fillRect(0, 0, S, S);

  const blobs = [];
  const nb = kind === 'glass' ? 22 : 46;
  for (let i = 0; i < nb; i++) {
    blobs.push([R() * S, R() * S, 22 + R() * 96, (R() - 0.5) * 2]);
  }
  const streaks = [];
  const ns = kind === 'glass' ? 26 : 40;
  for (let i = 0; i < ns; i++) {
    streaks.push([R() * S, R() * S, 60 + R() * 260, (R() - 0.5) * 2, R() * (kind === 'glass' ? 0.5 : 0.35)]);
  }
  // spread: how far the map may swing either side of `base`
  const amp = kind === 'glass' ? 0.30 : kind === 'track' ? 0.20 : kind === 'cloth' ? 0.05 : 0.14;

  tileDraw(g, S, () => {
    for (const b of blobs) {
      const v = clamp(base + b[3] * amp, 0.02, 1);
      const grd = g.createRadialGradient(b[0], b[1], 0, b[0], b[1], b[2]);
      grd.addColorStop(0, greyOf(v));
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 0.55;
      g.fillStyle = grd;
      g.beginPath();
      g.arc(b[0], b[1], b[2], 0, TAU);
      g.fill();
      g.globalAlpha = 1;
    }
    // worn edges / wiped glass / polished track contact faces
    for (const s of streaks) {
      g.save();
      g.translate(s[0], s[1]);
      g.rotate(s[4]);
      g.globalAlpha = 0.4;
      g.strokeStyle = greyOf(clamp(base + s[3] * amp * 1.4, 0.02, 1));
      g.lineWidth = 3 + Math.abs(s[3]) * 9;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(s[2], 0);
      g.stroke();
      g.globalAlpha = 1;
      g.restore();
    }
  });
  g.globalAlpha = 0.22;
  for (let i = 0; i < 800; i++) {
    const px = R() * S, py = R() * S, pr = 1.5 + R() * 5;
    g.fillStyle = greyOf(clamp(base + (R() - 0.5) * 2 * amp * 0.7, 0.02, 1));
    wrapDot(S, px, py, pr, (x, y) => {
      g.beginPath();
      g.arc(x, y, pr, 0, TAU);
      g.fill();
    });
  }
  g.globalAlpha = 1;
  return g;
}

// ---- albedo painters -------------------------------------------------------
// CRITIQUE ROUND-4 FIX 8. The traverse found 28 of 130 unit material slots
// carrying a `map`, and every one of them was `#armor` (the camo canvas from
// assets.js). `#rubber` (0x3B3A34), `#dark` (0x4C4D43), `#optics` (0x223038)
// and `#canvas` (0x6D7250) carried normal + roughness relief over a FLAT colour
// uniform, which at the 19 u camera this build now supports reads as tinted
// plastic: right silhouette, right shading, no material identity.
//
// Every painter below is authored as a DETAIL map, not as a finished colour.
// `applySurface()` measures the tile's mean in working space (`textureMean`,
// one cached 32² readback) and DIVIDES the material's colour by it, so the art
// bible's albedo survives as the MEAN of a real distribution and the map
// supplies only the break around it. That is what lets the track tile carry a
// ~4:1 steel-to-rubber value break without moving the rendered mean of
// `#rubber` off 0x3B3A34 — the same solve the camo already uses (`armorSolve`).
// If the mean cannot be measured the map is NOT bound at all: an unsolved
// detail map would silently darken the surface by its own mean, and a wrong
// albedo is worse than a flat one.
//
// Contrast leash: nothing here is authored below ~0.4× the tile mean. Round
// 4's headline finding is that the frame is now three times too CRUSHED
// (p01 0.043–0.061 against PC2's map-area 0.176–0.223), so a black hinge gap on
// a track pad is precisely the wrong thing to add. The break is bought at the
// TOP — bare steel, bolt heads, bleached canvas — not at the bottom.
//
// Alignment: the `track` and `optics` tiles reproduce the layout CONSTANTS of
// their height painters (4 link pitches; a 2×2 grid of vision blocks inset by
// HOOD=22 with a 156 px pane), and both bind at the same repeat as the normal,
// so the steel/rubber break lands on the modelled shoe and the pane tint lands
// inside the modelled bezel rather than crawling across it.

// Warm dried-mud glaze — sprayed over a finished tile so the darkest structural
// texels come UP and the whole surface reads as field-used rather than as a
// clean material sample. Alpha stays low; this is a film, not a repaint.
function mudGlaze(g, R, n, alpha, spread) {
  const S = SURF;
  for (let i = 0; i < n; i++) {
    const px = R() * S, py = R() * S, pr = 3 + R() * spread;
    const w = R();
    const cr = (150 + w * 26) | 0;
    const cg = (128 + w * 22) | 0;
    const cb = (96 + w * 18) | 0;
    g.fillStyle = `rgba(${cr},${cg},${cb},${alpha})`;
    wrapDot(S, px, py, pr, (x, y) => {
      g.beginPath();
      g.arc(x, y, pr, 0, TAU);
      g.fill();
    });
  }
}

// Track band, aligned link-for-link with paintTrackHeight: steel shoe bodies,
// a moulded rubber pad down the middle of each shoe, a hinge gap and two rows
// of connector bolts. THIS is the "rubber/steel albedo break" the critique
// asked for by name — the pad sits at ~1/3 of the shoe face in linear value, so
// a close camera sees two materials on one belt instead of one dark extrusion.
// Bound at repeat 4.3 like its normal, i.e. a 0.171 u link pitch on the belt.
function paintTrackAlbedo(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  const N = 4;
  const pitch = S / N;
  g.fillStyle = '#4b4a45';
  g.fillRect(0, 0, S, S);
  tileDraw(g, S, () => {
    for (let i = 0; i < N; i++) {
      const x0 = i * pitch;
      // steel shoe face — polished by the ground at its centre, dirty at the lip
      const grd = g.createLinearGradient(x0, 0, x0 + pitch * 0.82, 0);
      grd.addColorStop(0, '#6b6c66');
      grd.addColorStop(0.18, '#9ba09c');
      grd.addColorStop(0.82, '#8d9188');
      grd.addColorStop(1, '#5d5e58');
      g.fillStyle = grd;
      g.fillRect(x0 + pitch * 0.06, -4, pitch * 0.78, S + 8);
      // moulded rubber pad, exactly the band paintTrackHeight recesses
      g.fillStyle = '#5e5c55';
      g.fillRect(x0 + pitch * 0.20, -4, pitch * 0.50, S + 8);
      // the pad's ground-contact strip, buffed lighter by the road
      g.fillStyle = 'rgba(148,148,142,0.26)';
      g.fillRect(x0 + pitch * 0.34, -4, pitch * 0.22, S + 8);
      // hinge gap — the darkest thing on the tile, and still ~0.45× the tile
      // mean: the break is bought at the top (bare steel, bolt heads), never by
      // pushing a texel toward black. See the contrast-leash note above.
      g.fillStyle = '#4d4c47';
      g.fillRect(x0 + pitch * 0.86, -4, pitch * 0.14, S + 8);
      // connector bolts on the same two rows as the height tile
      for (let k = 0; k < 8; k++) {
        const y = (k + 0.5) * (S / 8);
        for (const bx of [x0 + pitch * 0.13, x0 + pitch * 0.77]) {
          g.fillStyle = '#b3b6ae';
          g.beginPath();
          g.arc(bx, y, 3.2, 0, TAU);
          g.fill();
        }
      }
    }
  });
  // rust bloom at the shoe lips, then mud packed into everything
  for (let i = 0; i < 220; i++) {
    const px = R() * S, py = R() * S, pr = 2 + R() * 7;
    g.fillStyle = `rgba(126,86,58,${0.10 + R() * 0.16})`;
    wrapDot(S, px, py, pr, (x, y) => {
      g.beginPath();
      g.arc(x, y, pr, 0, TAU);
      g.fill();
    });
  }
  mudGlaze(g, R, 420, 0.13, 16);
  return g;
}

// Painted steel: gun tubes, mounts, cages, exhausts. Mostly olive paint with
// bare-metal chips at the wear points, two tempering bands where the tube has
// been hot, oil weeping from a seam, and rust freckles.
function paintMetalAlbedo(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  g.fillStyle = '#8b8d84';
  g.fillRect(0, 0, S, S);

  // tempering bands — straw and blue-grey, the one feature that says "fired"
  const bands = [[R() * S, 46 + R() * 66, 150, 118, 84], [R() * S, 34 + R() * 52, 112, 120, 130]];
  for (const b of bands) {
    for (let o = -1; o <= 1; o++) {
      const y0 = b[0] + o * S - b[1];
      const grd = g.createLinearGradient(0, y0, 0, y0 + b[1] * 2);
      grd.addColorStop(0, `rgba(${b[2]},${b[3]},${b[4]},0)`);
      grd.addColorStop(0.5, `rgba(${b[2]},${b[3]},${b[4]},0.55)`);
      grd.addColorStop(1, `rgba(${b[2]},${b[3]},${b[4]},0)`);
      g.fillStyle = grd;
      g.fillRect(0, y0, S, b[1] * 2);
    }
  }

  // longitudinal brushing — the value break that keeps a barrel from reading
  // as one flat cylinder when the sun rakes along it
  const brush = [];
  for (let i = 0; i < 340; i++) {
    brush.push([R() * S, R() * S, 50 + R() * 210, R() < 0.5 ? 164 : 118]);
  }
  const seams = [seamPath(false, (0.42 + R() * 0.16) * S, S, 2.2, R)];
  const chips = [];
  for (let i = 0; i < 90; i++) chips.push([R() * S, R() * S, 2.5 + R() * 7, R()]);
  tileDraw(g, S, () => {
    for (const b of brush) {
      g.strokeStyle = `rgba(${b[3]},${b[3]},${b[3]},0.13)`;
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(b[0], b[1]);
      g.lineTo(b[0] + b[2], b[1]);
      g.stroke();
    }
    for (const p of seams) {
      strokePath(g, p, 4.0, 'rgba(158,160,152,0.34)');
      strokePath(g, p, 1.4, 'rgba(104,102,94,0.40)');
    }
    // bare-metal chips: paint knocked off an edge, lighter and colder
    for (const c of chips) {
      g.fillStyle = c[3] < 0.62 ? 'rgba(188,190,184,0.55)' : 'rgba(128,92,64,0.45)';
      g.beginPath();
      g.moveTo(c[0], c[1]);
      g.lineTo(c[0] + c[2], c[1] + c[2] * 0.42);
      g.lineTo(c[0] + c[2] * 0.35, c[1] + c[2] * 1.15);
      g.closePath();
      g.fill();
    }
  });
  // soot / oil weeping down from the seam, and casting speckle
  for (let i = 0; i < 900; i++) {
    const px = R() * S, py = R() * S, pr = 1.2 + R() * 3.4;
    const dark = R() < 0.5;
    g.fillStyle = dark ? 'rgba(96,96,90,0.16)' : 'rgba(176,178,170,0.16)';
    wrapDot(S, px, py, pr, (x, y) => {
      g.beginPath();
      g.arc(x, y, pr, 0, TAU);
      g.fill();
    });
  }
  mudGlaze(g, R, 180, 0.09, 14);
  return g;
}

// Tarpaulin / webbing / bustle-rack cover. The weave is the same over-under the
// height tile models, so the colour break sits on the modelled threads: warp a
// shade cooler than weft, sun-bleached patches on the crowns, dirt in the folds.
function paintClothAlbedo(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  const N = 26;
  const step = S / N;
  g.fillStyle = '#94967e';
  g.fillRect(0, 0, S, S);
  const bleach = [];
  for (let i = 0; i < 26; i++) bleach.push([R() * S, R() * S, 24 + R() * 74]);
  // Pre-rolled, INCLUDING the run's sideways drift: `tileDraw` executes its
  // callback nine times and a callback that consumes R() would paint nine
  // different streaks, which is exactly how a "seamless" tile grows a seam.
  const streaks = [];
  for (let i = 0; i < 16; i++) {
    streaks.push([R() * S, R() * S, 60 + R() * 190, 5 + R() * 13, (R() - 0.5) * 26]);
  }
  tileDraw(g, S, () => {
    for (let i = 0; i < N; i++) {
      const p = i * step;
      g.fillStyle = 'rgba(168,170,146,0.34)';
      g.fillRect(p, 0, step * 0.5, S);
      g.fillStyle = 'rgba(112,114,94,0.26)';
      g.fillRect(p + step * 0.5, 0, step * 0.5, S);
    }
    for (let i = 0; i < N; i++) {
      const p = i * step;
      g.fillStyle = 'rgba(158,158,132,0.26)';
      g.fillRect(0, p + step * 0.5, S, step * 0.5);
      g.fillStyle = 'rgba(106,108,90,0.20)';
      g.fillRect(0, p, S, step * 0.5);
    }
    // sun-bleached crowns — the top of a fold loses its dye first
    for (const b of bleach) {
      const grd = g.createRadialGradient(b[0], b[1], 0, b[0], b[1], b[2]);
      grd.addColorStop(0, 'rgba(196,196,170,0.34)');
      grd.addColorStop(1, 'rgba(196,196,170,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(b[0], b[1], b[2], 0, TAU);
      g.fill();
    }
    // dirt run-off down the folds
    for (const s of streaks) {
      g.strokeStyle = 'rgba(104,88,62,0.20)';
      g.lineWidth = s[3];
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(s[0], s[1]);
      g.lineTo(s[0] + s[4], s[1] + s[2]);
      g.stroke();
    }
  });
  mudGlaze(g, R, 260, 0.10, 18);
  return g;
}

// Vision blocks and sight faces, laid out cell-for-cell with paintOpticsHeight
// (2×2 blocks, HOOD 22, pane 156 px). The hood is armour grey, the gasket is
// black rubber and the pane carries an anti-reflection coating that swings
// green→violet across its face — which is what makes a sight read as GLASS at
// 19 u instead of as a dark painted rectangle, and it is the reason `#optics`
// was the last unfinished-looking part of an otherwise well-detailed hull.
function paintOpticsAlbedo(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  const C = S / 2;
  const HOOD = 22;
  const W = C - HOOD * 2;
  g.fillStyle = '#6d706a';
  g.fillRect(0, 0, S, S);

  // machined web between the blocks
  const brush = [];
  for (let i = 0; i < 240; i++) brush.push([R() * S, R() * S, 24 + R() * 130, R() < 0.5 ? 132 : 104]);
  tileDraw(g, S, () => {
    for (const b of brush) {
      g.strokeStyle = `rgba(${b[3]},${b[3]},${b[3]},0.16)`;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(b[0], b[1]);
      g.lineTo(b[0] + b[2], b[1]);
      g.stroke();
    }
  });

  const cell = (ox, oy, coat) => {
    const x0 = ox + HOOD, y0 = oy + HOOD;
    g.fillStyle = '#7a7d76';
    g.fillRect(x0, y0, W, W);
    g.fillStyle = '#878a82';
    g.fillRect(x0 + 6, y0 + 6, W - 12, W - 12);
    // rubber gasket
    g.strokeStyle = '#4f4f4b';
    g.lineWidth = 8;
    g.lineJoin = 'round';
    g.strokeRect(x0 + 22, y0 + 22, W - 44, W - 44);
    // the pane, with its coating swing across the face
    const px = x0 + 28, py = y0 + 28, pw = W - 56;
    const grd = g.createLinearGradient(px, py, px + pw, py + pw);
    if (coat) {
      grd.addColorStop(0, '#3d5a52');
      grd.addColorStop(0.55, '#4a5f66');
      grd.addColorStop(1, '#54506b');
    } else {
      grd.addColorStop(0, '#4a5566');
      grd.addColorStop(0.5, '#3f584f');
      grd.addColorStop(1, '#4d5560');
    }
    g.fillStyle = grd;
    g.fillRect(px, py, pw, pw);
    // laminate lines on the same 9 px pitch the height tile grooves
    for (let y = 4; y < pw - 2; y += 9) {
      g.fillStyle = 'rgba(46,58,62,0.30)';
      g.fillRect(px, py + y, pw, 2);
      g.fillStyle = 'rgba(126,140,140,0.16)';
      g.fillRect(px, py + y + 2, pw, 1);
    }
    // water spots and a dust film creeping in from the gasket
    for (let i = 0; i < 26; i++) {
      const sx = px + R() * pw, sy = py + R() * pw, sr = 1.6 + R() * 4.4;
      g.fillStyle = `rgba(158,166,160,${0.10 + R() * 0.14})`;
      g.beginPath();
      g.arc(sx, sy, sr, 0, TAU);
      g.fill();
    }
    // bezel bolts on the height tile's corners
    const bo = 13;
    for (let i = 0; i < 4; i++) {
      const bx = x0 + (i & 1 ? W - bo : bo);
      const by = y0 + (i & 2 ? W - bo : bo);
      g.fillStyle = '#b6b8b0';
      g.beginPath();
      g.arc(bx, by, 6.0, 0, TAU);
      g.fill();
    }
  };
  cell(0, 0, false);
  cell(C, 0, true);
  cell(0, C, true);
  cell(C, C, false);

  // hood dust — heavy, because nobody wipes the hood, only the pane
  mudGlaze(g, R, 300, 0.09, 12);
  return g;
}

// Moulded composite: drone airframes and sensor pods. Deliberately quiet — a
// UAV is a smooth object — but panel joints, a service hatch and scuffs stop it
// reading as a grey plastic toy at the close camera.
function paintCompositeAlbedo(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  const S = SURF;
  g.fillStyle = '#b4b6b1';
  g.fillRect(0, 0, S, S);
  const joints = [seamPath(true, S * 0.32, S, 1.2, R), seamPath(false, S * 0.68, S, 1.2, R)];
  const hatches = [];
  for (let i = 0; i < 3; i++) hatches.push([R() * S, R() * S, 40 + R() * 60, 26 + R() * 44]);
  const scuffs = [];
  for (let i = 0; i < 60; i++) scuffs.push([R() * S, R() * S, 8 + R() * 30, (R() - 0.5) * 1.4, R()]);
  tileDraw(g, S, () => {
    for (const h of hatches) {
      g.fillStyle = 'rgba(158,161,158,0.34)';
      g.fillRect(h[0], h[1], h[2], h[3]);
      g.strokeStyle = 'rgba(112,114,112,0.45)';
      g.lineWidth = 1.6;
      g.strokeRect(h[0], h[1], h[2], h[3]);
    }
    for (const j of joints) strokePath(g, j, 2.2, 'rgba(120,122,120,0.55)');
    for (const s of scuffs) {
      g.save();
      g.translate(s[0], s[1]);
      g.rotate(s[3]);
      g.strokeStyle = s[4] < 0.6 ? 'rgba(198,200,196,0.40)' : 'rgba(122,120,116,0.32)';
      g.lineWidth = 1.6 + s[4] * 2.2;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(s[2], 0);
      g.stroke();
      g.restore();
    }
  });
  for (let i = 0; i < 1200; i++) {
    const px = R() * S, py = R() * S, pr = 0.9 + R() * 2.2;
    const v = R() < 0.5 ? 196 : 158;
    g.fillStyle = `rgba(${v},${v},${v},0.12)`;
    wrapDot(S, px, py, pr, (x, y) => {
      g.beginPath();
      g.arc(x, y, pr, 0, TAU);
      g.fill();
    });
  }
  mudGlaze(g, R, 120, 0.07, 12);
  return g;
}

// ---- decal atlas -----------------------------------------------------------
// CRITIQUE ROUND-2 FIX 2 (markings), extended in PHASE 2 so the hull numbers
// are PER FACTION rather than one shared bank: 5×5 cells of ~102 px.
//   0–7   BLUE hull numbers — three digits, solid NATO-ish stencil paint
//   8–15  RED  hull numbers — two digits, larger, outline-only brush style
//   16    BLUE formation device (bar and chevron)
//   17    RED  formation device (slashed square)
//         both INVENTED — deliberately not any real national insignia
//   18 hazard triangle · 19 "FUEL" plate · 20 air-recognition panel
//   21 caution stripes  · 22 weight-class lozenge · 23–24 spare
// Alpha-tested, so no transparency sorting anywhere.
const DECAL_CELLS = 5;
const DECAL_NUM_BLUE = ['214', '317', '442', '508', '631', '723', '856', '907'];
const DECAL_NUM_RED = ['31', '47', '62', '18', '55', '73', '26', '94'];
const DECAL_NUM0_BLUE = 0;
const DECAL_NUM0_RED = 8;
const DECAL_BLUE = 16;
const DECAL_RED = 17;
const DECAL_HAZARD = 18;
const DECAL_FUEL = 19;
const DECAL_PANEL = 20;
const DECAL_STRIPES = 21;
const DECAL_LOZENGE = 22;

function cellRect(i) {
  const c = SURF / DECAL_CELLS;
  return [(i % DECAL_CELLS) * c, Math.floor(i / DECAL_CELLS) * c, c];
}

function paintDecalAtlas(R) {
  const g = surfCtx(SURF);
  if (!g) return null;
  g.clearRect(0, 0, SURF, SURF);
  const C = SURF / DECAL_CELLS;
  const PAINT = '#DCD8C6';
  const DARK = '#20211C';

  const stencil = (i, txt, scale) => {
    const [x, y] = cellRect(i);
    g.save();
    g.translate(x + C / 2, y + C / 2);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${Math.round(C * (scale || 0.56))}px "Arial Narrow", "Helvetica Neue", Impact, sans-serif`;
    g.lineWidth = C * 0.075;
    g.strokeStyle = DARK;
    g.strokeText(txt, 0, 0);
    g.fillStyle = PAINT;
    g.fillText(txt, 0, 0);
    g.restore();
  };

  // RED voice: two big digits drawn as an OUTLINE, the way a crew paints them
  // with a brush over camo. Same atlas, completely different read at 6 metres —
  // which is the point of splitting the bank per faction.
  const brushNum = (i, txt) => {
    const [x, y] = cellRect(i);
    g.save();
    g.translate(x + C / 2, y + C / 2);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${Math.round(C * 0.72)}px "Arial Narrow", "Helvetica Neue", Impact, sans-serif`;
    g.lineWidth = C * 0.115;
    g.strokeStyle = DARK;
    g.strokeText(txt, 0, 0);
    g.lineWidth = C * 0.062;
    g.strokeStyle = PAINT;
    g.strokeText(txt, 0, 0);
    g.restore();
  };

  for (let i = 0; i < DECAL_NUM_BLUE.length; i++) {
    stencil(DECAL_NUM0_BLUE + i, DECAL_NUM_BLUE[i], 0.58);
  }
  for (let i = 0; i < DECAL_NUM_RED.length; i++) {
    brushNum(DECAL_NUM0_RED + i, DECAL_NUM_RED[i]);
  }

  // BLUE device: horizontal bar with a chevron over it
  {
    const [x, y] = cellRect(DECAL_BLUE);
    g.save();
    g.translate(x + C / 2, y + C / 2);
    g.strokeStyle = DARK;
    g.lineWidth = C * 0.09;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(-C * 0.30, C * 0.02);
    g.lineTo(0, -C * 0.26);
    g.lineTo(C * 0.30, C * 0.02);
    g.stroke();
    g.strokeStyle = PAINT;
    g.lineWidth = C * 0.055;
    g.stroke();
    g.fillStyle = DARK;
    g.fillRect(-C * 0.32, C * 0.14, C * 0.64, C * 0.14);
    g.fillStyle = PAINT;
    g.fillRect(-C * 0.28, C * 0.17, C * 0.56, C * 0.08);
    g.restore();
  }
  // RED device: square with a diagonal slash
  {
    const [x, y] = cellRect(DECAL_RED);
    g.save();
    g.translate(x + C / 2, y + C / 2);
    g.strokeStyle = DARK;
    g.lineWidth = C * 0.11;
    g.strokeRect(-C * 0.27, -C * 0.27, C * 0.54, C * 0.54);
    g.strokeStyle = PAINT;
    g.lineWidth = C * 0.065;
    g.strokeRect(-C * 0.27, -C * 0.27, C * 0.54, C * 0.54);
    g.strokeStyle = DARK;
    g.lineWidth = C * 0.13;
    g.beginPath();
    g.moveTo(-C * 0.30, C * 0.30);
    g.lineTo(C * 0.30, -C * 0.30);
    g.stroke();
    g.strokeStyle = PAINT;
    g.lineWidth = C * 0.075;
    g.stroke();
    g.restore();
  }
  // hazard triangle
  {
    const [x, y] = cellRect(DECAL_HAZARD);
    g.save();
    g.translate(x + C / 2, y + C / 2);
    g.beginPath();
    g.moveTo(0, -C * 0.32);
    g.lineTo(C * 0.34, C * 0.26);
    g.lineTo(-C * 0.34, C * 0.26);
    g.closePath();
    g.fillStyle = '#C8A23C';
    g.fill();
    g.strokeStyle = DARK;
    g.lineWidth = C * 0.055;
    g.stroke();
    g.fillStyle = DARK;
    g.fillRect(-C * 0.035, -C * 0.12, C * 0.07, C * 0.24);
    g.beginPath();
    g.arc(0, C * 0.18, C * 0.045, 0, TAU);
    g.fill();
    g.restore();
  }
  stencil(DECAL_FUEL, 'FUEL', 0.30);
  // air-recognition panel
  {
    const [x, y] = cellRect(DECAL_PANEL);
    g.fillStyle = '#B9552E';
    g.fillRect(x + C * 0.12, y + C * 0.26, C * 0.76, C * 0.48);
    g.strokeStyle = 'rgba(20,20,18,0.55)';
    g.lineWidth = C * 0.03;
    g.strokeRect(x + C * 0.12, y + C * 0.26, C * 0.76, C * 0.48);
  }
  // caution stripes
  {
    const [x, y] = cellRect(DECAL_STRIPES);
    g.save();
    g.beginPath();
    g.rect(x + C * 0.06, y + C * 0.34, C * 0.88, C * 0.32);
    g.clip();
    g.fillStyle = '#C8A23C';
    g.fillRect(x, y, C, C);
    g.fillStyle = DARK;
    for (let i = -2; i < 10; i++) {
      g.save();
      g.translate(x + i * C * 0.12, y);
      g.rotate(0.5);
      g.fillRect(0, 0, C * 0.06, C * 1.4);
      g.restore();
    }
    g.restore();
  }
  // weight-class lozenge
  {
    const [x, y] = cellRect(DECAL_LOZENGE);
    g.save();
    g.translate(x + C / 2, y + C / 2);
    g.beginPath();
    g.arc(0, 0, C * 0.30, 0, TAU);
    g.fillStyle = '#C8A23C';
    g.fill();
    g.strokeStyle = DARK;
    g.lineWidth = C * 0.05;
    g.stroke();
    g.fillStyle = DARK;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${Math.round(C * 0.30)}px "Arial Narrow", Impact, sans-serif`;
    g.fillText('50', 0, C * 0.02);
    g.restore();
  }

  // paint wear: knock ~6 % of the coverage out so the markings are not decals
  // fresh off a printer. Alpha only — the colour underneath stays.
  const wear = [];
  for (let i = 0; i < 900; i++) wear.push([R() * SURF, R() * SURF, 1 + R() * 3.6]);
  g.globalCompositeOperation = 'destination-out';
  for (const w of wear) {
    g.fillStyle = `rgba(0,0,0,${0.25 + R() * 0.5})`;
    g.beginPath();
    g.arc(w[0], w[1], w[2], 0, TAU);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';

  const t = new THREE.CanvasTexture(g.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// ---- the local (fallback) bank ---------------------------------------------
// Lazy and per key. Nothing here is painted unless something actually asks for
// a map the shared library could not hand over, so on a healthy boot this file
// touches 5 × 512² canvases (the track link and optics height fields, their two
// normal-conversion targets and the decal atlas) where it used to paint 17 — the
// optics pair is round-3 fix 18's cost, and it is two canvases and one 512² RGB
// upload for every sight, periscope, vision block and sensor face in the game.
// Each painter gets its
// OWN seeded stream, so the result does not depend on which key was requested
// first — laziness cannot change what a map looks like.

const HEIGHT_PAINT = {
  armor: [paintArmorHeight, 2.6, 0x5EE15169],
  track: [paintTrackHeight, 3.4, 0x17ACC8D1],
  metal: [paintMetalHeight, 2.0, 0x2B9F3311],
  cloth: [paintClothHeight, 2.4, 0x3C4D5E6F],
  composite: [paintCompositeHeight, 1.6, 0x77AA33BB],
  // ROUND-3 FIX 18. Not a fallback: `optics` is a SECOND deliberate `link: true`
  // surface (see SURFACE below). Strength 2.0 is a shade under the armour tile's
  // 2.6 on purpose — this map's dominant feature is a real 5 mm hood step, and
  // on a near-mirror (roughness 0.15, metalness 0.55) an over-driven normal turns
  // every bezel edge into a specular sparkle crawl at RTS range.
  optics: [paintOpticsHeight, 2.0, 0x6C71C5A0],
};

// The map means the roughness scalars are solved against (see paintRough).
const ROUGH_BASE = {
  paint: 0.80, track: 0.92, metal: 0.78, glass: 0.55, cloth: 0.97, composite: 0.82,
};
const ROUGH_SEED = {
  paint: 0x91E4A03D, track: 0x4C7B1122, metal: 0x60D5F17E,
  glass: 0x0B3E9C45, cloth: 0x5A21D8F0, composite: 0x38C6047B,
};

let _bankWarned = false;
function bankWarn(err) {
  if (_bankWarned) return;
  _bankWarned = true;
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[models] local surface maps unavailable, using flat materials:', err);
  }
}

const _localNormal = new Map();
function localNormal(key) {
  if (_localNormal.has(key)) return _localNormal.get(key);
  let t = null;
  try {
    const p = HEIGHT_PAINT[key];
    if (p) t = heightToNormal(p[0](rng(p[2])), p[1], 1);
  } catch (err) {
    bankWarn(err);
    t = null;
  }
  _localNormal.set(key, t);
  return t;
}

// ROUND-4 FIX 8. The albedo bank, same laziness contract as the two above: a
// tile is painted the first time a material asks for it and never again, each
// painter gets its own seeded stream so the result cannot depend on request
// order, and a painter that throws costs the surface its map, not the boot.
//
// Cost, stated honestly: five more 512² canvases and five more sRGB uploads at
// boot (≈7 MB of VRAM with mips), taking this file from 5 painted tiles to 10.
// Nothing is added per frame beyond one texture fetch on materials that already
// fetch a normal and a roughness map, and the draw-call count is unchanged
// because the maps are SHARED across every instance — the per-instance clone
// copies the reference, exactly as it already does for the relief maps.
const ALBEDO_PAINT = {
  track: [paintTrackAlbedo, 0x1D4F77A3],
  metal: [paintMetalAlbedo, 0x62B0C41D],
  cloth: [paintClothAlbedo, 0x4E9931C7],
  optics: [paintOpticsAlbedo, 0x37D5A2E9],
  composite: [paintCompositeAlbedo, 0x58C1E60B],
};

const _localAlbedo = new Map();
function localAlbedo(key) {
  if (_localAlbedo.has(key)) return _localAlbedo.get(key);
  let t = null;
  try {
    const p = ALBEDO_PAINT[key];
    const g = p ? p[0](rng(p[1])) : null;
    if (g) {
      t = new THREE.CanvasTexture(g.canvas);
      // A COLOUR map, unlike every other tile in this file: it must be tagged
      // sRGB or the shader linearises nothing and the tile renders ~2× hot.
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      t.needsUpdate = true;
    }
  } catch (err) {
    bankWarn(err);
    t = null;
  }
  _localAlbedo.set(key, t);
  return t;
}

const _localRough = new Map();
function localRough(key) {
  if (_localRough.has(key)) return _localRough.get(key);
  let t = null;
  try {
    if (ROUGH_BASE[key] != null) {
      t = dataTex(paintRough(ROUGH_BASE[key], rng(ROUGH_SEED[key] || 0x5EE15169), key));
    }
  } catch (err) {
    bankWarn(err);
    t = null;
  }
  _localRough.set(key, t);
  return t;
}

let _decalTex;
function decalTex() {
  if (_decalTex !== undefined) return _decalTex;
  try {
    _decalTex = paintDecalAtlas(rng(0x0DECA152));
  } catch (err) {
    bankWarn(err);
    _decalTex = null;
  }
  return _decalTex;
}

// A texture's repeat is per-texture, so a shared source used at two scales has
// to be cloned. Cached by source+repeat, so it is still one upload.
const _repCache = new Map();
function atRepeat(tex, rep) {
  if (!tex) return null;
  const key = `${tex.uuid}|${rep}`;
  let t = _repCache.get(key);
  if (!t) {
    t = tex.clone();
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep, rep);
    t.needsUpdate = true;
    _repCache.set(key, t);
  }
  return t;
}

// Local material name -> how it binds.
//   kind  : shared-library surface class (core/assets.js `Surf`), tried FIRST
//   n     : local fallback normal key    ns: normalScale     nr: repeat
//   rk    : local fallback roughness key rough: TARGET mean roughness
//   ao    : aoMapIntensity, 0 = no AO map on this material
//   link  : true ⇒ always take the normal from the LOCAL bank even when the
//           shared library binds the rest. TWO surfaces use it, both because the
//           shared tile is a different object:
//             `tracks` — the shared `track` tile is chevron tread (right for a
//                        tyre, wrong for a link); the local one is shoes,
//                        hinge gaps and connector bolts at 4 pitches per tile.
//             `optics` — the shared `vehicle` tile is plate seams and weld
//                        beads; a sight block has a hood, a bezel, a gasket and
//                        a laminated pane, and welding one shut would be a
//                        strange thing to build. ROUND-3 FIX 18.
//           Everything else about both (roughness map, solved scalar, AO policy)
//           still comes from the shared library.
//
// The `nr` values are expressed against UV_SCALE = 0.34, i.e. repeat 1 covers
// ~2.94 world units ≈ one rolled hull plate.
//   alb   : ROUND-4 FIX 8 — local albedo DETAIL key (see ALBEDO_PAINT). Bound
//           at the same `nr` as the normal so the colour break lands on the
//           modelled feature, and solved against the material's own colour so
//           the art-bible albedo stays the MEAN. `armor` deliberately has none:
//           it already carries the camo canvas from assets.js, and applySurface
//           will not overwrite a map a material arrived with.
const SURFACE = {
  armor: { kind: 'vehicle', n: 'armor', ns: 0.6, nr: 1.0, rk: 'paint', rough: 0.72, ao: 0.55 },
  barrel: { kind: 'vehicle', n: 'metal', ns: 0.45, nr: 2.0, rk: 'metal', rough: 0.52, ao: 0, alb: 'metal' },
  tracks: { kind: 'track', n: 'track', ns: 1.05, nr: 4.3, rk: 'track', rough: 0.85, ao: 0, link: true, alb: 'track' },
  // ROUND-3 FIX 18: was `n: null, ns: 0` — the one unmapped surface on the hull.
  // ns 0.42 is deliberately below the hull's 0.6: the hood step in this tile is
  // authored as a real 0.36-of-range height jump, so at 0.6 the bezel would flare
  // white against a 4.4-intensity key on a metalness-0.55 surface.
  optics: { kind: 'vehicle', n: 'optics', ns: 0.42, nr: 6.0, rk: 'glass', rough: 0.15, ao: 0, link: true, alb: 'optics' },
  canvasTan: { kind: 'cloth', n: 'cloth', ns: 0.75, nr: 3.0, rk: 'cloth', rough: 0.94, ao: 0, alb: 'cloth' },
  droneGrey: { kind: 'vehicle', n: 'composite', ns: 0.38, nr: 4.0, rk: 'composite', rough: 0.55, ao: 0, alb: 'composite' },
  droneDark: { kind: 'vehicle', n: 'composite', ns: 0.38, nr: 4.0, rk: 'composite', rough: 0.58, ao: 0, alb: 'composite' },
};

// Bind the maps for `name` onto a material and solve its roughness scalar so
// the map's MEAN lands on the art-bible value.
//
// Order: shared library (one upload for the whole game, and the only source of
// an aoMap) → this file's local painters for anything still missing. Both paths
// solve `roughness = target / mapMean`, so the art-bible number stays the MEAN
// of a real distribution rather than a flat constant, and `jitter` rides on top
// of the solved scalar exactly as it did before.
//
// ROUND-3 FIX 14: `jitterSpan` is the PEAK-TO-PEAK width the caller rolled `jitter`
// out of. It is not cosmetic — it is the headroom `roughJit()` reserves at the top
// and bottom of the [0,1] band before it clamps the solved centre, which is what
// stops the clamp from eating the spread instead of re-centring it. Callers that
// pass no jitter may omit it.
function applySurface(m, name, jitter, jitterSpan) {
  const S = SURFACE[name];
  if (!S) return;
  const j = jitter || 0;
  // |j| is the correct fallback: a single sample can never exceed the half-span,
  // so an un-declared span degrades to "reserve at least what this roll needs".
  const half = jitterSpan != null ? Math.abs(jitterSpan) * 0.5 : Math.abs(j);
  let haveNormal = false;
  let haveRough = false;

  const SS = Surf ? Surf[S.kind] : null;
  if (bindSurface && SS) {
    try {
      const wantN = S.ns > 0 && !S.link;
      bindSurface(m, S.kind, {
        repeat: S.nr,
        normalScale: S.ns,
        roughness: S.rough,
        normal: wantN,
        ao: S.ao > 0,
        aoIntensity: S.ao,
      });
      // Asked of the LIBRARY, not of the material: a clone can arrive already
      // carrying a map that assets.js bound at ITS repeat, and inheriting that
      // silently would put the wrong tiling on the panel.
      haveNormal = wantN && !!SS.normal;
      haveRough = !!SS.rough;
      // bindSurface() solved `target / mapMean` and clamped it to ITS own [0.02, 2]
      // working range; this is the point of assignment that has to land it in the
      // renderer's [0, 1] with the jitter band intact.
      if (haveRough) m.roughness = roughJit(m.roughness, j, half);
    } catch (err) {
      bankWarn(err);
      haveNormal = false;
      haveRough = false;
    }
  }

  if (S.n && (!haveNormal || S.link)) {
    const t = localNormal(S.n);
    if (t) {
      m.normalMap = atRepeat(t, S.nr);
      m.normalScale = new THREE.Vector2(S.ns, S.ns);
    } else if (S.link && SS && SS.normal) {
      // ROUND-4 MINOR 16. A `link` surface asks for a tile the shared library
      // does not have; if the LOCAL painter could not run (no 2D context, an
      // out-of-memory canvas) the round-3 code left the surface with no normal
      // at all — which is exactly the flat gloss quad the critique keeps
      // photographing on `#optics`. The shared vehicle tile is the wrong object
      // here (plate seams on a sight block), so it goes on at 60 % scale: wrong
      // detail at low contrast still beats a mirror with no relief.
      m.normalMap = atRepeat(SS.normal, S.nr);
      m.normalScale = new THREE.Vector2(S.ns * 0.6, S.ns * 0.6);
    }
  }
  if (!haveRough) {
    const t = localRough(S.rk);
    if (t) {
      m.roughnessMap = atRepeat(t, S.nr > 1 ? S.nr : 1.0);
      // Same solve as the shared path — and it can overshoot 1 for the same
      // reason (a target close to the map's own mean solves near 1, so any
      // jitter on top of it clears the ceiling).
      m.roughness = roughJit(S.rough / ROUGH_BASE[S.rk], j, half);
    } else {
      // No map at all: the scalar IS the rendered roughness, so the jitter is
      // expressed in art-bible units rather than in solved-scalar units — and
      // the headroom has to be scaled the same way or the band drifts.
      const k = ROUGH_BASE[S.rk] || 1;
      m.roughness = roughJit(S.rough, j * k, half * k);
    }
  }
  // ROUND-4 FIX 8. Albedo LAST, and only when the tile's mean can be measured:
  // the map MULTIPLIES `color`, so binding it without the solve would darken the
  // surface by the tile's own mean and silently move it off the art bible — a
  // wrong albedo is worse than a flat one, so an unmeasurable tile is dropped.
  // `!m.map` protects the camo: `armor` arrives with its own map and no `alb`.
  if (S.alb && !m.map) {
    const src = localAlbedo(S.alb);
    const mean = src ? textureMean(src) : null;
    if (src && mean && mean.r > 2e-3 && mean.g > 2e-3 && mean.b > 2e-3) {
      m.map = atRepeat(src, S.nr);
      // Per channel, so a tile may carry hue (rust, an AR coating, bleached
      // canvas) without dragging the material's mean colour with it — the
      // uniform absorbs the tile's average hue and only the break survives.
      m.color.setRGB(
        clamp(m.color.r / mean.r, 0, 4),
        clamp(m.color.g / mean.g, 0, 4),
        clamp(m.color.b / mean.b, 0, 4));
    }
  }
  // The table above is authoritative about AO: a weld-crevice occlusion texture
  // belongs on a hull, not on a gun tube or a sight glass, and the clone may
  // have arrived carrying one.
  if (!S.ao) m.aoMap = null;
  m.needsUpdate = true;
}

// ---------------------------------------------------------------- materials

const _sharedMat = new Map();
const _tintCache = new Map();

// ---- ROUND-1 CRITIQUE FIX 1 -------------------------------------------------
// Painted military steel is a DIELECTRIC. `metalness 0.25` deletes a quarter of
// the diffuse response, and combined with the old raw 0x4A5240 camo canvas that
// made every vehicle render as a black cut-out against the wheat. Roughness is
// back on the authored 0.72; metalness is the one deviation from the bible and
// it is logged in ART_DIRECTION §4 and INTEGRATION_NOTES.
//
// assets.js now paints the camo at the raised bases (BLUE 0x6E7A5C splotches
// 0x515A42/0x8A8A63, RED 0x9A8F70 splotches 0x6E6650/0xB2A282), so the solve
// below is a ~1.2–1.4× trim rather than the ~2.7× stretch it used to be — which
// is why the splotch contrast survives instead of being pushed into the ceiling.
//
// The two constants are the EFFECTIVE albedo of a lit hull panel, not a colour
// uniform: the camo canvas is a MAP and the shader multiplies map × colour ×
// vertexColour, so the texture's mean is measured once (32×32 downsample,
// linearised per texel) and the uniform is SOLVED to land on these values.
//
// Why these two numbers. Through this exact chain — sun 2.6 @14° + hemi 1.10 +
// ambient 0.30, Lambert 1/π, exposure 1.12, ACES — a sun-facing hull panel of
// linear luminance L renders at ACES(L · 1.064). Solving that for the critique's
// acceptance bands gives BLUE ≈ 0.166 and RED ≈ 0.277 linear luminance:
//   BLUE 0x6A7657 → 35.4 % display luma   (band 30–36 %)
//   RED  0x9A8F70 → 49.3 % display luma   (band 45–52 %)
//   gap  13.9 points                      (required ≥12)
// RED is literally the new camo base; BLUE is the new camo base pulled down 7 %
// so the two factions clear the 12-point gap instead of landing 8 apart.
const ARMOR_ALBEDO = { blue: 0x6A7657, red: 0x9A8F70 };
const ARMOR_ROUGH = 0.72;
const ARMOR_METAL = 0.0;
// Peak-to-peak per-vehicle jitter on the SOLVED roughness scalar: one company's
// paint is chalkier than the next one's. Declared as a constant rather than
// inlined at the roll because `applySurface()` needs the SPAN, not the sample,
// to reserve ceiling headroom (round-3 fix 14) — an inlined 0.12 is exactly how
// the band ended up half out of contract.
const ARMOR_ROUGH_JITTER = 0.12;
// Same idea for the multiplicative running-gear wear jitter in instMat().
const WEAR_ROUGH_SPAN = 0.10;
// Mean vertex-colour factor over a vehicle's visible upper surfaces (see
// paintVC): the solve divides it out so the *rendered* value hits the target.
const VC_LIT_MEAN = 0.88;

function srgbToLinear(c) {
  return c < 0.04045 ? c * (1 / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4);
}

// True unless the app explicitly turned colour management off; decides whether
// the shader will see linearised texels or raw sRGB ones.
function cmEnabled() {
  return !(THREE.ColorManagement && THREE.ColorManagement.enabled === false);
}

// sRGB hex -> the renderer's working colour space (linear-sRGB by default).
function workingRGB(hex) {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  return cmEnabled()
    ? { r: srgbToLinear(r), g: srgbToLinear(g), b: srgbToLinear(b) }
    : { r, g, b };
}

const _meanCache = new Map();

// Mean colour of a canvas texture in working space. Cheap (one 32×32 readback
// per texture, cached) and it is the only way to aim the camo at a known albedo
// without owning assets.js.
function textureMean(tex) {
  if (!tex) return null;
  if (_meanCache.has(tex.uuid)) return _meanCache.get(tex.uuid);
  let mean = null;
  try {
    const img = tex.image;
    if (img && img.width && typeof document !== 'undefined') {
      const N = 32;
      const c = document.createElement('canvas');
      c.width = N;
      c.height = N;
      const g2 = c.getContext('2d', { willReadFrequently: true });
      g2.drawImage(img, 0, 0, N, N);
      const d = g2.getImageData(0, 0, N, N).data;
      const lin = cmEnabled();
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) {
        const cr = d[i] / 255, cg = d[i + 1] / 255, cb = d[i + 2] / 255;
        r += lin ? srgbToLinear(cr) : cr;
        g += lin ? srgbToLinear(cg) : cg;
        b += lin ? srgbToLinear(cb) : cb;
      }
      const n = d.length / 4;
      mean = { r: r / n, g: g / n, b: b / n };
    }
  } catch (err) {
    mean = null;                       // tainted/blank canvas — fall back below
  }
  _meanCache.set(tex.uuid, mean);
  return mean;
}

const _armorSolve = new Map();

function armorSolve(faction, src) {
  const key = `${faction}|${src && src.map ? src.map.uuid : 'flat'}`;
  const hit = _armorSolve.get(key);
  if (hit) return hit;
  const target = workingRGB(ARMOR_ALBEDO[faction] || ARMOR_ALBEDO.blue);
  const mean = src && src.map ? textureMean(src.map) : null;
  let f;
  if (mean && mean.r > 1e-4 && mean.g > 1e-4 && mean.b > 1e-4) {
    f = {
      r: clamp(target.r / (mean.r * VC_LIT_MEAN), 0.15, 8),
      g: clamp(target.g / (mean.g * VC_LIT_MEAN), 0.15, 8),
      b: clamp(target.b / (mean.b * VC_LIT_MEAN), 0.15, 8),
    };
  } else {
    // no map (or unreadable): the colour uniform IS the albedo
    f = {
      r: target.r / VC_LIT_MEAN,
      g: target.g / VC_LIT_MEAN,
      b: target.b / VC_LIT_MEAN,
    };
  }
  _armorSolve.set(key, f);
  return f;
}

// A tint is a colour SHIFT over the camo, never an absolute albedo. Feeding a
// raw hex through THREE.Color yields a LINEAR value (0xB0ADA2 -> 0.44), so every
// "lighter" detail — ERA blocks, heat-stained exhausts — used to render darker
// than the plain hull beside it. Normalising to a multiplier around 1.0 fixes it.
function tintColor(hex) {
  let c = _tintCache.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    const mx = Math.max(c.r, c.g, c.b) || 1;
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const k = (0.86 + 0.55 * Math.sqrt(clamp(lum, 0, 1))) / mx;
    c.setRGB(
      clamp(1 + (c.r * k - 1) * 0.75, 0, 2),
      clamp(1 + (c.g * k - 1) * 0.75, 0, 2),
      clamp(1 + (c.b * k - 1) * 0.75, 0, 2));
    _tintCache.set(hex, c);
  }
  return c;
}

// Dielectric-corrected, dust-lifted variants of the assets.js secondaries. These
// are applied to the local CLONE only — assets.js is owned by another module and
// its shared materials are never mutated. Rationale (round-1 critique): with the
// hull raised ~2.4×, an unchanged 0x33352F barrel and 0x2A2A28 track would have
// turned into the new black hole of the silhouette.
const MAT_TUNE = {
  // NOTE: `roughness` here is superseded by SURFACE[name].rough (applySurface
  // rebinds it as the mean of a roughness MAP). Kept in sync so the two tables
  // never disagree, and so the numbers still hold if the canvas painters fail.
  barrel: { color: 0x4A4C43, roughness: 0.52, metalness: 0.18 },
  tracks: { color: 0x3B3A34, roughness: 0.85, metalness: 0.0 },
  optics: { color: 0x223038, roughness: 0.15, metalness: 0.55 },
  canvasTan: { color: 0x6E7250, roughness: 0.94, metalness: 0.0 },
  droneGrey: { color: 0x8B9095, roughness: 0.55, metalness: 0.05 },
  droneDark: { color: 0x55595D, roughness: 0.58, metalness: 0.05 },
};

// PROTOTYPE vertex-colour-enabled clone of an assets.js material (or a safe
// stand-in if assets were never initialised — models must never throw). Built
// once per name; instances clone it (see `instMat`).
function vcMat(name, fallback) {
  const hit = _sharedMat.get(name);
  if (hit) return hit;
  const src = Mat ? Mat[name] : null;
  const m = src ? src.clone() : new THREE.MeshStandardMaterial(fallback);
  m.vertexColors = true;
  const tune = MAT_TUNE[name];
  if (tune) {
    if (tune.color != null) m.color.setHex(tune.color);
    if (tune.roughness != null) m.roughness = clamp(tune.roughness, ROUGH_MIN, ROUGH_MAX);
    if (tune.metalness != null) m.metalness = tune.metalness;
  }
  // ROUND-2 FIX 1: bind the normal + roughness maps. applySurface OVERWRITES
  // the scalar roughness set above, on purpose — the tune value becomes the
  // MEAN of the map instead of a flat constant.
  // The prototype carries NO jitter (span 0): the per-instance spread is rolled
  // in instMat()/armorMat() on the clone, so the prototype is the band's centre.
  applySurface(m, name, 0, 0);
  _sharedMat.set(name, m);
  return m;
}

// PHASE-2 FIX: these used to be handed to the meshes SHARED, one material object
// for every unit on the map. `fx/vfx.js` `hitFlash()` walks a struck unit's
// materials and writes `emissive` / `emissiveIntensity` on each one — so a
// single tank taking a hit lit the tracks, road wheels, gun barrels, optics,
// tarpaulins, drones and markings of EVERY unit in the scenario amber for 120 ms.
// Instances now get their own clone. `Material.clone()` copies map REFERENCES,
// so this costs ~6 material objects per unit and not one byte of extra VRAM or
// one extra GPU upload; the geometry is still shared through GEO_CACHE and the
// draw-call count is unchanged.
//
// The clone is also where per-vehicle wear lives: running gear and steel take a
// small value jitter, so one company's tracks are dustier than the next one's.
function instMat(name, fallback, r, wear) {
  const proto = vcMat(name, fallback);
  const m = proto.clone();
  if (r && wear) {
    const v = 1 + (r() - 0.5) * 2 * wear;   // ±wear in value: dusty ↔ freshly washed
    const warm = 1 + (v - 1) * 0.6;         // and dust is warm, not neutral
    m.color.setRGB(
      clamp(m.color.r * v * warm, 0, 1.5),
      clamp(m.color.g * v, 0, 1.5),
      clamp(m.color.b * v / warm, 0, 1.5));
    // ROUND-3 FIX 14: multiplicative ±5 % on the SOLVED scalar. `roughJitMul`
    // pulls the centre down to 1/(1+half) first where it has to, so a prototype
    // that already solved near the ceiling still spreads its full ±5 % instead
    // of piling the dusty half of the company onto a flat 1.0.
    m.roughness = roughJitMul(m.roughness,
      1 + (r() - 0.5) * WEAR_ROUGH_SPAN, WEAR_ROUGH_SPAN * 0.5);
  }
  return m;
}

// Per-instance camo: clones the faction material, re-rolls the texture frame
// (offset / 90° step + wobble / repeat) and nudges value, warmth and roughness so
// no two vehicles of a type look cloned — around the SOLVED base albedo.
function armorMat(faction, r) {
  const fac = faction === 'red' ? 'red' : 'blue';
  const src = Mat ? Mat[fac === 'red' ? 'armorRed' : 'armorBlue'] : null;
  const m = src
    ? src.clone()
    : new THREE.MeshStandardMaterial({
      color: ARMOR_ALBEDO[fac], roughness: ARMOR_ROUGH, metalness: ARMOR_METAL,
    });
  m.vertexColors = true;
  if (m.map) {
    const t = m.map.clone();
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.center.set(0.5, 0.5);
    t.rotation = ((r() * 4) | 0) * (Math.PI / 2) + (r() - 0.5) * 0.3;
    t.offset.set(r(), r());
    const rep = 0.92 + r() * 0.22;
    t.repeat.set(rep, rep);
    t.anisotropy = src && src.map ? src.map.anisotropy : 8;
    m.map = t;
  }
  const f = armorSolve(fac, src);
  const v = 0.93 + r() * 0.14;              // ±7% value between vehicles
  const warm = 1 + (r() - 0.5) * 0.09;      // ±4.5% warm/cool paint batch
  m.color.setRGB(
    clamp(f.r * v * warm, 0, 12),
    clamp(f.g * v, 0, 12),
    clamp(f.b * v / warm, 0, 12));
  // ROUND-2 FIX 1: weld beads / panel seams / hatch rims as a tiling normal at
  // normalScale 0.6, and a roughness map so the paint is a distribution around
  // ARMOR_ROUGH rather than one flat number across the whole vehicle. The
  // per-instance jitter now rides the SOLVED scalar, so the rendered mean still
  // moves ±6 % between vehicles exactly as before.
  // ROUND-3 FIX 14: the span goes with the sample so the [0,1] clamp re-centres
  // the band instead of shaving its top off. One r() call, same position in the
  // stream as before — the seeded layout of every vehicle is byte-identical.
  applySurface(m, 'armor', (r() - 0.5) * ARMOR_ROUGH_JITTER, ARMOR_ROUGH_JITTER);
  m.metalness = ARMOR_METAL;
  return m;
}

function ghostMat() {
  const hit = _sharedMat.get('__ghost');
  if (hit) return hit;
  const src = Mat ? Mat.ghost : null;
  const m = src ? src.clone() : new THREE.MeshBasicMaterial({
    color: 0x7ED88B, transparent: true, opacity: 0.3, depthWrite: false,
  });
  m.vertexColors = false;
  _sharedMat.set('__ghost', m);
  return m;
}

function makePalette(faction, r) {
  return {
    faction: faction === 'red' ? 'red' : 'blue',
    // the instance's seeded stream, so decals (hull numbers) vary per vehicle
    // and still reproduce byte-identically on reload
    r,
    numCell: null,
    armor: armorMat(faction, r),
    dark: instMat('barrel', { color: 0x33352F, roughness: 0.55, metalness: 0.4 }, r, 0.05),
    rubber: instMat('tracks', { color: 0x2A2A28, roughness: 0.9, metalness: 0.1 }, r, 0.07),
    optics: instMat('optics', { color: 0x1E2B33, roughness: 0.2, metalness: 0.6 }, r, 0),
    canvas: instMat('canvasTan', { color: 0x55593F, roughness: 0.95, metalness: 0 }, r, 0.06),
    grey: instMat('droneGrey', { color: 0x6B6F73, roughness: 0.6, metalness: 0.2 }, r, 0.03),
    dgrey: instMat('droneDark', { color: 0x3A3D40, roughness: 0.6, metalness: 0.2 }, r, 0.03),
    // MeshBasicMaterial: no `emissive`, so hitFlash() skips it and it can stay
    // shared across the whole roster.
    prop: (Mat && Mat.propDisc) || new THREE.MeshBasicMaterial({
      color: 0x222222, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthWrite: false,
    }),
    decal: null,          // lazily cloned on first addDecals() for this unit
    _shadow: true,
  };
}

function ghostPalette() {
  const g = ghostMat();
  return {
    faction: 'blue', ghost: true, r: null, numCell: null,
    armor: g, dark: g, rubber: g, optics: g, canvas: g,
    grey: g, dgrey: g, prop: g, decal: null, _shadow: false,
  };
}

// ---------------------------------------------------------- geometry plumbing

// AO descriptor: vertical gradient from `lo` to `hi` (unit space), floored at
// `min`; `yBias` lifts a sub-node's local Y back into unit space so the gradient
// stays continuous across turret / barrel / mast parts.
function AO(lo, hi, min = 0.48, yBias = 0) {
  return { lo, hi, min, yBias };
}

// Box projection, PER FACE.
//
// This used to pick the projection axis from each VERTEX's normal. On a
// cylinder — every wheel, roller, barrel and rod in this file — the three
// vertices of one triangle can then land on three different axes, which makes
// the UVs non-affine inside the triangle. With the diffuse map alone that was
// a smear; with a normal map it is fatal, because three derives the tangent
// frame from screen-space UV derivatives when there is no tangent attribute,
// and a non-affine triangle hands it a garbage frame (ROUND-2 FIX 1).
//
// Geometry reaching here is always non-indexed (finish() guarantees it), so a
// triangle owns its three vertices outright and one axis choice per face is
// both correct and free.
function projectUV(g, scale) {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const arr = p.array;
  const uv = new Float32Array(p.count * 2);
  const tri = p.count - (p.count % 3);
  for (let i = 0; i < tri; i += 3) {
    const ax = arr[i * 3], ay = arr[i * 3 + 1], az = arr[i * 3 + 2];
    const bx = arr[i * 3 + 3], by = arr[i * 3 + 4], bz = arr[i * 3 + 5];
    const cx = arr[i * 3 + 6], cy = arr[i * 3 + 7], cz = arr[i * 3 + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let fx = e1y * e2z - e1z * e2y;
    let fy = e1z * e2x - e1x * e2z;
    let fz = e1x * e2y - e1y * e2x;
    if (fx * fx + fy * fy + fz * fz < 1e-16) {
      // degenerate sliver — fall back to the shading normal of vertex 0
      fx = n ? n.getX(i) : 0;
      fy = n ? n.getY(i) : 1;
      fz = n ? n.getZ(i) : 0;
    }
    const nx = Math.abs(fx), ny = Math.abs(fy), nz = Math.abs(fz);
    // 0 = project on XZ (up faces), 1 = ZY (side faces), 2 = XY (front/back)
    const axis = (ny >= nx && ny >= nz) ? 0 : (nx >= nz ? 1 : 2);
    for (let k = 0; k < 3; k++) {
      const o = (i + k) * 3;
      const x = arr[o], y = arr[o + 1], z = arr[o + 2];
      const u = axis === 0 ? x : axis === 1 ? z : x;
      const v = axis === 0 ? z : y;
      uv[(i + k) * 2] = u * scale;
      uv[(i + k) * 2 + 1] = v * scale;
    }
  }
  for (let i = tri; i < p.count; i++) {
    uv[i * 2] = p.getX(i) * scale;
    uv[i * 2 + 1] = p.getZ(i) * scale;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// Dust skirt (ART_DIRECTION §4). `0x8A7355` in the working space is
// (0.2542, 0.1714, 0.0908); its Rec.709 luminance is 0.1832, and dividing the
// colour by it gives the multiplier below — a tint that is exactly
// luminance-neutral, so mixing toward it warms a panel without changing how
// bright it is. DUST_MAX is the mix at the contact plane.
const DUST_MUL = [1.388, 0.936, 0.496];
const DUST_MAX = 0.40;

function paintVC(g, ao, tintHex, shade) {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const col = new Float32Array(p.count * 3);
  const t = tintHex == null ? WHITE : tintColor(tintHex);
  const span = (ao.hi - ao.lo) || 1;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i) + ao.yBias;
    const z = p.getZ(i);
    let u = (y - ao.lo) / span;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    u = u * u * (3 - 2 * u);                       // smoothstep
    // Lifted AO floor. The baked gradient used to bottom out at 0.44 and then get
    // multiplied by a 0.70 underside term — on the shadow side of a 14° sun that
    // is pitch black, which is exactly what the round-1 critique flagged. The
    // grounding read survives; the dead zone does not.
    const mn = ao.min * 0.55 + 0.45;
    let f = mn + (1 - mn) * u;
    const ny = n ? n.getY(i) : 0;
    if (ny < 0) f *= 0.82 + 0.18 * (1 + ny);       // undersides / overhang shade
    else f *= 0.95 + 0.08 * ny;                    // sky-facing panels catch light
    f *= shade;
    // ROUND-4 FIX 8, second half: the dust skirt. ART_DIRECTION §4 "Edge wear &
    // grounding" has always asked for the bottom third of every vehicle tinted
    // dirt 0x8A7355 at ~30 % plus oil/soot streaks; what shipped was a mild
    // blue-cut spread evenly up the whole gradient, which is why the critique
    // reads the hulls as "uniformly clean" at the 19 u camera. `dust` is now
    // squared, so it is ~0.40 at the contact plane, 0.10 at mid-height and
    // nothing at the deck — a skirt, not a wash.
    const dz = 1 - u;
    const dust = ao.min < 1 ? DUST_MAX * dz * dz : 0;
    // Grain rides WITH the dirt: caked mud is mottled, clean paint is not.
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    const ga = 0.07 + 0.13 * dust;
    f *= (1 - ga * 0.5) + ga * (h - Math.floor(h));   // mean 1.0 at every dust level
    // Soot/oil runs: a low-frequency vertical stripe keyed on the horizontal
    // position, so two faces of one hull never wear identically. On the round
    // running gear (dozens of rings of vertices) this resolves as real streaks;
    // on a flat plate it is a per-panel value shift, which is the honest limit
    // of a vertex-colour overlay and still breaks the plastic read.
    const sk = Math.sin(x * 8.7 + z * 5.3 + y * 1.9);
    f *= 1 - 0.07 * dust * (0.5 + 0.5 * sk);
    // DUST_MUL is 0x8A7355 divided by its OWN luminance, so the mix shifts hue
    // and leaves value alone; the small explicit drop below is the whole of the
    // darkening. Round 4's finding is that the frame is three times too crushed,
    // so a dirt skirt that eats another stop off the lower hull would be paid
    // for twice — the dirt has to read as ochre, not as shadow.
    const vd = 1 - 0.06 * dust;
    col[i * 3] = clamp(t.r * f * vd * (1 + (DUST_MUL[0] - 1) * dust), 0, 1);
    col[i * 3 + 1] = clamp(t.g * f * vd * (1 + (DUST_MUL[1] - 1) * dust), 0, 1);
    col[i * 3 + 2] = clamp(t.b * f * vd * (1 + (DUST_MUL[2] - 1) * dust), 0, 1);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

const KEEP_ATTRS = ['position', 'normal', 'uv', 'color'];

function finish(geo, ao, opts, uvScale) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  projectUV(g, (opts && opts.uvScale) || uvScale || UV_SCALE);
  paintVC(g, ao, opts ? opts.tint : null, (opts && opts.shade) || 1);
  for (const k of Object.keys(g.attributes)) {
    if (KEEP_ATTRS.indexOf(k) === -1) g.deleteAttribute(k);
  }
  if (typeof g.clearGroups === 'function') g.clearGroups();
  return g;
}

// Hand-rolled merge (no addon dependency): every geometry here is non-indexed
// and carries exactly position/normal/uv/color, so concatenation is enough.
function mergeGeos(list) {
  if (list.length === 1) return list[0];
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    uv.set(g.attributes.uv.array, o * 2);
    col.set(g.attributes.color.array, o * 3);
    o += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

function shapeFrom(pts) {
  const list = signedArea(pts) < 0 ? pts.slice().reverse() : pts;
  const s = new THREE.Shape();
  s.moveTo(list[0][0], list[0][1]);
  for (let i = 1; i < list.length; i++) s.lineTo(list[i][0], list[i][1]);
  s.closePath();
  return s;
}

function place(geo, pos, opts) {
  if (opts) {
    if (opts.scale) geo.scale(opts.scale[0], opts.scale[1], opts.scale[2]);
    if (opts.rx) geo.rotateX(opts.rx);
    if (opts.ry) geo.rotateY(opts.ry);
    if (opts.rz) geo.rotateZ(opts.rz);
  }
  if (pos) geo.translate(pos[0], pos[1], pos[2]);
  return geo;
}

function createBuilder(ao, uvScale) {
  const buckets = new Map();
  const stack = [new THREE.Matrix4()];
  const uv = uvScale || UV_SCALE;

  const B = {
    buckets,
    push(m) {
      stack.push(new THREE.Matrix4().multiplyMatrices(stack[stack.length - 1], m));
      return B;
    },
    at(x, y, z, ry) {
      const m = new THREE.Matrix4().makeTranslation(x, y, z);
      if (ry) m.multiply(new THREE.Matrix4().makeRotationY(ry));
      return B.push(m);
    },
    pop() { if (stack.length > 1) stack.pop(); return B; },
    raw(key, geo, opts) {
      geo.applyMatrix4(stack[stack.length - 1]);
      const g = finish(geo, ao, opts, uv);
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(g);
      return B;
    },
    box(key, size, pos, opts) {
      return B.raw(key, place(new THREE.BoxGeometry(size[0], size[1], size[2]), pos, opts), opts);
    },
    cyl(key, rTop, rBot, h, seg, pos, axis, opts) {
      const g = new THREE.CylinderGeometry(rTop, rBot, h, seg || 10, 1, false);
      if (axis === 'x') g.rotateZ(-Math.PI / 2);
      else if (axis === 'z') g.rotateX(Math.PI / 2);
      return B.raw(key, place(g, pos, opts), opts);
    },
    cone(key, r, h, seg, pos, axis, opts) {
      const g = new THREE.ConeGeometry(r, h, seg || 10);
      if (axis === 'x') g.rotateZ(-Math.PI / 2);
      else if (axis === 'z') g.rotateX(Math.PI / 2);
      return B.raw(key, place(g, pos, opts), opts);
    },
    sph(key, r, pos, opts) {
      return B.raw(key, place(new THREE.SphereGeometry(r, 12, 8), pos, opts), opts);
    },
    // side-view profile (x = length, y = height) extruded across Z
    side(key, pts, depth, pos, opts) {
      const g = new THREE.ExtrudeGeometry(shapeFrom(pts), {
        depth, bevelEnabled: false, steps: 1, curveSegments: 3,
      });
      g.translate(0, 0, -depth / 2);
      return B.raw(key, place(g, pos, opts), opts);
    },
    // plan-view outline (x = length, y = lateral) extruded upward by `height`
    plan(key, pts, height, pos, opts) {
      const g = new THREE.ExtrudeGeometry(shapeFrom(pts), {
        depth: height, bevelEnabled: false, steps: 1, curveSegments: 3,
      });
      g.rotateX(-Math.PI / 2);
      return B.raw(key, place(g, pos, opts), opts);
    },
    // rod between two points — lattice masts, tripods, arms, tow bars
    strut(key, a, b, r, seg, opts) {
      const from = _sv1.set(a[0], a[1], a[2]);
      const to = _sv2.set(b[0], b[1], b[2]);
      const dir = _sv3.subVectors(to, from);
      const len = dir.length();
      if (len < 1e-5) return B;
      const g = new THREE.CylinderGeometry(r, r, len, seg || 6, 1, false);
      const q = new THREE.Quaternion().setFromUnitVectors(_up, dir.clone().normalize());
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5), q, _one);
      g.applyMatrix4(m);
      return B.raw(key, g, opts);
    },
  };
  return B;
}

const _sv1 = new THREE.Vector3();
const _sv2 = new THREE.Vector3();
const _sv3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _one = new THREE.Vector3(1, 1, 1);

// --------------------------------------------------------------- assembly

const GEO_CACHE = new Map();     // 'typeId:part' -> [[matKey, mergedGeometry], …]

function part(parent, cacheKey, P, ao, fn, uvScale) {
  let entries = GEO_CACHE.get(cacheKey);
  if (!entries) {
    const B = createBuilder(ao, uvScale);
    fn(B);
    entries = [];
    for (const [k, list] of B.buckets) {
      if (list.length) entries.push([k, mergeGeos(list)]);
    }
    GEO_CACHE.set(cacheKey, entries);
  }
  for (const [k, geo] of entries) {
    const mesh = new THREE.Mesh(geo, P[k] || P.armor);
    mesh.name = `${cacheKey}#${k}`;
    mesh.castShadow = P._shadow !== false;
    mesh.receiveShadow = P._shadow !== false;
    parent.add(mesh);
  }
  return parent;
}

function node(parent, name, x, y, z) {
  const g = new THREE.Group();
  if (name) g.name = name;
  g.position.set(x || 0, y || 0, z || 0);
  parent.add(g);
  return g;
}

let _discGeo = null;
function discGeo() {
  if (!_discGeo) {
    _discGeo = new THREE.CircleGeometry(1, 20);
    _discGeo.rotateX(-Math.PI / 2);
  }
  return _discGeo;
}

// One rotor: hard blades (merged, lit) + a translucent blur disc. VFX spins the
// returned group about its local Y.
function rotor(parentProps, P, cacheKey, radius, blades) {
  const g = new THREE.Group();
  parentProps.add(g);
  part(g, cacheKey, P, AO(0, 1, 1), (B) => {
    const n = blades || 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      B.push(new THREE.Matrix4().makeRotationY(a));
      B.box('dgrey', [radius * 0.9, 0.014, radius * 0.19],
        [radius * 0.5, 0, 0], { shade: 1.1, rz: 0.10 });
      B.pop();
    }
    B.cyl('dark', radius * 0.13, radius * 0.16, 0.08, 8, [0, 0.01, 0], 'y', { shade: 1.2 });
  });
  const disc = new THREE.Mesh(discGeo(), P.prop);
  disc.scale.set(radius, 1, radius);
  disc.castShadow = false;
  disc.receiveShadow = false;
  disc.renderOrder = 2;
  g.add(disc);
  return g;
}

// ------------------------------------------------------------ shared details

const ERA = 0xB0ADA2;            // reactive-armour block tint (over camo)
const HEAT = 0x8A6A50;           // exhaust / heat-stained metal tint

// Tracked running gear: belt runs, idler + drive sprocket, road wheels, ribs.
// CRITIQUE FIX 4: `ground` defaults to 0, not 0.04. Local y = 0 is the contact
// plane for every model in this file, callers place the group at
// terrain.heightAt(x, z), and a 4 cm gap under a 5-metre tank is exactly the
// kind of tell that reads as "placeholder" in a still frame.
// ROUND-2 CRITIQUE FIX 2. The old version of this function was the "single
// extruded dark skirt" the critic photographed: two flat boxes for the runs,
// two full-radius cylinders for the ends and a row of ribs. There was no
// running gear at all — no sprocket, no idler, no return roller, and the "road
// wheels" were the same radius as the wrap so they vanished into the belt.
//
// What it builds now, per side:
//   • a segmented BELT — flat bottom run, sagging top run over the return
//     rollers, and two wrap arcs built from real tangent link plates, so the
//     silhouette at the ends is a polygonal chain of shoes and not a disc;
//   • a toothed DRIVE SPROCKET at the rear (hub, tooth ring, two rim plates);
//   • a smooth IDLER at the front with a tension-arm and rim lip;
//   • `wheels` ROAD WHEELS on swing arms, each with a rubber tyre, a dished
//     rim, lightening holes and a hub cap;
//   • two RETURN ROLLERS carrying the top run;
//   • shock absorbers on the first and last stations.
// The link PITCH itself comes from the track normal map (SURFACE.tracks, 4.3
// repeats ⇒ ~0.17 u shoes), which is what the critique explicitly allowed and
// what keeps this at ~1.7k triangles a side instead of ~6k.
// Convex hull (Andrew monotone chain) of a set of circles sampled at `res`
// points each. Used to route the track belt around the sprocket, idler and the
// two outer road wheels: the hull IS the taut belt, and because it comes back
// as a polygon its edges are already the individual link plates. Doing it this
// way rather than solving four external tangents analytically removes the whole
// class of "which side is the tangent on" bugs, and it costs 80 points and one
// sort, once per unit TYPE (the geometry is cached).
function beltHull(circles, res) {
  const pts = [];
  for (const c of circles) {
    for (let i = 0; i < res; i++) {
      const a = (i / res) * TAU;
      pts.push([c[0] + Math.cos(a) * c[2], c[1] + Math.sin(a) * c[2]]);
    }
  }
  pts.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2
      && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2
      && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function addTracks(B, o) {
  const len = o.len;
  const halfZ = o.halfZ;
  const beltW = o.beltW || 0.60;
  const ground = o.ground == null ? 0 : o.ground;
  const topY = o.topY;
  const n = o.wheels || 6;
  const thk = Math.min(0.10, (topY - ground) * 0.17);

  // ---- station geometry, SOLVED rather than assumed ------------------------
  // Constraints, all of which the old code violated at once:
  //   (1) the belt's lowest surface is the contact plane (`ground`);
  //   (2) the belt's highest surface is `topY` (fenders sit on it);
  //   (3) no two adjacent road wheels may interpenetrate — they are coplanar
  //       cylinders, so an overlap is an artefact, not interleaved suspension;
  //   (4) the first/last road wheel must clear the sprocket/idler.
  // Let rw = road-wheel radius, Rs = 1.18·rw the sprocket/idler radius and
  // g = 1.15 the station clearance factor. Then
  //   wheelSpan = len − 2·thk − 2·g·(Rs + rw)   and   rw = 0.485·wheelSpan/(n−1)
  // which solves in closed form to the expression below. Everything else in
  // this function is a consequence of it.
  const rw = clamp((0.485 * len - 0.97 * thk) / (n + 2.576),
    (topY - ground) * 0.13, (topY - ground) * 0.34);
  const Rs = rw * 1.18;                     // drive sprocket / idler radius
  const wy = ground + thk + rw;             // road-wheel axle: tyre ON the belt
  const ys = topY - thk - Rs;               // sprocket / idler axle
  const xs0 = -len / 2 + Rs + thk;          // rear — drive sprocket
  const xs1 = len / 2 - Rs - thk;           // front — idler
  const wx0 = xs0 + (Rs + rw) * 1.15;
  const wx1 = xs1 - (Rs + rw) * 1.15;
  const step = n > 1 ? (wx1 - wx0) / (n - 1) : 0;
  // One track shoe. Solved off the road-wheel radius so a 7-wheel SPG gets
  // proportionally the same pitch as a 6-wheel MBT, then clamped so the plate
  // count stays sane at either end of the roster.
  const linkLen = clamp(rw * 0.60, 0.20, 0.34);
  const rr = rw * 0.42;                     // return roller radius
  const ry = topY - thk - rr;               // roller axle: belt on its crown
  const rx1 = n > 3 ? wx0 + step * 1.5 : (xs0 + xs1) * 0.5 - Rs;
  const rx2 = n > 3 ? wx0 + step * (n - 2.5) : (xs0 + xs1) * 0.5 + Rs;

  // ---- the belt path -------------------------------------------------------
  // Convex hull of the four wrap circles, offset outward by half the link
  // thickness. This is what gives the authentic modern-tank silhouette: a flat
  // ground run, a straight top run, and the two DIAGONALS where the belt climbs
  // from the outer road wheels up to the raised sprocket and idler. A single
  // ground-to-top circle at each end (what this used to be) is a WW1 profile.
  const hull = beltHull([
    [xs0, ys, Rs + thk / 2],
    [xs1, ys, Rs + thk / 2],
    [wx1, wy, rw + thk / 2],
    [wx0, wy, rw + thk / 2],
  ], 20);

  for (const s of [-1, 1]) {
    const z = s * halfZ;

    // hull sidewall behind the running gear: without it you look straight
    // through the suspension to the wheat, which is exactly why the previous
    // version had to be a solid skirt
    B.box('armor', [len * 0.94, (topY - thk) - wy, beltW * 0.16],
      [0, (wy + topY - thk) / 2, z - s * (beltW * 0.50)], { shade: 0.58 });

    // PHASE-2: the belt is a CHAIN OF LINKS, not one plate per hull edge.
    // Around the sprocket and idler the hull polygon already gave one plate per
    // 18° of arc, but the two long runs came out as a single 4.4-unit and a
    // single 3.0-unit box — i.e. exactly the "solid extruded skirt" the critic
    // photographed, everywhere the eye actually looks. Every edge is now cut
    // into shoe-length (`linkLen`) plates with alternating value. The link
    // PITCH detail — hinge gaps, connector bolts, rubber pads — is the track
    // normal map laid over the top of this.
    let link = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L = Math.sqrt(dx * dx + dy * dy);
      if (L < 1e-4) continue;
      const ang = Math.atan2(dy, dx);
      const ux = dx / L;
      const uy = dy / L;
      const nSeg = Math.max(1, Math.round(L / linkLen));
      const seg = L / nSeg;
      // Absolute, not proportional, overlap — a 6 % stretch on the 4.4-unit top
      // run would poke 13 cm past the tangent point and break the diagonal at
      // the front of the track. It is applied ONLY at the two ends of an edge:
      // at a hull corner the neighbouring edge leaves at an angle so the
      // overlap just closes the wedge, whereas overlapping two COLLINEAR plates
      // would put two coplanar faces in the same place and z-fight.
      const ext = thk * 0.55;
      for (let k = 0; k < nSeg; k++) {
        const e0 = k === 0 ? ext : 0;
        const e1 = k === nSeg - 1 ? ext : 0;
        const mid = k * seg + seg / 2 + (e1 - e0) / 2;
        const cx = a[0] + ux * mid;
        const cy = a[1] + uy * mid;
        const up = (cy - (ground + (topY - ground) / 2)) / ((topY - ground) / 2);
        // ±4 % per shoe: close up it is the difference between a polished
        // contact face and one still packed with mud; at RTS zoom it is the
        // fine dither that keeps reading as pitch after the normal map has
        // mipped away.
        const alt = (link++ & 1) ? 0.962 : 1.038;
        B.box('rubber', [seg + e0 + e1, thk, beltW], [cx, cy, z],
          { rz: ang, shade: (0.86 + 0.24 * clamp(up, -1, 1)) * alt });
      }
    }

    // ---- drive sprocket (rear): small hub, tooth ring out to the pitch circle
    B.cyl('dark', Rs * 0.62, Rs * 0.62, beltW * 0.60, 12, [xs0, ys, z], 'z', { shade: 1.05 });
    B.cyl('dark', Rs * 0.40, Rs * 0.40, beltW * 0.94, 10, [xs0, ys, z], 'z', { shade: 1.18 });
    const TEETH = 12;
    for (let i = 0; i < TEETH; i++) {
      const a = (i / TEETH) * TAU;
      B.box('dark', [Rs * 0.34, Rs * 0.26, beltW * 0.34],
        [xs0 + Math.cos(a) * Rs * 0.80, ys + Math.sin(a) * Rs * 0.80, z],
        { rz: a, shade: 1.22 });
    }
    // final-drive housing, inboard of the sprocket
    B.cyl('armor', Rs * 0.66, Rs * 0.74, beltW * 0.50, 10,
      [xs0, ys, z - s * (beltW * 0.52)], 'z', { shade: 0.92 });

    // ---- idler (front) + tension arm
    B.cyl('rubber', Rs * 0.92, Rs * 0.92, beltW * 0.70, 14, [xs1, ys, z], 'z', { shade: 0.86 });
    B.cyl('dark', Rs * 0.98, Rs * 0.98, beltW * 0.16, 14, [xs1, ys, z + s * beltW * 0.32], 'z',
      { shade: 1.12 });
    B.cyl('dark', Rs * 0.34, Rs * 0.34, beltW * 0.82, 8, [xs1, ys, z], 'z', { shade: 1.16 });
    B.box('armor', [Rs * 1.9, Rs * 0.46, beltW * 0.34],
      [xs1 - Rs * 0.95, ys - Rs * 0.30, z - s * beltW * 0.46], { rz: 0.22, shade: 0.94 });

    // ---- road wheels on swing arms
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? (wx0 + wx1) / 2 : wx0 + i * step;
      B.box('armor', [rw * 1.5, rw * 0.50, beltW * 0.26],
        [x + rw * 0.62, wy + rw * 0.20, z - s * (beltW * 0.34)], { rz: 0.22, shade: 0.88 });
      B.cyl('rubber', rw, rw, beltW * 0.78, 12, [x, wy, z], 'z', { shade: 0.84 });
      B.cyl('dark', rw * 0.72, rw * 0.72, beltW * 0.30, 12, [x, wy, z + s * beltW * 0.30], 'z',
        { shade: 1.16 });
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU + i * 0.4;
        B.box('dark', [rw * 0.28, rw * 0.28, beltW * 0.16],
          [x + Math.cos(a) * rw * 0.42, wy + Math.sin(a) * rw * 0.42, z + s * beltW * 0.38],
          { rz: a, shade: 0.70 });
      }
      B.cyl('dark', rw * 0.24, rw * 0.24, beltW * 0.42, 8, [x, wy, z + s * beltW * 0.30], 'z',
        { shade: 1.26 });
      // shock absorbers on the end stations
      if (i === 0 || i === n - 1) {
        const dir = i === 0 ? 1 : -1;
        B.cyl('dark', 0.05, 0.05, rw * 2.0, 6,
          [x + dir * rw * 0.55, wy + rw * 0.85, z - s * (beltW * 0.56)], 'y',
          { rz: dir * 0.62, shade: 1.20 });
      }
    }

    // ---- return rollers under the top run
    for (const rxp of [rx1, rx2]) {
      const rz = z - s * (beltW * 0.12);
      B.cyl('rubber', rr, rr, beltW * 0.58, 10, [rxp, ry, rz], 'z', { shade: 0.90 });
      B.cyl('dark', rr * 0.44, rr * 0.44, beltW * 0.82, 8, [rxp, ry, rz], 'z', { shade: 1.20 });
      B.box('armor', [rr * 0.8, rr * 1.8, beltW * 0.26],
        [rxp, ry - rr * 0.9, rz - s * beltW * 0.44], { shade: 0.95 });
    }
  }
}

// Wheeled running gear. The tyre tread comes from the track normal map bound to
// the `rubber` material (vertical shoulder blocks read correctly as tread), so
// the geometry only has to carry the silhouette lugs, a dished rim, six wheel
// nuts and a hub cap — ROUND-2 FIX 2 for the wheeled half of the roster.
function addWheels(B, xs, halfZ, r, w, opts) {
  const dual = opts && opts.dual;
  for (const s of [-1, 1]) {
    for (const x of xs) {
      const zs = dual && dual.indexOf(x) !== -1
        ? [s * (halfZ - w * 0.52), s * (halfZ + w * 0.52)]
        : [s * halfZ];
      for (const z of zs) {
        const outer = z + s * w * 0.5;
        B.cyl('rubber', r, r, w, 14, [x, r, z], 'z', { shade: 0.82 });
        // shoulder lugs — silhouette only, six is plenty at this scale
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU;
          B.box('rubber', [0.10, r * 0.44, w + 0.03],
            [x + Math.cos(a) * r * 0.80, r + Math.sin(a) * r * 0.80, z],
            { rz: a, shade: 1.06 });
        }
        // dished steel rim + nuts + hub cap
        B.cyl('dark', r * 0.60, r * 0.60, w * 0.22, 12, [x, r, outer], 'z', { shade: 1.14 });
        B.cyl('dark', r * 0.46, r * 0.46, w * 0.30, 10, [x, r, outer + s * 0.02], 'z',
          { shade: 0.92 });
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU + 0.3;
          B.box('dark', [0.055, 0.055, w * 0.16],
            [x + Math.cos(a) * r * 0.34, r + Math.sin(a) * r * 0.34, outer + s * 0.05],
            { rz: a, shade: 1.28 });
        }
        B.cyl('dark', r * 0.17, r * 0.17, w * 0.30, 8, [x, r, outer + s * 0.03], 'z',
          { shade: 1.30 });
        // brake drum / hub carrier behind the wheel
        B.cyl('armor', r * 0.52, r * 0.56, w * 0.40, 10, [x, r, z - s * w * 0.62], 'z',
          { shade: 0.90 });
      }
    }
  }
}

// Anti-FPV slat cage — the silhouette that says "this war".
// ROUND-2 FIX 2: the grid used to float over the roof on four hairline posts
// that started at `yTop − postH` regardless of where the roof actually was.
// `opts.base` now anchors the stanchions ON the plate they stand on, they are
// thicker than the mesh bars, they get corner gussets and diagonal knee braces,
// and mid-span posts stop the long edges sagging visually.
function cage(B, key, x0, x1, halfZ, yTop, opts) {
  const o = opts || {};
  const bar = o.bar || 0.055;
  const postH = o.postH || 0.55;
  const shade = o.shade || 1.18;
  const nLong = o.long || 5;
  const nCross = o.cross || 5;
  const y0 = o.base == null ? yTop - postH : o.base;
  const h = Math.max(0.12, yTop - y0);
  const post = bar * 1.9;

  for (const sx of [x0, x1]) {
    for (const sz of [-halfZ, halfZ]) {
      B.box(key, [post, h, post], [sx, y0 + h / 2, sz], { shade });
      // foot plate — the part that makes it stand ON something
      B.box(key, [post * 2.6, 0.035, post * 2.6], [sx, y0 + 0.018, sz], { shade: shade * 0.92 });
      // knee braces to the frame, one in each plane
      B.strut(key, [sx, y0 + 0.04, sz], [sx + (sx === x0 ? 0.30 : -0.30), yTop - 0.02, sz],
        bar * 0.62, 4, { shade: shade * 0.96 });
      B.strut(key, [sx, y0 + 0.04, sz], [sx, yTop - 0.02, sz + (sz < 0 ? 0.26 : -0.26)],
        bar * 0.62, 4, { shade: shade * 0.96 });
    }
  }
  // mid-span stanchions on the long edges
  if (x1 - x0 > 1.2) {
    for (const sz of [-halfZ, halfZ]) {
      B.box(key, [post * 0.85, h, post * 0.85], [(x0 + x1) / 2, y0 + h / 2, sz], { shade });
    }
  }
  for (let i = 0; i < nLong; i++) {
    const z = -halfZ + 2 * halfZ * (i / (nLong - 1));
    B.box(key, [x1 - x0, bar, bar], [(x0 + x1) / 2, yTop, z], { shade });
  }
  for (let i = 0; i < nCross; i++) {
    const x = x0 + (x1 - x0) * (i / (nCross - 1));
    B.box(key, [bar, bar, halfZ * 2], [x, yTop, 0], { shade });
  }
  // perimeter rail — the mesh reads as a built object, not a floating plane
  B.box(key, [x1 - x0, bar * 1.3, bar * 1.3], [(x0 + x1) / 2, yTop, -halfZ], { shade: shade * 1.04 });
  B.box(key, [x1 - x0, bar * 1.3, bar * 1.3], [(x0 + x1) / 2, yTop, halfZ], { shade: shade * 1.04 });
  B.box(key, [bar * 1.3, bar * 1.3, halfZ * 2], [x0, yTop, 0], { shade: shade * 1.04 });
  B.box(key, [bar * 1.3, bar * 1.3, halfZ * 2], [x1, yTop, 0], { shade: shade * 1.04 });
}

// Whip antenna. ROUND-2 FIX 2: a straight tapered cylinder reads as a spike; a
// real whip is a curve, so this is a 5-segment tapered polyline bent along a
// quadratic, on a spring base with a tie-down and a tip bead.
function addAntenna(B, x, y, z, h, lean) {
  const L = lean || 0;
  B.box('dark', [0.13, 0.09, 0.13], [x, y + 0.045, z], { shade: 1.0 });
  B.cyl('dark', 0.045, 0.055, 0.13, 8, [x, y + 0.14, z], 'y', { shade: 1.12 });
  const N = 5;
  const px = (t) => x + L * h * t * t;
  const py = (t) => y + 0.20 + (h - 0.20) * t;
  const pz = (t) => z + L * 0.35 * h * t * t;
  for (let i = 0; i < N; i++) {
    const t0 = i / N;
    const t1 = (i + 1) / N;
    const rad = 0.019 * (1 - t0 * 0.72);
    B.strut('dark', [px(t0), py(t0), pz(t0)], [px(t1), py(t1), pz(t1)], rad, 5,
      { shade: 1.20 + 0.10 * t0 });
  }
  B.sph('dark', 0.026, [px(1), py(1), pz(1)], { shade: 1.32 });
}

// Bedroll + rolled tarp + tool box. ROUND-2 FIX 2 asked for 2–3 stowage props
// per vehicle; this is one of the three (see addJerrycans / addTowCable).
function addStowage(B, x, y, z, s) {
  const w = s || 1;
  B.box('canvas', [0.62 * w, 0.28 * w, 0.46 * w], [x, y, z], { shade: 0.95 });
  // lashing straps over the bundle
  for (const sx of [-0.18, 0.18]) {
    B.box('dark', [0.05 * w, 0.31 * w, 0.49 * w], [x + sx * w, y, z], { shade: 0.78 });
  }
  // rolled bedroll with end caps and a tie
  B.cyl('canvas', 0.16 * w, 0.16 * w, 0.5 * w, 8, [x - 0.42 * w, y + 0.02, z], 'z',
    { shade: 1.05 });
  B.cyl('canvas', 0.115 * w, 0.115 * w, 0.53 * w, 8, [x - 0.42 * w, y + 0.02, z], 'z',
    { shade: 0.86 });
  B.box('dark', [0.34 * w, 0.05 * w, 0.34 * w], [x - 0.42 * w, y + 0.02, z], { shade: 0.8 });
  // tool box with latch
  B.box('dark', [0.24 * w, 0.30 * w, 0.20 * w], [x + 0.44 * w, y + 0.02, z], { shade: 0.9 });
  B.box('dark', [0.26 * w, 0.04 * w, 0.06 * w], [x + 0.44 * w, y + 0.10 * w, z], { shade: 1.2 });
}

// Jerrycans in a rack — the X-rib pressing is what makes a can read as a can.
function addJerrycans(B, x, y, z, n, ry) {
  const count = n || 2;
  for (let i = 0; i < count; i++) {
    const cx = x - i * 0.26;
    B.box('armor', [0.22, 0.44, 0.34], [cx, y, z], { ry: ry || 0, shade: 0.95 });
    // pressed X ribs on the outer face
    B.box('dark', [0.02, 0.42, 0.05], [cx + 0.115, y, z], { ry: ry || 0, rz: 0.72, shade: 1.14 });
    B.box('dark', [0.02, 0.42, 0.05], [cx + 0.115, y, z], { ry: ry || 0, rz: -0.72, shade: 1.14 });
    // cap + carry handles
    B.cyl('dark', 0.045, 0.045, 0.05, 8, [cx, y + 0.24, z + 0.10], 'y', { shade: 1.2 });
    B.box('dark', [0.19, 0.035, 0.05], [cx, y + 0.23, z - 0.05], { shade: 1.1 });
  }
  // retaining strap
  B.box('dark', [0.26 * count + 0.06, 0.05, 0.37], [x - (count - 1) * 0.13, y + 0.08, z],
    { ry: ry || 0, shade: 0.8 });
}

// Tow cable coiled along a hull flank: a shallow catenary of struts with a
// shackle eye at each end. Three-metre steel rope is on every real vehicle in
// this war and it breaks up the long flat side that the critique called flat.
function addTowCable(B, x0, x1, y, z, sag) {
  const N = 6;
  const d = sag == null ? 0.16 : sag;
  const p = (t) => [x0 + (x1 - x0) * t, y - d * Math.sin(Math.PI * t), z];
  for (let i = 0; i < N; i++) {
    B.strut('dark', p(i / N), p((i + 1) / N), 0.030, 5, { shade: 1.10 });
  }
  for (const t of [0, 1]) {
    const e = p(t);
    B.cyl('dark', 0.075, 0.075, 0.06, 8, [e[0], e[1], e[2]], 'z', { shade: 1.22 });
    B.cyl('rubber', 0.042, 0.042, 0.08, 6, [e[0], e[1], e[2]], 'z', { shade: 0.8 });
  }
  // two cable clips holding it to the flank
  for (const t of [0.32, 0.68]) {
    const e = p(t);
    B.box('dark', [0.07, 0.10, 0.05], [e[0], e[1] + 0.05, e[2]], { shade: 1.05 });
  }
}

// Smoke-grenade launcher bank: `n` tubes in two rows on a bolted bracket,
// canted outboard by `out` and up by 0.42 rad. Every vehicle in this war carries
// a cluster of these and they are a strong silhouette cue at the turret cheek.
// (The MBT and the IFV hand-roll their own banks to fit their exact cheek
// geometry; this is for the vehicles that had none at all.)
function addSmokeBank(B, x, y, z, s, n, out) {
  const count = n || 4;
  const yaw = s * -(out == null ? 0.45 : out);
  // Tube axis after `ry` then `rz` (place() applies them in that order) is
  // Rz(0.42)·Ry(yaw)·(1,0,0) — solved here so the muzzle collar lands on the
  // open end of the tube whatever way the bank is canted.
  const dx = Math.cos(0.42) * Math.cos(yaw);
  const dy = Math.sin(0.42) * Math.cos(yaw);
  const dz = -Math.sin(yaw);
  B.box('armor', [0.34, 0.12, 0.18], [x - 0.09, y - 0.13, z], { ry: yaw, shade: 0.98 });
  for (let i = 0; i < count; i++) {
    const px = x - (i % 2) * 0.16;
    const py = y + ((i / 2) | 0) * 0.17;
    B.cyl('dark', 0.073, 0.073, 0.28, 8, [px, py, z], 'x', { ry: yaw, rz: 0.42, shade: 1.10 });
    B.cyl('dark', 0.084, 0.084, 0.035, 8,
      [px + dx * 0.15, py + dy * 0.15, z + dz * 0.15], 'x',
      { ry: yaw, rz: 0.42, shade: 1.24 });
  }
}

// A worn plate edge. Procedural 90° corners are what make a box read as a box:
// a real hull corner is rolled, and it has been chipped back to bare metal by
// crews climbing over it, so it is the ONE feature on a vehicle that catches a
// 14° key when the plates either side of it are in shade. This lays a hairline
// rod along the corner, tinted to scuffed steel and shaded to the top of the
// range, and because it is round it holds a specular streak along its length.
const WEAR = 0xCFCABA;
function edgeWear(B, a, b, opts) {
  const o = opts || {};
  B.strut(o.key || 'armor', a, b, o.r == null ? 0.019 : o.r, 4,
    { shade: o.shade || 1.22, tint: o.tint === undefined ? WEAR : o.tint });
}

// ================================================== ROUND-6 FIX 13: mid-scale
// surface detail. The round-6 critique's structural finding is that our
// surfaces "have detail at exactly one scale" — fine texture that the mip chain
// eats, and a silhouette, with nothing in between. On a vehicle the missing
// band is 3-15 cm relief: weld beads, fastener bosses, hinge lugs, grab rails.
// All three helpers below are GEOMETRY, deliberately, because that is the only
// kind of detail that keeps its contrast as the sampling gets finer instead of
// averaging toward the tile mean.
//
// SCALE NOTE, because it is what makes this honest: the MBT hull here is 5.30 u
// long against a ~7.4 m real hull, so 1 u ≈ 1.40 m. A real M12 bolt head (19 mm)
// is 0.014 u — at the 24 u camera the critique used that is ~1.3 px, i.e. noise.
// So nothing below is a bolt head. What is modelled is the 6-12 cm hardware a
// person actually resolves at 20-40 u: the weld bead, the boss/washer stack the
// bolt sits in, the hinge lug, the handle.

// A welded plate join. A real armour seam is a rope of overlapping passes, not
// a line, so this is a chain of short rods whose radius alternates ±16 % and
// whose value alternates ±6 %. That gives the run TWO scales at once — a raised
// line at 60 u, a chain of ripples at 20 u — which is exactly the property a
// single-scale metric cannot see and a person can.
//
// APPARENT SIZE, derived from the camera (fov 40°, 1080 px tall, so px/u =
// 1080 / (2·d·tan 20°) = 1483/d) — this is optics arithmetic, not a rendered
// measurement: at the default 24 u close camera one bead pitch (0.28 u) is
// 17 px and the bead itself is 3.7 px across; at the 15 u zoom stop they are
// 28 px and 5.9 px. So the RIPPLE is the feature that reads and the bead's
// cross-section is not: `seg` 3 costs about a pixel of silhouette against
// `seg` 12 and saves 36 triangles a bead — a 5 u seam is ~216 triangles
// instead of ~864.
function weldSeam(B, a, b, opts) {
  const o = opts || {};
  const key = o.key || 'armor';
  const r = o.r == null ? 0.030 : o.r;
  const pitch = o.pitch == null ? 0.28 : o.pitch;
  const seg = o.seg || 3;
  const sh = o.shade == null ? 1.10 : o.shade;
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (L < 1e-4) return;
  const n = Math.max(2, Math.round(L / pitch));
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    // 14 % overlap forward, clamped at the end, so consecutive passes fuse
    // instead of leaving a gap the eye reads as a dashed line
    const t1 = Math.min(1, (i + 1.14) / n);
    const rr = r * ((i & 1) ? 0.84 : 1.16);
    B.strut(key,
      [a[0] + dx * t0, a[1] + dy * t0, a[2] + dz * t0],
      [a[0] + dx * t1, a[1] + dy * t1, a[2] + dz * t1],
      rr, seg, { shade: sh * ((i & 1) ? 0.94 : 1.06), tint: o.tint });
  }
}

// A run of fastener bosses along a line — skirt hinge bolts, bracket pads, ERA
// retaining studs. See the scale note: these are the 8-12 cm boss the bolt sits
// in, drawn as a box because at 6-9 px a 6-sided cylinder costs twice the
// triangles to look identical.
function boltRow(B, a, b, n, opts) {
  const o = opts || {};
  const key = o.key || 'dark';
  const s = o.size == null ? 0.070 : o.size;
  const h = o.h == null ? 0.042 : o.h;
  const sh = o.shade == null ? 1.16 : o.shade;
  const count = Math.max(1, n | 0);
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const dim = o.axis === 'x' ? [h, s, s] : o.axis === 'y' ? [s, h, s] : [s, s, h];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    B.box(key, dim, [a[0] + dx * t, a[1] + dy * t, a[2] + dz * t],
      { shade: sh * (1 + ((i & 1) ? 0.04 : -0.04)), tint: o.tint });
  }
}

// Crew grab handle: two feet on the plate and a bar standing off it. This is a
// SILHOUETTE feature, not a surface one — it is the cheapest thing on the list
// that survives to 60 u, because it breaks the plate outline against whatever
// is behind it instead of relying on a shading gradient.
// `a` and `b` are the feet, in the part's local space; `out` is the stand-off
// vector (direction AND length), so the same call works on a roof, a flank or a
// sloped glacis without a separate axis argument.
function grabRail(B, a, b, out, opts) {
  const o = opts || {};
  const key = o.key || 'dark';
  const r = o.r == null ? 0.026 : o.r;
  const sh = o.shade == null ? 1.18 : o.shade;
  const A = [a[0] + out[0], a[1] + out[1], a[2] + out[2]];
  const C = [b[0] + out[0], b[1] + out[1], b[2] + out[2]];
  B.strut(key, a, A, r, 4, { shade: sh * 0.94 });
  B.strut(key, b, C, r, 4, { shade: sh * 0.94 });
  B.strut(key, A, C, r * 1.05, 5, { shade: sh });
}

// Louvred exhaust outlet: a stack of angled slats in a frame, plus a deflector
// lip. The MBT had a plain box + tube here and the IFV had nothing at all,
// which is why both read as sealed castings from behind.
function exhaustLouvre(B, x, y, z, w, hh, opts) {
  const o = opts || {};
  const face = o.face === 'z' ? 'z' : 'x';
  const sh = o.shade == null ? 1.0 : o.shade;
  const n = o.slats || 4;
  // frame
  if (face === 'x') {
    B.box('armor', [0.10, hh, w], [x, y, z], { shade: sh * 0.92, tint: HEAT });
    for (let i = 0; i < n; i++) {
      const yy = y - hh * 0.5 + hh * ((i + 0.5) / n);
      B.box('dark', [0.14, hh / n * 0.62, w * 0.90], [x + 0.03, yy, z],
        { rz: 0.42, shade: sh * (1.12 - 0.06 * (i & 1)), tint: HEAT });
    }
    B.box('armor', [0.16, 0.05, w * 1.06], [x + 0.06, y + hh * 0.5 + 0.02, z],
      { rz: -0.20, shade: sh * 1.14, tint: HEAT });
  } else {
    B.box('armor', [w, hh, 0.10], [x, y, z], { shade: sh * 0.92, tint: HEAT });
    for (let i = 0; i < n; i++) {
      const yy = y - hh * 0.5 + hh * ((i + 0.5) / n);
      B.box('dark', [w * 0.90, hh / n * 0.62, 0.14], [x, yy, z + 0.03],
        { rx: -0.42, shade: sh * (1.12 - 0.06 * (i & 1)), tint: HEAT });
    }
    B.box('armor', [w * 1.06, 0.05, 0.16], [x, y + hh * 0.5 + 0.02, z + 0.06],
      { rx: 0.20, shade: sh * 1.14, tint: HEAT });
  }
}

// One side-skirt panel, hung from its hinge line. Round 6 photographed the
// running gear as "a flat dark rectangle with a lighter band" — the lighter
// band IS this array, and until now it was five identical flat boxes. A real
// skirt is a hinged panel with a swaged stiffener down the middle, two hinge
// lugs on the top edge, and a hang angle that differs panel to panel because
// crews bend them on tree stumps. `k` (0..1) drives the per-panel variation so
// no two panels in a run are the same object.
function skirtPanel(B, x, y, z, w, hh, thk, k, opts) {
  const o = opts || {};
  const s = z < 0 ? -1 : 1;
  // ±8 % value between panels (0.92 … 1.08): at 24 u this is the difference
  // between a row of plates and one extruded band, and unlike a texture feature
  // it survives every mip level, because it IS the mip level's mean.
  const v = 0.92 + 0.16 * k;
  // one panel per run is knocked out of true — 0.06 rad is ~3.5°, enough to
  // catch a different amount of key without reading as damage
  const cant = o.cant || 0;
  B.box('armor', [w, hh, thk], [x, y, z], { rx: cant, shade: 0.90 * v });
  // Swaged stiffener down the panel centre. `rib: false` on the two panels that
  // carry the hull number and the formation device — a 22 %-width rib standing
  // 3 cm proud straight through a marking is worse than no rib, and those two
  // panels get their value break from the decal instead.
  if (o.rib !== false) {
    B.box('armor', [w * 0.22, hh * 0.86, thk * 0.75], [x, y, z + s * thk * 0.72],
      { rx: cant, shade: 0.98 * v });
  }
  // hinge lugs on the top edge, and the pin between them
  for (const lx of [-w * 0.30, w * 0.30]) {
    B.box('dark', [w * 0.16, 0.085, thk * 1.9], [x + lx, y + hh * 0.5 + 0.02, z],
      { shade: 1.14 });
  }
  B.strut('dark', [x - w * 0.40, y + hh * 0.5 + 0.02, z + s * thk * 0.5],
    [x + w * 0.40, y + hh * 0.5 + 0.02, z + s * thk * 0.5], 0.022, 4, { shade: 1.20 });
  // caked mud fillet along the bottom edge — the one place on a tracked
  // vehicle that is never clean, and a second value break at the panel's foot
  B.box('rubber', [w * 0.92, 0.10, thk * 2.3], [x, y - hh * 0.5 + 0.03, z],
    { rx: cant, shade: 0.74, tint: 0x8A7355 });
}

// ------------------------------------------------------------------- decals
// ROUND-2 FIX 2 (markings). Alpha-tested quads standing 12 mm proud of the
// panel they sit on. One shared material and one geometry per atlas cell, so a
// full order of battle costs a handful of extra draw calls and no state churn.

let _decalMat = null;
function decalMat() {
  if (_decalMat) return _decalMat;
  const tex = decalTex();
  if (!tex) return null;
  _decalMat = new THREE.MeshStandardMaterial({
    map: tex,
    color: 0xFFFFFF,
    roughness: 0.82,
    metalness: 0,
    alphaTest: 0.42,
    transparent: false,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -6,
  });
  return _decalMat;
}

// Atlas cell -> [u0, v0, u1, v1]. Canvas Y runs down and texture V runs up, so
// atlas row 0 is the TOP of the tile. The inset is one atlas texel at 512 plus
// a hair, which stops a neighbouring cell bleeding in at low mips.
function cellUV(cell) {
  const c = 1 / DECAL_CELLS;
  const col = cell % DECAL_CELLS;
  const row = Math.floor(cell / DECAL_CELLS);
  const inset = 0.0035;
  return [col * c + inset, 1 - (row + 1) * c + inset,
    (col + 1) * c - inset, 1 - row * c - inset];
}

const DECAL_FACE = {
  'z+': [0, 0],
  'z-': [0, Math.PI],
  'x+': [0, Math.PI / 2],
  'x-': [0, -Math.PI / 2],
  'y+': [-Math.PI / 2, 0],
};

const _dq = new THREE.Quaternion();
const _dq2 = new THREE.Quaternion();
const _de = new THREE.Euler();
const _dnorm = new THREE.Vector3();
const _dvec = new THREE.Vector3();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);

// Local quad corners in PlaneGeometry(1,1) order, and its triangle winding.
const DQ_X = [-0.5, 0.5, -0.5, 0.5];
const DQ_Y = [0.5, 0.5, -0.5, -0.5];
const DQ_TRI = [0, 2, 1, 2, 3, 1];

// One hull number per VEHICLE (not per decal), drawn from the instance's own
// seeded stream so a scenario is byte-identical on reload.
function numCell(P) {
  if (P.numCell == null) {
    const red = P.faction === 'red';
    const n = red ? DECAL_NUM_RED.length : DECAL_NUM_BLUE.length;
    const k = P.r ? Math.floor(P.r() * n) : 0;
    P.numCell = (red ? DECAL_NUM0_RED : DECAL_NUM0_BLUE) + (k % n);
  }
  return P.numCell;
}

function facCell(P) {
  return P.faction === 'red' ? DECAL_RED : DECAL_BLUE;
}

// spec entries: { c: 'num' | 'fac' | <cell>, p: [x,y,z], f: face, w, h, o }
// `mirror: true` repeats the entry on both flanks (z is taken as |z|).
//
// PHASE 2: all the markings on one node are baked into ONE geometry and drawn
// by ONE mesh. They used to be a Mesh each — six draw calls on an MBT and ~150
// across a full order of battle, every one of them two triangles against a
// state change. The transform per quad is identical to what the old per-mesh
// path produced (face euler, then LOCAL tilt about X, then LOCAL spin about Z,
// then a push along the quad's own normal), it is just resolved on the CPU.
function addDecals(parent, P, list) {
  if (!P || P.ghost || !list || !list.length) return null;
  if (!P.decal) {
    const proto = decalMat();
    // per-unit clone for the same reason the palette is per-unit: hitFlash()
    // writes emissive on whatever it finds under a struck unit
    P.decal = proto ? proto.clone() : null;
  }
  const mat = P.decal;
  if (!mat) return null;

  const quads = [];
  for (const d of list) {
    const cell = d.c === 'num' ? numCell(P) : d.c === 'fac' ? facCell(P) : d.c;
    if (cell == null) continue;
    if (d.mirror) {
      const az = Math.abs(d.p[2]);
      quads.push([cell, d.p[0], d.p[1], az, 'z+', d.w, d.h, d.o]);
      quads.push([cell, d.p[0], d.p[1], -az, 'z-', d.w, d.h, d.o]);
    } else {
      quads.push([cell, d.p[0], d.p[1], d.p[2], d.f, d.w, d.h, d.o]);
    }
  }
  if (!quads.length) return null;

  const pos = new Float32Array(quads.length * 18);
  const nor = new Float32Array(quads.length * 18);
  const uvs = new Float32Array(quads.length * 12);
  let po = 0;
  let uo = 0;
  for (const q of quads) {
    const o = q[7] || {};
    const f = DECAL_FACE[q[4]] || DECAL_FACE['z+'];
    _de.set(f[0], f[1], 0, 'XYZ');
    _dq.setFromEuler(_de);
    if (o.tilt) _dq.multiply(_dq2.setFromAxisAngle(_xAxis, o.tilt));
    if (o.spin) _dq.multiply(_dq2.setFromAxisAngle(_zAxis, o.spin));
    _dnorm.set(0, 0, 1).applyQuaternion(_dq);
    const off = o.off == null ? 0.012 : o.off;
    const cx = q[1] + _dnorm.x * off;
    const cy = q[2] + _dnorm.y * off;
    const cz = q[3] + _dnorm.z * off;
    const uv = cellUV(q[0]);
    const uvx = [uv[0], uv[2], uv[0], uv[2]];
    const uvy = [uv[3], uv[3], uv[1], uv[1]];
    for (let k = 0; k < 6; k++) {
      const c = DQ_TRI[k];
      _dvec.set(DQ_X[c] * q[5], DQ_Y[c] * q[6], 0).applyQuaternion(_dq);
      pos[po] = cx + _dvec.x;
      pos[po + 1] = cy + _dvec.y;
      pos[po + 2] = cz + _dvec.z;
      nor[po] = _dnorm.x;
      nor[po + 1] = _dnorm.y;
      nor[po + 2] = _dnorm.z;
      po += 3;
      uvs[uo] = uvx[c];
      uvs[uo + 1] = uvy[c];
      uo += 2;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'decals';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 1;
  parent.add(mesh);
  return mesh;
}

// ------------------------------------------------ ground-contact shadow decal
// CRITIQUE FIX 4. The old answer was an elliptical blob decal — a dark pool the
// size of a hex under every vehicle, which is worse than no shadow at all: it
// reads as a camera-aligned sticker and it makes the tank look like it is
// hovering over a hole. This is the replacement.
//
// Why a decal at all when the sun already casts real shadows: the shadow rig is
// a 4096² map over a camera-tracked box with `normalBias ≈ 0.9`, and that bias is
// exactly what stops a 14°-lit ground plane from acneing against itself. The
// price is that the shadow DETACHES from the caster right where the tracks meet
// the dirt — the one place the eye checks. The map draws the long shadow; this
// draws the contact; both point the same way so they read as one shadow.
//
// Two capsules, both flat on the contact plane (local y ≈ 0.03):
//   contact — the vehicle's own footprint. Parented to the model root, so it
//             turns with the hull. This is the "it is touching the ground" term.
//   cast    — longer, softer, faded along its length, offset and aligned to the
//             SUN AZIMUTH (250° per ART_DIRECTION §1 → ground yaw −0.3489 rad).
//             It re-aims itself in onBeforeRender against the root's yaw, so a
//             vehicle may face any heading and its shadow still falls ESE.

// Sun azimuth 250°, position (−273.5, 72.6, −99.5) → the light's horizontal
// travel direction is −normalize(sun.xz) = (0.9397, 0.3418). A yaw θ maps the
// decal's local +X to (cos θ, −sin θ), so θ = atan2(−0.3418, 0.9397).
const SUN_GROUND_YAW = -0.3489;

const SHADOW_COLOR = 0x15170F;
const CONTACT_OPACITY = 0.52;
const CAST_OPACITY = 0.26;

// Footprint table: [length along +X, width along Z, silhouette height].
// Height only sets how far the cast capsule reaches and how far it is pushed
// downwind; it is deliberately NOT h·cot(14°) = 4h, because a literal 14°
// projection puts a 10-unit smear across the neighbouring hex and the shadow map
// is already drawing that part. This decal owns the first ~2 units.
const FOOTPRINT = {
  mbt: [5.30, 3.72, 2.30],
  ifv: [5.00, 3.50, 2.42],
  apc: [5.44, 3.32, 2.10],
  spg: [6.00, 3.92, 2.50],
  mlrs: [6.10, 3.44, 2.90],
  aa: [5.50, 3.28, 2.60],
  sam: [6.50, 3.90, 3.60],
  ew: [5.62, 3.20, 3.00],
  truck: [6.10, 2.62, 2.55],
  loiter_munition: [5.96, 2.60, 2.70],
  infantry: [3.30, 2.90, 0.95],
  atgm_team: [2.50, 2.30, 0.90],
  fpv_drone: [2.80, 2.40, 1.05],
  // airborne: the wing is the caster, and the decal sits on the ground under it
  recon_drone: [2.90, 4.20, 1.20],
  // The gunship's caster is the fuselage plus a hint of disc, NOT the full 6.4 u
  // rotor: a literal disc shadow is a black pool two thirds the width of the hex
  // and it swallows the terrain the unit is supposed to be flying over.
  helo: [5.60, 3.20, 1.70],
};

let _shadowGeo = null;
function shadowGeo() {
  if (!_shadowGeo) {
    _shadowGeo = new THREE.PlaneGeometry(1, 1);
    _shadowGeo.rotateX(-Math.PI / 2);       // lies in XZ, normal +Y
  }
  return _shadowGeo;
}

// White RGB, soft alpha capsule. `core` is the fraction of the half-width that
// stays fully opaque; `tail` fades the alpha along +x (the downwind end of the
// cast decal) so the smear dissolves instead of stopping at an edge.
function makeShadowTexture(core, tail) {
  const W = 192, H = 96;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const d = img.data;
  const a = 0.44;                            // capsule segment half-length in u
  const span = 1 - core || 1;
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H * 2 - 1;
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W * 2 - 1;
      const dx = Math.abs(u) - a;            // distance to the segment, in u/v
      const ex = dx > 0 ? dx / (1 - a) : 0;  // normalise the caps to the same 0..1
      const dist = Math.sqrt(ex * ex + v * v);
      let al = dist >= 1 ? 0 : dist <= core ? 1 : 1 - (dist - core) / span;
      al = al * al * (3 - 2 * al);           // smoothstep — no banding, no edge
      if (tail) {
        const t = Math.min(1, Math.max(0, (u + 0.35) / 1.35));
        al *= 1 - tail * t * t;
      }
      const o = (j * W + i) * 4;
      d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
      d[o + 3] = Math.round(al * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const _shadowMat = {};
function shadowMat(kind) {
  if (_shadowMat[kind] !== undefined) return _shadowMat[kind];
  const contact = kind === 'contact';
  const map = contact ? makeShadowTexture(0.30, 0) : makeShadowTexture(0.16, 0.82);
  // No canvas ⇒ no decal. A mapless MeshBasicMaterial here would draw a solid
  // black rectangle under every vehicle, which is worse than the bug it fixes.
  const m = map ? new THREE.MeshBasicMaterial({
    color: SHADOW_COLOR,
    map,
    transparent: true,
    opacity: contact ? CONTACT_OPACITY : CAST_OPACITY,
    depthWrite: false,
    depthTest: true,
    // The decal already sits 5 cm above the contact plane, which is ~100× the
    // depth-buffer resolution at RTS range, so this offset is not fighting
    // z-fighting — it is slope insurance, and it is deliberately small: a big
    // negative offset would pull the decal up over the bottom of the tracks.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  }) : null;
  _shadowMat[kind] = m;
  return m;
}

// Re-aim the cast decal at the sun each frame it is drawn. `this` is the decal.
// onBeforeRender runs inside WebGLRenderer.renderObject() immediately before
// modelViewMatrix is derived from matrixWorld, so writing matrixWorld here lands
// on THIS frame, not the next one.
function aimCastShadow() {
  const root = this.parent;
  if (!root) return;
  const want = SUN_GROUND_YAW - root.rotation.y;
  if (Math.abs(this.rotation.y - want) < 1e-4) return;
  const off = this.userData.off || 0;
  this.rotation.y = want;
  this.position.x = Math.cos(want) * off;
  this.position.z = -Math.sin(want) * off;
  this.updateMatrix();
  this.matrixWorld.multiplyMatrices(root.matrixWorld, this.matrix);
}

function addContactShadow(root, typeId, P) {
  if (!P || P._shadow === false) return;          // ghost previews get none
  const contactMat = shadowMat('contact');
  const castMat = shadowMat('cast');
  if (!contactMat || !castMat) return;
  const fp = FOOTPRINT[typeId] || FOOTPRINT.mbt;
  const len = fp[0], wid = fp[1], hgt = fp[2];
  const geo = shadowGeo();

  const contact = new THREE.Mesh(geo, contactMat);
  contact.name = 'shadow-contact';
  contact.scale.set(len * 1.06, 1, wid * 1.06);
  contact.position.y = 0.050;
  contact.castShadow = false;
  contact.receiveShadow = false;
  contact.renderOrder = 1;
  root.add(contact);

  // The cast capsule: half the footprint plus a height-driven reach, pushed
  // downwind far enough that its bright end still overlaps the tracks.
  const castLen = len * 0.62 + hgt * 1.45;
  const off = Math.min(hgt * 0.55, 1.75) + castLen * 0.20;
  const cast = new THREE.Mesh(geo, castMat);
  cast.name = 'shadow-cast';
  cast.scale.set(castLen, 1, wid * 0.80);
  cast.position.set(Math.cos(SUN_GROUND_YAW) * off, 0.044,
    -Math.sin(SUN_GROUND_YAW) * off);
  cast.rotation.y = SUN_GROUND_YAW;
  cast.userData.off = off;
  cast.castShadow = false;
  cast.receiveShadow = false;
  cast.renderOrder = 1;
  cast.onBeforeRender = aimCastShadow;
  root.add(cast);
}

// ------------------------------------------------------------ exact grounding
// CRITIQUE FIX 4, second half. Every builder is authored so that local y = 0 is
// the contact plane, but "authored so" is not "measured so": this walks the
// assembled model, takes the real bounding box of everything that is supposed to
// touch the ground, and shifts the model until min.y is exactly 0. Sub-trees
// named `lift` (the FPV quad hovering over its team, the recon UAV at 8.4 u) are
// excluded — dropping THOSE to the ground would land an aircraft in the wheat.
function isAirborne(o, root) {
  let p = o;
  while (p && p !== root) {
    if (p.name === 'lift') return true;
    p = p.parent;
  }
  return false;
}

const _gbox = new THREE.Box3();
const _gtmp = new THREE.Box3();

function groundModel(root) {
  root.updateMatrixWorld(true);
  _gbox.makeEmpty();
  let found = false;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || isAirborne(o, root)) return;
    if (o.name && o.name.indexOf('shadow') === 0) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    if (!o.geometry.boundingBox) return;
    _gtmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    _gbox.union(_gtmp);
    found = true;
  });
  if (!found || !Number.isFinite(_gbox.min.y)) return 0;
  const dy = _gbox.min.y;
  if (Math.abs(dy) > 0.004) {
    for (const c of root.children) c.position.y -= dy;
    root.updateMatrixWorld(true);
  }
  return dy;
}

// NOTE (round 2, critique fix 2): this file used to carry an `app6Sprite()` —
// a world-scaled APP-6 badge bolted onto the infantry far LOD, because at
// strategic zoom a four-man squad is six pixels tall and "friendly infantry
// section, here" has to survive anyway. `fx/markers.js` now puts a real counter
// over EVERY unit at a CONSTANT screen size, which is strictly better and covers
// every type, so the badge was deleted rather than left to double up with it.

// A posed low-poly rifleman. pose: 'stand' | 'kneel' | 'crouch' | 'prone'
// Every pose carries legs, a helmet sphere and a weapon cylinder — the round-1
// critique read the old squad as "four brown lumps", and a squad that cannot be
// told apart from a crate is the single worst readability failure in the game.
function soldier(B, x, z, ry, pose, opts) {
  const o = opts || {};
  const kneel = pose === 'kneel';
  const crouch = pose === 'crouch';

  if (pose === 'prone') {
    B.at(x, 0, z, ry);
    // legs splayed back, boots turned out
    for (const s of [-1, 1]) {
      B.box('armor', [0.62, 0.155, 0.17], [-0.50, 0.10, s * 0.16],
        { ry: s * 0.22, shade: 0.86 });
      B.box('dark', [0.21, 0.115, 0.15], [-0.86, 0.085, s * 0.26],
        { ry: s * 0.22, shade: 0.76 });
    }
    // torso, plate carrier, pack
    B.box('armor', [0.68, 0.21, 0.40], [-0.02, 0.19, 0], { shade: 1.0 });
    B.box('canvas', [0.48, 0.17, 0.42], [-0.08, 0.31, 0], { shade: 1.06 });
    for (const pz of [-0.14, 0.14]) {
      B.box('canvas', [0.12, 0.10, 0.12], [0.14, 0.34, pz], { shade: 1.12 });
    }
    if (o.pack) B.box('canvas', [0.36, 0.20, 0.36], [-0.36, 0.33, 0.02], { ry: 0.14, shade: 0.94 });
    // arms forward onto the weapon
    B.strut('armor', [0.14, 0.22, 0.19], [0.52, 0.16, 0.11], 0.055, 6, { shade: 0.96 });
    B.strut('armor', [0.14, 0.22, -0.19], [0.44, 0.16, -0.04], 0.055, 6, { shade: 0.92 });
    // head + helmet (the bright dot that says "soldier" from above)
    B.cyl('dark', 0.078, 0.078, 0.11, 8, [0.32, 0.27, 0], 'x', { shade: 0.74 });
    B.sph('armor', 0.155, [0.40, 0.33, 0], { scale: [1.10, 0.84, 1], shade: 1.16 });
    B.cyl('armor', 0.170, 0.170, 0.042, 12, [0.40, 0.27, 0], 'y', { shade: 1.08 });
    // weapon: long cylinder + bipod, laid over the parapet
    const mg = o.weapon === 'mg';
    B.strut('dark', [0.24, 0.24, 0.05], [mg ? 1.16 : 0.98, 0.27, 0.03], 0.038, 6, { shade: 1.16 });
    B.box('dark', [0.24, 0.11, 0.08], [0.14, 0.22, 0.05], { shade: 1.0 });
    B.box('optics', [0.15, 0.06, 0.05], [0.34, 0.33, 0.04], { shade: 1.3 });
    if (mg) {
      B.box('dark', [0.30, 0.09, 0.20], [0.62, 0.22, -0.06], { shade: 0.95 });
      B.strut('dark', [0.94, 0.24, 0.02], [1.02, 0.02, 0.20], 0.020, 5, { shade: 0.9 });
      B.strut('dark', [0.94, 0.24, 0.02], [1.02, 0.02, -0.16], 0.020, 5, { shade: 0.9 });
    } else if (o.bipod !== false) {
      B.strut('dark', [0.80, 0.25, 0.03], [0.88, 0.03, 0.17], 0.018, 5, { shade: 0.9 });
      B.strut('dark', [0.80, 0.25, 0.03], [0.88, 0.03, -0.12], 0.018, 5, { shade: 0.9 });
    }
    B.pop();
    return;
  }

  const drop = kneel ? 0.30 : crouch ? 0.15 : 0;
  const lean = kneel ? 0.14 : crouch ? 0.18 : 0.05;
  B.at(x, 0, z, ry);

  // legs / boots
  if (kneel) {
    B.box('armor', [0.44, 0.15, 0.18], [0.10, 0.30, -0.12], { rz: -0.16, shade: 0.88 });
    B.box('armor', [0.16, 0.32, 0.18], [0.27, 0.17, -0.12], { shade: 0.84 });
    B.box('armor', [0.46, 0.15, 0.18], [-0.10, 0.32, 0.12], { rz: 0.30, shade: 0.86 });
    B.box('armor', [0.40, 0.14, 0.18], [-0.20, 0.09, 0.12], { shade: 0.8 });
    B.box('dark', [0.24, 0.09, 0.16], [0.36, 0.05, -0.12], { shade: 0.75 });
  } else {
    const stride = crouch ? 0.14 : 0.10;
    for (const s of [-1, 1]) {
      const bend = crouch ? 0.22 : 0.06;
      B.box('armor', [0.17, 0.30, 0.18], [stride * s, 0.50 - drop * 0.6, s * 0.11],
        { rz: -bend * s, shade: 0.88 });
      B.box('armor', [0.16, 0.30, 0.17], [stride * s * 1.4, 0.22, s * 0.11],
        { rz: bend * s * 0.6, shade: 0.84 });
      B.box('dark', [0.25, 0.09, 0.16], [stride * s * 1.7, 0.05, s * 0.11], { shade: 0.75 });
    }
  }

  const ty = 0.64 - drop;                    // torso base
  const fx = lean * 0.5;
  B.box('armor', [0.29, 0.42, 0.40], [fx, ty + 0.21, 0], { rz: -lean * 0.45, shade: 1.0 });
  B.box('canvas', [0.33, 0.30, 0.44], [fx + 0.03, ty + 0.24, 0], { shade: 0.96 });
  for (const pz of [-0.13, 0.13]) {
    B.box('canvas', [0.11, 0.13, 0.13], [fx + 0.19, ty + 0.15, pz], { shade: 1.1 });
  }
  B.box('canvas', [0.23, 0.34, 0.36], [fx - 0.24, ty + 0.24, 0], { shade: 0.86 });
  if (o.pack) B.cyl('canvas', 0.10, 0.10, 0.36, 8, [fx - 0.34, ty + 0.36, 0], 'z', { shade: 0.9 });

  // head + helmet
  const hy = ty + 0.44;
  B.cyl('dark', 0.082, 0.082, 0.11, 8, [fx + 0.03, hy + 0.03, 0], 'y', { shade: 0.72 });
  B.sph('armor', 0.155, [fx + 0.04, hy + 0.13, 0], { scale: [1.05, 0.86, 1], shade: 1.12 });
  B.cyl('armor', 0.172, 0.172, 0.045, 12, [fx + 0.04, hy + 0.06, 0], 'y', { shade: 1.05 });
  if (o.goggles) {
    B.box('optics', [0.09, 0.09, 0.30], [fx + 0.14, hy + 0.09, 0], { shade: 1.3 });
  }

  // arms + weapon
  const sy = ty + 0.36;
  const hand = [fx + 0.36, ty + 0.24, 0.06];
  B.strut('armor', [fx - 0.02, sy, 0.19], [hand[0], hand[1], hand[2] + 0.06], 0.055, 6, { shade: 0.98 });
  B.strut('armor', [fx - 0.02, sy, -0.19], [hand[0] - 0.10, hand[1] + 0.04, -0.02], 0.055, 6, { shade: 0.94 });
  if (o.weapon === 'binos') {
    B.box('optics', [0.10, 0.09, 0.22], [fx + 0.30, ty + 0.42, 0], { shade: 1.2 });
  } else if (o.weapon === 'none') {
    // observer / operator
  } else {
    const long = o.weapon === 'mg';
    B.strut('dark', [fx + 0.10, ty + 0.26, 0.04], [fx + (long ? 0.94 : 0.74), ty + 0.30, 0.02],
      0.036, 6, { shade: 1.15 });
    B.box('dark', [0.20, 0.10, 0.07], [fx - 0.02, ty + 0.24, 0.04], { shade: 1.0 });
    B.box('dark', [0.08, 0.16, 0.06], [fx + 0.22, ty + 0.18, 0.04], { rz: 0.2, shade: 0.9 });
    B.box('optics', [0.14, 0.06, 0.05], [fx + 0.20, ty + 0.34, 0.04], { shade: 1.2 });
    if (o.optic) {
      // magnified day sight — the one detail that makes a kneeling figure read
      // as "designated marksman / observer" rather than a repeat of the others
      B.cyl('dark', 0.048, 0.048, 0.26, 8, [fx + 0.24, ty + 0.38, 0.04], 'x', { shade: 1.2 });
      B.cyl('optics', 0.056, 0.056, 0.05, 10, [fx + 0.38, ty + 0.38, 0.04], 'x', { shade: 1.32 });
      B.box('dark', [0.06, 0.09, 0.05], [fx + 0.16, ty + 0.33, 0.04], { shade: 1.05 });
    }
    if (long) B.strut('dark', [fx + 0.66, ty + 0.24, 0.02], [fx + 0.78, 0.02, 0.16], 0.022, 5, { shade: 0.9 });
  }
  B.pop();
}

function addSandbags(B, x, z, ry, n) {
  B.at(x, 0, z, ry);
  for (let i = 0; i < (n || 3); i++) {
    B.box('canvas', [0.46, 0.17, 0.26], [(i - 1) * 0.30, 0.09, (i % 2) * 0.06],
      { ry: 0.12 * (i % 3) - 0.1, shade: 0.9 });
  }
  for (let i = 0; i < (n || 3) - 1; i++) {
    B.box('canvas', [0.44, 0.16, 0.25], [(i - 0.5) * 0.30, 0.25, 0.03],
      { ry: -0.08 * i, shade: 1.0 });
  }
  B.pop();
}

// ------------------------------------------------------------------- models

function modelMBT(root, P) {
  const DECK = 1.44;
  part(root, 'mbt:hull', P, AO(0.0, 2.6, 0.44), (B) => {
    B.side('armor', [
      [-2.60, 0.58], [2.36, 0.62], [2.62, 0.94], [0.86, 1.44], [-2.34, 1.44], [-2.60, 1.18],
    ], 2.46, [0, 0, 0]);
    addTracks(B, { len: 5.30, halfZ: 1.52, beltW: 0.60, topY: 1.12, wheels: 6 });

    // engine deck, grilles, exhaust
    B.box('armor', [1.85, 0.16, 2.26], [-1.55, 1.52, 0], { shade: 1.08 });
    for (const gx of [-1.05, -1.75, -2.20]) {
      B.box('dark', [0.36, 0.05, 1.66], [gx, 1.62, 0], { shade: 0.85 });
    }
    B.box('armor', [0.55, 0.42, 0.40], [-2.05, 1.60, -1.16], { shade: 0.9, tint: HEAT });
    B.cyl('dark', 0.13, 0.13, 0.40, 10, [-2.42, 1.62, -1.16], 'x', { shade: 0.8, tint: HEAT });
    // ROUND-6 FIX 13 — the outlet itself. The exhaust used to end in a capped
    // tube; now the stack vents through a louvred grille with a deflector lip,
    // which is the one place on the hull where a hard sun/shade ladder exists
    // at 5 cm pitch.
    exhaustLouvre(B, -2.60, 1.62, -1.16, 0.36, 0.30, { face: 'x', slats: 4 });

    // glacis ERA array + spare track links
    for (let i = 0; i < 4; i++) {
      const t = 0.10 + i * 0.26;
      const x = 0.95 + t * 1.60;
      const y = 1.42 - t * 0.48;
      for (let j = -1; j <= 1; j++) {
        B.box('armor', [0.40, 0.13, 0.60], [x, y + 0.08, j * 0.72],
          { rz: -0.288, shade: 0.84, tint: ERA });
      }
    }
    for (let i = 0; i < 5; i++) {
      B.box('dark', [0.14, 0.08, 0.46], [1.15 + i * 0.17, 1.42 - i * 0.05, 0],
        { rz: -0.288, shade: 1.0 });
    }
    // nose furniture
    for (const s of [-1, 1]) {
      B.cyl('optics', 0.11, 0.11, 0.09, 10, [2.60, 1.06, s * 0.88], 'x', { shade: 1.3 });
      B.box('dark', [0.06, 0.24, 0.28], [2.66, 1.06, s * 0.88], { shade: 1.1 });
      B.box('dark', [0.22, 0.14, 0.14], [2.60, 0.72, s * 0.55], { shade: 1.0 });
    }

    for (const s of [-1, 1]) {
      // fenders + stowage
      B.box('armor', [5.00, 0.07, 0.62], [0, 1.46, s * 1.55], { shade: 1.14 });
      // the fender's outer lip is the most-walked-on edge on the vehicle
      edgeWear(B, [-2.50, 1.495, s * 1.86], [2.50, 1.495, s * 1.86]);
      B.box('armor', [1.45, 0.40, 0.50], [-1.30, 1.70, s * 1.56], { shade: 0.98 });
      B.box('armor', [0.80, 0.34, 0.48], [0.60, 1.67, s * 1.56], { shade: 1.04 });
      // stowage: a real catenary tow cable with shackle eyes (was a straight
      // rod), and a two-can jerrycan rack on the forward fender — ROUND-2 FIX 2
      addTowCable(B, -1.20, 1.80, 1.62, s * 1.28, 0.11);
      addJerrycans(B, 1.55, 1.72, s * 1.55, 2);
      // side skirts + skirt ERA
      // ROUND-6 FIX 13. These five boxes were the "lighter band" over the
      // "flat dark rectangle" the critique photographed at 24 u. They are now
      // hinged panels: swaged stiffener, two lugs and a hinge pin on the top
      // edge, a mud fillet at the foot, ±8 % value panel to panel, and one
      // panel per side knocked 3.5° out of true.
      for (let i = 0; i < 5; i++) {
        const px = -2.00 + i * 0.94;
        // deterministic, not random: the geometry is cached per TYPE, so a
        // random draw here would give every tank on the map the same "random"
        // skirt anyway. A fixed irrational stride reads as unpatterned across
        // five panels and stays identical between the two flanks, which is
        // what a real vehicle looks like.
        const k = (i * 0.618 + (s > 0 ? 0.27 : 0.0)) % 1;
        skirtPanel(B, px, 1.06, s * 1.86, 0.88, 0.66, 0.10, k,
          { cant: i === 3 ? s * 0.06 : 0, rib: i > 1 });
        if (i >= 2) {
          B.box('armor', [0.74, 0.44, 0.15], [px, 1.06, s * 1.94],
            { shade: 0.8, tint: ERA });
          // ERA block retaining studs — the boss, not the bolt (see scale note)
          boltRow(B, [px - 0.30, 1.24, s * 2.02], [px + 0.30, 1.24, s * 2.02], 3,
            { axis: 'z', size: 0.062, h: 0.038, shade: 1.10 });
        }
      }
      // fender support brackets: the fender is a 5 u shelf and read as a decal
      // stuck to the hull because nothing held it up
      for (let i = 0; i < 4; i++) {
        const bx = -1.95 + i * 1.30;
        B.box('armor', [0.09, 0.30, 0.34], [bx, 1.32, s * 1.68],
          { rx: s * 0.55, shade: 1.02 });
      }
      // hull-side / fender weld, the longest continuous seam on the vehicle
      weldSeam(B, [-2.30, 1.435, s * 1.22], [0.84, 1.435, s * 1.22],
        { pitch: 0.32, r: 0.030, shade: 1.08 });
      // crew grab rail on the flank stowage box — a climb point, and the only
      // thing on this face that breaks its outline
      grabRail(B, [-1.70, 1.70, s * 1.81], [-0.95, 1.70, s * 1.81], [0, 0, s * 0.13],
        { r: 0.026 });
      // mud flaps
      B.box('rubber', [0.10, 0.42, 0.60], [-2.62, 0.62, s * 1.52], { shade: 0.8 });
    }
    // engine-deck plate perimeter weld (the deck sits ON the roof at y 1.44)
    for (const s of [-1, 1]) {
      weldSeam(B, [-2.44, 1.448, s * 1.13], [-0.66, 1.448, s * 1.13],
        { pitch: 0.34, r: 0.028, shade: 1.06 });
    }
    // transverse glacis weld, aft of both the ERA array and the spare links.
    // The glacis runs y = 1.44 − 0.2841·(x − 0.86), so x = 1.00 sits at 1.400.
    weldSeam(B, [1.00, 1.412, -1.18], [1.00, 1.412, 1.18],
      { pitch: 0.32, r: 0.030, shade: 1.12 });
    // driver's grab rails either side of the glacis hatch line
    for (const s of [-1, 1]) {
      grabRail(B, [1.62, 1.238, s * 1.14], [2.10, 1.102, s * 1.14], [0, 0.13, 0],
        { r: 0.024 });
    }
    // rear plate kit
    B.box('armor', [0.14, 0.50, 1.60], [-2.66, 1.00, 0], { shade: 0.86 });
    // rear-plate weld + the towing/step rail every crew uses to climb aboard
    weldSeam(B, [-2.62, 1.28, -0.78], [-2.62, 1.28, 0.78],
      { pitch: 0.30, r: 0.028, shade: 1.10 });
    grabRail(B, [-2.72, 1.14, -0.30], [-2.72, 1.14, 0.30], [-0.13, 0, 0], { r: 0.028 });
    addStowage(B, -2.10, 1.86, 0.0, 1.0);
    // engine-deck anti-drone cage
    // base 1.60 = the top of the engine deck plate, so the stanchions land on
    // steel instead of hovering 4 cm over it (ROUND-2 FIX 2)
    cage(B, 'dark', -2.35, -0.75, 1.06, 2.26, { base: 1.60, long: 4, cross: 4 });
  });

  const turret = node(root, 'turret', 0.18, DECK, 0);
  const PLAN = [
    [-1.42, -0.62], [-1.20, -1.02], [0.42, -1.02], [1.12, -0.52], [1.24, 0.0],
    [1.12, 0.52], [0.42, 1.02], [-1.20, 1.02], [-1.42, 0.62],
  ];
  part(turret, 'mbt:turret', P, AO(0.0, 2.6, 0.44, DECK), (B) => {
    B.plan('armor', PLAN, 0.62, [0, 0, 0]);
    B.plan('armor', PLAN.map((p) => [p[0] * 0.90, p[1] * 0.90]), 0.09, [0.02, 0.62, 0],
      { shade: 1.16 });
    // mantlet
    B.box('armor', [0.50, 0.52, 0.92], [1.22, 0.30, 0], { shade: 0.92 });
    B.cyl('armor', 0.26, 0.26, 0.90, 12, [1.40, 0.30, 0], 'z', { shade: 0.95 });
    // cheek ERA
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        B.box('armor', [0.34, 0.30, 0.16], [0.62 - i * 0.40, 0.20 + i * 0.24, s * 0.86],
          { ry: s * -0.55, shade: 0.82, tint: ERA });
      }
      for (let i = 0; i < 3; i++) {
        B.box('armor', [0.34, 0.34, 0.13], [-0.15 - i * 0.40, 0.32, s * 1.06],
          { shade: 0.82, tint: ERA });
      }
    }
    // commander cupola + periscopes
    B.cyl('armor', 0.32, 0.34, 0.24, 12, [-0.42, 0.74, 0.42], 'y', { shade: 1.05 });
    B.cyl('armor', 0.30, 0.30, 0.06, 12, [-0.42, 0.88, 0.42], 'y', { shade: 1.18 });
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.45;
      B.box('optics', [0.09, 0.08, 0.13],
        [-0.42 + Math.cos(a) * 0.33, 0.80, 0.42 + Math.sin(a) * 0.33],
        { ry: -a, shade: 1.25 });
    }
    // gunner sight
    B.box('armor', [0.34, 0.24, 0.34], [0.42, 0.74, -0.42], { shade: 1.06 });
    B.box('optics', [0.05, 0.16, 0.24], [0.60, 0.76, -0.42], { shade: 1.3 });
    // remote weapon station
    B.cyl('armor', 0.16, 0.18, 0.14, 10, [0.10, 0.74, -0.05], 'y', { shade: 1.1 });
    B.box('armor', [0.30, 0.20, 0.30], [0.10, 0.90, -0.05], { shade: 1.0 });
    B.cyl('dark', 0.042, 0.042, 0.78, 8, [0.55, 0.92, -0.05], 'x', { shade: 1.2 });
    B.box('optics', [0.06, 0.10, 0.14], [0.26, 0.99, -0.05], { shade: 1.3 });
    // smoke grenade launchers
    for (const s of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        B.cyl('dark', 0.075, 0.075, 0.30, 8,
          [0.50 - (i % 2) * 0.16, 0.34 + ((i / 2) | 0) * 0.17, s * 0.96], 'x',
          { ry: s * -0.45, rz: 0.42, shade: 1.1 });
      }
    }
    // bustle basket + kit
    for (const s of [-1, 1]) {
      B.box('dark', [0.66, 0.04, 0.05], [-1.72, 0.14, s * 0.86], { shade: 1.1 });
      B.box('dark', [0.66, 0.04, 0.05], [-1.72, 0.52, s * 0.86], { shade: 1.1 });
      B.box('dark', [0.05, 0.42, 0.05], [-2.02, 0.33, s * 0.86], { shade: 1.1 });
    }
    B.cyl('canvas', 0.20, 0.20, 1.35, 8, [-1.78, 0.34, 0], 'z', { shade: 0.95 });
    // turret roof rim: the two front facets and both side rims, where the sun
    // is grazing the plate and the crew climb on and off
    edgeWear(B, [1.12, 0.62, -0.52], [1.24, 0.62, 0]);
    edgeWear(B, [1.24, 0.62, 0], [1.12, 0.62, 0.52]);
    for (const s of [-1, 1]) {
      edgeWear(B, [0.42, 0.62, s * 1.02], [-1.20, 0.62, s * 1.02]);
    }
    // ROUND-6 FIX 13 — the turret roof is the surface a 52° camera actually
    // looks at, and it was one flat inset plate. The plate is now WELDED on:
    // a bead follows the whole 0.90-scale outline at its foot, which reads as a
    // raised line at 60 u and as a chain of passes at 15 u.
    for (let i = 0; i < PLAN.length; i++) {
      const p0 = PLAN[i];
      const p1 = PLAN[(i + 1) % PLAN.length];
      weldSeam(B, [p0[0] * 0.90 + 0.02, 0.628, p0[1] * 0.90],
        [p1[0] * 0.90 + 0.02, 0.628, p1[1] * 0.90],
        { pitch: 0.34, r: 0.028, shade: 1.12 });
    }
    // vertical corner welds where the front and rear facets meet the flanks
    for (const c of [[1.12, -0.52], [1.24, 0.0], [1.12, 0.52], [-1.42, -0.62], [-1.42, 0.62]]) {
      weldSeam(B, [c[0], 0.05, c[1]], [c[0], 0.58, c[1]],
        { pitch: 0.27, r: 0.026, shade: 1.06 });
    }
    // mantlet retaining bosses along the top of the trunnion box
    boltRow(B, [1.22, 0.565, -0.38], [1.22, 0.565, 0.38], 4,
      { axis: 'y', size: 0.072, h: 0.040, shade: 1.14 });
    // crew handholds on the roof, and two lifting eyes on the front rim — the
    // roof had no vertical relief at all between the cupola and the cage
    grabRail(B, [-0.92, 0.71, 0.16], [-0.92, 0.71, 0.68], [0, 0.12, 0], { r: 0.025 });
    grabRail(B, [-0.58, 0.71, -0.28], [-0.58, 0.71, -0.76], [0, 0.12, 0], { r: 0.025 });
    for (const s of [-1, 1]) {
      grabRail(B, [0.86, 0.71, s * 0.62], [0.98, 0.71, s * 0.50], [0, 0.14, 0],
        { r: 0.030, shade: 1.24 });
    }
    addAntenna(B, -1.28, 0.66, 0.74, 1.90, 0.06);
    addAntenna(B, -1.28, 0.66, -0.74, 1.55, -0.05);
    // turret anti-FPV cage
    // base 0.71 = the turret roof plate (0.62 + 0.09 extrusion)
    cage(B, 'dark', -1.45, 1.05, 0.98, 1.34, { base: 0.71, long: 6, cross: 6 });
  });

  const barrel = node(turret, 'barrel', 2.72, 0.32, 0);
  part(barrel, 'mbt:barrel', P, AO(0, 1, 1), (B) => {
    // ROUND-2 FIX 2. This was a bare stepped cylinder. Now: gun tube, a
    // two-piece THERMAL SLEEVE with five clamp bands and a longitudinal joint
    // strip, a BORE EVACUATOR drum with end collars and four bleed bosses, a
    // muzzle reference mirror and a mantlet dust boot.
    // The tip stays at local x = +1.70: vfx.muzzle() flashes at
    // barrelWorldPos + forward × 1.7 and that invariant is load-bearing.
    B.cyl('dark', 0.098, 0.118, 3.06, 14, [0.18, 0, 0], 'x', { shade: 1.0 });
    B.cyl('rubber', 0.185, 0.205, 0.34, 12, [-1.16, 0, 0], 'x', { shade: 0.82 });
    B.cyl('armor', 0.158, 0.162, 1.16, 14, [-0.46, 0, 0], 'x', { shade: 0.98 });
    B.cyl('armor', 0.150, 0.146, 0.74, 14, [1.02, 0, 0], 'x', { shade: 0.96 });
    for (const bx of [-1.02, -0.44, 0.08, 0.70, 1.34]) {
      B.cyl('dark', 0.176, 0.176, 0.055, 14, [bx, 0, 0], 'x', { shade: 1.14 });
    }
    B.box('dark', [1.14, 0.030, 0.075], [-0.46, 0.160, 0], { shade: 1.18 });
    B.box('dark', [0.72, 0.030, 0.070], [1.02, 0.152, 0], { shade: 1.18 });
    // bore evacuator
    B.cyl('armor', 0.232, 0.232, 0.50, 16, [0.40, 0, 0], 'x', { shade: 0.94 });
    B.cyl('dark', 0.246, 0.246, 0.055, 16, [0.16, 0, 0], 'x', { shade: 1.10 });
    B.cyl('dark', 0.246, 0.246, 0.055, 16, [0.64, 0, 0], 'x', { shade: 1.10 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      B.box('dark', [0.10, 0.075, 0.075],
        [0.40, Math.sin(a) * 0.234, Math.cos(a) * 0.234], { shade: 1.2 });
    }
    // muzzle crown + reference mirror
    B.cyl('dark', 0.132, 0.132, 0.20, 14, [1.60, 0, 0], 'x', { shade: 1.18 });
    B.cyl('dark', 0.142, 0.142, 0.05, 14, [1.68, 0, 0], 'x', { shade: 1.24 });
    B.box('dark', [0.14, 0.10, 0.12], [1.42, 0.155, 0], { shade: 1.1 });
    B.box('optics', [0.10, 0.07, 0.09], [1.44, 0.205, 0], { shade: 1.3 });
  });

  // markings: hull number on the bare forward skirts, formation device aft,
  // a hazard plate and caution stripes on the rear plate (ROUND-2 FIX 2)
  addDecals(root, P, [
    { c: 'num', p: [-1.06, 1.12, 1.915], w: 0.62, h: 0.36, mirror: true },
    { c: 'fac', p: [-2.00, 1.12, 1.915], w: 0.44, h: 0.44, mirror: true },
    { c: DECAL_LOZENGE, p: [-2.74, 1.16, 0.52], f: 'x-', w: 0.28, h: 0.28 },
    { c: DECAL_STRIPES, p: [-2.74, 0.92, 0.0], f: 'x-', w: 1.20, h: 0.24 },
  ]);
  // PHASE 2: an air-recognition panel on the turret roof. The RTS camera looks
  // at these vehicles from 52° above — the roof is the surface the player
  // actually sees, and until now every marking on every unit was on a flank
  // nobody was looking at.
  addDecals(turret, P, [
    { c: DECAL_PANEL, p: [-0.95, 0.715, -0.45], f: 'y+', w: 0.42, h: 0.28 },
  ]);
}

function modelIFV(root, P) {
  const DECK = 1.74;
  part(root, 'ifv:hull', P, AO(0.0, 2.7, 0.44), (B) => {
    B.side('armor', [
      [-2.45, 0.55], [2.06, 0.58], [2.42, 1.08], [1.02, 1.74], [-2.30, 1.74], [-2.45, 1.42],
    ], 2.20, [0, 0, 0]);
    // sponsons overhanging the tracks
    B.box('armor', [4.55, 0.42, 2.92], [-0.18, 1.52, 0], { shade: 1.02 });
    addTracks(B, { len: 4.95, halfZ: 1.40, beltW: 0.52, topY: 1.06, wheels: 6 });

    for (const s of [-1, 1]) {
      // skirts — ROUND-6 FIX 13, see skirtPanel(). Panels 0 and 1 carry the
      // hull number and the formation device, so they run without the rib.
      for (let i = 0; i < 4; i++) {
        const px = -1.75 + i * 1.02;
        const k = (i * 0.618 + (s > 0 ? 0.41 : 0.0)) % 1;
        skirtPanel(B, px, 1.06, s * 1.74, 0.98, 0.52, 0.09, k,
          { cant: i === 2 ? s * -0.055 : 0, rib: i > 1 });
      }
      // firing ports + vision blocks
      for (let i = 0; i < 3; i++) {
        B.cyl('optics', 0.09, 0.09, 0.06, 10, [-1.6 + i * 0.62, 1.60, s * 1.47], 'z',
          { shade: 1.25 });
      }
      B.box('armor', [0.70, 0.30, 0.42], [-1.05, 1.86, s * 1.30], { shade: 1.0 });
      addTowCable(B, -0.80, 1.40, 1.86, s * 1.36, 0.09);
      addJerrycans(B, -1.92, 1.96, s * 1.18, 2);
      // sponson lip, in two runs so it clears the flank stowage box at x −1.05
      edgeWear(B, [-0.60, 1.73, s * 1.46], [2.05, 1.73, s * 1.46]);
      edgeWear(B, [-2.40, 1.73, s * 1.46], [-1.50, 1.73, s * 1.46]);
      // ROUND-6 FIX 13. The sponson is a 4.5 u appliqué plate welded onto the
      // hull roof; the join was invisible, so the two plates read as one
      // casting. Two runs, split around the flank stowage box.
      weldSeam(B, [-2.26, 1.745, s * 1.18], [-1.48, 1.745, s * 1.18],
        { pitch: 0.30, r: 0.028, shade: 1.08 });
      weldSeam(B, [-0.62, 1.745, s * 1.18], [0.98, 1.745, s * 1.18],
        { pitch: 0.30, r: 0.028, shade: 1.08 });
      // appliqué fasteners along the sponson flank
      boltRow(B, [-2.10, 1.38, s * 1.475], [0.80, 1.38, s * 1.475], 7,
        { axis: 'z', size: 0.068, h: 0.040, shade: 1.12 });
      // crew grab rail on the sponson flank, forward of the stowage box
      grabRail(B, [0.30, 1.44, s * 1.47], [0.90, 1.44, s * 1.47], [0, 0, s * 0.13],
        { r: 0.025 });
    }
    // engine exhaust — the IFV had none at all, so its right sponson was the
    // largest unbroken painted surface in the roster
    exhaustLouvre(B, 1.30, 1.50, 1.50, 0.52, 0.30, { face: 'z', slats: 4 });
    // driver + commander hatches, glacis detail
    B.cyl('armor', 0.24, 0.24, 0.09, 10, [1.05, 1.78, 0.62], 'y', { shade: 1.16 });
    B.box('optics', [0.06, 0.13, 0.34], [1.32, 1.66, 0.62], { rz: -0.35, shade: 1.3 });
    B.box('armor', [0.90, 0.10, 2.16], [1.55, 1.32, 0], { rz: -0.44, shade: 1.06 });
    for (const s of [-1, 1]) {
      B.cyl('optics', 0.10, 0.10, 0.08, 10, [2.40, 1.14, s * 0.78], 'x', { shade: 1.3 });
    }
    // rear ramp with periscope + grab handles
    B.box('armor', [0.12, 1.02, 1.55], [-2.50, 1.12, 0], { shade: 0.9 });
    B.box('dark', [0.10, 0.05, 0.42], [-2.58, 1.42, 0.42], { shade: 1.1 });
    B.box('optics', [0.05, 0.14, 0.20], [-2.58, 1.44, -0.35], { shade: 1.25 });
    addStowage(B, -1.95, 1.92, 0.0, 0.9);
  });

  const turret = node(root, 'turret', 0.34, DECK, 0);
  part(turret, 'ifv:turret', P, AO(0, 2.7, 0.44, DECK), (B) => {
    B.plan('armor', [
      [-0.74, -0.54], [0.34, -0.52], [0.72, -0.26], [0.78, 0.26], [0.34, 0.52], [-0.74, 0.54],
      [-0.88, 0.28], [-0.88, -0.28],
    ], 0.56, [0, 0, 0]);
    B.box('armor', [0.34, 0.40, 0.60], [0.62, 0.26, 0], { shade: 0.94 });
    B.plan('armor', [
      [-0.66, -0.47], [0.32, -0.45], [0.65, -0.21], [0.65, 0.21], [0.32, 0.45], [-0.66, 0.47],
    ], 0.08, [0, 0.56, 0], { shade: 1.18 });
    // ATGM tube pack, raised so it reads from a top-down camera
    B.box('armor', [0.90, 0.34, 0.30], [-0.14, 0.50, 0.62], { shade: 1.0 });
    for (let i = 0; i < 2; i++) {
      B.cyl('dark', 0.125, 0.125, 0.94, 10, [-0.12, 0.44 + i * 0.24, 0.62], 'x', { shade: 1.12 });
      B.cyl('dark', 0.140, 0.140, 0.07, 10, [0.36, 0.44 + i * 0.24, 0.62], 'x', { shade: 1.25 });
    }
    // sight + smoke pots + AA MG
    B.box('armor', [0.22, 0.22, 0.28], [0.10, 0.66, -0.32], { shade: 1.1 });
    B.box('optics', [0.05, 0.15, 0.22], [0.24, 0.68, -0.32], { shade: 1.3 });
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        B.cyl('dark', 0.068, 0.068, 0.26, 8, [0.12 - i * 0.16, 0.26, s * 0.58], 'x',
          { ry: s * -0.5, rz: 0.4, shade: 1.1 });
      }
    }
    // ROUND-6 FIX 13 — the roof plate is welded on, same argument as the MBT's.
    const ROOF = [
      [-0.66, -0.47], [0.32, -0.45], [0.65, -0.21], [0.65, 0.21], [0.32, 0.45], [-0.66, 0.47],
    ];
    for (let i = 0; i < ROOF.length; i++) {
      const p0 = ROOF[i];
      const p1 = ROOF[(i + 1) % ROOF.length];
      weldSeam(B, [p0[0], 0.567, p0[1]], [p1[0], 0.567, p1[1]],
        { pitch: 0.28, r: 0.025, shade: 1.12 });
    }
    // lifting eyes on the front roof corners
    for (const s of [-1, 1]) {
      grabRail(B, [0.40, 0.64, s * 0.40], [0.52, 0.64, s * 0.30], [0, 0.12, 0],
        { r: 0.028, shade: 1.24 });
    }
    addAntenna(B, -0.80, 0.58, -0.34, 1.45, -0.05);
  });

  const barrel = node(turret, 'barrel', 1.20, 0.28, 0);
  part(barrel, 'ifv:barrel', P, AO(0, 1, 1), (B) => {
    B.cyl('dark', 0.080, 0.095, 2.34, 12, [0.10, 0, 0], 'x', { shade: 1.05 });
    B.cyl('armor', 0.145, 0.145, 0.64, 12, [-0.74, 0, 0], 'x', { shade: 0.98 });
    B.cyl('dark', 0.115, 0.115, 0.06, 12, [-0.36, 0, 0], 'x', { shade: 1.2 });
    // ROUND-6 FIX 13 — muzzle brake. The autocannon ended in a plain stepped
    // collar; the critique counted it as one of the two barrels without a
    // brake. A 30 mm gun's brake is a slotted double-baffle sleeve, so: body,
    // two baffle rings, and the four webs between the ports. The tube's tip
    // stays at x 1.27 and nothing is added forward of 1.42, so the vfx muzzle
    // anchor is untouched.
    B.cyl('dark', 0.124, 0.124, 0.30, 10, [1.22, 0, 0], 'x', { shade: 1.20 });
    B.cyl('dark', 0.152, 0.152, 0.045, 10, [1.10, 0, 0], 'x', { shade: 1.26 });
    B.cyl('dark', 0.152, 0.152, 0.045, 10, [1.34, 0, 0], 'x', { shade: 1.26 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.785;
      B.box('dark', [0.24, 0.055, 0.055],
        [1.22, Math.sin(a) * 0.132, Math.cos(a) * 0.132], { rx: a, shade: 1.14 });
    }
    B.cyl('dark', 0.138, 0.138, 0.035, 10, [1.40, 0, 0], 'x', { shade: 1.30 });
  });

  addDecals(root, P, [
    // ROUND-6, found while doing fix 13: these two sat at z 1.750 and the decal
    // pass pushes a quad only 12 mm along its normal, so they landed at 1.762 —
    // 23 mm INSIDE a skirt panel whose outer face is at 1.740 + 0.045 = 1.785.
    // The IFV's hull number and formation device have never rendered. 1.800
    // puts them 27 mm proud, matching the MBT's 17 mm.
    { c: 'num', p: [-0.73, 1.08, 1.80], w: 0.56, h: 0.30, mirror: true },
    { c: 'fac', p: [-1.75, 1.08, 1.80], w: 0.36, h: 0.36, mirror: true },
    { c: DECAL_HAZARD, p: [-2.57, 0.86, 0.0], f: 'x-', w: 0.28, h: 0.28 },
    // roof panel on the clear stretch of deck between the turret ring and the
    // flank stowage box (hull top y 1.74, sponson top 1.73)
    { c: DECAL_PANEL, p: [-1.30, 1.745, 0.80], f: 'y+', w: 0.40, h: 0.26 },
  ]);
}

function modelAPC(root, P) {
  const TOP = 1.92;
  part(root, 'apc:hull', P, AO(0.0, 2.5, 0.46), (B) => {
    B.side('armor', [
      [-2.70, 0.46], [2.16, 0.44], [2.72, 0.96], [2.34, 1.92], [-2.70, 1.92],
    ], 2.42, [0, 0, 0]);
    const xs = [2.02, 0.92, -1.12, -2.16];
    addWheels(B, xs, 1.44, 0.58, 0.42);
    for (const s of [-1, 1]) {
      for (const x of xs) {
        B.box('armor', [1.10, 0.26, 0.30], [x, 1.10, s * 1.34], { shade: 1.05 });
      }
      // slat screen along the flanks
      for (let i = 0; i < 7; i++) {
        B.box('dark', [0.05, 0.72, 0.05], [-2.20 + i * 0.72, 1.60, s * 1.62], { shade: 1.15 });
      }
      B.box('dark', [4.60, 0.05, 0.05], [-0.05, 1.96, s * 1.62], { shade: 1.15 });
      B.box('dark', [4.60, 0.05, 0.05], [-0.05, 1.26, s * 1.62], { shade: 1.15 });
      // vision blocks + side hatch
      for (let i = 0; i < 3; i++) {
        B.box('optics', [0.30, 0.16, 0.05], [-0.45 + i * 0.75, 1.66, s * 1.22], { shade: 1.3 });
      }
      B.box('armor', [0.06, 0.90, 0.90], [1.10, 1.42, s * 1.22], { shade: 0.95 });
      B.cyl('optics', 0.11, 0.11, 0.08, 10, [2.66, 1.12, s * 0.86], 'x', { shade: 1.3 });
      // roof gutter line — everything else on this roof is inboard of z 1.12
      edgeWear(B, [-2.68, 1.92, s * 1.21], [2.30, 1.92, s * 1.21]);
      // tow rope on the flank, above the wheel arches (their tops are y 1.23;
      // this sags to 1.33 at midspan) and below the vision blocks at y 1.58
      addTowCable(B, -2.05, -0.55, 1.40, s * 1.24, 0.07);
    }
    // windscreen shutters + roof kit
    B.box('armor', [0.10, 0.70, 1.50], [2.56, 1.48, 0], { rz: 0.36, shade: 1.0 });
    B.box('optics', [0.05, 0.52, 1.34], [2.52, 1.48, 0], { rz: 0.36, shade: 1.3 });
    B.cyl('armor', 0.26, 0.26, 0.08, 12, [1.55, 1.96, -0.62], 'y', { shade: 1.16 });
    B.box('armor', [1.30, 0.14, 1.30], [-1.60, 1.98, 0], { shade: 1.1 });
    addStowage(B, -0.40, 2.06, 0.75, 1.0);
    addJerrycans(B, 1.05, 2.14, -0.95, 2);
    // rear door + spare wheel
    B.box('armor', [0.12, 1.20, 1.60], [-2.76, 1.16, 0], { shade: 0.9 });
    B.cyl('rubber', 0.52, 0.52, 0.32, 14, [-2.98, 1.30, 0.70], 'x', { shade: 0.85 });
    B.cyl('dark', 0.20, 0.20, 0.36, 8, [-2.98, 1.30, 0.70], 'x', { shade: 1.2 });
    addAntenna(B, -2.30, 1.98, -0.80, 1.70, -0.06);
  });

  const turret = node(root, 'turret', 0.55, TOP, 0);
  part(turret, 'apc:turret', P, AO(0, 2.5, 0.46, TOP), (B) => {
    B.cyl('armor', 0.42, 0.46, 0.16, 12, [0, 0.08, 0], 'y', { shade: 1.08 });
    B.box('armor', [0.10, 0.34, 0.76], [0.34, 0.30, 0], { rz: 0.14, shade: 1.0 });
    for (const s of [-1, 1]) {
      B.box('armor', [0.46, 0.30, 0.08], [0.10, 0.30, s * 0.38], { shade: 0.98 });
    }
    B.box('dark', [0.30, 0.16, 0.22], [0.02, 0.30, 0], { shade: 1.1 });
    B.box('optics', [0.08, 0.10, 0.12], [0.10, 0.44, -0.18], { shade: 1.3 });
    B.box('dark', [0.20, 0.14, 0.14], [-0.22, 0.34, 0.16], { shade: 1.0 });
    // PHASE 2: three smoke pots a side, bracketed outboard of the ammo boxes at
    // z ±0.42. This turret was the only one on a gun vehicle with none.
    for (const s of [-1, 1]) addSmokeBank(B, 0.02, 0.32, s * 0.50, s, 3, 0.55);
  });

  const barrel = node(turret, 'barrel', 0.62, 0.30, 0);
  part(barrel, 'apc:barrel', P, AO(0, 1, 1), (B) => {
    B.cyl('dark', 0.040, 0.048, 0.95, 8, [0.05, 0, 0], 'x', { shade: 1.15 });
    B.cyl('dark', 0.070, 0.070, 0.26, 8, [-0.32, 0, 0], 'x', { shade: 1.0 });
    B.box('dark', [0.16, 0.13, 0.10], [-0.10, -0.10, 0], { shade: 0.95 });
  });

  // number reads through the slat screen, which is exactly how it looks on the
  // real vehicles this is drawn from
  addDecals(root, P, [
    { c: 'num', p: [-1.60, 1.55, 1.215], w: 0.56, h: 0.30, mirror: true },
    { c: 'fac', p: [-2.30, 1.52, 1.215], w: 0.34, h: 0.34, mirror: true },
    { c: DECAL_LOZENGE, p: [-2.83, 1.34, -0.42], f: 'x-', w: 0.26, h: 0.26 },
    // roof panel: starboard of the roof kit box (x −2.25…−0.95) and clear of
    // the lashed bundle, which is on the port side at z +0.75
    { c: DECAL_PANEL, p: [-0.40, 1.922, -0.60], f: 'y+', w: 0.44, h: 0.28 },
  ]);
}

function modelSPG(root, P) {
  const DECK = 1.36;
  part(root, 'spg:hull', P, AO(0.0, 3.0, 0.44), (B) => {
    B.side('armor', [
      [-3.00, 0.58], [2.62, 0.60], [2.98, 1.02], [1.55, 1.36], [-3.00, 1.36],
    ], 2.72, [0, 0, 0]);
    addTracks(B, { len: 5.85, halfZ: 1.62, beltW: 0.66, topY: 1.16, wheels: 7 });
    for (const s of [-1, 1]) {
      B.box('armor', [5.60, 0.08, 0.66], [0, 1.38, s * 1.64], { shade: 1.12 });
      for (let i = 0; i < 3; i++) {
        B.box('armor', [1.05, 0.34, 0.44], [-1.90 + i * 1.15, 1.58, s * 1.66], { shade: 0.98 });
      }
      B.box('rubber', [0.10, 0.40, 0.66], [-3.02, 0.60, s * 1.62], { shade: 0.8 });
      addJerrycans(B, 2.10, 1.64, s * 1.64, 2);
      // rear recoil spade
      B.box('armor', [0.90, 0.20, 0.80], [-3.20, 0.70, s * 0.70], { rz: 0.55, shade: 0.9 });
      // fender lip, outboard of every stowage box on the flank (z ≤ 1.88)
      edgeWear(B, [-2.80, 1.42, s * 1.97], [2.80, 1.42, s * 1.97]);
    }
    for (const gx of [-2.05, -2.55]) {
      B.box('dark', [0.34, 0.05, 1.70], [gx, 1.40, 0], { shade: 0.85 });
    }
    B.box('armor', [0.90, 0.10, 2.30], [2.10, 1.24, 0], { rz: -0.24, shade: 1.06 });
    for (const s of [-1, 1]) {
      B.cyl('optics', 0.10, 0.10, 0.08, 10, [2.96, 1.10, s * 0.90], 'x', { shade: 1.3 });
    }
    B.cyl('armor', 0.24, 0.24, 0.10, 10, [2.20, 1.40, 0.70], 'y', { shade: 1.16 });
    // ROUND-2 FIX 2, stowage. The howitzer carried jerrycans and a rolled tarp
    // and nothing else. Spare track links bolted to the glacis (every crew in
    // this war carries them as appliqué) and a lashed bundle on the rear deck.
    // The glacis plate is `rz -0.24` about (2.10, 1.24), so its surface follows
    // y = 1.33 − 0.245·(x − 2.10); the links ride 4 cm proud of it.
    for (let i = 0; i < 5; i++) {
      B.box('dark', [0.15, 0.08, 0.44], [1.70 + i * 0.17, 1.428 - i * 0.042, 0],
        { rz: -0.24, shade: 1.0 });
    }
    addStowage(B, -2.40, 1.50, 0.90, 0.95);
  });

  const turret = node(root, 'turret', -0.50, DECK, 0);
  part(turret, 'spg:turret', P, AO(0, 3.0, 0.44, DECK), (B) => {
    B.plan('armor', [
      [1.42, -1.20], [1.55, -0.60], [1.55, 0.60], [1.42, 1.20],
      [-1.55, 1.30], [-1.72, 0.70], [-1.72, -0.70], [-1.55, -1.30],
    ], 1.00, [0, 0, 0]);
    B.plan('armor', [
      [1.30, -1.10], [1.42, -0.55], [1.42, 0.55], [1.30, 1.10],
      [-1.45, 1.20], [-1.60, 0.64], [-1.60, -0.64], [-1.45, -1.20],
    ], 0.10, [0, 1.00, 0], { shade: 1.18 });
    // mantlet + trunnion
    B.box('armor', [0.44, 0.72, 1.00], [1.60, 0.52, 0], { shade: 0.94 });
    B.cyl('armor', 0.36, 0.36, 1.02, 12, [1.72, 0.52, 0], 'z', { shade: 0.98 });
    // commander cupola + MG + hatches
    B.cyl('armor', 0.34, 0.36, 0.24, 12, [-0.55, 1.10, 0.60], 'y', { shade: 1.08 });
    B.cyl('dark', 0.045, 0.045, 0.72, 8, [-0.10, 1.28, 0.60], 'x', { shade: 1.2 });
    B.box('armor', [0.70, 0.08, 0.70], [-0.60, 1.14, -0.60], { shade: 1.14 });
    // ammo panniers + kit
    for (const s of [-1, 1]) {
      B.box('armor', [1.70, 0.46, 0.20], [-0.30, 0.50, s * 1.34], { shade: 0.96 });
      for (let i = 0; i < 4; i++) {
        B.box('dark', [0.05, 0.44, 0.05], [-1.05 + i * 0.50, 0.72, s * 1.36], { shade: 1.15 });
      }
    }
    B.cyl('canvas', 0.22, 0.22, 1.20, 8, [-1.55, 0.62, 0], 'z', { shade: 0.95 });
    // PHASE 2: smoke pots on the casemate cheeks (the wall runs through
    // z ≈ ±1.21 at x 1.05, so the bracket is bolted through it) and a worn rim
    // along the front roof edge.
    for (const s of [-1, 1]) addSmokeBank(B, 1.05, 0.70, s * 1.27, s, 4, 0.5);
    edgeWear(B, [1.55, 1.00, -0.60], [1.55, 1.00, 0.60]);
    addAntenna(B, -1.60, 1.02, 0.90, 1.85, 0.05);
    addAntenna(B, -1.60, 1.02, -0.90, 1.40, -0.05);
  });

  // node sits on the bore line at (tip - 1.7) so vfx.muzzle() flashes at the brake
  const barrel = node(turret, 'barrel', 3.57, 0.87, 0);
  barrel.rotation.z = 13 * DEG;
  part(barrel, 'spg:barrel', P, AO(0, 1, 1), (B) => {
    B.cyl('dark', 0.130, 0.170, 4.70, 14, [-0.71, 0, 0], 'x', { shade: 1.0 });
    B.cyl('armor', 0.235, 0.235, 1.05, 14, [-2.51, 0, 0], 'x', { shade: 0.96 });
    B.cyl('dark', 0.200, 0.200, 0.06, 14, [-1.91, 0, 0], 'x', { shade: 1.1 });
    // pepper-pot muzzle brake
    B.cyl('dark', 0.255, 0.255, 0.62, 14, [1.39, 0, 0], 'x', { shade: 1.12 });
    for (let i = 0; i < 3; i++) {
      B.cyl('dark', 0.290, 0.290, 0.06, 14, [1.16 + i * 0.22, 0, 0], 'x', { shade: 1.22 });
    }
    // fume extractor + recoil cylinders
    B.cyl('armor', 0.215, 0.215, 0.50, 14, [-0.30, 0, 0], 'x', { shade: 0.92 });
    for (const s of [-1, 1]) {
      B.cyl('armor', 0.10, 0.10, 1.30, 8, [-2.11, 0.22, s * 0.20], 'x', { shade: 1.05 });
    }
    // ROUND-2 FIX 2: thermal sleeve in two sections either side of the fume
    // extractor, with clamp bands — the chase was a bare cylinder.
    B.cyl('armor', 0.196, 0.192, 1.15, 14, [-1.20, 0, 0], 'x', { shade: 0.97 });
    B.cyl('armor', 0.190, 0.186, 0.95, 14, [0.52, 0, 0], 'x', { shade: 0.95 });
    for (const bx of [-1.72, -1.20, -0.68, 0.10, 0.52, 0.94]) {
      B.cyl('dark', 0.210, 0.210, 0.05, 14, [bx, 0, 0], 'x', { shade: 1.14 });
    }
  });

  addDecals(turret, P, [
    { c: 'num', p: [-0.30, 0.48, 1.445], w: 0.60, h: 0.28, mirror: true },
    { c: 'fac', p: [-1.73, 0.20, 0.0], f: 'x-', w: 0.36, h: 0.36 },
    // roof panel forward of the commander's cupola and the loader's hatch
    { c: DECAL_PANEL, p: [0.60, 1.102, -0.20], f: 'y+', w: 0.44, h: 0.28 },
  ]);
  addDecals(root, P, [
    { c: DECAL_HAZARD, p: [-3.00, 0.98, 0.42], f: 'x-', w: 0.26, h: 0.26 },
  ]);
}

function modelMLRS(root, P) {
  part(root, 'mlrs:hull', P, AO(0.0, 3.2, 0.44), (B) => {
    // ladder chassis + deck
    B.box('armor', [6.00, 0.34, 1.86], [-0.10, 0.86, 0], { shade: 0.88 });
    B.box('armor', [3.60, 0.16, 2.30], [-1.55, 1.10, 0], { shade: 1.0 });
    // protected cab
    B.side('armor', [
      [0.95, 0.98], [2.70, 0.98], [3.05, 1.30], [3.05, 2.06], [2.40, 2.46], [0.95, 2.46],
    ], 2.20, [0, 0, 0]);
    B.box('optics', [0.08, 0.62, 1.92], [2.76, 2.02, 0], { rz: 0.54, shade: 1.3 });
    for (const s of [-1, 1]) {
      B.box('optics', [0.60, 0.42, 0.05], [1.70, 1.96, s * 1.11], { shade: 1.25 });
      B.cyl('optics', 0.12, 0.12, 0.10, 10, [3.02, 1.30, s * 0.76], 'x', { shade: 1.3 });
      B.box('dark', [0.16, 0.30, 0.10], [2.60, 2.36, s * 1.20], { shade: 1.1 });
      B.box('dark', [0.10, 0.24, 0.24], [2.55, 2.36, s * 1.34], { shade: 1.15 });
      // fuel + air tanks, jacks
      B.cyl('armor', 0.26, 0.26, 0.90, 10, [0.35, 0.86, s * 1.06], 'x', { shade: 0.94 });
      B.box('armor', [0.30, 0.62, 0.30], [-2.85, 0.62, s * 1.00], { shade: 0.9 });
      B.box('dark', [0.42, 0.12, 0.42], [-2.85, 0.28, s * 1.00], { shade: 1.0 });
    }
    B.box('dark', [0.90, 0.30, 2.10], [3.10, 1.10, 0], { shade: 1.05 });
    addWheels(B, [2.30, -1.10, -2.10], 1.24, 0.62, 0.46, { dual: [-1.10, -2.10] });
    for (const s of [-1, 1]) {
      B.box('armor', [1.30, 0.10, 0.52], [-1.60, 1.34, s * 1.34], { shade: 1.08 });
    }
    B.cyl('armor', 0.72, 0.78, 0.22, 14, [-1.30, 1.22, 0], 'y', { shade: 1.05 });
    // ROUND-2 FIX 2: the launcher had no antenna and no stowage at all.
    // Cab roof rather than the chassis deck — the deck between the cab face
    // (x 0.95) and the turntable (x −0.58) is already fuel tank, and a bundle
    // lashed over the cab is where a real crew puts it anyway.
    addAntenna(B, 1.10, 2.46, -0.92, 1.60, -0.06);
    addJerrycans(B, -3.00, 1.40, 0.85, 2);
    addStowage(B, 1.55, 2.586, 0.30, 0.9);
    // rear-mounted spare road wheel on the frame end beam
    B.cyl('rubber', 0.60, 0.60, 0.42, 14, [-3.06, 0.72, 0], 'x', { shade: 0.84 });
    B.cyl('dark', 0.36, 0.36, 0.20, 12, [-3.16, 0.72, 0], 'x', { shade: 1.12 });
    B.cyl('dark', 0.16, 0.16, 0.30, 8, [-3.18, 0.72, 0], 'x', { shade: 1.26 });
    B.box('armor', [0.22, 0.14, 0.16], [-2.98, 0.72, 0], { shade: 0.94 });
  });

  const turret = node(root, 'turret', -1.30, 1.34, 0);
  part(turret, 'mlrs:turret', P, AO(0, 3.2, 0.44, 1.34), (B) => {
    B.box('armor', [1.20, 0.34, 1.90], [0, 0.16, 0], { shade: 1.02 });
    for (const s of [-1, 1]) {
      B.box('armor', [0.32, 0.86, 0.16], [-0.28, 0.58, s * 0.92], { rz: 0.30, shade: 0.96 });
    }
    B.box('dark', [0.30, 0.26, 0.30], [0.50, 0.30, 0.70], { shade: 1.05 });
  });

  const barrel = node(turret, 'barrel', 0.34, 0.58, 0);
  barrel.rotation.z = 30 * DEG;
  part(barrel, 'mlrs:barrel', P, AO(0, 1, 1), (B) => {
    // tube pack: open-topped cradle so the tube mouths read from above
    B.box('armor', [2.70, 0.10, 1.94], [0, -0.56, 0], { shade: 0.92 });
    for (const s of [-1, 1]) {
      B.box('armor', [2.70, 1.16, 0.10], [0, 0.06, s * 0.94], { shade: 0.98 });
      B.box('armor', [0.16, 1.30, 0.20], [-1.32, 0.06, s * 0.66], { shade: 1.0 });
      B.box('armor', [0.16, 1.30, 0.20], [1.32, 0.06, s * 0.66], { shade: 1.06 });
    }
    // 3 x 4 launch tubes (top row proud of the frame rails)
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 4; col++) {
        const y = -0.34 + row * 0.36;
        const z = -0.68 + col * 0.45;
        B.cyl('dark', 0.170, 0.170, 2.66, 12, [0, y, z], 'x', { shade: 0.82 });
        B.cyl('dark', 0.188, 0.188, 0.10, 12, [1.30, y, z], 'x', { shade: 1.18 });
        B.cyl('dark', 0.188, 0.188, 0.08, 12, [-1.30, y, z], 'x', { shade: 0.9 });
      }
    }
    B.box('dark', [0.24, 0.30, 0.24], [-1.46, 0.24, 0], { shade: 1.05 });
  });

  addDecals(root, P, [
    { c: 'num', p: [1.60, 1.42, 1.105], w: 0.50, h: 0.28, mirror: true },
    { c: DECAL_HAZARD, p: [1.14, 1.42, 1.105], w: 0.26, h: 0.26, mirror: true },
    // cab roof (flat y 2.46 between x 0.95 and 2.40), starboard of the lashed
    // bundle at z +0.30 and clear of the whip at z −0.92
    { c: DECAL_PANEL, p: [2.00, 2.465, -0.35], f: 'y+', w: 0.36, h: 0.24 },
  ]);
  addDecals(turret, P, [
    { c: 'fac', p: [0.0, 0.16, 0.955], w: 0.30, h: 0.30, mirror: true },
  ]);
}

function modelAA(root, P) {
  const TOP = 1.72;
  part(root, 'aa:hull', P, AO(0.0, 3.0, 0.46), (B) => {
    B.side('armor', [
      [-2.75, 0.44], [2.18, 0.42], [2.78, 0.96], [2.40, 1.72], [-2.75, 1.72],
    ], 2.36, [0, 0, 0]);
    const xs = [2.05, -0.55, -1.95];
    addWheels(B, xs, 1.40, 0.56, 0.44);
    for (const s of [-1, 1]) {
      for (const x of xs) {
        B.box('armor', [1.06, 0.24, 0.28], [x, 1.06, s * 1.30], { shade: 1.05 });
      }
      B.box('armor', [1.60, 0.34, 0.30], [0.70, 1.30, s * 1.24], { shade: 0.98 });
      B.cyl('optics', 0.11, 0.11, 0.08, 10, [2.72, 1.12, s * 0.82], 'x', { shade: 1.3 });
      B.box('optics', [0.34, 0.20, 0.05], [1.30, 1.50, s * 1.19], { shade: 1.28 });
      // stabiliser jacks
      B.box('dark', [0.22, 0.44, 0.20], [-2.55, 0.52, s * 1.16], { shade: 1.0 });
      // ROUND-2 FIX 2: the SHORAD carried NO stowage of any kind. Tow rope on
      // the flank above the fender line — x is held back to −0.40 so it clears
      // the side stowage box that starts at x −0.10.
      addTowCable(B, -2.30, -0.40, 1.42, s * 1.21, 0.10);
    }
    B.box('armor', [0.10, 0.66, 1.50], [2.62, 1.34, 0], { rz: 0.42, shade: 1.0 });
    B.box('optics', [0.05, 0.50, 1.34], [2.58, 1.34, 0], { rz: 0.42, shade: 1.3 });
    B.cyl('armor', 0.70, 0.76, 0.14, 14, [-0.20, 1.76, 0], 'y', { shade: 1.06 });
    addAntenna(B, -2.45, 1.78, -0.86, 1.60, -0.06);
    // rear roof deck: lashed bundle to port, jerrycan rack to starboard. The
    // turret ring stops at x −0.90 and the turret box at x −1.25, so both sit
    // behind the traverse envelope and never clip the elevating pack.
    addStowage(B, -1.95, 1.846, -0.55, 0.9);
    addJerrycans(B, -2.20, 1.94, 0.70, 2);
  });

  const turret = node(root, 'turret', -0.20, TOP + 0.14, 0);
  part(turret, 'aa:turret', P, AO(0, 3.2, 0.46, TOP + 0.14), (B) => {
    B.box('armor', [2.10, 0.44, 1.86], [0, 0.22, 0], { shade: 1.02 });
    B.box('armor', [0.70, 0.30, 1.20], [-0.72, 0.56, 0], { shade: 1.06 });
    // electro-optical sensor ball + laser designator
    B.sph('optics', 0.24, [0.86, 0.62, 0.52], { shade: 1.25 });
    B.box('armor', [0.34, 0.30, 0.34], [0.86, 0.86, 0.52], { shade: 1.08 });
    B.box('dark', [0.26, 0.20, 0.20], [0.82, 0.60, -0.62], { shade: 1.1 });
    addAntenna(B, -0.95, 0.42, 0.80, 1.05, 0.04);
  });

  // rotating search radar panel (idle sweep, art bible §4)
  const radar = node(turret, 'radar', -0.78, 0.86, 0);
  part(radar, 'aa:radar', P, AO(0, 1, 0.9), (B) => {
    B.cyl('dark', 0.13, 0.16, 0.34, 10, [0, -0.16, 0], 'y', { shade: 1.05 });
    B.box('armor', [0.16, 1.15, 1.55], [0, 0.52, 0], { rz: -0.12, shade: 1.1 });
    B.box('dark', [0.06, 1.02, 1.42], [-0.09, 0.52, 0], { rz: -0.12, shade: 0.85 });
    for (let i = 0; i < 5; i++) {
      B.box('dark', [0.05, 0.05, 1.44], [0.10, 0.06 + i * 0.23, 0], { shade: 1.2 });
    }
  });
  const clock = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();
  const spin = () => { radar.rotation.y = (clock() % 3600000) * 0.00042; };
  for (const m of radar.children) m.onBeforeRender = spin;

  // elevating missile pack (named 'barrel' so muzzle FX fire from the tubes)
  const barrel = node(turret, 'barrel', 0.60, 0.50, 0);
  barrel.rotation.z = 32 * DEG;
  part(barrel, 'aa:barrel', P, AO(0, 1, 1), (B) => {
    B.box('armor', [1.05, 0.16, 1.05], [-0.10, -0.28, 0], { shade: 0.95 });
    for (let row = 0; row < 2; row++) {
      for (const s of [-1, 1]) {
        const y = -0.08 + row * 0.34;
        const z = s * 0.28;
        B.box('armor', [1.55, 0.30, 0.30], [0, y, z], { shade: 1.0 });
        B.cyl('dark', 0.115, 0.115, 1.50, 10, [0.02, y, z], 'x', { shade: 0.9 });
        B.cone('optics', 0.10, 0.24, 10, [0.86, y, z], 'x', { shade: 1.2 });
      }
    }
    B.box('dark', [0.20, 0.66, 0.20], [-0.82, 0.12, 0], { shade: 1.05 });
  });

  addDecals(root, P, [
    { c: 'num', p: [-1.15, 1.30, 1.185], w: 0.52, h: 0.28, mirror: true },
    { c: 'fac', p: [-2.30, 1.30, 1.185], w: 0.32, h: 0.32, mirror: true },
    // hull roof forward of the turret box, which starts at x −1.25 and only
    // reaches x 0.85
    { c: DECAL_PANEL, p: [1.15, 1.725, 0.55], f: 'y+', w: 0.36, h: 0.24 },
  ]);
}

// ---------------------------------------------------------------- ROUND-7: sam
// Long-range SAM battery. It sits directly beside the SHORAD in the roster and
// the player has to tell them apart in one glance from 115 u up, so nothing
// about the silhouette is shared:
//   SHORAD  — 3 axles, compact turret, small flat radar plate, four SHORT tubes
//             lying at 32°. Reads as a gun-height vehicle.
//   SAM     — 4 axles and a metre longer, four BIG canisters standing at 62°
//             (nothing else in the game points at the sky), and a two-storey
//             search-radar array on a mast at the rear. Reads as a structure on
//             wheels: two tall peaks over a long hull.
// It is also the only vehicle in the roster with deployed outriggers down —
// the "emplaced, not driving" cue that matches its move 3.
function modelSAM(root, P) {
  const TOP = 1.76;
  part(root, 'sam:hull', P, AO(0.0, 3.4, 0.44), (B) => {
    // long 8×8 chassis
    B.box('armor', [6.30, 0.34, 2.00], [-0.10, 0.86, 0], { shade: 0.88 });
    B.side('armor', [
      [1.15, 0.98], [2.92, 0.98], [3.22, 1.32], [3.22, 2.02], [2.58, 2.42], [1.15, 2.42],
    ], 2.14, [0, 0, 0]);
    B.box('optics', [0.08, 0.58, 1.86], [2.94, 2.02, 0], { rz: 0.58, shade: 1.3 });
    const xs = [2.42, 1.24, -1.50, -2.62];
    addWheels(B, xs, 1.46, 0.60, 0.46);
    for (const s of [-1, 1]) {
      for (const x of xs) {
        B.box('armor', [1.12, 0.24, 0.30], [x, 1.14, s * 1.34], { shade: 1.05 });
      }
      B.box('optics', [0.50, 0.36, 0.05], [1.86, 1.94, s * 1.09], { shade: 1.25 });
      B.cyl('optics', 0.12, 0.12, 0.10, 10, [3.20, 1.30, s * 0.74], 'x', { shade: 1.3 });
      // deployed outriggers: leg out, foot down, pad on the dirt. This is the
      // whole "emplaced" read and it is why the battery moves 3.
      B.box('dark', [0.30, 0.22, 0.86], [-0.40, 1.06, s * 1.52], { shade: 1.0 });
      B.cyl('dgrey', 0.10, 0.10, 1.06, 8, [-0.40, 0.54, s * 1.92], 'y', { shade: 1.12 });
      B.cyl('dgrey', 0.34, 0.30, 0.12, 12, [-0.40, 0.06, s * 1.92], 'y', { shade: 0.94 });
      B.box('dark', [0.30, 0.22, 0.86], [-3.02, 1.06, s * 1.52], { shade: 1.0 });
      B.cyl('dgrey', 0.10, 0.10, 1.06, 8, [-3.02, 0.54, s * 1.92], 'y', { shade: 1.12 });
      B.cyl('dgrey', 0.34, 0.30, 0.12, 12, [-3.02, 0.06, s * 1.92], 'y', { shade: 0.94 });
      addTowCable(B, -2.20, -0.90, 1.50, s * 1.24, 0.10);
    }
    // deck, launcher turntable ring, power/coolant group behind the cab
    B.box('armor', [4.30, 0.16, 2.10], [-1.05, TOP - 0.06, 0], { shade: 0.96 });
    B.cyl('armor', 0.76, 0.82, 0.16, 16, [-1.20, TOP + 0.06, 0], 'y', { shade: 1.06 });
    B.box('armor', [1.00, 0.62, 1.70], [0.86, TOP + 0.25, 0], { shade: 0.94 });
    for (let i = 0; i < 4; i++) {
      B.box('dark', [0.06, 0.44, 1.60], [0.50 + i * 0.24, TOP + 0.25, 0], { shade: 0.86 });
    }
    B.cyl('dark', 0.26, 0.26, 0.62, 10, [1.30, TOP + 0.66, -0.56], 'y',
      { shade: 0.9, tint: HEAT });
    addAntenna(B, 1.36, TOP + 0.60, 0.78, 1.55, -0.05);
    addStowage(B, -3.10, TOP + 0.10, 0.60, 0.9);
    addJerrycans(B, -3.20, TOP + 0.18, -0.62, 2);
  });

  addDecals(root, P, [
    { c: 'num', p: [1.90, 1.42, 1.075], w: 0.52, h: 0.28, mirror: true },
    { c: 'fac', p: [-2.60, 1.42, 1.005], w: 0.36, h: 0.36, mirror: true },
    { c: DECAL_HAZARD, p: [-0.90, 1.44, 1.005], w: 0.26, h: 0.26, mirror: true },
    { c: DECAL_PANEL, p: [-2.70, TOP + 0.03, 0.62], f: 'y+', w: 0.38, h: 0.26 },
  ]);

  // ---- search radar: a tall planar array on its own mast at the rear, sweeping
  // continuously. Same idle-sweep trick the SHORAD's plate uses (onBeforeRender,
  // wall clock — no engine hook), but four times the panel and twice the height,
  // because "there is a radar looking for aircraft here" is the unit's identity.
  const radar = node(root, 'radar', -3.02, TOP + 0.10, 0);
  part(radar, 'sam:radar', P, AO(0, 2.6, 0.7, TOP + 0.10), (B) => {
    B.cyl('armor', 0.34, 0.42, 0.30, 12, [0, 0.12, 0], 'y', { shade: 1.02 });
    B.cyl('dark', 0.16, 0.18, 0.62, 10, [0, 0.56, 0], 'y', { shade: 1.1 });
    B.box('armor', [0.44, 0.26, 0.90], [0, 0.90, 0], { shade: 1.04 });
    // the array itself: face, backing frame, waveguide ribs
    B.box('armor', [0.18, 2.05, 1.62], [0.06, 1.98, 0], { rz: -0.14, shade: 1.12 });
    B.box('dark', [0.07, 1.86, 1.46], [-0.05, 1.98, 0], { rz: -0.14, shade: 0.84 });
    for (let i = 0; i < 7; i++) {
      B.box('dark', [0.05, 0.06, 1.50], [0.16, 1.10 + i * 0.30, 0],
        { rz: -0.14, shade: 1.22 });
    }
    for (const s of [-1, 1]) {
      B.strut('dgrey', [-0.10, 1.16, s * 0.72], [-0.34, 1.98, 0], 0.045, 5, { shade: 1.05 });
      B.box('optics', [0.10, 0.16, 0.16], [0.14, 2.98, s * 0.66], { shade: 1.28 });
    }
  });
  const samClock = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();
  const sweep = () => { radar.rotation.y = (samClock() % 3600000) * 0.00031; };
  for (const m of radar.children) m.onBeforeRender = sweep;

  // ---- launcher: turntable ('turret') carrying the erected canister pack
  // ('barrel', forward of its parent origin per the file header, so muzzle FX
  // and recoil hook up exactly like every gun in the roster).
  const turret = node(root, 'turret', -1.20, TOP + 0.20, 0);
  part(turret, 'sam:mount', P, AO(0, 3.4, 0.5, TOP + 0.20), (B) => {
    B.cyl('armor', 0.62, 0.70, 0.26, 14, [0, 0.10, 0], 'y', { shade: 1.04 });
    B.box('armor', [1.10, 0.44, 1.42], [0.08, 0.36, 0], { shade: 1.0 });
    for (const s of [-1, 1]) {
      B.box('armor', [0.34, 0.62, 0.26], [0.44, 0.62, s * 0.66], { shade: 1.06 });
      // elevating ram
      B.strut('dgrey', [-0.42, 0.30, s * 0.50], [0.34, 0.92, s * 0.50], 0.09, 8,
        { shade: 1.12 });
    }
    B.box('dark', [0.30, 0.26, 0.34], [-0.52, 0.46, 0.52], { shade: 1.1 });
  });

  const barrel = node(turret, 'barrel', 0.44, 0.62, 0);
  barrel.rotation.z = 62 * DEG;
  part(barrel, 'sam:canisters', P, AO(0, 3.0, 1, TOP + 0.82), (B) => {
    // erector frame
    B.box('armor', [2.90, 0.14, 1.30], [1.18, -0.42, 0], { shade: 0.96 });
    for (const dz of [-0.62, 0.62]) {
      B.box('armor', [2.86, 0.34, 0.10], [1.18, -0.16, dz], { shade: 1.02 });
    }
    // four square canisters, 2×2, with frangible end caps and lift lugs
    for (const dy of [-0.02, 0.62]) {
      for (const dz of [-0.34, 0.34]) {
        B.box('armor', [2.74, 0.58, 0.58], [1.20, dy, dz], { shade: 1.0 });
        B.box('dgrey', [0.10, 0.52, 0.52], [2.62, dy, dz], { shade: 1.18 });
        B.box('dark', [0.08, 0.60, 0.60], [-0.16, dy, dz], { shade: 0.88 });
        for (let i = 0; i < 3; i++) {
          B.box('dark', [0.07, 0.60, 0.60], [0.30 + i * 0.86, dy, dz], { shade: 1.08 });
        }
      }
    }
    B.box('dark', [0.26, 0.24, 1.34], [-0.30, 0.30, 0], { shade: 1.05 });
  });
}

function modelEW(root, P) {
  part(root, 'ew:hull', P, AO(0.0, 4.2, 0.46), (B) => {
    B.box('armor', [5.40, 0.30, 1.80], [-0.10, 0.80, 0], { shade: 0.88 });
    // cab
    B.side('armor', [
      [1.05, 0.92], [2.62, 0.92], [2.92, 1.24], [2.92, 1.92], [2.30, 2.34], [1.05, 2.34],
    ], 2.14, [0, 0, 0]);
    B.box('optics', [0.08, 0.58, 1.86], [2.64, 1.92, 0], { rz: 0.58, shade: 1.3 });
    for (const s of [-1, 1]) {
      B.box('optics', [0.56, 0.40, 0.05], [1.75, 1.86, s * 1.08], { shade: 1.25 });
      B.cyl('optics', 0.12, 0.12, 0.10, 10, [2.90, 1.22, s * 0.72], 'x', { shade: 1.3 });
      B.box('dark', [0.14, 0.26, 0.10], [2.48, 2.24, s * 1.18], { shade: 1.1 });
      B.box('dark', [0.10, 0.22, 0.22], [2.44, 2.24, s * 1.32], { shade: 1.15 });
      B.box('armor', [0.28, 0.56, 0.28], [-2.70, 0.58, s * 0.92], { shade: 0.92 });
    }
    B.box('dark', [0.34, 0.34, 2.00], [2.98, 1.06, 0], { shade: 1.05 });
    addWheels(B, [2.02, -1.35, -2.30], 1.20, 0.58, 0.44, { dual: [-1.35, -2.30] });
    // shelter body (the jammer's electronics box)
    B.box('armor', [3.30, 1.72, 2.24], [-1.25, 1.82, 0], { shade: 1.0 });
    B.box('armor', [3.34, 0.10, 2.30], [-1.25, 2.72, 0], { shade: 1.2 });
    for (const s of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        B.box('dark', [0.05, 1.44, 0.05], [-2.60 + i * 0.86, 1.82, s * 1.13], { shade: 1.1 });
      }
      B.box('dark', [0.70, 0.34, 0.06], [-0.30, 2.28, s * 1.13], { shade: 0.9 });
      B.cyl('dark', 0.20, 0.20, 0.10, 10, [-2.30, 1.60, s * 1.14], 'z', { shade: 1.1 });
    }
    B.box('armor', [0.08, 1.30, 0.90], [-2.92, 1.80, -0.50], { shade: 0.94 });
    B.box('dark', [0.10, 0.10, 0.30], [-2.98, 1.80, -0.02], { shade: 1.15 });
    // generator + cable reel behind the cab
    B.box('armor', [0.80, 0.60, 0.90], [0.75, 1.28, 0.55], { shade: 0.96 });
    B.cyl('dark', 0.28, 0.28, 0.44, 12, [0.75, 1.30, -0.62], 'z', { shade: 1.0 });

    // ---- lattice mast: the tallest ground silhouette on the map
    const mx = -1.25;
    const base = 2.78;
    const top = 6.05;
    const legs = [[0.28, 0.30], [0.28, -0.30], [-0.28, 0.30], [-0.28, -0.30]];
    const seg = 5;
    const taper = (t) => 1 - 0.45 * t;
    for (const L of legs) {
      for (let i = 0; i < seg; i++) {
        const t0 = i / seg;
        const t1 = (i + 1) / seg;
        const y0 = base + (top - base) * t0;
        const y1 = base + (top - base) * t1;
        B.strut('dark',
          [mx + L[0] * taper(t0), y0, L[1] * taper(t0)],
          [mx + L[0] * taper(t1), y1, L[1] * taper(t1)], 0.045, 5, { shade: 1.2 });
      }
    }
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const y = base + (top - base) * t;
      const k = taper(t);
      B.strut('dark', [mx + 0.28 * k, y, 0.30 * k], [mx + 0.28 * k, y, -0.30 * k], 0.032, 4, { shade: 1.25 });
      B.strut('dark', [mx - 0.28 * k, y, 0.30 * k], [mx - 0.28 * k, y, -0.30 * k], 0.032, 4, { shade: 1.25 });
      B.strut('dark', [mx + 0.28 * k, y, 0.30 * k], [mx - 0.28 * k, y, 0.30 * k], 0.032, 4, { shade: 1.25 });
      B.strut('dark', [mx + 0.28 * k, y, -0.30 * k], [mx - 0.28 * k, y, -0.30 * k], 0.032, 4, { shade: 1.25 });
      if (i < seg) {
        const t1 = (i + 1) / seg;
        const y1 = base + (top - base) * t1;
        const k1 = taper(t1);
        B.strut('dark', [mx + 0.28 * k, y, 0.30 * k], [mx + 0.28 * k1, y1, -0.30 * k1], 0.026, 4, { shade: 1.15 });
        B.strut('dark', [mx - 0.28 * k, y, -0.30 * k], [mx - 0.28 * k1, y1, 0.30 * k1], 0.026, 4, { shade: 1.15 });
      }
    }
    // mast head: dishes, yagi array, whips
    B.box('armor', [0.46, 0.34, 0.46], [mx, top + 0.14, 0], { shade: 1.1 });
    for (const s of [-1, 1]) {
      B.cyl('armor', 0.44, 0.40, 0.10, 14, [mx + 0.30 * s, top + 0.30, 0.34 * s], 'x',
        { ry: s > 0 ? 0.6 : 2.5, shade: 1.14 });
      B.cyl('dark', 0.06, 0.06, 0.30, 8, [mx + 0.42 * s, top + 0.30, 0.44 * s], 'x',
        { ry: s > 0 ? 0.6 : 2.5, shade: 1.2 });
    }
    B.cyl('dark', 0.05, 0.05, 1.30, 6, [mx - 0.10, top + 0.90, -0.34], 'x', { shade: 1.2 });
    for (let i = 0; i < 7; i++) {
      B.box('dark', [0.03, 0.03, 0.62 - i * 0.05], [mx - 0.65 + i * 0.19, top + 0.90, -0.34],
        { shade: 1.25 });
    }
    B.cyl('dark', 0.016, 0.045, 1.10, 6, [mx, top + 0.84, 0.20], 'y', { shade: 1.25 });
    // guy stays
    for (const g of [[0.9, 1.0], [0.9, -1.0], [-1.5, 0.0]]) {
      B.strut('dark', [mx, top - 0.60, 0], [mx + g[0] * 1.4, 2.76, g[1] * 1.1], 0.018, 4,
        { shade: 1.1 });
    }
    // ROUND-2 FIX 2: the jammer carried no whip at all — only the mast array
    addAntenna(B, 1.20, 2.34, -0.86, 1.45, -0.05);
    // ...and no stowage. The chassis gap between cab and shelter is already
    // generator + cable reel, so the kit goes on the shelter roof (top 2.77),
    // clear of the mast footprint (x −1.53 … −0.97) and of the guy stays.
    addStowage(B, -0.20, 2.896, 0.55, 0.95);
    addJerrycans(B, -2.40, 2.99, -0.70, 2);
  });

  addDecals(root, P, [
    { c: 'num', p: [-1.31, 2.05, 1.125], w: 0.60, h: 0.30, mirror: true },
    { c: 'fac', p: [-2.17, 2.05, 1.125], w: 0.34, h: 0.34, mirror: true },
    { c: DECAL_HAZARD, p: [-0.45, 1.55, 1.125], w: 0.26, h: 0.26, mirror: true },
    // shelter roof (top y 2.77), outboard of the mast footprint (z ±0.30) and
    // clear of both the roof bundle and the jerrycan rack
    { c: DECAL_PANEL, p: [-1.90, 2.775, 0.60], f: 'y+', w: 0.44, h: 0.30 },
  ]);
}

// ============================================================ ROUND-7 FIX 3
// PLAYER REPORT: "if an FPV attacks infantry, you cannot see the units it is
// attacking."
//
// The suspected cause was that THREE.LOD picks its level from the wrong camera
// during an FPV dive. VERIFIED FALSE, and worth writing down so nobody chases
// it again: `WebGLRenderer.projectObject()` calls `LOD.update(camera)` with the
// camera the current render pass was handed, `js/core/engine.js` renders the
// beauty pass and the half-res AO normal pass with the SAME `engine.camera`
// object, and `js/fx/dronecam.js` flies THAT object rather than swapping in a
// second camera. The level therefore always follows the eye that is about to
// draw the frame. It also never mattered: an FPV strike is range ≤ 4 and hexes
// are 9–10.4 world units apart (terrain.js HEX.size 6), so the whole dive
// happens inside ~50 units of the target — far below any plausible threshold.
//
// The REAL cause was this constant, and the arithmetic in the comment that used
// to sit here. MEASUREMENT, from the source:
//     engine.js  DEFAULT_DIST = 115           (the camera you boot into)
//     dronecam.js FALLBACK_OFFSET length 118  (where restoreCamera() puts you,
//                                              pre-aimed AT the unit you just
//                                              hit, as the static fades)
//     old INFANTRY_LOD_FAR = 90
// 115 > 90 and 118 > 90, so the *default* view — and specifically the framed,
// pre-aimed view the player is given at the end of every FPV strike — was
// already past the switch. What the far level draws is a scraped fighting
// position: spoil ring, sandbags, two crates and NO SOLDIERS. The player flew a
// drone into a hole in the ground and got a damage float over empty dirt.
//
// Two changes, because either alone still leaves a hole:
//   1. The threshold moves out past the whole "inspect" band. 170 sits above
//      the boot distance (115), above the post-dive restore (118) and above a
//      comfortable zoomed-out working view, and still buys the saving back on
//      the top third of the 15–260 zoom clamp.
//   2. The far level gets two simplified bodies in it, so even at strategic
//      zoom the position reads as MANNED rather than abandoned. A hole with men
//      in it is the whole point of the counter-plus-geometry pair.
// MODEL PREDICTION for the readability half: at fov 40 on a 1080-line viewport
// a 1.7 u standing soldier is 1.7/115 rad ≈ 23 px tall at the default distance
// and ≈ 15 px at the new threshold — legible as a person in both cases.
//
// Infantry is the ONLY type in this file with an LOD; every other class is
// single-level and already draws full geometry at any distance, so nothing else
// needed a near level for the dronecam.
const INFANTRY_LOD_FAR = 170;

function modelInfantry(root, P) {
  // THREE.LOD is updated by the renderer itself (projectObject), so this needs no
  // engine hook and no per-frame callback. `root` stays a plain Group, which is
  // what the contract promises and what markers/vfx/fog all parent themselves to.
  const lod = new THREE.LOD();
  lod.name = 'lod';
  root.add(lod);

  // ---------------------------------------------------------------- near level
  const near = new THREE.Group();
  near.name = 'squad';
  part(near, 'infantry:team', P, AO(0.0, 1.5, 0.55), (B) => {
    // Four distinct poses. Two prone on the parapet (one rifleman, one gunner),
    // one kneeling observer with a magnified sight, one standing section commander
    // — so the squad reads as a squad and not as four copies of one lump.
    soldier(B, 1.22, -0.62, -0.14, 'prone', { weapon: 'rifle' });
    soldier(B, 0.72, 0.92, 0.26, 'prone', { weapon: 'mg', pack: true });
    soldier(B, -0.48, -0.28, -0.06, 'kneel', { weapon: 'rifle', optic: true });
    soldier(B, -1.28, 0.58, 0.32, 'stand', { weapon: 'rifle', pack: true });
    // position furniture
    addSandbags(B, 1.72, -0.42, 0.30, 3);
    addSandbags(B, 1.30, 1.02, 0.72, 2);
    B.box('canvas', [0.44, 0.24, 0.34], [-0.25, 0.12, -0.05], { ry: 0.4, shade: 0.9 });
    B.box('dark', [0.40, 0.20, 0.26], [0.45, 0.10, 1.25], { ry: -0.25, shade: 1.0 });
    B.box('canvas', [0.30, 0.16, 0.22], [-1.62, 0.08, -0.15], { ry: 0.9, shade: 0.95 });
    B.cyl('dark', 0.10, 0.10, 0.30, 8, [-0.90, 0.10, -0.62], 'z', { shade: 0.95 });
  }, 1.7);   // finer camo scale on cloth-sized surfaces
  lod.addLevel(near, 0);

  // ----------------------------------------------------------------- far level
  const far = new THREE.Group();
  far.name = 'squad-far';
  part(far, 'infantry:far', P, AO(0.0, 1.0, 0.62), (B) => {
    // scraped fighting position — spoil ring + sandbag lip, so the base plate is
    // still a piece of terrain rather than a counter
    B.plan('canvas', [
      [-1.42, -1.02], [-0.30, -1.30], [1.10, -1.06], [1.46, -0.28],
      [1.30, 0.72], [0.24, 1.28], [-1.16, 1.10], [-1.50, 0.20],
    ], 0.24, [0, 0, 0], { shade: 0.84 });
    addSandbags(B, 0.92, -0.58, -0.30, 3);
    addSandbags(B, -0.42, 0.92, 2.70, 3);
    B.box('armor', [0.52, 0.26, 0.38], [-0.94, 0.36, -0.46], { ry: 0.32, shade: 0.96 });
    B.box('dark', [0.42, 0.22, 0.30], [0.34, 0.34, 0.66], { ry: -0.4, shade: 1.02 });
    // ROUND-7 FIX 3, half two: the position is MANNED at every zoom. Two bodies
    // only, and the cheapest two poses (the prone silhouette is four boxes and
    // a helmet), because the job here is "someone is in that hole", not a
    // second squad. The kneeling one is what carries it: a vertical torso plus
    // a helmet sphere is the shape the eye reads as a person at 15 px.
    soldier(B, -0.34, -0.20, -0.06, 'kneel', { weapon: 'rifle' });
    soldier(B, 1.06, 0.72, 0.22, 'prone', { weapon: 'rifle' });
  }, 1.1);
  // No badge here any more — fx/markers.js carries one over every unit at every
  // zoom, and two of them stacked at different heights read as a bug.
  lod.addLevel(far, INFANTRY_LOD_FAR);
}

function modelATGM(root, P) {
  part(root, 'atgm:team', P, AO(0.0, 1.5, 0.55), (B) => {
    // tripod
    const apex = [0.02, 0.80, 0];
    for (const f of [[0.46, 0], [-0.28, 0.42], [-0.28, -0.42]]) {
      B.strut('dark', apex, [apex[0] + f[0], 0.02, f[1]], 0.035, 5, { shade: 1.15 });
      B.box('dark', [0.14, 0.05, 0.12], [apex[0] + f[0], 0.03, f[1]], { shade: 1.0 });
    }
    B.box('dark', [0.20, 0.16, 0.20], [apex[0], apex[1] - 0.04, 0], { shade: 1.1 });
    // ammo cases + crew
    B.box('canvas', [0.86, 0.24, 0.30], [-0.15, 0.12, 0.98], { ry: 0.18, shade: 0.92 });
    B.box('canvas', [0.86, 0.24, 0.30], [-0.25, 0.36, 0.98], { ry: 0.10, shade: 1.02 });
    soldier(B, -0.62, 0.18, -0.10, 'kneel', { weapon: 'none' });
    soldier(B, -0.95, -0.85, 0.30, 'crouch', { weapon: 'binos', pack: true });
    addSandbags(B, 0.85, -0.85, 0.5, 3);
  }, 1.7);

  const turret = node(root, 'turret', 0.02, 0.86, 0);
  part(turret, 'atgm:mount', P, AO(0, 1.6, 0.6, 0.86), (B) => {
    B.box('armor', [0.26, 0.22, 0.40], [0, 0.06, 0], { shade: 1.05 });
    B.box('optics', [0.14, 0.16, 0.14], [0.02, 0.20, -0.28], { shade: 1.3 });
    B.box('armor', [0.20, 0.18, 0.18], [-0.12, 0.20, 0.26], { shade: 1.0 });
    B.cyl('dark', 0.03, 0.03, 0.26, 6, [-0.20, 0.28, 0.26], 'y', { shade: 1.2 });
  });

  const barrel = node(turret, 'barrel', 0.34, 0.10, 0);
  part(barrel, 'atgm:tube', P, AO(0, 1, 1), (B) => {
    B.cyl('armor', 0.135, 0.135, 1.35, 12, [0, 0, 0], 'x', { shade: 1.0 });
    B.cyl('dark', 0.155, 0.155, 0.10, 12, [0.66, 0, 0], 'x', { shade: 1.15 });
    B.cone('dark', 0.15, 0.30, 12, [-0.80, 0, 0], 'x', { ry: Math.PI, shade: 1.05 });
    B.box('armor', [0.42, 0.16, 0.16], [-0.10, 0.16, 0], { shade: 1.1 });
    B.box('optics', [0.10, 0.10, 0.10], [0.14, 0.20, 0], { shade: 1.3 });
  });
}

function modelTruck(root, P) {
  part(root, 'truck:body', P, AO(0.0, 3.0, 0.46), (B) => {
    B.box('armor', [5.30, 0.28, 1.72], [-0.20, 0.78, 0], { shade: 0.88 });
    // cab
    B.side('armor', [
      [0.85, 0.90], [2.55, 0.90], [2.86, 1.22], [2.86, 1.86], [2.24, 2.30], [0.85, 2.30],
    ], 2.06, [0, 0, 0]);
    B.box('optics', [0.08, 0.60, 1.80], [2.58, 1.88, 0], { rz: 0.60, shade: 1.3 });
    for (const s of [-1, 1]) {
      B.box('optics', [0.54, 0.40, 0.05], [1.70, 1.82, s * 1.04], { shade: 1.25 });
      B.cyl('optics', 0.12, 0.12, 0.10, 10, [2.84, 1.20, s * 0.70], 'x', { shade: 1.3 });
      B.box('dark', [0.14, 0.26, 0.10], [2.42, 2.20, s * 1.14], { shade: 1.1 });
      B.box('dark', [0.10, 0.22, 0.22], [2.38, 2.20, s * 1.28], { shade: 1.15 });
      B.box('armor', [1.10, 0.10, 0.52], [2.10, 1.16, s * 1.18], { shade: 1.05 });
      B.box('armor', [1.60, 0.10, 0.52], [-1.60, 1.10, s * 1.18], { shade: 1.05 });
      B.cyl('armor', 0.24, 0.24, 0.80, 10, [0.35, 0.80, s * 0.96], 'x', { shade: 0.94 });
    }
    B.box('dark', [0.28, 0.34, 1.84], [2.92, 1.06, 0], { shade: 1.05 });
    addWheels(B, [1.95, -1.40, -2.32], 1.16, 0.56, 0.42, { dual: [-1.40, -2.32] });
    // cargo bed + arched canvas tilt
    B.box('armor', [3.60, 0.14, 2.10], [-1.20, 1.02, 0], { shade: 0.95 });
    for (const s of [-1, 1]) {
      B.box('armor', [3.60, 0.46, 0.10], [-1.20, 1.30, s * 1.02], { shade: 1.0 });
    }
    B.side('canvas', [
      [-3.00, 1.32], [0.55, 1.32], [0.55, 2.26], [0.34, 2.50], [-2.78, 2.50], [-3.00, 2.26],
    ], 2.14, [0, 0, 0], { shade: 1.0 });
    for (let i = 0; i < 4; i++) {
      const x = -2.55 + i * 0.80;
      B.box('canvas', [0.10, 0.06, 2.20], [x, 2.46, 0], { shade: 1.15 });
      for (const s of [-1, 1]) {
        B.box('canvas', [0.10, 0.90, 0.06], [x, 1.85, s * 1.08], { shade: 1.05 });
      }
    }
    B.box('canvas', [0.08, 1.10, 2.06], [-3.02, 1.86, 0], { shade: 0.9 });
    B.box('dark', [0.10, 0.24, 2.10], [-3.06, 1.36, 0], { shade: 1.0 });
    // jerry cans, spare wheel, tow hitch
    addJerrycans(B, 0.05, 1.24, 1.20, 2);
    B.cyl('rubber', 0.50, 0.50, 0.30, 14, [-0.90, 0.60, -1.02], 'y', { shade: 0.85 });
    B.cyl('dark', 0.19, 0.19, 0.34, 8, [-0.90, 0.60, -1.02], 'y', { shade: 1.2 });
    B.box('dark', [0.34, 0.16, 0.20], [-3.10, 0.70, 0], { shade: 1.05 });
    addAntenna(B, 0.95, 2.30, -0.90, 1.35, -0.08);
  });

  addDecals(root, P, [
    { c: 'num', p: [1.60, 1.42, 1.035], w: 0.50, h: 0.28, mirror: true },
    { c: 'fac', p: [-1.35, 1.90, 1.085], w: 0.42, h: 0.42, mirror: true },
    { c: DECAL_STRIPES, p: [-3.11, 1.36, 0.0], f: 'x-', w: 1.30, h: 0.22 },
    // the supply truck finally gets the FUEL plate the atlas has always carried
    // — on the cargo-bed side board, outer face z ±1.07
    { c: DECAL_FUEL, p: [-2.30, 1.30, 1.075], w: 0.50, h: 0.22, mirror: true },
    // and a device on the flat of the tilt, between the bows at x −1.75/−0.95
    { c: 'fac', p: [-1.30, 2.505, 0.0], f: 'y+', w: 0.60, h: 0.40 },
  ]);
}

function modelFPV(root, P) {
  // ---- ground: operator, control station, spare airframes
  part(root, 'fpv:team', P, AO(0.0, 1.6, 0.55), (B) => {
    soldier(B, -0.85, 0.42, 0.22, 'kneel', { weapon: 'none', goggles: true });
    soldier(B, -1.35, -0.62, 0.55, 'crouch', { weapon: 'rifle', pack: true });
    // control case (open lid) + controller
    B.box('armor', [0.66, 0.20, 0.50], [-0.28, 0.10, -0.05], { ry: 0.2, shade: 0.95 });
    B.box('armor', [0.62, 0.44, 0.06], [-0.52, 0.32, -0.14], { ry: 0.2, rz: -0.35, shade: 1.05 });
    B.box('optics', [0.50, 0.32, 0.05], [-0.48, 0.32, -0.12], { ry: 0.2, rz: -0.35, shade: 1.3 });
    B.box('dark', [0.26, 0.10, 0.34], [-0.06, 0.24, -0.02], { ry: 0.2, shade: 1.1 });
    // ground control antenna tripod
    const apex = [0.30, 1.05, 1.05];
    for (const f of [[0.36, 0], [-0.20, 0.32], [-0.20, -0.32]]) {
      B.strut('dark', apex, [apex[0] + f[0], 0.02, apex[2] + f[1]], 0.028, 5, { shade: 1.15 });
    }
    B.box('dark', [0.10, 0.42, 0.32], [apex[0], apex[1] + 0.16, apex[2]], { shade: 1.1 });
    B.box('armor', [0.05, 0.36, 0.28], [apex[0] + 0.07, apex[1] + 0.16, apex[2]], { shade: 1.18 });
    B.cyl('dark', 0.012, 0.03, 0.60, 6, [apex[0] - 0.10, apex[1] + 0.40, apex[2]], 'y',
      { shade: 1.25 });
    // transport case with two spare airframes
    B.box('armor', [0.86, 0.24, 0.62], [0.55, 0.12, -0.95], { ry: -0.3, shade: 0.92 });
    B.box('armor', [0.84, 0.52, 0.06], [0.30, 0.36, -1.10], { ry: -0.3, rz: 0.5, shade: 1.0 });
    for (let i = 0; i < 2; i++) {
      B.box('dgrey', [0.34, 0.08, 0.30], [0.42 + i * 0.28, 0.26, -0.90 - i * 0.08],
        { ry: -0.3, shade: 1.1 });
    }
  }, 1.7);

  // ---- the airframe itself, hovering above the team
  const lift = node(root, 'lift', 0.55, 2.55, -0.10);
  lift.rotation.z = -6 * DEG;
  part(lift, 'fpv:quad', P, AO(-0.4, 0.4, 0.75), (B) => {
    const arm = 0.50;
    // body stack
    B.box('dgrey', [0.46, 0.10, 0.34], [0, 0, 0], { shade: 1.0 });
    B.box('dgrey', [0.40, 0.16, 0.28], [-0.03, 0.13, 0], { shade: 1.12 });
    B.box('dark', [0.30, 0.05, 0.24], [-0.03, 0.22, 0], { shade: 0.85 });
    B.box('dgrey', [0.16, 0.10, 0.26], [0.24, 0.02, 0], { shade: 1.05 });
    // arms + motors
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const ax = sx * arm;
        const az = sz * arm;
        B.strut('dgrey', [sx * 0.16, -0.01, sz * 0.12], [ax, 0.02, az], 0.035, 5, { shade: 1.05 });
        B.cyl('dark', 0.085, 0.085, 0.13, 10, [ax, 0.09, az], 'y', { shade: 1.15 });
        B.cyl('dgrey', 0.05, 0.05, 0.06, 8, [ax, 0.17, az], 'y', { shade: 1.2 });
        B.box('dgrey', [0.10, 0.02, 0.10], [ax, -0.05, az], { shade: 0.9 });
      }
    }
    // camera pod + antennas
    B.box('dark', [0.13, 0.14, 0.14], [0.33, 0.07, 0], { rz: -0.22, shade: 1.1 });
    B.cyl('optics', 0.055, 0.055, 0.07, 10, [0.40, 0.10, 0], 'x', { rz: -0.22, shade: 1.3 });
    B.strut('dark', [-0.18, 0.06, 0.10], [-0.34, 0.22, 0.20], 0.014, 4, { shade: 1.2 });
    B.strut('dark', [-0.18, 0.06, -0.10], [-0.34, 0.22, -0.20], 0.014, 4, { shade: 1.2 });
    // dangling shaped-charge warhead
    B.cyl('dark', 0.095, 0.11, 0.30, 10, [0.05, -0.18, 0], 'x', { shade: 0.95 });
    B.cone('dark', 0.115, 0.24, 10, [0.30, -0.18, 0], 'x', { shade: 1.0 });
    B.cyl('dark', 0.05, 0.05, 0.16, 8, [-0.16, -0.18, 0], 'x', { shade: 1.1 });
    B.strut('dark', [0.02, -0.06, 0], [0.02, -0.14, 0], 0.02, 4, { shade: 1.0 });
  });

  const props = node(lift, 'props', 0, 0.20, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const r = rotor(props, P, 'fpv:rotor', 0.42, 2);
      r.position.set(sx * 0.50, 0, sz * 0.50);
    }
  }
}

function modelReconDrone(root, P) {
  const lift = node(root, 'lift', 0, 8.40, 0);
  lift.rotation.z = 4 * DEG;
  lift.rotation.y = 0.10;
  part(lift, 'recon:air', P, AO(-0.5, 0.5, 0.72), (B) => {
    // fuselage pod + tail boom
    B.side('grey', [
      [-0.55, -0.16], [0.62, -0.20], [0.92, -0.10], [0.98, 0.06], [0.70, 0.20], [-0.55, 0.18],
    ], 0.36, [0, 0, 0], { shade: 1.0 });
    B.cone('grey', 0.17, 0.34, 12, [1.12, 0.0, 0], 'x', { shade: 1.06 });
    B.strut('grey', [-0.50, 0.02, 0], [-1.55, 0.14, 0], 0.075, 8, { shade: 0.98 });
    // straight high-aspect wing with taper + winglets
    B.plan('grey', [
      [0.30, -2.10], [0.30, 2.10], [-0.02, 2.10], [-0.34, 0.28], [-0.34, -0.28], [-0.02, -2.10],
    ], 0.085, [0, 0.16, 0], { shade: 1.14 });
    for (const s of [-1, 1]) {
      B.box('grey', [0.28, 0.26, 0.05], [0.16, 0.28, s * 2.08], { shade: 1.05 });
      // wing fences / servo bumps
      B.box('grey', [0.16, 0.05, 0.10], [-0.10, 0.14, s * 1.05], { shade: 0.95 });
    }
    // V-tail
    for (const s of [-1, 1]) {
      B.box('grey', [0.46, 0.06, 0.68], [-1.62, 0.32, s * 0.24],
        { rx: s * 42 * DEG, shade: 1.08 });
    }
    // sensor turret + antennas
    B.sph('optics', 0.15, [0.42, -0.20, 0], { scale: [1, 0.9, 1], shade: 1.25 });
    B.cyl('grey', 0.09, 0.11, 0.10, 10, [0.42, -0.12, 0], 'y', { shade: 1.0 });
    B.cyl('dark', 0.012, 0.03, 0.34, 6, [-0.30, -0.20, 0], 'y', { rz: 0, shade: 1.2 });
    B.box('dark', [0.16, 0.03, 0.03], [0.10, 0.24, 0], { shade: 1.2 });
    B.box('optics', [0.12, 0.08, 0.20], [0.72, 0.10, 0], { shade: 1.25 });
  });

  // Formation device on both upper wing surfaces (plan extruded 0.085 from
  // y 0.16, so the skin is at y 0.245). The recon bird orbits at 8.4 u and is
  // ALWAYS seen from above — this is the one marking the player actually reads.
  addDecals(lift, P, [
    { c: 'fac', p: [-0.02, 0.247, 1.05], f: 'y+', w: 0.34, h: 0.34 },
    { c: 'fac', p: [-0.02, 0.247, -1.05], f: 'y+', w: 0.34, h: 0.34 },
    // chord is only 0.40 wide out at |z| = 1.62, so this one is pulled forward
    { c: 'num', p: [0.06, 0.247, 1.62], f: 'y+', w: 0.30, h: 0.18 },
  ]);

  // nose prop: hub rolled so VFX's local-Y spin becomes thrust-axis spin
  const props = node(lift, 'props', 1.31, 0.0, 0);
  props.rotation.z = -Math.PI / 2;
  rotor(props, P, 'recon:rotor', 0.44, 2);
}

// ---------------------------------------------------------------- ROUND-7: helo
// Attack helicopter. The read has to survive at RTS zoom with no counter, from
// a 38°-down camera ~115 u out, so the silhouette is built out of the four cues
// that say "helicopter" before any detail resolves:
//   1. a 6.4 u main rotor DISC — by far the widest thing on the model, and the
//      only spinning translucent plane in the roster;
//   2. a long thin tail boom ending in a VERTICAL disc (the tail rotor);
//   3. stub wings hung with fat pylon stores, which is what separates a gunship
//      from a transport at a glance;
//   4. skids, i.e. no wheels and no tracks — nothing else in the roster has
//      that, so it reads as an aircraft even in silhouette.
// Everything is parented under 'lift', exactly like the recon UAV: groundModel()
// skips 'lift' sub-trees, so the model keeps its hover altitude and the contact
// shadow (added on the root afterwards) stays on the dirt underneath it.
function modelHelo(root, P) {
  const lift = node(root, 'lift', 0, 5.10, 0);
  // Nose-down attitude. A helicopter in level flight is pitched forward, and
  // 5° is the cheapest possible way to say "this is flying" instead of "this is
  // parked in the air".
  lift.rotation.z = -5 * DEG;

  part(lift, 'helo:body', P, AO(-1.5, 1.3, 0.66), (B) => {
    // ---- fuselage pod: side profile (x = length, y = height), extruded across Z
    B.side('armor', [
      [-1.62, -0.28], [-0.30, -0.60], [1.40, -0.62], [2.16, -0.34],
      [2.42, 0.02], [2.06, 0.34], [0.90, 0.60], [-0.55, 0.66], [-1.62, 0.40],
    ], 1.16, [0, 0, 0], { shade: 0.96 });
    // nose cap + chin fairing under the sensor turret
    B.cone('armor', 0.30, 0.42, 10, [2.60, 0.02, 0], 'x', { shade: 1.04 });
    B.box('armor', [0.90, 0.30, 0.74], [1.86, -0.52, 0], { rz: 0.10, shade: 0.92 });

    // ---- tandem cockpit: gunner low and forward, pilot stepped up behind.
    // Two separate glass boxes rather than one canopy — the step between them
    // is the classic gunship profile and it survives to a dozen pixels.
    B.box('optics', [0.86, 0.34, 0.90], [1.66, 0.42, 0], { rz: -0.16, shade: 1.28 });
    B.box('optics', [0.90, 0.40, 0.98], [0.72, 0.66, 0], { rz: -0.06, shade: 1.24 });
    B.box('dark', [0.10, 0.30, 0.96], [1.19, 0.56, 0], { shade: 1.05 });
    B.box('armor', [0.16, 0.26, 1.02], [0.24, 0.76, 0], { shade: 1.02 });

    // ---- engine deck + exhaust suppressors either side of the mast
    for (const s of [-1, 1]) {
      B.cyl('dark', 0.30, 0.32, 1.30, 10, [-0.62, 0.62, s * 0.44], 'x',
        { shade: 0.94, tint: HEAT });
      B.cyl('dark', 0.20, 0.26, 0.34, 8, [-1.34, 0.66, s * 0.44], 'x',
        { rz: 0.22, shade: 0.82, tint: HEAT });
      // intake screen, forward of the nacelle
      B.box('dark', [0.14, 0.30, 0.34], [0.06, 0.66, s * 0.44], { shade: 1.12 });
    }
    // mast fairing + swashplate stack
    B.cyl('armor', 0.26, 0.34, 0.34, 10, [0.02, 0.86, 0], 'y', { shade: 1.06 });
    B.cyl('dark', 0.14, 0.14, 0.30, 8, [0.02, 1.06, 0], 'y', { shade: 1.18 });
    B.cyl('dark', 0.22, 0.22, 0.07, 10, [0.02, 1.10, 0], 'y', { shade: 1.24 });

    // ---- tail boom, fin, stabiliser, tail gearbox
    B.cyl('armor', 0.13, 0.21, 1.90, 10, [-2.55, 0.20, 0], 'x', { shade: 1.0 });
    B.side('armor', [
      [-3.62, 0.10], [-3.02, 0.06], [-2.86, 0.72], [-3.30, 1.04], [-3.66, 0.92],
    ], 0.20, [0, 0, 0], { shade: 1.08 });
    // ventral fin — stops the boom reading as a floating stick
    B.side('armor', [
      [-3.46, -0.44], [-2.94, 0.04], [-3.50, 0.06],
    ], 0.16, [0, 0, 0], { shade: 0.94 });
    B.box('armor', [0.52, 0.09, 1.66], [-2.86, 0.30, 0], { shade: 1.10 });
    for (const s of [-1, 1]) {
      B.box('armor', [0.30, 0.34, 0.07], [-2.90, 0.44, s * 0.80], { shade: 1.04 });
    }
    B.box('dark', [0.34, 0.36, 0.30], [-3.30, 0.60, 0.16], { shade: 1.12 });

    // ---- stub wings + stores. The pylons are the "gunship" tell, so they are
    // deliberately chunky: a quad ATGM box outboard, a rocket pod inboard.
    for (const s of [-1, 1]) {
      // B.plan extrudes upward and maps the outline's lateral axis to −Z, so the
      // s = +1 wing is the one that needs the yaw flip, not the s = −1 one.
      B.plan('armor', [
        [0.62, 0.56], [0.62, 1.72], [-0.52, 1.66], [-0.72, 0.56],
      ], 0.16, [0, 0.02, 0], { ry: s > 0 ? Math.PI : 0, shade: 1.06 });
      B.box('armor', [0.30, 0.34, 0.22], [0.05, -0.10, s * 1.62], { shade: 1.0 });
      B.box('armor', [0.26, 0.30, 0.20], [0.02, -0.08, s * 0.98], { shade: 1.0 });
      // outboard: four-round ATGM launcher. The tubes are 0.20 longer than the
      // box on purpose — four dark muzzle circles standing proud of the end
      // face are the difference between "missile launcher" and "grey crate".
      B.box('dark', [1.06, 0.46, 0.46], [0.10, -0.34, s * 1.58], { shade: 1.02 });
      for (const dy of [-0.46, -0.22]) {
        for (const dz of [-0.11, 0.11]) {
          B.cyl('dgrey', 0.095, 0.095, 1.26, 8, [0.10, dy, s * 1.58 + dz], 'x',
            { shade: 1.14 });
        }
      }
      // inboard: rocket pod
      B.cyl('dark', 0.27, 0.27, 1.16, 12, [0.06, -0.30, s * 0.98], 'x', { shade: 0.96 });
      B.cyl('dgrey', 0.22, 0.22, 0.10, 12, [0.66, -0.30, s * 0.98], 'x', { shade: 1.2 });
      B.cone('dark', 0.27, 0.22, 12, [-0.58, -0.30, s * 0.98], 'x',
        { ry: Math.PI, shade: 1.05 });

      // ---- skids: two longitudinal tubes on splayed struts
      B.cyl('dgrey', 0.085, 0.085, 2.90, 8, [-0.05, -1.24, s * 0.86], 'x', { shade: 1.06 });
      B.cyl('dgrey', 0.085, 0.085, 0.30, 8, [1.48, -1.16, s * 0.86], 'x',
        { rz: 0.55, shade: 1.06 });
      B.strut('dgrey', [0.80, -0.60, s * 0.44], [0.86, -1.22, s * 0.86], 0.075, 6,
        { shade: 1.02 });
      B.strut('dgrey', [-0.86, -0.58, s * 0.44], [-0.92, -1.22, s * 0.86], 0.075, 6,
        { shade: 1.02 });
      // navigation light blister + a whip on the boom
      B.box('optics', [0.14, 0.10, 0.10], [0.60, -0.04, s * 1.74], { shade: 1.3 });
    }
    B.cyl('dark', 0.02, 0.03, 0.66, 6, [-2.30, 0.44, -0.22], 'y', { rz: -0.16, shade: 1.2 });
    B.box('optics', [0.16, 0.12, 0.12], [-3.66, 0.98, 0], { shade: 1.3 });
  });

  // Faction devices go on the tail boom flanks and on the fuselage spine. The
  // spine one is the one that matters: the RTS camera looks DOWN at this unit,
  // and the rotor blur disc is depthWrite:false, so it reads straight through.
  addDecals(lift, P, [
    { c: 'fac', p: [-2.30, 0.24, 0.30], w: 0.40, h: 0.40, mirror: true },
    { c: 'num', p: [-1.30, 0.16, 0.52], w: 0.44, h: 0.24, mirror: true },
    { c: 'fac', p: [-0.30, 0.70, 0.0], f: 'y+', w: 0.52, h: 0.52 },
    { c: DECAL_HAZARD, p: [1.10, -0.56, 0.42], w: 0.22, h: 0.22, mirror: true },
  ]);

  // ---- rotors. Contract: fx/vfx.js spins every CHILD of 'props' about that
  // child's own local Y. The main rotor is child 0 (38 rad/s) and the tail rotor
  // is child 1 (41 rad/s); the tail hub carries rx = +90° so its own local Y
  // points along the aircraft's Z and the disc stands on edge. Euler order XYZ
  // means the spin (Y) is applied INSIDE the tilt (X), so the disc keeps
  // spinning in its own plane instead of tumbling.
  const props = node(lift, 'props', 0.02, 1.16, 0);
  rotor(props, P, 'helo:rotor', 3.20, 4);
  const tail = rotor(props, P, 'helo:tailrotor', 0.62, 3);
  tail.position.set(-3.32, -0.56, 0.30);
  tail.rotation.x = Math.PI / 2;

  // ---- chin turret + gun, so muzzle flash / recoil hook up like every other
  // unit ('barrel' sits forward of its parent origin, per the file header).
  const turret = node(lift, 'turret', 1.98, -0.72, 0);
  part(turret, 'helo:turret', P, AO(-0.9, 0.5, 0.7, -0.72), (B) => {
    B.cyl('armor', 0.28, 0.30, 0.26, 12, [0, 0.10, 0], 'y', { shade: 1.04 });
    B.box('armor', [0.44, 0.34, 0.46], [0.02, -0.10, 0], { shade: 1.0 });
    B.sph('optics', 0.19, [-0.14, -0.06, 0], { scale: [1, 0.92, 1], shade: 1.28 });
    B.box('dark', [0.16, 0.14, 0.30], [0.10, -0.24, 0], { shade: 1.1 });
  });
  const barrel = node(turret, 'barrel', 0.34, -0.12, 0);
  part(barrel, 'helo:gun', P, AO(-0.9, 0.4, 1, -0.84), (B) => {
    B.cyl('dark', 0.075, 0.085, 0.86, 8, [0.20, 0, 0], 'x', { shade: 1.12 });
    B.cyl('dgrey', 0.10, 0.10, 0.12, 8, [0.60, 0, 0], 'x', { shade: 1.2 });
    B.box('dark', [0.22, 0.18, 0.22], [-0.16, 0.02, 0], { shade: 1.05 });
  });
}

function modelLoiter(root, P) {
  part(root, 'loiter:launcher', P, AO(0.0, 3.2, 0.46), (B) => {
    B.box('armor', [5.30, 0.30, 1.76], [-0.15, 0.80, 0], { shade: 0.88 });
    B.side('armor', [
      [0.95, 0.92], [2.55, 0.92], [2.86, 1.24], [2.86, 1.88], [2.26, 2.28], [0.95, 2.28],
    ], 2.08, [0, 0, 0]);
    B.box('optics', [0.08, 0.56, 1.82], [2.58, 1.88, 0], { rz: 0.60, shade: 1.3 });
    for (const s of [-1, 1]) {
      B.box('optics', [0.52, 0.38, 0.05], [1.72, 1.82, s * 1.05], { shade: 1.25 });
      B.cyl('optics', 0.12, 0.12, 0.10, 10, [2.84, 1.22, s * 0.70], 'x', { shade: 1.3 });
      B.box('armor', [0.28, 0.54, 0.28], [-2.66, 0.56, s * 0.94], { shade: 0.92 });
      B.box('dark', [0.40, 0.12, 0.40], [-2.66, 0.24, s * 0.94], { shade: 1.0 });
      B.box('armor', [1.10, 0.10, 0.50], [-1.30, 1.08, s * 1.16], { shade: 1.05 });
    }
    B.box('dark', [0.28, 0.32, 1.86], [2.92, 1.06, 0], { shade: 1.05 });
    addWheels(B, [1.95, -1.35, -2.30], 1.18, 0.56, 0.42, { dual: [-1.35, -2.30] });
    // launch deck + hydraulic ram + rail cradle
    B.box('armor', [3.40, 0.16, 2.00], [-1.10, 1.02, 0], { shade: 0.96 });
    B.cyl('armor', 0.62, 0.66, 0.16, 14, [-1.55, 1.14, 0], 'y', { shade: 1.06 });
    B.strut('dark', [-0.20, 1.10, 0.62], [-1.10, 2.05, 0.62], 0.09, 8, { shade: 1.1 });
    B.strut('dark', [-0.20, 1.10, -0.62], [-1.10, 2.05, -0.62], 0.09, 8, { shade: 1.1 });
    // covered spare rounds
    B.box('canvas', [1.70, 0.66, 1.70], [-2.15, 1.52, 0], { shade: 0.95 });
    for (let i = 0; i < 3; i++) {
      B.box('canvas', [0.06, 0.68, 1.74], [-2.75 + i * 0.60, 1.52, 0], { shade: 1.05 });
    }
    // ROUND-2 FIX 2: the battery had neither a whip nor loose stowage
    addAntenna(B, 1.05, 2.28, -0.86, 1.50, -0.06);
    addJerrycans(B, 0.40, 1.32, 0.72, 2);
  });

  addDecals(root, P, [
    { c: 'num', p: [1.60, 1.42, 1.045], w: 0.50, h: 0.28, mirror: true },
    { c: 'fac', p: [-1.85, 1.55, 0.855], w: 0.40, h: 0.40, mirror: true },
    { c: DECAL_HAZARD, p: [-2.45, 1.55, 0.855], w: 0.26, h: 0.26, mirror: true },
    // launch deck (top y 1.10) forward of the turntable, which ends at x −0.89
    { c: DECAL_PANEL, p: [0.25, 1.105, 0.55], f: 'y+', w: 0.34, h: 0.24 },
  ]);

  // launch rail (traversable) with the round on it
  const turret = node(root, 'turret', -1.55, 1.42, 0);
  turret.rotation.z = 30 * DEG;
  part(turret, 'loiter:rail', P, AO(0, 3.4, 0.5, 1.42), (B) => {
    for (const s of [-1, 1]) {
      B.box('armor', [3.30, 0.14, 0.16], [1.05, 0.02, s * 0.34], { shade: 1.02 });
      B.box('dark', [3.30, 0.06, 0.06], [1.05, 0.12, s * 0.34], { shade: 1.15 });
    }
    for (let i = 0; i < 4; i++) {
      B.box('armor', [0.12, 0.20, 0.84], [-0.30 + i * 0.90, 0.0, 0], { shade: 0.96 });
    }
    B.box('armor', [0.42, 0.36, 0.80], [-0.60, 0.06, 0], { shade: 1.0 });
    B.box('dark', [0.20, 0.24, 0.30], [-0.80, 0.20, 0.44], { shade: 1.1 });
  });

  // the delta-wing round itself (named 'barrel' so launch FX fire from the rail)
  const round = node(turret, 'barrel', 1.10, 0.34, 0);
  part(round, 'loiter:round', P, AO(0, 1, 1), (B) => {
    // fuselage
    B.side('dgrey', [
      [-1.05, -0.13], [0.72, -0.15], [1.02, -0.05], [1.06, 0.06], [0.72, 0.17], [-1.05, 0.13],
    ], 0.30, [0, 0, 0], { shade: 1.0 });
    B.cone('dgrey', 0.145, 0.30, 12, [1.20, 0.0, 0], 'x', { shade: 1.05 });
    B.sph('optics', 0.10, [1.30, -0.02, 0], { scale: [0.8, 1, 1], shade: 1.25 });
    // swept delta wing + winglets
    B.plan('dgrey', [
      [0.80, 0], [-0.28, -1.16], [-0.90, -1.16], [-0.90, 1.16], [-0.28, 1.16],
    ], 0.10, [0, 0.03, 0], { shade: 1.14 });
    for (const s of [-1, 1]) {
      B.box('dgrey', [0.56, 0.34, 0.07], [-0.60, 0.20, s * 1.13], { rx: s * -0.16, shade: 1.06 });
      B.box('dgrey', [0.34, 0.06, 0.26], [-0.20, 0.11, s * 0.62], { shade: 0.95 });
    }
    // warhead band + hardware
    B.cyl('dark', 0.155, 0.155, 0.34, 12, [0.55, 0.0, 0], 'x', { shade: 0.9 });
    B.box('dark', [0.22, 0.10, 0.20], [-0.55, 0.18, 0], { shade: 1.1 });
    B.cyl('dark', 0.012, 0.03, 0.26, 6, [-0.30, 0.24, 0], 'y', { shade: 1.2 });
    // pusher engine nacelle
    B.cyl('dgrey', 0.13, 0.15, 0.36, 10, [-1.18, 0.02, 0], 'x', { shade: 1.0 });
  });

  // ROUND-2 FIX 2: the round on the rail is the object the player looks at from
  // directly above for the whole loiter order, and it was completely unmarked.
  // The delta's upper surface sits at y = 0.13 (plan extruded 0.10 from y 0.03).
  addDecals(round, P, [
    { c: 'num', p: [-0.20, 0.132, 0.60], f: 'y+', w: 0.34, h: 0.20 },
    { c: 'fac', p: [-0.28, 0.132, -0.62], f: 'y+', w: 0.30, h: 0.30 },
  ]);

  const props = node(round, 'props', -1.42, 0.02, 0);
  props.rotation.z = -Math.PI / 2;
  rotor(props, P, 'loiter:rotor', 0.40, 2);
}

// ------------------------------------------------------------------ registry

const BUILDERS = {
  mbt: modelMBT,
  ifv: modelIFV,
  apc: modelAPC,
  spg: modelSPG,
  mlrs: modelMLRS,
  aa: modelAA,
  sam: modelSAM,
  helo: modelHelo,
  ew: modelEW,
  infantry: modelInfantry,
  atgm_team: modelATGM,
  truck: modelTruck,
  fpv_drone: modelFPV,
  recon_drone: modelReconDrone,
  loiter_munition: modelLoiter,
};

// Approximate model height (world units) — handy for HUD/VFX anchoring.
// `helo` is measured from the GROUND, not from the airframe: the hover node
// sits at 5.10 and the rotor plane 1.16 above that, so a counter anchored at
// 6.9 floats just clear of the disc instead of inside it.
const HEIGHTS = {
  mbt: 4.0, ifv: 3.8, apc: 3.7, spg: 4.2, mlrs: 3.2, aa: 3.8, sam: 5.4,
  helo: 6.9, ew: 7.4,
  infantry: 1.5, atgm_team: 1.3, truck: 3.7, fpv_drone: 2.9,
  recon_drone: 9.1, loiter_munition: 3.3,
};

let _seq = 0;
const _warned = new Set();

function hashId(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function build(typeId, faction, ghost) {
  const fac = faction === 'red' ? 'red' : 'blue';
  const fn = BUILDERS[typeId] || BUILDERS.mbt;
  // deterministic per-instance jitter (seeded, so a scenario looks identical on reload)
  const r = rng((hashId(`${typeId}|${fac}`) + Math.imul(_seq++, 2654435761)) >>> 0);
  const P = ghost ? ghostPalette() : makePalette(fac, r);

  const g = new THREE.Group();
  g.name = `unit-${typeId}`;
  try {
    fn(g, P);
  } catch (err) {
    // never let a model bug take down the boot — fall back to a legible block
    if (!_warned.has(typeId)) {
      _warned.add(typeId);
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[models] ${typeId} build failed, using fallback:`, err);
      }
    }
    part(g, 'fallback:block', P, AO(0, 2, 0.5), (B) => {
      B.box('armor', [4.0, 1.2, 2.4], [0, 0.9, 0], {});
      B.box('dark', [1.6, 0.6, 1.4], [0.3, 1.8, 0], {});
    });
  }
  // CRITIQUE FIX 4 — measure, then ground, THEN lay the decal (so the decal is
  // never itself part of the measurement and never gets shifted by it).
  const drop = groundModel(g);
  addContactShadow(g, typeId, P);
  g.userData.typeId = typeId;
  g.userData.faction = fac;
  g.userData.ghost = !!ghost;
  g.userData.height = (HEIGHTS[typeId] || 2.6) - drop;
  g.userData.groundDrop = drop;
  g.userData.bounce = 0;
  g.userData.turret = g.getObjectByName('turret') || null;
  g.userData.barrel = g.getObjectByName('barrel') || null;
  g.userData.props = g.getObjectByName('props') || null;
  return g;
}

// ------------------------------------------------------------------ exports

export function buildUnitMesh(typeId, faction) {
  return build(typeId, faction, false);
}

// ---------------------------------------------------------------------------
// ROUND-6 FIX 11 SUPPORT — exported for `js/world/features.js`.
//
// Fix 11 (the pylon / lattice UV and world-scale defect) is NOT in this file:
// `BUILDERS` covers units only, and every pylon, mast, catwalk, gantry, fence
// and yard pole named by the critique is built in `js/world/features.js` on
// `M.lattice`. That was established in round 5 (see INTEGRATION_NOTES) and it
// is still true — this pass re-verified it against the current file.
//
// What round 5 handed over was a 30-line function to PORT, and it was dropped.
// So this round hands over an IMPORT instead. Both helpers below are the exact
// code that has shipped on every vehicle in this game since round 2; neither
// touches anything in this module, and nothing here calls them.
//
//   import { worldProjectUV, bakeMemberValue } from '../units/models.js';
//
// See INTEGRATION_NOTES (round 6, models pass) for the per-call-site list.

// Box-project UVs at a fixed repeats-per-world-unit, so a 15 u pylon leg and a
// 0.45 u flange sample the galvanised tile at the SAME texel density. This is
// the whole of fix 11's first half: `partBox()` hands every face a 0..1 UV
// regardless of that face's world size, so a leg currently gets 569 texels/u
// across and 17 texels/u along — a 33:1 anisotropy that the mip chain resolves
// to the tile's own mean, which is `0x8A8F8C`, which is the "pale grey stick"
// the critique photographed.
//
// Suggested scale for lattice steel: 0.55 repeats/u (tile ≈ 1.8 u, bolt heads
// land near 4 cm). Vehicles here use 0.34 for hull plate.
//
// Input must be non-indexed — this converts if it is not — and the axis is
// picked from the FACE normal, not the vertex normal, so the mapping stays
// affine across each triangle. That is load-bearing: without a tangent
// attribute three derives the tangent frame from screen-space UV derivatives,
// and a non-affine triangle hands the normal map a garbage frame.
export function worldProjectUV(geometry, scale) {
  let g = geometry;
  if (!g || !g.attributes || !g.attributes.position) return g;
  if (g.index) g = g.toNonIndexed();
  if (!g.attributes.normal) g.computeVertexNormals();
  projectUV(g, scale || 0.55);
  return g;
}

// Per-member VALUE variation — fix 11's second half, and the half that survives
// minification. A texture cannot save a 3 px member; only the member's own mean
// can differ from its neighbour's. Call this on each member geometry BEFORE the
// merge, then render with a material that has `vertexColors: true`.
//
// opts: { seed (number, drives the ±16 % member multiplier)
//       , y0, y1 (world Y band for the gradient; default 0 .. 15)
//       , rust (true ⇒ warm bias × [1.14, 0.94, 0.78]; feed it from the seed on
//               ~25 % of members)
//       , dirt (bottom-of-member darkening, default 0.22) }
//
// FOOTGUN, and it will produce BLACK towers if missed: do not simply set
// `vertexColors: true` on `M.lattice`. That material is shared with plain
// `G.box` / `G.cyl8` meshes that carry no `color` attribute; three declares
// `USE_COLOR` and the disabled attribute reads back as (0,0,0), multiplying
// those meshes to black. Add a separate `M.latticeVC` (a clone with
// `vertexColors: true`) and use it only on geometry that carries the attribute.
// SECOND FOOTGUN: `mergeGeos()` in features.js (line ~1406) copies position /
// normal / uv only — it drops `color`. It needs the same three lines
// `models.js:mergeGeos` has, or the attribute is thrown away at merge time.
export function bakeMemberValue(geometry, opts) {
  const g = geometry;
  if (!g || !g.attributes || !g.attributes.position) return g;
  const o = opts || {};
  const p = g.attributes.position;
  const n = p.count;
  const y0 = o.y0 == null ? 0 : o.y0;
  const y1 = o.y1 == null ? 15 : o.y1;
  const span = (y1 - y0) || 1;
  const dirt = o.dirt == null ? 0.22 : o.dirt;
  // hash the seed to a stable ±16 % multiplier
  let h = Math.imul((o.seed | 0) ^ 0x9E3779B9, 2654435761) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  const v = 0.84 + 0.32 * ((h & 0xFFFF) / 0xFFFF);
  const rr = o.rust ? 1.14 : 1;
  const rg = o.rust ? 0.94 : 1;
  const rb = o.rust ? 0.78 : 1;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let t = (p.getY(i) - y0) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    // splash dirt low, rain-washed zinc high — a vertical ramp is the one
    // gradient a 3 px member can still show, because it runs along its length
    const f = v * (1 - dirt + dirt * (0.35 + 0.85 * t));
    col[i * 3] = clamp(f * rr, 0, 1);
    col[i * 3 + 1] = clamp(f * rg, 0, 1);
    col[i * 3 + 2] = clamp(f * rb, 0, 1);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export function buildGhostMesh(typeId) {
  const g = build(typeId, 'blue', true);
  g.name = `ghost-${typeId}`;
  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.renderOrder = 1;
    }
  });
  return g;
}
