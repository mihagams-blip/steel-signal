// STEEL SIGNAL — game/ai.js
// RED utility AI per GAMEPLAY.md §7. Initiative order: artillery → drones →
// AA/EW/recon → combat units. Each unit picks the highest-priority action it
// qualifies for; every unit is wrapped in try/catch and the turn ALWAYS
// resolves (contract requirement).
//
// Contract export: async function runAITurn(Game).
//
// CRITIQUE ROUND 2, fixes 19 + 20 — "the opponent is not there".
// The old build emitted ONE generic sentence ("RED command holds the line.")
// and, in defend posture, moved nothing: garrisons were pinned by an early-out
// in tryAdvance, the batteries could not reach anything so they never fired,
// and END TURN handed control straight back with no camera event. Four turns of
// that read as a broken opponent. This module now guarantees, every RED phase:
//
//   (a) at least one REPOSITION inside RED's own defensive zone — rotateTheLine
//       with taste, then insistOnMovement with teeth if taste found nothing
//   (b) every battery either FIRES (spotted target → fire mission onto a
//       remembered contact → registration/interdiction of the approach to the
//       crossing) or DISPLACES to a firing position that covers the threatened
//       crossing (shoot-and-scoot). Never onto RED's own infrastructure.
//   (c) a PATROL LEG for anything with eyes — recon UAV if the order of battle
//       has one, otherwise the FPV team, which creeps its 4-hex envelope onto
//       the gate and then works the same circuit a UAV would
//   (d) SPECIFIC log lines built from the map's own place names
//       ("RED MLRS displaces to the Zoria treeline.",
//        "RED counter-battery mission on grid 7·6.") — never one generic line,
//       and never the same sentence twice in one phase.
//
// And it presents the phase: the camera pans to any RED action BLUE can
// actually see, holds a beat on it, and the phase is padded so that even a
// silent RED turn is felt (main.js draws the RED PHASE banner over the top).
// Nothing here ever leaks information the player has not earned: an action
// outside BLUE's vision produces at most a coarse SIGINT line, never a grid.
//
// Combat resolution goes through the Game wrappers when they exist (they run
// state.js's post-action pass: fog, capture, sudden-defeat) and falls back to
// combat.js — the authoritative resolver, which spends ammo, sets `fired` and
// emits unitAttacked/unitKilled/log itself.
//
// PLAYER-FEEDBACK ROUND — "the specialty of the Russian front is drone war,
// not tanks… I expected more of that dynamic." RED now fights drones-first:
//
//   • Eyes fly BEFORE the guns pick targets (recon UAV — if the OOB has one —
//     has initiative 0 and, with no contact, pushes its circuit over the water
//     onto the far-bank approaches until it FINDS the player). Everything is
//     type-generic: whatever recon/FPV/loiter units the scenario gives RED are
//     used; no unit ids are hard-coded.
//   • Move and fire are separate actions (the same rule the player has), and
//     RED finally uses both: an FPV team that creeps into range STRIKES from
//     the new launch point the same phase; a battery that had to displace to
//     reach the approach FIRES from the new position. A RED FPV strike runs
//     the same full dronecam the player's own strikes get (combat.js plays it
//     faction-agnostically) — GAMEPLAY §8 T3's "dronecam moment happens TO
//     you" is this code path.
//   • Strike teams and batteries that shoot dry fall back on the supply column
//     and go firm beside it to re-arm (state.js's §3.1 supply tick), so the
//     drone pressure is sustained, not a two-round cameo.
//   • Pre-contact, one battery per phase registers defensive fires on the
//     deploy-road chokepoint west of the crossing (§7.3 blind fire, comms
//     tower alive) — weak by design, but the player SEES rounds landing on
//     the road they are about to use.
//   • EW/SHORAD rules are respected via previewAttack (abort/intercept odds
//     folded into the EV). A strike whose discounted EV clears the bar still
//     flies INTO the player's SHORAD umbrella and sometimes dies there — that
//     attrition trade is the drone war, not a bug to route around.
//   • Failures are LOUD: every swallowed exception now prints console.error
//     AND a comms-log line, so a systematically broken RED can never again
//     present as four turns of polite silence.

import { hexDistance, hexToWorld, hexNeighbors } from '../world/terrain.js';
import { isVisible } from './fog.js';
import {
  resolveAttack, fpvStrike, loiterStrike, artilleryBarrage, previewAttack,
} from './combat.js';

// --------------------------------------------------------------- pacing knobs
const PAN_PRE_MS = 300;     // camera lead-in before a watched action plays
const MOVE_HOLD_MS = 240;   // beat after a watched move (the move itself reads)
const FIRE_HOLD_MS = 620;   // beat after a watched shot (shell arc + detonation)
const PHASE_TAIL_MS = 800;  // CRITIQUE 20: hold on the action before control returns
const MIN_PHASE_MS = 1150;  // even a silent RED phase has to be felt
const MAX_PANS = 6;         // never turn the turn into a camera tour
const PRESENT_BUDGET_MS = 4200; // after this, orders resolve without pans/holds

// --------------------------------------------------------------- AI constants
const RETURN_FIRE_WEIGHT = 0.7;   // §7.5 net-trade weighting
const FPV_MIN_EV = 2;             // §7.4 skip EW-covered strikes below this EV
const CONTACT_MEMORY_TURNS = 3;   // how long RED remembers a BLUE sighting
const HARASS_MEMORY_TURNS = 2;    // a fire mission onto a remembered position
const ZONE_RADIUS = 3;            // "its own defensive zone", in hexes
const MAX_ROTATIONS = 3;          // repositions per phase from the rotation pass
const INTEL_BUDGET = 3;           // SIGINT lines per phase for unseen activity
const HARASS_COOLDOWN = 2;        // turns between interdiction missions/battery
// A defending battery ranges the gate it expects the assault through BEFORE the
// assault arrives — that is what registration of defensive fires IS, and it is
// also what turns RED's opening turns from silence into rounds landing on the
// crossing the player has to use. Rationed hard: never the last rounds, never
// more than twice per battery for the whole scenario, one mission per phase.
const INTERDICT_FROM_TURN = 1;    // §8 T1 scripts shells on the road from RED's first phase
const MAX_INTERDICT_PER_BATTERY = 2;
// Which crossings count as "serving the threatened axis". Measured in the
// harness: with the old cap of 5 the FIRST contact (BLUE's recon UAV crossing
// the line) pulled the anchor 6+ hexes west of every gate and interdiction
// starved for the whole scenario — the anchor is where BLUE is, and BLUE is
// an approach march away from the span by definition. 9 keeps the far-flank
// crossing (14+ away in scenario01) excluded while the axis crossing stays in.
const INTERDICT_GATE_RADIUS = 9;
// Loitering rounds are the scenario's scarcest asset; a spotted target sitting
// on or beside a live crossing/chokepoint (§7: infrastructure-adjacent) is
// worth proportionally more of one.
const LOITER_CHOKE_MULT = 1.35;

const ARTY_IDS = ['spg', 'mlrs'];
const DRONE_STRIKE_IDS = ['fpv_drone', 'loiter_munition'];
const ARMOR_VALUE_IDS = new Set(['mbt', 'ifv', 'spg', 'mlrs', 'aa', 'apc']);
const COMBAT_IDS = new Set(['mbt', 'ifv', 'apc', 'infantry', 'atgm_team', 'aa']);

const hidden = () =>
  (typeof document !== 'undefined' && document.hidden === true);

// A hidden tab freezes rAF, so nothing we would be pacing is on screen anyway —
// waiting there just makes the turn take a minute for nobody. (Timers in a
// background tab are throttled to ≥1 s, which is exactly how a 16-unit RED turn
// used to look like a stall to an automated reviewer.)
const delay = (ms) => (ms > 0 && !hidden())
  ? new Promise((res) => { setTimeout(res, ms); })
  : Promise.resolve();

const now = () => ((typeof performance !== 'undefined' && performance.now)
  ? performance.now() : Date.now());

const hkey = (h) => `${h.q},${h.r}`;

// ---------------------------------------------------------------------------
// RED's memory. Module-level so it survives between phases; cleared when the
// turn counter moves backwards (a fresh scenario on the same page).
// ---------------------------------------------------------------------------
const MEM = {
  home: new Map(),      // red unit id → the hex it defends from
  recent: new Map(),    // red unit id → last few hexes (anti-oscillation)
  lastMove: new Map(),  // red unit id → turn it last repositioned
  lastHarass: new Map(),// battery id → turn it last fired an interdiction mission
  harassCount: new Map(),// battery id → interdiction missions fired this scenario
  patrol: new Map(),    // red unit id → { legs: [hex], i }
  contacts: new Map(),  // blue unit id → { hex, turn, unit }
  contactMade: false,   // RED has seen BLUE at least once this scenario
  groundContactMade: false, // …seen BLUE *ground* forces (a UAV is not an axis)
  lastTurn: 0,
};

