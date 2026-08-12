// STEEL SIGNAL — game/fog.js
// Fog of war: per-unit spotting with line of sight, hill bonus, forest blocking,
// recon-drone reveal and EW blinding (GAMEPLAY.md §4.1–§4.2).
//
// Two visibility sets are maintained, one per faction:
//   • `isVisible(hex)` answers for the side whose turn it is (ARCHITECTURE
//     contract) — that is what ai.js and combat.js need (RED must fire on what
//     RED can see, BLUE on what BLUE can see).
//   • Mesh visibility ALWAYS follows the BLUE set, so the player never watches
//     enemy units pop in during the RED phase.
//
// Contract exports: initFog(Game, terrain), isVisible(hex).
// Extra exports (see INTEGRATION_NOTES.md): refreshFog(), isVisibleTo(hex, side),
// visibleHexes(side), sightOf(unit).

import { hexDistance } from '../world/terrain.js';

const EW_RADIUS = 2;              // GAMEPLAY.md §9
const DEFAULT_HILL_THRESHOLD = 2.2;

let G = null;
let T = null;
let inited = false;
let hillThreshold = DEFAULT_HILL_THRESHOLD;

const sets = { blue: new Set(), red: new Set() };

const key = (h) => `${h.q},${h.r}`;

// ---------------------------------------------------------------------------
// Hex helpers (cube space)
// ---------------------------------------------------------------------------
function cubeRound(x, y, z) {
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const dx = Math.abs(rx - x);
  const dy = Math.abs(ry - y);
  const dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

// Contiguous hex line from a to b (inclusive of both ends).
function hexLine(a, b) {
  const n = hexDistance(a, b);
  if (n === 0) return [{ q: a.q, r: a.r }];
  const ax = a.q;
  const az = a.r;
  const ay = -ax - az;
  const bx = b.q;
  const bz = b.r;
  const by = -bx - bz;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // epsilons break coordinate ties consistently; they sum to zero so the
    // sample never leaves the cube plane
    out.push(cubeRound(
      ax + (bx - ax) * t + 1e-6,
      ay + (by - ay) * t + 1e-6,
      az + (bz - az) * t - 2e-6));
  }
  return out;
}

function tileAt(hex) {
  if (!T || !T.tiles) return null;
  return T.tiles.get(key(hex)) || null;
}

function isHill(hex) {
  const t = tileAt(hex);
  return !!t && (t.height || 0) >= hillThreshold;
}

// Forest blocks sight THROUGH a hex, never INTO it (GAMEPLAY.md §4.1).
function blocksSight(hex) {
  const t = tileAt(hex);
  return !!t && t.type === 'forest';
}

function hasTrait(u, trait) {
  return !!(u && u.type && Array.isArray(u.type.traits) &&
    u.type.traits.includes(trait));
}

// An enemy jammer within radius 2 blinds a recon drone down to sight 1 (§4.2).
function jammedBy(unit) {
  if (!G || !Array.isArray(G.units)) return false;
  return G.units.some((e) =>
    e.alive && e.faction !== unit.faction && hasTrait(e, 'jammer') &&
    hexDistance(e.hex, unit.hex) <= EW_RADIUS);
}

export function sightOf(unit) {
  let s = (unit.type && unit.type.sight) || 0;
  if (s <= 0) return 0;
  if (isHill(unit.hex)) s += 1;
  if (hasTrait(unit, 'recon') && jammedBy(unit)) s = 1;
  return s;
}

// ---------------------------------------------------------------------------
// Visibility computation
// ---------------------------------------------------------------------------
function seesFrom(origin, target) {
  const d = hexDistance(origin, target);
  if (d <= 1) return true;
  const line = hexLine(origin, target);
  for (let i = 1; i < line.length - 1; i++) {
    if (blocksSight(line[i])) return false;
  }
  return true;
}

function computeSide(side) {
  const out = new Set();
  if (!G || !Array.isArray(G.units)) return out;
  for (const u of G.units) {
    if (!u.alive || u.faction !== side || !u.hex) continue;
    out.add(key(u.hex));
    const r = sightOf(u);
    if (r <= 0) continue;
    for (let dq = -r; dq <= r; dq++) {
      const lo = Math.max(-r, -dq - r);
      const hi = Math.min(r, -dq + r);
      for (let dr = lo; dr <= hi; dr++) {
        const h = { q: u.hex.q + dq, r: u.hex.r + dr };
        const k = `${h.q},${h.r}`;
        if (out.has(k)) continue;
        if (T && T.tiles && !T.tiles.has(k)) continue;
        if (seesFrom(u.hex, h)) out.add(k);
      }
    }
  }
  return out;
}

function applyMeshVisibility() {
  if (!G || !Array.isArray(G.units)) return;
  for (const u of G.units) {
    if (!u.mesh) continue;
    if (!u.alive) { u.mesh.visible = false; continue; }
    u.mesh.visible = u.faction === 'blue' ? true : sets.blue.has(key(u.hex));
  }
}

/** Recompute both factions' visible sets and re-apply enemy mesh visibility. */
export function refreshFog() {
  if (!inited) return;
  sets.blue = computeSide('blue');
  sets.red = computeSide('red');
  applyMeshVisibility();
}

// ---------------------------------------------------------------------------
// Contract API
// ---------------------------------------------------------------------------
export function initFog(Game, terrain) {
  G = Game || null;
  T = terrain || null;
  if (!G) return;

  const scenario = (G.deps && G.deps.scenario) || null;
  hillThreshold = (scenario && typeof scenario.hillThreshold === 'number')
    ? scenario.hillThreshold : DEFAULT_HILL_THRESHOLD;

  if (!inited) {
    inited = true;
    // state.js also calls refreshFog() mid-animation; these keep fog honest
    // even if some other module moves or removes a unit on its own.
    G.on('unitMoved', () => refreshFog());
    G.on('unitKilled', () => refreshFog());
    G.on('turnStarted', () => refreshFog());
    G.on('unitDeployed', () => refreshFog());
  }
  refreshFog();
}

/** Visible to the side currently acting (ARCHITECTURE contract). */
export function isVisible(hex) {
  if (!inited || !hex) return true;
  const side = (G && G.side === 'red') ? 'red' : 'blue';
  return sets[side].has(key(hex));
}

/** Visible to a named faction — used by state.js for ZOC and target lists. */
export function isVisibleTo(hex, side) {
  if (!inited || !hex) return true;
  const s = side === 'red' ? 'red' : 'blue';
  return sets[s].has(key(hex));
}

/** Read-only copy of a faction's visible hex-key set. */
export function visibleHexes(side) {
  const s = side === 'red' ? 'red' : 'blue';
  return new Set(sets[s]);
}