function resetMemory() {
  MEM.home.clear();
  MEM.recent.clear();
  MEM.lastMove.clear();
  MEM.lastHarass.clear();
  MEM.harassCount.clear();
  MEM.patrol.clear();
  MEM.contacts.clear();
  MEM.contactMade = false;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function initiativeOf(u) {
  // Eyes up FIRST: the UAV's leg refreshes RED's fog before the guns pick
  // targets, so this phase's fire missions run on this phase's spotting. §7
  // groups recon with the drones; flying it at the head of the column is what
  // turns "drones first" from a sentence into a doctrine.
  if (u.typeId === 'recon_drone') return 0;
  if (ARTY_IDS.includes(u.typeId)) return 1;
  if (DRONE_STRIKE_IDS.includes(u.typeId)) return 2;
  if (u.typeId === 'aa' || u.typeId === 'ew') return 3;
  return 4;
}

/** Visible to the side that is currently acting (RED, during its own phase). */
function seen(hex) {
  try { return isVisible(hex) !== false; } catch (_) { return true; }
}

function redSees(Game, hex) {
  try { return Game.visibleTo(hex, 'red') !== false; } catch (_) { return seen(hex); }
}

function blueSees(Game, hex) {
  try { return Game.visibleTo(hex, 'blue') === true; } catch (_) { return false; }
}

function val(u) { return (u.type && u.type.cost) || 100; }

function traits(u) { return (u.type && u.type.traits) || []; }

function aliveOf(Game, faction) {
  return Game.units.filter((u) => u.alive && u.faction === faction);
}

function occupied(Game, hex) {
  return Game.units.some(
    (u) => u.alive && u.hex.q === hex.q && u.hex.r === hex.r);
}

function tileAt(Game, hex) {
  const terrain = Game.deps && Game.deps.terrain;
  if (!terrain || !terrain.tiles || !hex) return null;
  return terrain.tiles.get(hkey(hex)) || null;
}

function nearest(hex, list, keyFn) {
  let best = null;
  let bestD = Infinity;
  for (const item of list) {
    const h = keyFn ? keyFn(item) : item;
    if (!h) continue;
    const d = hexDistance(hex, h);
    if (d < bestD) { bestD = d; best = item; }
  }
  return best;
}

function centroid(units) {
  if (!units.length) return null;
  let q = 0, r = 0;
  for (const u of units) { q += u.hex.q; r += u.hex.r; }
  return { q: Math.round(q / units.length), r: Math.round(r / units.length) };
}

// Hexes adjacent to a visible armed BLUE unit exert ZOC on RED movement.
function inBlueZOC(Game, hex, blues) {
  return blues.some((b) =>
    seen(b.hex) && (b.type.range || 0) >= 1 &&
    hexDistance(b.hex, hex) === 1);
}

// ---------------------------------------------------------------------------
// Place names — CRITIQUE 19(d). Every log line is built from the map the player
// is looking at: settlement names, bridge names, treelines, then a grid ref in
// the same "GRID q·r" form the HUD uses.
// ---------------------------------------------------------------------------
const COMPASS = ['north', 'north-east', 'east', 'south-east',
  'south', 'south-west', 'west', 'north-west'];

let _idxSrc = null;
let _idx = null;

function placeIndex(Game) {
  const terrain = Game.deps && Game.deps.terrain;
  const layout = terrain && terrain.layout;
  if (!layout) return null;
  if (_idxSrc === layout && _idx) return _idx;
  const idx = {
    settle: new Map(), bridge: new Map(), forest: new Set(), centers: [],
  };
  for (const s of (layout.settlements || [])) {
    if (!s) continue;
    for (const h of (s.hexes || [])) idx.settle.set(hkey(h), s.name);
    if (s.center) idx.centers.push({ name: s.name, hex: s.center });
  }
  for (const b of (layout.bridges || [])) {
    if (!b) continue;
    for (const h of (b.hexes || [])) idx.bridge.set(hkey(h), b.name);
    if (b.anchor) idx.bridge.set(hkey(b.anchor), b.name);
  }
  for (const h of (layout.forest || [])) idx.forest.add(hkey(h));
  _idxSrc = layout;
  _idx = idx;
  return idx;
}

function gridOf(hex) { return `grid ${hex.q}·${hex.r}`; }

function bearing(from, to) {
  try {
    const a = hexToWorld(from.q, from.r);
    const b = hexToWorld(to.q, to.r);
    const ang = Math.atan2(b.x - a.x, -(b.z - a.z));   // 0 = north, + = east
    let i = Math.round(ang / (Math.PI / 4));
    i = ((i % 8) + 8) % 8;
    return COMPASS[i];
  } catch (_) { return 'beside'; }
}

function nearestCenter(idx, hex) {
  let best = null;
  let bd = Infinity;
  for (const c of idx.centers) {
    const d = hexDistance(c.hex, hex);
    if (d < bd) { bd = d; best = c; }
  }
  return best ? { name: best.name, hex: best.hex, d: bd } : null;
}

/** A human phrase for a hex: "Zoria", "the Zoria treeline", "east of Sokil". */
function placeOf(Game, hex) {
  if (!hex) return 'an unreported grid';
  const idx = placeIndex(Game);
  if (!idx) return gridOf(hex);
  const k = hkey(hex);
  if (idx.bridge.has(k)) return `the ${idx.bridge.get(k)}`;
  if (idx.settle.has(k)) return idx.settle.get(k);
  const near = nearestCenter(idx, hex);
  const tile = tileAt(Game, hex);
  const type = tile ? tile.type : null;
  if (type === 'forest' || idx.forest.has(k)) {
    return (near && near.d <= 7)
      ? `the ${near.name} treeline` : `the treeline at ${gridOf(hex)}`;
  }
  if (type === 'town' && near) return `the outskirts of ${near.name}`;
  if (near && near.d <= 2) return `the edge of ${near.name}`;
  if (near && near.d <= 8) {
    return type === 'road'
      ? `the ${bearing(near.hex, hex)} road into ${near.name}`
      : `the ${bearing(near.hex, hex)} approach to ${near.name}`;
  }
  return gridOf(hex);
}

/** Deliberately coarse — this is what SIGINT gets you, not a grid reference. */
function areaHint(Game, hex) {
  const idx = placeIndex(Game);
  if (idx && hex) {
    const near = nearestCenter(idx, hex);
    if (near && near.d <= 9) return `near ${near.name}`;
  }
  return 'on the far bank';
}

function armLabel(u) {
  switch (u.typeId) {
    case 'mbt': return 'RED armour';
    case 'ifv': return 'A RED IFV section';
    case 'apc': return 'A RED motor-rifle section';
    case 'infantry': return 'A RED rifle section';
    case 'atgm_team': return 'A RED ATGM team';
    case 'spg': return 'RED howitzer battery';
    case 'mlrs': return 'RED MLRS';
    case 'aa': return 'RED SHORAD';
    case 'ew': return 'RED EW truck';
    case 'truck': return 'RED supply column';
    case 'fpv_drone': return 'RED FPV team';
    case 'loiter_munition': return 'RED loitering-munition battery';
    case 'recon_drone': return 'RED recon UAV';
    default: return 'A RED element';
  }
}

function intelLabel(u) {
  if (ARTY_IDS.includes(u.typeId)) return 'artillery net';
  if (u.typeId === 'ew') return 'jamming source';
  if (u.typeId === 'aa') return 'air-defence radar';
  if (u.type && (u.type.class === 'armor' || u.type.class === 'mech')) {
    return 'vehicle net';
  }
  if (u.type && u.type.class === 'drone') return 'UAV datalink';
  return 'command net';
}

// ---------------------------------------------------------------------------
// Movement primitives
// ---------------------------------------------------------------------------
function safeReach(Game, u) {
  try {
    const r = Game.reachableHexes(u);
    if (!Array.isArray(r)) return [];
    return r.filter((h) => h && h.q != null && h.r != null);
  } catch (_) { return []; }
}

/**
 * Highest-scoring reachable hex, or null.
 * opts.within  { hex, radius } — never leave this zone
 * opts.minGain how much better than staying put it has to be (default 0.5;
 *              a negative value permits a lateral/slightly worse shift, which
 *              is what a genuine relief-in-place looks like)
 */
function pickHex(Game, u, scoreFn, opts = {}) {
  if (!u || !u.alive || u.moved) return null;
  const reach = safeReach(Game, u);
  if (!reach.length) return null;
  const zone = opts.within || null;
  let best = null;
  let bestS = -Infinity;
  for (const h of reach) {
    if (occupied(Game, h)) continue;
    const t = tileAt(Game, h);
    if (t && !Number.isFinite(t.moveCost)) continue;
    if (zone && hexDistance(zone.hex, h) > zone.radius) continue;
    const s = scoreFn(h, t);
    if (!Number.isFinite(s)) continue;
    if (s > bestS) { bestS = s; best = h; }
  }
  if (!best) return null;
  const here = scoreFn(u.hex, tileAt(Game, u.hex));
  const gain = Number.isFinite(opts.minGain) ? opts.minGain : 0.5;
  if (bestS <= (Number.isFinite(here) ? here : 0) + gain) return null;
  return best;
}

function noteMove(u, from, turn) {
  const arr = MEM.recent.get(u.id) || [];
  arr.push({ q: from.q, r: from.r });
  while (arr.length > 3) arr.shift();
  MEM.recent.set(u.id, arr);
  MEM.lastMove.set(u.id, turn);
}

function wasRecently(u, hex) {
  const arr = MEM.recent.get(u.id);
  if (!arr) return false;
  return arr.some((h) => h.q === hex.q && h.r === hex.r);
}

async function walk(Game, u, path) {
  const from = { q: u.hex.q, r: u.hex.r };
  try {
    await Game.moveUnit(u, path);
  } catch (err) {
    // moveUnit answers benign refusals by RETURNING false — a throw is a
    // systemic break and must never be silent again.
    console.error('[ai] moveUnit THREW (systemic — investigate):', u.typeId, err);
    try {
      Game.emit('log', `AI ERROR — RED ${u.typeId} movement failed; see console.`);
    } catch (_) { /* the log bus itself is down */ }
    return false;
  }
  const moved = u.hex.q !== from.q || u.hex.r !== from.r;
  if (moved) {
    u.moved = true;
    noteMove(u, from, Game.turn);
  }
  return moved;
}

// ---------------------------------------------------------------------------
// The camera. CRITIQUE 20: a RED action BLUE can see is framed and held on.
// Everything is best-effort — a missing engine, a dronecam that has seized the
// camera, or a bad hex all degrade to "no pan", never to a thrown turn.
// ---------------------------------------------------------------------------
function createCinema(Game, overBudget) {
  const engine = Game.deps && Game.deps.engine;
  const terrain = Game.deps && Game.deps.terrain;
  let pans = 0;
  return {
    shown: false,
    /** @returns true when BLUE can see this hex (whether or not we panned). */
    async frame(hex) {
      if (!hex) return false;
      if (!blueSees(Game, hex)) return false;
      this.shown = true;
      if (!engine || typeof engine.focusOn !== 'function') return true;
      const controls = engine.controls;
      // dronecam holds the camera during an FPV dive — never fight it.
      if (controls && controls.enabled === false) return true;
      if (pans >= MAX_PANS || overBudget()) return true;
      let x = 0, z = 0;
      try {
        const w = hexToWorld(hex.q, hex.r);
        x = w.x; z = w.z;
      } catch (_) { return true; }
      if (!Number.isFinite(x) || !Number.isFinite(z)) return true;
      const t = controls && controls.target;
      // Already in frame — panning would be a pointless twitch.
      if (t && Math.hypot(t.x - x, t.z - z) < 30) return true;
      let y = 0;
      try {
        if (terrain && terrain.heightAt) {
          const h = terrain.heightAt(x, z);
          if (Number.isFinite(h)) y = h;
        }
      } catch (_) { y = 0; }
      try { engine.focusOn({ x, y, z }, { duration: 0.55 }); } catch (_) { return true; }
      pans++;
      await delay(PAN_PRE_MS);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting. An action inside BLUE's vision gets the exact line; an action in
// the fog gets, at most, a coarse SIGINT line — never a grid reference.
// ---------------------------------------------------------------------------
function report(ctx, visible, exact, intel) {
  const Game = ctx.Game;
  if (visible) {
    Game.emit('log', exact);
    return true;
  }
  // SIGINT is coarse by design, so two batteries displacing inside the same
  // area produce the same sentence — and a comms log with the same line twice
  // in a row reads as a stuck process, which is exactly the impression this
  // whole pass exists to remove. One instance per phase, and a suppressed
  // duplicate does not spend the budget.
  if (intel && ctx.intel > 0 && !ctx.said.has(intel)) {
    ctx.intel--;
    ctx.said.add(intel);
    Game.emit('log', intel);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Situation: where RED expects to be hit, and what it knows about BLUE.
// ---------------------------------------------------------------------------
function knownBlue(Game) {
  const out = [];
  for (const b of Game.units) {
    if (!b.alive || b.faction !== 'blue') continue;
    if (redSees(Game, b.hex)) {
      out.push({ hex: b.hex, unit: b, turn: Game.turn, live: true });
      continue;
    }
    const c = MEM.contacts.get(b.id);
    if (c && Game.turn - c.turn <= CONTACT_MEMORY_TURNS) {
      out.push({ hex: c.hex, unit: b, turn: c.turn, live: false });
    }
  }
  return out;
}

// Distance to the nearest BLUE unit RED knows about. Capped (never Infinity) so
// it can be used in arithmetic and in sort comparators without producing NaN.
const NO_CONTACT_DIST = 99;
function frontDist(ctx, hex) {
  let d = NO_CONTACT_DIST;
  for (const c of ctx.known) d = Math.min(d, hexDistance(c.hex, hex));
  return d;
}

function crossings(Game) {
  const out = [];
  const features = Game.deps && Game.deps.features;
  const list = (features && features.infrastructure) || [];
  for (const o of list) {
    if (!o || !o.hex) continue;
    if (o.alive === false) continue;
    if (o.kind === 'bridge' || o.kind === 'rail_bridge') out.push(o.hex);
  }
  if (out.length) return out;
  const terrain = Game.deps && Game.deps.terrain;
  const layout = terrain && terrain.layout;
  for (const b of ((layout && layout.bridges) || [])) {
    if (b && b.anchor) out.push(b.anchor);
  }
  return out;
}

/**
 * True when a battery may legally *and sensibly* put rounds on this hex.
 *
 * combat.js's artilleryBarrage falls through to `infraAt(hex)` when no enemy is
 * standing there and damages the structure — so a fire mission aimed at a
 * crossing is a fire mission aimed at RED's OWN bridge. Every piece of
 * infrastructure on this map belongs to RED (both Vovcha crossings, the
 * substation, the fuel depot, the rail yard, the comms tower), and a bridge
 * carries 8 structural hp: two batteries "interdicting" the crossing for three
 * turns would drop the span RED needs for its own counterattack and hand BLUE
 * an objective it can no longer even reach. RED shells its own structures only
 * when a BLUE unit is standing on one.
 */
function infraSafe(Game, hex) {
  let infra = null;
  try {
    infra = typeof Game.infrastructureAt === 'function'
      ? Game.infrastructureAt(hex) : null;
  } catch (_) { infra = null; }
  if (!infra) return true;
  const occ = typeof Game.unitAt === 'function' ? Game.unitAt(hex) : null;
  return !!(occ && occ.faction === 'blue');
}

/**
 * Where interdiction fire actually lands: the far-bank approach to a crossing,
 * not the span itself. Picks the neighbouring hex furthest from RED's own
 * centre of mass — i.e. the ground BLUE has to form up on to use the bridge.
 */
function approachTo(Game, gate, reds) {
  const com = centroid(reds) || gate;
  const base = hexDistance(com, gate);
  // Two rings, because a crossing can be two hexes of water wide: the hex that
  // covers the bridge may not touch it.
  const ring = new Map();
  for (const n of hexNeighbors(gate)) {
    ring.set(hkey(n), n);
    for (const m of hexNeighbors(n)) {
      if (hexDistance(gate, m) === 2) ring.set(hkey(m), m);
    }
  }
  let best = null;
  let bestS = -Infinity;
  for (const n of ring.values()) {
    if (!infraSafe(Game, n)) continue;
    const t = tileAt(Game, n);
    if (!t || t.type === 'water' || !Number.isFinite(t.moveCost)) continue;
    const occ = typeof Game.unitAt === 'function' ? Game.unitAt(n) : null;
    if (occ && occ.faction === 'red') continue;   // fire mission would be denied
    const d = hexDistance(com, n);
    if (d < base) continue;         // never drop rounds behind RED's own line
    // The ROAD hex dominates: the deploy road into the crossing is the
    // chokepoint §7.3 names, the ground the player's column is actually
    // driving on when the blind rounds arrive. Distance terms only break
    // ties — measured in the harness, a raw far-side distance score kept
    // picking open field two hexes off the road instead of the road itself.
    const s = (t.type === 'road' ? 2 : 0) - hexDistance(gate, n) * 0.25 + d * 0.05;
    if (s > bestS) { bestS = s; best = n; }
  }
  return best;
}

/**
 * Pre-contact aiming point for the batteries: the deploy-road chokepoint on
 * the far-bank approach to the gate nearest the anchor. Cached per phase; the
 * moment RED has ANY live or remembered contact this returns null and the
 * batteries range the contact mass instead. Displacement uses it too, so a
 * battery out of range of the approach marches until the approach is in range
 * — then fires the registration mission the same phase (move + fire are
 * separate actions).
 */
function interdictAim(ctx) {
  // A UAV overhead is not a target list: registration of the chokepoint keeps
  // going until RED knows about BLUE units it can actually shell.
  if (groundContacts(ctx.known).length) return null;
  if (ctx._interdictAim !== undefined) return ctx._interdictAim;
  const Game = ctx.Game;
  let best = null;
  for (const g of crossings(Game)) {
    if (hexDistance(ctx.anchor, g) > INTERDICT_GATE_RADIUS) continue;
    const a = approachTo(Game, g, ctx.reds);
    if (!a) continue;
    if (!best || hexDistance(ctx.anchor, a) < hexDistance(ctx.anchor, best)) {
      best = a;
    }
  }
  ctx._interdictAim = best || null;
  return ctx._interdictAim;
}

/**
 * The hex RED fights for this turn: the mass of what it knows about BLUE, and
 * failing that the crossing nearest its own centre of mass — the gate the
 * assault has to come through. Batteries range it; the reserve shifts toward it.
 */
/**
 * Contacts that define an AXIS: everything except the enemy's recon flyer.
 * Measured in the harness: anchoring on a lone UAV overflight sent both RED
 * batteries driving ACROSS the bridge to hold "ideal range" from an aircraft
 * they cannot even shell. FPV and loiter teams are ground contacts and count.
 */
function groundContacts(known) {
  return known.filter((k) => !(k.unit && k.unit.typeId === 'recon_drone'));
}

function threatAnchor(Game, reds, known) {
  const ground = groundContacts(known);
  if (ground.length) {
    const c = centroid(ground.map((k) => ({ hex: k.hex })));
    if (c) return c;
  }
  const com = centroid(reds) || (reds[0] && reds[0].hex) || { q: 0, r: 0 };
  const gates = crossings(Game);
  if (gates.length) {
    const g = nearest(com, gates);
    if (g) return g;
  }
  const objs = (Game.objectives || []).filter((o) => o.owner === 'red' && o.hex);
  const o = nearest(com, objs, (x) => x.hex);
  return o ? o.hex : com;
}

function homeOf(u) {
  return MEM.home.get(u.id) || u.hex;
}

function onObjective(Game, hex) {
  return (Game.objectives || []).some(
    (o) => o.hex && o.hex.q === hex.q && o.hex.r === hex.r);
}

/**
 * Fold everything RED can currently see into its contact memory. Called at the
 * top of the phase AND after every unit acts — the recon UAV flies at
 * initiative 0 precisely so the sightings from ITS leg are already in memory
 * when the batteries and FPV teams take their decisions this same phase.
 */
function recordContacts(Game) {
  for (const b of Game.units) {
    if (!b.alive || b.faction !== 'blue') continue;
    if (!redSees(Game, b.hex)) continue;
    MEM.contacts.set(b.id, {
      hex: { q: b.hex.q, r: b.hex.r }, turn: Game.turn, unit: b,
    });
    MEM.contactMade = true;
  }
}

function memoryTick(Game, posture) {
  if (Game.turn < MEM.lastTurn) resetMemory();
  MEM.lastTurn = Game.turn;

  for (const u of Game.units) {
    if (!u.alive || u.faction !== 'red') continue;
    // In defend posture a unit's zone is where it started; once RED goes over
    // to the attack the zone travels with it.
    if (posture !== 'defend' || !MEM.home.has(u.id)) {
      MEM.home.set(u.id, { q: u.hex.q, r: u.hex.r });
    }
  }
  recordContacts(Game);
  for (const [id, c] of MEM.contacts) {
    if (!c.unit || !c.unit.alive || Game.turn - c.turn > CONTACT_MEMORY_TURNS) {
      MEM.contacts.delete(id);
    }
  }
}

/** A live piece of infrastructure on or beside this hex — the chokepoints. */
function nearAliveInfra(Game, hex) {
  const features = Game.deps && Game.deps.features;
  const list = (features && features.infrastructure) || [];
  return list.some((o) => o && o.alive !== false && o.hex &&
    hexDistance(o.hex, hex) <= 1);
}

// ---------------------------------------------------------------------------
// Order routing — prefer state.js's wrappers (they run the post-action pass),
// fall back to combat.js directly.
// ---------------------------------------------------------------------------
function orderAttack(Game, u, target) {
  if (typeof Game.attack === 'function') return Game.attack(u, target);
  return resolveAttack(u, target);
}

function orderBarrage(Game, u, hex) {
  if (typeof Game.artilleryBarrage === 'function') return Game.artilleryBarrage(u, hex);
  return artilleryBarrage(u, hex);
}

function orderFpv(Game, u, target) {
  if (typeof Game.fpvStrike === 'function') return Game.fpvStrike(u, target);
  return fpvStrike(u, target);
}

function orderLoiter(Game, u, target) {
  if (typeof Game.loiterStrike === 'function') return Game.loiterStrike(u, target);
  return loiterStrike(u, target);
}

// ---------------------------------------------------------------------------
// Shared action wrappers
// ---------------------------------------------------------------------------
async function relocate(ctx, u, hex, exact, intel, holdMs) {
  const Game = ctx.Game;
  if (!hex) return false;
  let path = null;
  try {
    path = typeof Game.pathTo === 'function' ? Game.pathTo(u, hex) : null;
  } catch (_) { path = null; }
  if (!path || !path.length) return false;

  // Frame the destination if BLUE can see it, otherwise the departure. The pan
  // LEADS the move, the sentence FOLLOWS it: a move the mover never completes
  // (a spent unit, a path that broke under it) can no longer leave a phantom
  // line in the comms log claiming ground RED never took.
  const from = { q: u.hex.q, r: u.hex.r };
  let framed = await ctx.cine.frame(hex);
  if (!framed) framed = await ctx.cine.frame(u.hex);

  const ok = await walk(Game, u, path);
  if (!ok) return false;
  ctx.stats.moves++;

  // moveUnit() recomputes fog per hex, so this is the truth at the moment of
  // reporting: seen leaving OR seen arriving earns the exact line.
  const landed = { q: u.hex.q, r: u.hex.r };
  const watched = blueSees(Game, landed) || blueSees(Game, from);
  report(ctx, watched, exact, intel);
  if (!framed && watched) framed = await ctx.cine.frame(landed);
  await ctx.beat(framed, holdMs == null ? MOVE_HOLD_MS : holdMs);
  return true;
}

async function fireMission(ctx, u, hex, exact) {
  const Game = ctx.Game;
  ctx.firedHexes.add(hkey(hex));
  const framed = await ctx.cine.frame(hex);
  // Cause before consequence: the fire order, then combat.js's result line.
  if (exact) Game.emit('log', exact);
  let res = null;               // NB: never name this `report` — it would shadow
  try {
    res = orderBarrage(Game, u, hex);
  } catch (err) {
    res = null;
    // The resolver answers every bad order by RETURNING a refusal report — a
    // throw here is systemic and must be loud (the order line above already
    // printed, so a silent failure would leave a phantom mission in the log).
    console.error('[ai] fire mission THREW (systemic — investigate):', u.typeId, err);
    try {
      Game.emit('log', `AI ERROR — RED ${u.typeId} fire mission failed; see console.`);
    } catch (_) { /* the log bus itself is down */ }
  }
  ctx.stats.missions++;
  await ctx.beat(framed, FIRE_HOLD_MS);
  return res;
}

// ---------------------------------------------------------------------------
// Posture — §7 aggression states
// ---------------------------------------------------------------------------
function getPosture(Game) {
  const fx = Game.infraEffects || {};
  if (fx.commsDead) return 'defend';
  if (Game.turn >= 13) return 'desperate';
  if (Game.turn >= 8) {
    const holds = (Game.objectives || []).some((o) => o.owner === 'red');
    return holds ? 'counterattack' : 'desperate';
  }
  return 'defend';
}

function postureLine(Game, posture, reds) {
  const objectives = Game.objectives || [];
  const held = objectives.filter((o) => o.owner === 'red');
  const keystone = held.find((o) => o.kind === 'town') || held[0] || null;
  const where = keystone ? keystone.name : 'the far bank';
  if (posture === 'defend') {
    const dug = reds.filter((u) => (u.entrench || 0) > 0).length;
    return dug
      ? `RED command holds the line — ${dug} of ${reds.length} elements dug in around ${where}.`
      : `RED command holds the line — ${reds.length} elements astride ${where}.`;
  }
  if (posture === 'counterattack') {
    const lost = objectives.find((o) => o.owner !== 'red');
    return `RED command orders a counterattack toward ${lost ? lost.name : 'the crossings'}.`;
  }
  return `RED command commits everything to ${where}.`;
}

function goalFor(Game, u, posture, blues) {
  const objectives = Game.objectives || [];
  if (posture === 'defend') {
    const own = objectives.filter((o) => o.owner === 'red');
    const o = nearest(u.hex, own.length ? own : objectives, (x) => x.hex);
    return o ? o.hex : null;
  }
  if (posture === 'counterattack') {
    const lost = objectives.filter((o) => o.owner !== 'red');
    if (lost.length) {
      const o = nearest(u.hex, lost, (x) => x.hex);
      return o ? o.hex : null;
    }
    const b = nearest(u.hex, blues, (x) => x.hex);
    return b ? b.hex : null;
  }
  const o = nearest(u.hex, objectives, (x) => x.hex);
  if (o) return o.hex;
  const b = nearest(u.hex, blues, (x) => x.hex);
  return b ? b.hex : null;
}

// ---------------------------------------------------------------------------
// Priority behaviors — each returns true if the unit acted.
// ---------------------------------------------------------------------------

// §7.1 Survive (hp < 3): break contact, prefer cover. Score 90.
async function trySurvive(ctx, u) {
  const Game = ctx.Game;
  if (u.hp >= 3 || u.moved || u.typeId === 'recon_drone') return false;
  const threat = ctx.blues.filter((b) => seen(b.hex));
  if (!threat.length) return false;
  const hex = pickHex(Game, u, (h, t) => {
    let minD = Infinity;
    for (const b of threat) minD = Math.min(minD, hexDistance(b.hex, h));
    return minD * 10 + (t ? (t.cover || 0) * 4 : 0) -
      (inBlueZOC(Game, h, ctx.blues) ? 30 : 0);
  });
  if (!hex) return false;
  return relocate(ctx, u, hex,
    `${armLabel(u)} breaks contact and falls back to ${placeOf(Game, hex)}.`,
    `SIGINT: a RED ${intelLabel(u)} goes to ground ${areaHint(Game, hex)}.`);
}

// §7.3 Artillery fires: spotted target first, then a fire mission onto a
// remembered contact, then interdiction of the crossing. CRITIQUE 19(b).
async function tryArtilleryFire(ctx, u) {
  const Game = ctx.Game;
  if (!ARTY_IDS.includes(u.typeId) || u.fired || u.ammo <= 0) return false;
  const range = u.type.range || 0;
  if (range < 1) return false;

  // 1) anything RED can actually see
  let best = null;
  let bestS = 0;
  for (const b of ctx.blues) {
    if (b.typeId === 'recon_drone') continue;
    if (!redSees(Game, b.hex)) continue;
    const d = hexDistance(u.hex, b.hex);
    if (d < 1 || d > range) continue;
    const ev = previewAttack(u, b);
    // Batteries spread their fire rather than all piling onto one hex.
    const s = ev.dmg * val(b) * (ctx.firedHexes.has(hkey(b.hex)) ? 0.5 : 1);
    if (s > bestS) { bestS = s; best = b; }
  }
  if (best && bestS > 0) {
    const counter = best.typeId === 'spg' || best.typeId === 'mlrs';
    const repeat = ctx.firedHexes.has(hkey(best.hex));
    const line = repeat
      ? `${armLabel(u)} joins the fire mission on ${gridOf(best.hex)}.`
      : (counter
        ? `RED counter-battery mission on ${gridOf(best.hex)} — BLUE guns located.`
        : `${armLabel(u)} ranges ${placeOf(Game, best.hex)} — fire mission on ${gridOf(best.hex)}.`);
    await fireMission(ctx, u, best.hex, line);
    return true;
  }

  // 2) a fire mission onto the last reported position of something RED lost
  //    sight of (§7.3 blind fire — needs the comms tower alive).
  const fx = Game.infraEffects || {};
  if (fx.commsDead) return false;
  if (u.ammo < 2) return false;                  // keep a round for a real target
  let target = null;
  let targetVal = 0;
  for (const c of MEM.contacts.values()) {
    if (Game.turn - c.turn > HARASS_MEMORY_TURNS) continue;
    if (!c.unit || !c.unit.alive) continue;
    if (c.unit.typeId === 'recon_drone') continue; // cannot shell a UAV's shadow
    if (redSees(Game, c.unit.hex)) continue;     // handled by branch 1
    const d = hexDistance(u.hex, c.hex);
    if (d < 1 || d > range) continue;
    const occ = typeof Game.unitAt === 'function' ? Game.unitAt(c.hex) : null;
    if (occ && occ.faction === 'red') continue;  // fire mission would be denied
    if (!tileAt(Game, c.hex)) continue;
    if (!infraSafe(Game, c.hex)) continue;       // never shell RED's own bridge
    const v = val(c.unit);
    if (v > targetVal) { targetVal = v; target = c; }
  }
  if (target) {
    await fireMission(ctx, u, target.hex,
      `${armLabel(u)} fires on the last reported BLUE position — ${gridOf(target.hex)}.`);
    return true;
  }

  // 3) Registration / interdiction of the crossing RED expects the assault to
  //    use. Before contact this is pre-registration — the thing a dug-in
  //    battery does on the approach march, and the reason RED's opening turns
  //    are rounds on the bridge instead of four sentences of silence. Rationed
  //    hard: one mission per phase across the whole battery group, a cooldown
  //    per battery, at most twice per battery per scenario, and never the last
  //    rounds. The rounds land on the far-bank APPROACH, never on the span.
  if (ctx.interdicted) return false;
  if (u.ammo < 3) return false;
  // Pre-contact registration is the rationed part: two rounds per battery for
  // the whole scenario. Once RED has actually seen BLUE, interdicting the
  // crossing is a live tactical choice again and only ammo and the cooldown
  // hold it back.
  const registering = !MEM.contactMade;
  if (registering) {
    if (Game.turn < INTERDICT_FROM_TURN) return false;
    if ((MEM.harassCount.get(u.id) || 0) >= MAX_INTERDICT_PER_BATTERY) return false;
  }
  const last = MEM.lastHarass.get(u.id);
  if (last != null && Game.turn - last < HARASS_COOLDOWN) return false;

  let aim = null;
  let aimGate = null;
  for (const g of crossings(Game)) {
    if (hexDistance(ctx.anchor, g) > INTERDICT_GATE_RADIUS) continue;
    const a = approachTo(Game, g, ctx.reds);
    if (!a) continue;
    const d = hexDistance(u.hex, a);
    if (d < 1 || d > range) continue;
    if (!aim || hexDistance(ctx.anchor, a) < hexDistance(ctx.anchor, aim)) {
      aim = a;
      aimGate = g;
    }
  }
  if (!aim) return false;
  MEM.lastHarass.set(u.id, Game.turn);
  if (registering) {
    MEM.harassCount.set(u.id, (MEM.harassCount.get(u.id) || 0) + 1);
  }
  ctx.interdicted = true;
  const where = placeOf(Game, aimGate || aim);
  await fireMission(ctx, u, aim, registering
    ? `${armLabel(u)} registers defensive fires on the approach to ${where}.`
    : `${armLabel(u)} drops interdiction fire on the approach to ${where}.`);
  return true;
}

// Shoot-and-scoot / displacement. A battery that cannot reach anything moves
// until it can, then stops. CRITIQUE 19(a)+(b): this is what turns four silent
// turns into "RED MLRS displaces to the Zoria treeline."
async function tryArtilleryDisplace(ctx, u) {
  const Game = ctx.Game;
  if (u.moved) return false;
  const range = u.type.range || 5;
  // Pre-contact the battery positions to range the deploy-road chokepoint it
  // is about to register (interdictAim); once there is a contact, the mass of
  // what RED knows about BLUE (the anchor) takes over.
  const anchor = interdictAim(ctx) || ctx.anchor;
  const ideal = Math.max(1, range - 1);
  const home = homeOf(u);
  const com = centroid(ctx.reds) || home;
  const eg = groundContacts(ctx.known);
  const enemyCom = eg.length ? centroid(eg.map((k) => ({ hex: k.hex }))) : null;
  const hex = pickHex(Game, u, (h, t) => {
    // A battery holds ITS side of the field: any hex as close to the enemy's
    // ground mass as to RED's own — the equidistant midline is the bridge
    // itself — is the enemy's half of the ring. Measured in the harness:
    // without this the ideal-range chase marched both batteries across the
    // water to shell the column from beside it. When the mass is out of reach
    // from RED's side, the battery waits at the line for the targets to come
    // into range instead of chasing. (No known ground enemy → no rule — the
    // pre-contact registration ring is on RED's own terms already.)
    if (enemyCom &&
        hexDistance(h, enemyCom) <= hexDistance(h, com)) return -1e9;
    const d = hexDistance(anchor, h);
    let s = 0;
    if (d > ideal) s -= (d - ideal) * 14;        // out of reach — come forward
    else s -= (ideal - d) * 2;                   // in reach — stay deep
    s -= hexDistance(home, h) * 1.2;             // and stay near the zone it knows
    const fd = frontDist(ctx, h);
    if (fd <= 2) s -= 120;                       // never park a gun in contact
    else if (fd <= 3) s -= 55;
    else if (fd <= 4) s -= 18;
    s += (t ? (t.cover || 0) : 0) * 3;
    if (wasRecently(u, h)) s -= 25;
    return s;
  }, { minGain: 1 });
  if (!hex) return false;
  return relocate(ctx, u, hex,
    `${armLabel(u)} displaces to ${placeOf(Game, hex)}.`,
    `SIGINT: RED artillery net shifts ${areaHint(Game, hex)}.`);
}

// §7.4 FPV / loiter strike vs the highest-value BLUE armour in reach.
// previewAttack folds the EW abort and the SHORAD intercept odds into the EV,
// so a jammed shot below FPV_MIN_EV is skipped (§7.4) — but a strike whose
// DISCOUNTED EV still clears the bar flies straight into the player's AA
// umbrella and eats the 40/50 % intercepts. Losing airframes to a well-placed
// SHORAD is the trade the drone war is made of; the AI does not route around
// it. Loitering rounds additionally weight targets sitting on or beside live
// infrastructure — the bridge chokepoints §7 names — so massing armour at the
// crossing is exactly what draws the Shahed.
async function tryDroneStrike(ctx, u) {
  const Game = ctx.Game;
  if (!DRONE_STRIKE_IDS.includes(u.typeId) || u.fired || u.ammo <= 0) return false;
  const range = u.type.range || 4;
  const targets = ctx.blues.filter((b) =>
    ARMOR_VALUE_IDS.has(b.typeId) && redSees(Game, b.hex) &&
    hexDistance(u.hex, b.hex) >= 1 && hexDistance(u.hex, b.hex) <= range);
  if (!targets.length) return false;
  let best = null;
  let bestS = 0;
  for (const b of targets) {
    const ev = previewAttack(u, b);        // folds EW abort + AA intercept
    if (ev.dmg < FPV_MIN_EV) continue;     // skip jammed/screened low-value shots
    let s = ev.dmg * val(b);
    if (u.typeId === 'loiter_munition' && nearAliveInfra(Game, b.hex)) {
      s *= LOITER_CHOKE_MULT;              // §7: infrastructure-adjacent chokepoint
    }
    if (s > bestS) { bestS = s; best = b; }
  }
  if (!best) return false;

  const framed = await ctx.cine.frame(best.hex);
  Game.emit('log', u.typeId === 'fpv_drone'
    ? `${armLabel(u)} launches on ${best.type.name} at ${gridOf(best.hex)}.`
    : `${armLabel(u)} commits a round to ${gridOf(best.hex)}.`);
  const res = u.typeId === 'fpv_drone'
    ? orderFpv(Game, u, best)
    : orderLoiter(Game, u, best);
  ctx.stats.strikes++;
  if (res && res.done) {
    // The dronecam promise is contract-guaranteed to resolve; a rejection is a
    // cinematic bug, not a rules bug — state is already final. Loud anyway.
    try { await res.done; } catch (err) {
      console.error('[ai] dronecam promise rejected (cosmetic, but report it):', err);
    }
  }
  await ctx.beat(framed, FIRE_HOLD_MS);
  return true;
}

// A strike team or battery that has shot itself dry walks back to the supply
// column and goes FIRM beside it — state.js's §3.1 supply tick refills a unit
// that ends the turn adjacent to a truck having neither moved nor fired. This
// is what turns RED's drone pressure from a two-round cameo into a cycle:
// strike, strike, fall back, re-arm, come again.
async function tryRearm(ctx, u) {
  const Game = ctx.Game;
  if (u.ammo > 0) return false;
  const trucks = ctx.reds.filter((v) => traits(v).includes('supply'));
  if (!trucks.length) return false;
  const truck = nearest(u.hex, trucks, (t) => t.hex);
  if (!truck) return false;
  if (hexDistance(u.hex, truck.hex) <= 1) {
    // On station: holding still IS the action (the resupply predicate).
    if (!u.moved && !u.fired) {
      report(ctx, blueSees(Game, u.hex),
        `${armLabel(u)} goes firm beside the supply column to re-arm.`,
        `SIGINT: a RED ${intelLabel(u)} goes quiet ${areaHint(Game, u.hex)}.`);
    }
    return true;
  }
  if (u.moved) return true;                // already walked — hold the claim
  const hex = pickHex(Game, u, (h, t) =>
    -hexDistance(truck.hex, h) * 10 + (t ? (t.cover || 0) * 2 : 0) -
    (frontDist(ctx, h) <= 3 ? 60 : 0) - (wasRecently(u, h) ? 15 : 0));
  if (!hex) return true;                   // boxed in — wait for a lane
  return relocate(ctx, u, hex,
    `${armLabel(u)} falls back on the supply column to re-arm.`,
    `SIGINT: a RED ${intelLabel(u)} goes quiet ${areaHint(Game, hex)}.`);
}

// CRITIQUE 19(c), shipped-scenario half. scenario01's RED order of battle has
// no recon UAV, so the FPV team IS RED's eyes and edge, and it has to be seen
// flying a leg every single turn — never parked. Two modes:
//   • its 4-hex strike envelope does not yet cover the gate RED is defending →
//     creep the launch point forward until it does,
//   • it does → work the same circuit a recon UAV would (patrolLeg), shifting
//     laterally between the crossings and the objectives it screens.
// Either way it refuses to close inside three hexes of anything BLUE has: an
// FPV team caught in contact is two men and a suitcase.
async function tryDroneCreep(ctx, u) {
  const Game = ctx.Game;
  if (u.moved) return false;
  const range = u.type.range || 4;
  const ideal = Math.max(1, range - 1);
  const covering = hexDistance(u.hex, ctx.anchor) <= ideal;
  const aim = covering ? patrolLeg(ctx, u) : ctx.anchor;
  const hex = pickHex(Game, u, (h, t) => {
    const d = hexDistance(aim, h);
    let s = -d * (covering ? 7 : 12);
    // Closing further than the envelope needs is pure risk, no reward.
    if (!covering && d < ideal) s -= (ideal - d) * 3;
    const fd = frontDist(ctx, h);
    if (fd <= 2) s -= 140;                       // an FPV team dies in contact
    else if (fd <= 3) s -= 45;
    s += (t ? (t.cover || 0) : 0) * 4;
    if (wasRecently(u, h)) s -= 25;
    return s;
    // A patrol leg is allowed to be a lateral shift (negative minGain); moving
    // the launch point forward has to actually improve the firing position.
  }, { minGain: covering ? -1.5 : 1 });
  if (!hex) return false;
  const line = covering
    ? `${armLabel(u)} works a sweep over ${placeOf(Game, hex)}.`
    : `${armLabel(u)} moves its launch point to ${placeOf(Game, hex)}.`;
  return relocate(ctx, u, hex, line,
    `SIGINT: a RED UAV datalink comes up ${areaHint(Game, hex)}.`, 220);
}

// §7.2 SHORAD: shoot recon drones, otherwise screen the artillery.
async function tryAA(ctx, u) {
  const Game = ctx.Game;
  if (u.typeId !== 'aa') return false;
  const range = u.type.range || 2;
  if (!u.fired && u.ammo > 0) {
    const drone = ctx.blues.find((b) =>
      b.typeId === 'recon_drone' && redSees(Game, b.hex) &&
      hexDistance(u.hex, b.hex) >= 1 && hexDistance(u.hex, b.hex) <= range);
    if (drone) {
      const framed = await ctx.cine.frame(drone.hex);
      Game.emit('log', `${armLabel(u)} engages the BLUE UAV over ${placeOf(Game, drone.hex)}.`);
      try {
        orderAttack(Game, u, drone);
      } catch (err) {
        console.error('[ai] SHORAD engagement THREW (systemic — investigate):', err);
        try {
          Game.emit('log', 'AI ERROR — RED aa engagement failed; see console.');
        } catch (_) { /* the log bus itself is down */ }
      }
      ctx.stats.shots++;
      await ctx.beat(framed, FIRE_HOLD_MS);
      return true;
    }
  }
  const droneThreat = ctx.blues.some((b) => DRONE_STRIKE_IDS.includes(b.typeId) ||
    b.typeId === 'recon_drone');
  if (!droneThreat || u.moved) return false;
  const wards = ctx.reds.filter((v) => ARTY_IDS.includes(v.typeId));
  if (!wards.length) return false;
  const uncovered = wards.filter((w) => hexDistance(u.hex, w.hex) > 2);
  if (!uncovered.length) return false;           // umbrella already in place
  const hex = pickHex(Game, u, (h, t) => {
    let s = (t ? (t.cover || 0) * 2 : 0) - (inBlueZOC(Game, h, ctx.blues) ? 30 : 0);
    for (const w of wards) s -= hexDistance(w.hex, h) * 6;
    if (wasRecently(u, h)) s -= 20;
    return s;
  });
  if (!hex) return false;
  return relocate(ctx, u, hex,
    `${armLabel(u)} moves its umbrella over the guns at ${placeOf(Game, hex)}.`,
    `SIGINT: a RED air-defence radar radiates ${areaHint(Game, hex)}.`);
}

// §7.8 EW truck (and the supply truck) shadow the main body's centre of mass.
async function tryFollowBody(ctx, u) {
  const Game = ctx.Game;
  if (u.moved) return false;
  const body = ctx.reds.filter((v) => COMBAT_IDS.has(v.typeId));
  const com = centroid(body);
  if (!com) return false;
  if (hexDistance(u.hex, com) <= 1) return false;   // already on station
  const hex = pickHex(Game, u, (h, t) =>
    -hexDistance(com, h) * 8 + (t ? (t.cover || 0) * 2 : 0) -
    (inBlueZOC(Game, h, ctx.blues) ? 30 : 0) - (wasRecently(u, h) ? 15 : 0));
  if (!hex) return false;
  const line = traits(u).includes('jammer')
    ? `${armLabel(u)} shifts its jamming bubble over ${placeOf(Game, hex)}.`
    : `${armLabel(u)} runs ammunition forward to ${placeOf(Game, hex)}.`;
  return relocate(ctx, u, hex, line,
    `SIGINT: a RED ${intelLabel(u)} moves ${areaHint(Game, hex)}.`);
}

// CRITIQUE 19(c): eyes fly a leg EVERY turn. The UAV works a circuit over the
// gates RED is defending, so it keeps re-spotting for the guns instead of
// parking on top of the BLUE mass and dying to SHORAD.
/**
 * The circuit a unit with eyes flies/walks. `deep` (the recon UAV) matters
 * when RED has NO contact: the flyer's circuit then pushes over the water onto
 * the far-bank approaches — the ground BLUE has to form up on — until it FINDS
 * the player, because an army with no target list cannot fight drones-first.
 * Ground strike teams never get the far-bank legs (an FPV team west of the
 * river is two men and a suitcase in the wrong country). The circuit is
 * replanned whenever the contact picture flips (none → some or back).
 */
function patrolLeg(ctx, u, deep = false) {
  const Game = ctx.Game;
  const hasContact = ctx.known.length > 0;
  let rec = MEM.patrol.get(u.id);
  if (rec && rec.hadContact !== hasContact) rec = null;   // situation changed
  if (!rec || !rec.legs || !rec.legs.length) {
    const legs = [];
    if (hasContact) {
      const c = centroid(ctx.known.map((k) => ({ hex: k.hex })));
      if (c) legs.push(c);
    }
    for (const h of crossings(Game)) {
      if (deep && !hasContact) {
        // The probe leg sits BEYOND the far-bank approach (extended along the
        // gate→approach line), and comes BEFORE the gate leg: an approach hex
        // adjacent to the span would be swallowed by the arrive-within-1 leg
        // advance and the flyer would never actually cross the water.
        const a = approachTo(Game, h, ctx.reds);
        if (a) {
          const probe = { q: a.q + (a.q - h.q) * 2, r: a.r + (a.r - h.r) * 2 };
          legs.push(tileAt(Game, probe) ? probe : { q: a.q, r: a.r });
        }
      }
      legs.push({ q: h.q, r: h.r });
    }
    for (const o of (Game.objectives || [])) {
      if (o && o.hex && o.owner === 'red') legs.push({ q: o.hex.q, r: o.hex.r });
    }
    if (!legs.length) legs.push({ q: u.hex.q, r: u.hex.r });
    rec = { legs, i: 0, hadContact: hasContact };
    MEM.patrol.set(u.id, rec);
  }
  if (hexDistance(u.hex, rec.legs[rec.i]) <= 1) {
    rec.i = (rec.i + 1) % rec.legs.length;
  }
  return rec.legs[rec.i];
}

async function tryReconPatrol(ctx, u) {
  const Game = ctx.Game;
  if (u.typeId !== 'recon_drone' || u.moved) return false;
  const leg = patrolLeg(ctx, u, true);   // deep: push out until contact is made
  const blueAA = ctx.blues.filter((b) => b.typeId === 'aa');
  const hex = pickHex(Game, u, (h) => {
    let s = -hexDistance(leg, h) * 8;
    for (const a of blueAA) {
      if (hexDistance(a.hex, h) <= 2) s -= 60;   // auto-engage umbrella
    }
    if (wasRecently(u, h)) s -= 12;
    return s;
  }, { minGain: -1 });
  if (!hex) return false;
  return relocate(ctx, u, hex,
    `${armLabel(u)} sweeps ${placeOf(Game, hex)}.`,
    `SIGINT: a RED UAV datalink sweeps ${areaHint(Game, hex)}.`, 200);
}

// §7.5 Best net-trade direct attack.
async function tryDirectAttack(ctx, u) {
  const Game = ctx.Game;
  if (u.fired || (u.type.range || 0) < 1) return false;
  if (u.type.ammo > 0 && u.ammo <= 0) return false;
  let best = null;
  let bestNet = -Infinity;
  for (const b of ctx.blues) {
    if (!redSees(Game, b.hex)) continue;
    const d = hexDistance(u.hex, b.hex);
    if (d < 1 || d > (u.type.range || 0)) continue;
    const ev = previewAttack(u, b);
    if (ev.dmg <= 0) continue;
    const net = ev.dmg * val(b) / 100 -
      ev.returnDmg * val(u) / 100 * RETURN_FIRE_WEIGHT;
    if (net > bestNet) { bestNet = net; best = b; }
  }
  if (!best || bestNet < -0.5) return false;     // never trade badly on purpose
  const framed = await ctx.cine.frame(best.hex);
  try {
    orderAttack(Game, u, best);
  } catch (err) {
    console.error('[ai] direct attack THREW (systemic — investigate):', u.typeId, err);
    try {
      Game.emit('log', `AI ERROR — RED ${u.typeId} attack failed; see console.`);
    } catch (_) { /* the log bus itself is down */ }
  }
  ctx.stats.shots++;
  await ctx.beat(framed, FIRE_HOLD_MS);
  return true;
}

// §7.7 Advance toward the objective via cover, avoiding BLUE ZOC.
async function tryAdvance(ctx, u) {
  const Game = ctx.Game;
  if (u.moved) return false;
  const goal = goalFor(Game, u, ctx.posture, ctx.blues);
  if (!goal) return false;
  if (ctx.posture === 'defend') {
    // A garrison does not wander off its position — the rotation pass below is
    // what keeps the line alive.
    if (hexDistance(u.hex, goal) <= 1) return false;
    // Neither does a unit that is already in a prepared position with nothing
    // in front of it: the scenario's dug-in screen and treeline ambush are
    // authored, and marching them onto the objective would throw them away.
    if ((u.entrench || 0) >= 1 && frontDist(ctx, u.hex) > 6) return false;
  }
  const defend = ctx.posture === 'defend';
  const hex = pickHex(Game, u, (h, t) => {
    const d = hexDistance(goal, h);
    const cover = t ? (t.cover || 0) : 0;
    // Defending, a unit takes up a covered position COVERING the objective
    // instead of piling onto it; attacking, it closes all the way.
    const pull = defend ? -Math.max(0, d - 1) * 10 : -d * 10;
    return pull + cover * (defend ? 7 : 4) -
      (inBlueZOC(Game, h, ctx.blues) ? 25 : 0) -
      (wasRecently(u, h) ? 15 : 0);
  });
  if (!hex) return false;
  const verb = ctx.posture === 'defend' ? 'closes up on' : 'pushes to';
  return relocate(ctx, u, hex,
    `${armLabel(u)} ${verb} ${placeOf(Game, hex)}.`,
    `SIGINT: a RED ${intelLabel(u)} is on the move ${areaHint(Game, hex)}.`);
}

// ---------------------------------------------------------------------------
// CRITIQUE 19(a) — the relief in place. Even a dug-in defence rotates: after
// every unit has taken its own decision, if the line has not visibly moved we
// shift the reserve inside its own zone. Front-line garrisons that are dug in
// and in contact are deliberately excluded — they are supposed to sit still.
// ---------------------------------------------------------------------------
function rotationScore(ctx, u, h, t) {
  const home = homeOf(u);
  let s = (t ? (t.cover || 0) : 0) * 6;
  s -= hexDistance(home, h) * 2.5;
  s -= hexDistance(ctx.anchor, h) * 0.8;         // drift toward the threat
  const fd = frontDist(ctx, h);
  if (fd <= 1) s -= 60;
  else if (fd <= 2) s -= 18;
  if (wasRecently(u, h)) s -= 30;                // no shuffling back and forth
  if (onObjective(ctx.Game, h)) s += 5;          // holding ground is never wrong
  return s;
}

/**
 * Who is allowed to shuffle.
 * `strict` (the normal pass) protects prepared positions: a unit dug in to 2+
 * that is covering the expected point of contact is doing its job, and making
 * it walk would throw away the entrenchment bonus it spent turns earning.
 * The relaxed pass only ever adds units with nothing within five hexes of them,
 * where re-digging costs a turn nobody is going to contest.
 */
function rotationPool(ctx, strict) {
  const Game = ctx.Game;
  return ctx.reds.filter((u) => {
    if (!u.alive || u.moved) return false;
    if (u.type && u.type.class === 'drone') return false;
    if (onObjective(Game, u.hex)) return false;  // never vacate an objective
    if ((u.entrench || 0) >= 2) {
      const fd = frontDist(ctx, u.hex);
      if (!strict) return fd >= 5;
      if (fd < 5 || hexDistance(u.hex, ctx.anchor) <= 4) return false;
    }
    return true;
  });
}

async function rotateTheLine(ctx, strict = true, limit = MAX_ROTATIONS) {
  const Game = ctx.Game;
  let done = 0;
  // Every unit that acted before this pass may have opened or closed a contact,
  // so the situation this pass reasons about has to be the current one.
  ctx.blues = aliveOf(Game, 'blue');
  ctx.reds = aliveOf(Game, 'red');
  ctx.known = knownBlue(Game);

  const pool = rotationPool(ctx, strict);
  pool.sort((a, b) => {
    const am = MEM.lastMove.get(a.id) === Game.turn - 1 ? 1 : 0;
    const bm = MEM.lastMove.get(b.id) === Game.turn - 1 ? 1 : 0;
    if (am !== bm) return am - bm;                       // rested units first
    const ae = a.entrench || 0, be = b.entrench || 0;
    if (ae !== be) return ae - be;                       // least dug in first
    return frontDist(ctx, b.hex) - frontDist(ctx, a.hex); // reserves, not the front
  });

  for (const u of pool) {
    if (done >= limit) break;
    if (Game.phase === 'over') break;
    const zone = { hex: homeOf(u), radius: ZONE_RADIUS };
    // The first rotation of the phase is guaranteed: the threshold is loose
    // enough that a plain one-hex shift inside the zone qualifies (leaving home
    // costs 2.5/hex on its own). Any further one has to earn itself.
    const first = done === 0;
    const hex = pickHex(Game, u, (h, t) => rotationScore(ctx, u, h, t),
      { within: zone, minGain: first ? (strict ? -4 : -9) : 1.5 });
    if (!hex) continue;
    const place = placeOf(Game, hex);
    const line = ARTY_IDS.includes(u.typeId)
      ? `${armLabel(u)} displaces to ${place}.`
      : `${armLabel(u)} rotates into ${place}.`;
    let ok = false;
    try {
      ok = await relocate(ctx, u, hex, line,
        `SIGINT: a RED ${intelLabel(u)} relocates ${areaHint(Game, hex)}.`);
    } catch (err) {
      console.error('[ai] rotation THREW (systemic — investigate):', u.typeId, err);
      try {
        Game.emit('log', `AI ERROR — RED ${u.typeId} rotation failed; see console.`);
      } catch (_) { /* the log bus itself is down */ }
    }
    if (ok) done++;
  }
  return done;
}

/**
 * CRITIQUE 19(a) is an absolute: "even in defend posture, RED must reposition
 * at least one unit within its own defensive zone, every turn". The strict pass
 * is the one with taste; this is the one with teeth. If taste produced nothing
 * — every reserve boxed in, every candidate already where it wants to be — one
 * more unit moves anyway, chosen from the units that lose the least by moving.
 */
async function insistOnMovement(ctx) {
  if (ctx.Game.phase === 'over') return 0;
  const loud = (err, which) => {
    console.error(`[ai] ${which} rotation pass THREW (systemic — investigate):`, err);
    try {
      ctx.Game.emit('log', 'AI ERROR — RED rotation pass failed; see console.');
    } catch (_) { /* the log bus itself is down */ }
  };
  let done = 0;
  try {
    done = await rotateTheLine(ctx, true, MAX_ROTATIONS);
  } catch (err) { loud(err, 'strict'); }
  if (done > 0 || ctx.Game.phase === 'over') return done;
  try {
    done = await rotateTheLine(ctx, false, 1);
  } catch (err) { loud(err, 'relaxed'); }
  return done;
}

/**
 * A defence that genuinely cannot move still has to read as a defence at work
 * rather than a dead process. State-derived, leaks nothing: it is a headcount
 * of RED elements that will deepen their positions when the phase closes
 * (state.js's entrenchment tick fires on exactly this predicate).
 */
function sappersLine(Game, reds) {
  let n = 0;
  for (const u of reds) {
    if (!u.alive || u.moved || u.fired) continue;
    if (u.type && u.type.class === 'drone') continue;
    const cap = traits(u).includes('entrench_bonus') ? 3 : 2;
    if ((u.entrench || 0) < cap) n++;
  }
  if (!n) return null;
  const idx = placeIndex(Game);
  let where = 'the far bank';
  if (idx) {
    const com = centroid(reds);
    const near = com ? nearestCenter(idx, com) : null;
    if (near) where = near.name;
  }
  return n > 1
    ? `RED engineers work the line — ${n} elements deepen their positions around ${where}.`
    : `RED engineers deepen one more position around ${where}.`;
}

// ---------------------------------------------------------------------------
// Per-unit brain — ordered by the §7 priority scores.
// ---------------------------------------------------------------------------
async function actUnit(ctx, u) {
  const Game = ctx.Game;
  ctx.blues = aliveOf(Game, 'blue');
  ctx.reds = aliveOf(Game, 'red');
  recordContacts(Game);          // fold mid-phase sightings (the UAV's leg) in
  ctx.known = knownBlue(Game);   // a unit that moved may have opened a contact
  if (!ctx.blues.length) return false;

  if (await trySurvive(ctx, u)) return true;                       // 90

  if (u.typeId === 'aa') {
    if (await tryAA(ctx, u)) return true;                          // 75
    if (await tryDirectAttack(ctx, u)) return true;                // 60
    return tryAdvance(ctx, u);
  }
  if (ARTY_IDS.includes(u.typeId)) {
    const fired = await tryArtilleryFire(ctx, u);                  // 70
    if (!fired && u.ammo <= 0 && await tryRearm(ctx, u)) return true;
    // Shoot-and-scoot: a battery that has fired still displaces if it can —
    // and one that could NOT reach anything marches into range and fires from
    // the new position the same phase (move + fire are separate actions,
    // exactly as they are for the player).
    const moved = await tryArtilleryDisplace(ctx, u);
    if (!fired && moved && await tryArtilleryFire(ctx, u)) return true;
    return fired || moved;
  }
  if (DRONE_STRIKE_IDS.includes(u.typeId)) {
    if (await tryDroneStrike(ctx, u)) return true;                 // 65
    if (u.ammo <= 0 && await tryRearm(ctx, u)) return true;        // dry — cycle back
    const crept = await tryDroneCreep(ctx, u);
    // The creep may have walked a target into the strike envelope: launch from
    // the new position the same phase (move + fire are separate actions).
    if (crept && await tryDroneStrike(ctx, u)) return true;
    return crept;
  }
  if (u.typeId === 'recon_drone') {
    return tryReconPatrol(ctx, u);                                 // 45
  }
  if (traits(u).includes('jammer') || traits(u).includes('supply')) {
    return tryFollowBody(ctx, u);                                  // 40
  }

  // Line units: fight, hold, or advance.
  if (await tryDirectAttack(ctx, u)) return true;                  // 60
  if (onObjective(Game, u.hex) && (u.entrench || 0) >= 1 &&
      ctx.posture === 'defend') {
    return false;                                                  // 55 hold
  }
  const moved = await tryAdvance(ctx, u);                          // 40
  if (moved && await tryDirectAttack(ctx, u)) return true;         // strike after move
  return moved;
}

// ---------------------------------------------------------------------------
// Contract export
// ---------------------------------------------------------------------------
export async function runAITurn(Game) {
  const t0 = now();
  // A RED phase is a beat in the turn, not a cutscene: once the presentation
  // budget is spent the remaining orders resolve without pans or holds.
  const overBudget = () => (now() - t0) > PRESENT_BUDGET_MS;
  let cine = null;
  try {
    cine = createCinema(Game, overBudget);
    const posture = getPosture(Game);
    memoryTick(Game, posture);

    const reds = aliveOf(Game, 'red');
    const ctx = {
      Game,
      cine,
      posture,
      blues: aliveOf(Game, 'blue'),
      reds,
      known: knownBlue(Game),
      anchor: null,
      intel: INTEL_BUDGET,
      interdicted: false,
      firedHexes: new Set(),
      said: new Set(),
      // missions = indirect fire, shots = direct engagements, strikes = drones.
      // Kept apart so the phase summary never calls a tank shot a fire mission.
      stats: { moves: 0, missions: 0, shots: 0, strikes: 0 },
      async beat(framed, ms) { if (framed && !overBudget()) await delay(ms); },
    };
    ctx.anchor = threatAnchor(Game, reds, ctx.known);

    if (!reds.length) {
      Game.emit('log', 'RED command has no forces able to act.');
    } else {
      Game.emit('log', postureLine(Game, posture, reds));
      await delay(220);

      const order = reds
        .filter((u) => !(u.moved && u.fired))
        .sort((a, b) => initiativeOf(a) - initiativeOf(b));

      for (const u of order) {
        if (Game.phase === 'over') break;
        if (!u.alive) continue;
        try {
          await actUnit(ctx, u);
        } catch (err) {
          // The unit still passes (the turn must always resolve — contract),
          // but never silently: a repeated line here is a systematic failure
          // and the whole "RED does nothing" era began as swallowed throws.
          console.error('[ai] UNIT ORDERS THREW — unit passes:', u.typeId, u.id, err);
          try {
            Game.emit('log', `AI ERROR — RED ${u.typeId} passes its turn (exception; see console).`);
          } catch (_) { /* the log bus itself is down */ }
        }
      }

      // CRITIQUE 19(a): the line is never allowed to be completely inert.
      if (Game.phase !== 'over' && ctx.stats.moves === 0) {
        await insistOnMovement(ctx);
      }

      // A phase that fired nothing reports the work a dug-in defence actually
      // does, so "quiet" never reads as "broken".
      const st = ctx.stats;
      if (Game.phase !== 'over' && !st.missions && !st.shots && !st.strikes) {
        const line = sappersLine(Game, aliveOf(Game, 'red'));
        if (line) Game.emit('log', line);
      }

      const bits = [];
      const plural = (n, one) => `${n} ${one}${n > 1 ? 's' : ''}`;
      if (st.missions) bits.push(plural(st.missions, 'fire mission'));
      if (st.shots) bits.push(plural(st.shots, 'engagement'));
      if (st.strikes) bits.push(plural(st.strikes, 'drone strike'));
      if (st.moves) bits.push(plural(st.moves, 'movement'));
      Game.emit('log', bits.length
        ? `RED phase complete — ${bits.join(', ')}.`
        : 'RED phase complete — the line stays silent.');
    }
  } catch (err) {
    console.error('[ai] RED TURN THREW — phase abandoned (systemic — investigate):', err);
    try {
      Game.emit('log', 'AI ERROR — RED turn aborted by an exception; see console.');
    } catch (_) { /* the log bus itself is down */ }
  }

  // CRITIQUE 20: hold on the action before control goes back to the player, and
  // never let the phase be so short that the player misses that it happened.
  try {
    if (cine && cine.shown) await delay(PHASE_TAIL_MS);
    const spent = now() - t0;
    if (spent < MIN_PHASE_MS) await delay(MIN_PHASE_MS - spent);
  } catch (_) { /* pacing is cosmetic */ }
}
