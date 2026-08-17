// STEEL SIGNAL — game/state.js
// The central store: turn structure, movement (Dijkstra over terrain cost with
// animated multi-hex moves), objectives, requisition economy, reinforcement
// waves, victory/defeat, and the event bus every other module subscribes to.
//
// Contract: export const Game (singleton).
//
// Division of labour with combat.js — combat.js is AUTHORITATIVE for damage: it
// spends ammo, sets `fired`, applies damage/suppression/veterancy, kills units
// and emits 'unitAttacked' / 'unitKilled' / 'infraDestroyed' itself. state.js
// never re-emits those; it validates the order, delegates, then does the
// post-action bookkeeping (fog, capture, victory).
//
// Canonical events emitted here:
//   select, deselect            (also emitted by hud.js — both sides listen)
//   unitMoved(unit)             after a completed move
//   unitDeployed(unit)          extra: reinforcement / purchase spawn
//   turnStarted({turn, side})   turnEnded({turn, side})
//   objectiveTaken(objective)   resourcesChanged({blue, red, side, delta})
//   entrench(unit)              gameOver(result)   log(string)
//   unitResupplied({unit})      after §3.1 end-of-turn resupply applied

import { hexDistance, hexNeighbors, hexToWorld } from '../world/terrain.js';
import { createUnit, attachTerrain, UNIT_TYPES } from '../units/units.js';
import {
  resolveAttack,
  fpvStrike as combatFpvStrike,
  loiterStrike as combatLoiterStrike,
  artilleryBarrage as combatArtilleryBarrage,
  effectiveMove,
} from './combat.js';
import { runAITurn } from './ai.js';
import { refreshFog, isVisibleTo } from './fog.js';

// ---------------------------------------------------------------------------
// Constants — GAMEPLAY.md §2, §6, §9
// ---------------------------------------------------------------------------
const INCOME = { base: 10, village: 5, town: 15, bridgeExit: 5 };
const RED_INCOME_BASE = 20;
const RED_SUBSTATION_INCOME = 10;

const SUPPLY_HEAL = 2;
const SUPPLY_HEAL_CAP = 8;
const REPLACEMENT_MAX_HP = 10;

const ENTRENCH_MAX = 2;
const ENTRENCH_MAX_SAPPER = 3;

const MOVE_MS_PER_HEX = 400;        // ≈ 2.5 hex/s (ARCHITECTURE)
const FLY_MS_PER_HEX = 240;

const MIN_BLUE_COMBAT_UNITS = 4;    // §6.1 defeat threshold

// Per-type movement / cover normalisation (GAMEPLAY.md §2). The terrain module
// owns the *look*; these numbers are gameplay law, so they are re-asserted on
// whatever tiles we are handed.
const TERRAIN_RULES = {
  road: { moveCost: 0.5, cover: 0 },
  grass: { moveCost: 1, cover: 0 },
  field: { moveCost: 1, cover: 0 },
  forest: { moveCost: 2, cover: 2 },
  town: { moveCost: 1, cover: 3 },
  mud: { moveCost: 2, cover: 0 },
  water: { moveCost: Infinity, cover: 0 },
};

// §6.1 counts only manoeuvre units towards the "combat-ineffective" threshold.
const NON_COMBAT_CLASSES = new Set(['support', 'drone']);
const HARD_TARGET_IDS = new Set(['mbt', 'ifv', 'apc', 'spg', 'mlrs', 'aa']);

const key = (h) => `${h.q},${h.r}`;
const sameHex = (a, b) => !!a && !!b && a.q === b.q && a.r === b.r;

// ---- ROUND-5 FIX 19: the move-order shape contract, support cast -----------
// `moveUnit()` used to accept exactly one shape and return silently for every
// other, which is how a wrong call survived two rounds of capture harnesses.
// These three keep the complaint short, precise and — crucially — ONCE per
// distinct message: a broken script in a per-turn loop must not turn the
// console into a wall that hides the next real error.
// `h.q != null` first, because `Number(null)` is 0 and would let `{q: null}`
// pass as a hex at the origin — exactly the class of silent wrong answer this
// fix exists to stop.
const isHexLike = (h) => !!h && typeof h === 'object' &&
  h.q != null && h.r != null &&
  Number.isFinite(Number(h.q)) && Number.isFinite(Number(h.r));

const _complained = new Set();
const COMPLAIN_CAP = 24;             // the messages carry hex coords, so the
                                     // distinct-message set is bounded by the
                                     // caller's map positions, not by 1. Cap it
                                     // so a broken script left running all
                                     // match cannot fill the console anyway.
function shapeComplaint(msg) {
  if (_complained.has(msg) || _complained.size >= COMPLAIN_CAP) return;
  _complained.add(msg);
  console.error(`[Game] ${msg}`);
}

function describeOrder(o) {
  if (o === null) return 'null';
  if (Array.isArray(o)) return `an array of ${o.length}`;
  const t = typeof o;
  if (t !== 'object') return `${t} ${String(o)}`;
  const q = o.q, r = o.r;
  return `object {q: ${String(q)}, r: ${String(r)}}`;
}

function hasTrait(u, trait) {
  return !!(u && u.type && Array.isArray(u.type.traits) &&
    u.type.traits.includes(trait));
}

function isFlyer(u) {
  return !!u && u.typeId === 'recon_drone';
}

function isGroundHolder(u) {
  // Only ground units capture (GAMEPLAY.md §6) — drones fly, they do not hold.
  return !!u && !!u.type && u.type.class !== 'drone';
}

function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Time-driven tween. Every value is derived from the clock, never accumulated,
// so the callback rate is free to vary or to be delivered twice in a row.
//
// CRITIQUE r6, INTEGRATOR. This used to be rAF-only with a single
// `setTimeout(finish, dur + 400)` net. In the automation tab
// `document.hidden === true` and **rAF delivers exactly 0 frames per second** —
// the same trap the r5 critique lost an hour to on the render loop, which the
// engine already fixed with `setFrameDriver('timer')`. Here it was worse than a
// stall: `moveUnit()` awaits this per hex and holds `Game._moving` across the
// walk, and `moveUnit`/`endTurn` both refuse outright while `_moving` is set —
// so ONE move ordered from a script latched `_moving` true and every later move
// and every end-turn was silently refused for the rest of the session. A
// scripted play-test of the game was impossible; measured directly (rAF frames
// in one second: 0, `_moving`: true, unchanged 3 s later).
//
// The fix is to run a plain `setInterval` ALONGSIDE rAF for the tween's whole
// life. A visible tab still animates on the display refresh; a hidden one is
// carried by the interval. `k` is read from the clock on every callback and
// never accumulated, so a doubled or a skipped tick changes nothing — this
// cannot move where a unit ends up, what it costs, or any combat number.
const TWEEN_WATCHDOG_MS = 24;

function tween(durationMs, onUpdate) {
  if (durationMs <= 0) {                 // unseen move — apply the end state now
    try { onUpdate(1); } catch (_) { /* visual only */ }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const dur = Math.max(1, durationMs);
    const hasRaf = typeof requestAnimationFrame === 'function';
    const canCancelRaf = typeof cancelAnimationFrame === 'function';
    const now = () => ((typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now());
    const t0 = now();
    let done = false, rafId = 0, intervalId = 0;
    const disarm = () => {
      if (rafId && canCancelRaf) cancelAnimationFrame(rafId);
      if (intervalId) clearInterval(intervalId);
      rafId = 0; intervalId = 0;
    };
    const finish = () => {
      if (done) return;
      done = true;
      disarm();
      try { onUpdate(1); } catch (_) { /* visual only */ }
      resolve();
    };
    function stepFn() {
      if (done) return;
      const k = Math.min(1, (now() - t0) / dur);
      try { onUpdate(k); } catch (_) { /* visual only */ }
      if (k >= 1) { finish(); return; }
      if (hasRaf) rafId = requestAnimationFrame(stepFn);
    }
    // The watchdog is ONE `setInterval`, not a chain of `setTimeout`s, and that
    // distinction is the whole fix. Chrome's intensive throttling clamps NESTED
    // timers in a page that has been hidden for a few minutes to roughly one
    // callback per minute — a self-rescheduling `setTimeout` chain (and the old
    // `setTimeout(finish, dur + 400)` backstop with it) therefore turned one
    // hex of movement into a minute of wall clock, which is indistinguishable
    // from a wedged turn. A plain interval is not throttled that way: it is
    // what `engine.setFrameDriver('timer')` already uses to deliver a measured
    // 72 fps in this same hidden tab.
    intervalId = setInterval(stepFn, TWEEN_WATCHDOG_MS);
    if (hasRaf) rafId = requestAnimationFrame(stepFn);
  });
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------
const listeners = new Map();

// ---------------------------------------------------------------------------
// Game singleton
// ---------------------------------------------------------------------------
export const Game = {
  units: [],
  turn: 1,
  maxTurns: 16,
  side: 'blue',
  phase: 'setup',           // 'setup' | 'play' | 'over'
  selected: null,
  resources: { blue: 0, red: 0 },
  objectives: [],
  deps: null,
  result: null,

  // strategic effects written by combat.js (§5) — created here so every module
  // sees the same object shape from frame zero
  infraEffects: {
    substationDead: false,
    railYardDead: false,
    commsDead: false,
    fuelDepotTurns: 0,
    deadBridges: [],
  },

  _waves: [],
  _deployUsed: new Set(),
  _moving: false,
  _turnBusy: false,
  _endTurnPending: false,
  _setupDone: false,

  // ---------------------------------------------------------------- lifecycle

  init(deps) {
    this.deps = deps || {};
    const scenario = this.deps.scenario || null;
    const terrain = this.deps.terrain || null;

    attachTerrain(terrain);

    if (scenario) {
      this.maxTurns = scenario.maxTurns ?? 16;
      const start = scenario.startResources || { blue: 200, red: 120 };
      this.resources = { blue: start.blue ?? 200, red: start.red ?? 120 };
      this.objectives = (scenario.objectives || []).map((o) => ({
        ...o,
        hex: { q: o.hex.q, r: o.hex.r },
        owner: o.owner || 'red',
      }));
      this._waves = (scenario.reinforcements || []).map((w) => ({
        ...w,
        units: (w.units || []).map((u) => ({ ...u })),
        delivered: false,
        cancelled: false,
      }));
    }

    this._applyTerrainData();
    this._ensureInfrastructure();

    // §5: killing the rail yard reshapes RED's timetable.
    this.on('infraDestroyed', (obj) => {
      try { this._onInfraDestroyed(obj); } catch (_) { /* never break combat */ }
    });
  },

  start() {
    if (this.phase === 'play') return;
    this._firstTimeSetup();
    this.phase = 'play';
    this.side = 'blue';
    this.turn = Math.max(1, this.turn | 0);

    this._safeFog();
    this._income('blue');

    this.emit('turnStarted', { turn: this.turn, side: this.side });

    const scen = (this.deps && this.deps.scenario) || {};
    this.emit('log', `OPERATION ${(scen.name || 'SIGNAL ON THE VOVCHA').toUpperCase()} — H-HOUR.`);
    this.emit('log',
      'Recon the far bank before you commit armour: the treelines are held.');
    this.emit('log',
      `Objectives: ${this.objectives.filter((o) => o.primary)
        .map((o) => o.name).join(' · ')}.`);
  },

  // ---------------------------------------------------------------- event bus

  on(evt, cb) {
    if (typeof cb !== 'function') return () => {};
    if (!listeners.has(evt)) listeners.set(evt, []);
    listeners.get(evt).push(cb);
    return () => {
      const arr = listeners.get(evt);
      if (!arr) return;
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  },

  emit(evt, ...args) {
    const arr = listeners.get(evt);
    if (!arr || !arr.length) return;
    for (const cb of [...arr]) {
      try { cb(...args); } catch (err) {
        console.warn(`[Game] listener error on '${evt}':`, err);
      }
    }
  },

  // ---------------------------------------------------------------- queries

  unitAt(hex) {
    if (!hex) return null;
    for (const u of this.units) {
      if (u.alive && u.hex && u.hex.q === hex.q && u.hex.r === hex.r) return u;
    }
    return null;
  },

  tileAt(hex) {
    const terrain = this.deps && this.deps.terrain;
    if (!terrain || !terrain.tiles || !hex) return null;
    return terrain.tiles.get(key(hex)) || null;
  },

  objectiveAt(hex) {
    return this.objectives.find((o) => sameHex(o.hex, hex)) || null;
  },

  infrastructureAt(hex) {
    const features = this.deps && this.deps.features;
    const list = (features && features.infrastructure) || [];
    return list.find((o) => o.alive && sameHex(o.hex, hex)) || null;
  },

  visibleTo(hex, faction) {
    try { return isVisibleTo(hex, faction) !== false; } catch (_) { return true; }
  },

  /**
   * §3.1 pre-check for the HUD: true when ending the turn RIGHT NOW would
   * resupply `unit` (adjacent to a friendly supply truck, has not moved or
   * fired, and would actually gain ammo or hp). Mirrors _supplyTick exactly —
   * if this returns true, the end-of-turn tick WILL fire for this unit.
   */
  resupplyEligible(unit) {
    if (!unit || !unit.alive || unit.moved || unit.fired) return false;
    if (this.phase !== 'play') return false;
    if (hasTrait(unit, 'supply')) return false;
    if (!this._adjacentSupply(unit)) return false;
    const maxAmmo = (unit.type && unit.type.ammo) || 0;
    return (maxAmmo > 0 && unit.ammo < maxAmmo) || unit.hp < SUPPLY_HEAL_CAP;
  },

  /**
   * True when any hex of `path` (or the unit's current hex) is spotted by the
   * human side — i.e. the move is worth animating. Used to skip the tween for
   * enemy movement the player cannot see.
   */
  _pathIsSeen(unit, path) {
    try {
      if (this.visibleTo(unit.hex, 'blue')) return true;
      for (let i = 0; i < path.length; i++) {
        if (this.visibleTo(path[i], 'blue')) return true;
      }
    } catch (_) { return true; }
    return false;
  },

  // ---------------------------------------------------------------- movement

  /** Movement cost of entering `tile` for `unit` (Infinity = impassable). */
  moveCostFor(unit, tile) {
    if (!tile) return Infinity;
    if (isFlyer(unit)) return 1;            // §1 notes: flies, all hexes cost 1
    if (tile.bridge) return TERRAIN_RULES.road.moveCost;
    const rule = TERRAIN_RULES[tile.type];
    const cost = rule ? rule.moveCost : (tile.moveCost ?? 1);
    return Number.isFinite(cost) ? cost : Infinity;
  },

  /** Hexes adjacent to a visible armed enemy — entering one ends movement. */
  _zocFor(unit) {
    const zoc = new Set();
    if (isFlyer(unit)) return zoc;          // air ignores zones of control
    for (const e of this.units) {
      if (!e.alive || e.faction === unit.faction) continue;
      if (isFlyer(e)) continue;
      if (((e.type && e.type.range) || 0) < 1) continue;
      if (!this.visibleTo(e.hex, unit.faction)) continue;
      for (const n of hexNeighbors(e.hex)) zoc.add(key(n));
    }
    return zoc;
  },

  /** Dijkstra over terrain cost. Returns { dist, prev } keyed by "q,r". */
  _moveField(unit) {
    const terrain = this.deps && this.deps.terrain;
    const dist = new Map();
    const prev = new Map();
    if (!unit || !unit.alive || !terrain || !terrain.tiles) return { dist, prev };

    const budget = Math.max(0, effectiveMove(unit));
    const startKey = key(unit.hex);
    dist.set(startKey, 0);
    if (budget <= 0) return { dist, prev };

    const zoc = this._zocFor(unit);
    const open = [{ k: startKey, h: { q: unit.hex.q, r: unit.hex.r }, d: 0 }];
    const closed = new Set();

    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].d < open[bi].d) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (closed.has(cur.k)) continue;
      closed.add(cur.k);
      // Entering an enemy zone of control ends the move (GAMEPLAY.md §2).
      if (cur.k !== startKey && zoc.has(cur.k)) continue;

      for (const n of hexNeighbors(cur.h)) {
        const nk = key(n);
        if (closed.has(nk)) continue;
        const tile = terrain.tiles.get(nk);
        if (!tile) continue;
        const cost = this.moveCostFor(unit, tile);
        if (!Number.isFinite(cost)) continue;
        const occ = this.unitAt(n);
        if (occ && occ.faction !== unit.faction) continue;   // enemies block
        const nd = cur.d + cost;
        if (nd > budget + 1e-6) continue;
        const known = dist.get(nk);
        if (known !== undefined && known <= nd + 1e-9) continue;
        dist.set(nk, nd);
        prev.set(nk, { q: cur.h.q, r: cur.h.r });
        open.push({ k: nk, h: { q: n.q, r: n.r }, d: nd });
      }
    }
    return { dist, prev };
  },

  /**
   * Hexes this unit could finish its move on.
   *
   * ROUND-5 FIX 19 — CONTRACT, stated once so nobody has to read the loop:
   * this answers a SET of legal DESTINATIONS, in no particular order. It is not
   * a path and its order carries no meaning. `moveUnit()` walks a PATH. The two
   * are now interoperable — `moveUnit(u, reachableHexes(u)[i])` resolves the
   * path itself, and `moveTo(u, hex)` is the explicit spelling — but handing
   * the whole array to `moveUnit()` is still a caller bug and now says so out
   * loud instead of returning silently. See moveUnit().
   */
  reachableHexes(unit) {
    if (!unit || !unit.alive || unit.moved || this.phase === 'over') return [];
    const { dist } = this._moveField(unit);
    const startKey = key(unit.hex);
    const out = [];
    for (const k of dist.keys()) {
      if (k === startKey) continue;
      const parts = k.split(',');
      const h = { q: parseInt(parts[0], 10), r: parseInt(parts[1], 10) };
      if (this.unitAt(h)) continue;         // cannot stop on an occupied hex
      out.push(h);
    }
    return out;
  },

  /** Cheapest path (excluding the start hex) or null. */
  pathTo(unit, hex) {
    if (!unit || !unit.alive || !hex || unit.moved) return null;
    if (sameHex(unit.hex, hex)) return null;
    if (this.unitAt(hex)) return null;
    const { dist, prev } = this._moveField(unit);
    const target = key(hex);
    if (!dist.has(target)) return null;
    const path = [];
    let cur = { q: hex.q, r: hex.r };
    const startKey = key(unit.hex);
    let guard = 0;
    while (key(cur) !== startKey && guard++ < 4096) {
      path.push({ q: cur.q, r: cur.r });
      const p = prev.get(key(cur));
      if (!p) return null;
      cur = p;
    }
    path.reverse();
    return path.length ? path : null;
  },

  /**
   * Move `unit` to `order`, animating the mesh and updating fog per hex.
   * Resolves `true` if the unit actually walked, `false` if the order was
   * refused. (It has always been fire-and-forget; the boolean is additive and
   * no existing caller reads it.)
   *
   * ---- ROUND-5 FIX 19: the shape contract, closed ------------------------
   * Carried open for two rounds. `reachableHexes()` answers `{q, r}`
   * DESTINATIONS; this walks a PATH — an array of hexes each adjacent to the
   * last, which is what `pathTo()` returns. So the obvious script,
   *     Game.moveUnit(u, Game.reachableHexes(u)[0])
   * failed the `hexDistance(...) !== 1` guard on its first step and returned
   * silently, and `Game.moveUnit(u, Game.reachableHexes(u))` did the same. Two
   * capture harnesses "moved" units that never moved, and hud.js grew
   * `Game.ui.moveTo` to paper over it. That wrapper stays (it is a documented
   * surface now), but the contract is normalised HERE, where both halves live:
   *
   *   · a single hex  `{q, r}`            → path resolved via pathTo()
   *   · a one-element array `[{q, r}]`    → same, whether or not it is adjacent
   *   · a contiguous array (step 0 adjacent to the unit) → walked as a path,
   *     byte-for-byte the behaviour that shipped; nothing about a legal call
   *     changes
   *   · a multi-hex array that is NOT contiguous → this is `reachableHexes()`
   *     output handed to the wrong door. It is a caller bug with no sane
   *     interpretation (the array is a SET; its last element is arbitrary), so
   *     it is refused LOUDLY — once per distinct message — instead of no-oping.
   *
   * Nothing here touches movement cost, terrain rules or the walk itself.
   */
  async moveUnit(unit, order) {
    if (this.phase === 'over') return false;
    if (!unit || !unit.alive || unit.moved || this._moving) return false;

    const path = this._asPath(unit, order);
    if (!path) return false;

    const terrain = this.deps && this.deps.terrain;
    const mesh = unit.mesh || null;
    this._moving = true;
    this._releaseTile(unit);

    try {
      let perHex = isFlyer(unit) ? FLY_MS_PER_HEX : MOVE_MS_PER_HEX;
      // An enemy column the player cannot see is not worth watching: walk it
      // instantly (fog still updates per hex, so it pops into view the moment it
      // is spotted, and the RED turn does not take a minute of dead air).
      if (unit.faction !== 'blue' && !this._pathIsSeen(unit, path)) perHex = 0;
      for (let i = 0; i < path.length; i++) {
        const raw = path[i];
        if (!unit.alive) break;
        const step = { q: raw.q, r: raw.r };
        if (hexDistance(unit.hex, step) !== 1) break;
        const tile = this.tileAt(step);
        if (!tile) break;
        if (!Number.isFinite(this.moveCostFor(unit, tile))) break;
        // Columns pass through each other; nobody stops on an occupied hex and
        // nobody drives into an enemy.
        const occ = this.unitAt(step);
        if (occ && occ !== unit &&
            (occ.faction !== unit.faction || i === path.length - 1)) break;

        const from = hexToWorld(unit.hex.q, unit.hex.r);
        const to = hexToWorld(step.q, step.r);
        const yaw = Math.atan2(-(to.z - from.z), to.x - from.x);
        const yaw0 = mesh ? mesh.rotation.y : yaw;
        const dYaw = shortestAngle(yaw0, yaw);

        await tween(perHex, (k) => {
          if (!mesh) return;
          const x = from.x + (to.x - from.x) * k;
          const z = from.z + (to.z - from.z) * k;
          const y = terrain && terrain.heightAt ? terrain.heightAt(x, z) : mesh.position.y;
          mesh.position.set(x, y, z);
          mesh.rotation.y = yaw0 + dYaw * Math.min(1, k * 2.4);
        });

        unit.hex = step;
        this._safeFog();
      }
    } finally {
      this._occupyTile(unit);
      unit.moved = true;
      unit.entrench = 0;                    // §2: entrenchment resets on move
      this._moving = false;
    }

    this.emit('unitMoved', unit);
    this._afterAction();

    if (this._endTurnPending && !this._moving) {
      this._endTurnPending = false;
      this.endTurn();
    }
    return true;
  },

  /**
   * ROUND-5 FIX 19 — the whole shape contract, in one place. Returns a walkable
   * path (array of adjacent `{q, r}`) or `null`, and is the ONLY thing that
   * decides whether a caller's argument was a path, a destination or a bug.
   * Pure: it reads `pathTo()` and nothing else, and mutates nothing.
   */
  _asPath(unit, order) {
    if (!order) return null;

    if (!Array.isArray(order)) {
      if (!isHexLike(order)) {
        shapeComplaint('moveUnit(unit, order): `order` must be a hex {q, r}, ' +
          'or a path — an array of hexes each adjacent to the last (see ' +
          'Game.pathTo). Got: ' + describeOrder(order));
        return null;
      }
      return this.pathTo(unit, order);
    }

    if (!order.length) return null;
    if (!order.every(isHexLike)) {
      shapeComplaint('moveUnit(unit, order): every element of `order` must be ' +
        'a hex {q, r}. Got: ' + describeOrder(order));
      return null;
    }
    // The shipped shape first, so a legal call costs nothing new: step 0
    // adjacent to the unit means this is a real path and it is walked as-is.
    if (unit.hex && hexDistance(unit.hex, order[0]) === 1) return order;
    // A single hex is a destination however it was wrapped.
    if (order.length === 1) return this.pathTo(unit, order[0]);

    // Everything else is `reachableHexes()` handed to the wrong door. There is
    // no defensible reading of it — the array is an unordered SET of legal
    // destinations, so "the last one" would move the unit somewhere the caller
    // never named. Refuse, and say exactly what to call instead.
    shapeComplaint('moveUnit(unit, order): got ' + order.length + ' hexes whose ' +
      'first (' + order[0].q + ',' + order[0].r + ') is not adjacent to the ' +
      'unit — that is a reachableHexes() SET, not a path. Use ' +
      'Game.moveTo(unit, hex), or Game.moveUnit(unit, Game.pathTo(unit, hex)).');
    return null;
  },

  /**
   * Move to a destination hex. The explicit spelling of the conversion the HUD
   * click handler has always done by hand (`pathTo` then `moveUnit`), so a
   * script never has to know that `reachableHexes()` and `moveUnit()` speak
   * different shapes. Returns the same promise `moveUnit()` does — which is
   * why `Game.ui.moveTo` in hud.js is NOT an alias of this: a promise is
   * truthy even for a refused order, so the HUD keeps the synchronous
   * boolean spelling for harnesses that branch on the return value.
   */
  moveTo(unit, hex) {
    return this.moveUnit(unit, hex);
  },

  // ---------------------------------------------------------------- combat

  /** Enemy units this unit may legally engage right now. */
  attackableTargets(unit) {
    if (!unit || !unit.alive || unit.fired || this.phase === 'over') return [];
    const type = unit.type || {};
    const range = type.range || 0;
    if (range < 1) return [];
    if ((type.ammo || 0) > 0 && unit.ammo <= 0) return [];

    const atk = type.attack || {};
    const out = [];
    for (const t of this.units) {
      if (!t.alive || t.faction === unit.faction) continue;
      const d = hexDistance(unit.hex, t.hex);
      if (d < 1 || d > range) continue;
      if (!this.visibleTo(t.hex, unit.faction)) continue;
      const air = t.typeId === 'recon_drone';
      if (air) {
        if (unit.typeId !== 'aa') continue;          // §1.1 only SHORAD
        if ((atk.air || 0) <= 0) continue;
      } else {
        const cat = HARD_TARGET_IDS.has(t.typeId) ? 'hard' : 'soft';
        if ((atk[cat] || 0) <= 0) continue;
      }
      out.push(t);
    }
    return out;
  },

  attack(unit, target) {
    if (this.phase === 'over' || !unit || !target) return null;
    if (!unit.alive || !target.alive) return null;
    if (unit.faction === target.faction) return null;
    const report = resolveAttack(unit, target);
    this._afterAction();
    return report;
  },

  // hud.js prefers these wrappers so ammo / fired bookkeeping and the
  // post-action pass (fog, capture, victory) stay in one place.
  fpvStrike(unit, target) {
    if (this.phase === 'over' || !unit || !target) return null;
    const report = combatFpvStrike(unit, target);
    this._afterAction();
    return report;
  },

  loiterStrike(unit, target) {
    if (this.phase === 'over' || !unit || !target) return null;
    const report = combatLoiterStrike(unit, target);
    this._afterAction();
    return report;
  },

  // ---- ROUND-5 FIX 18: a declined fire mission is now an ANSWER ------------
  // combat.js's `artilleryBarrage()` has six refusal paths (no indirect trait,
  // no ammo, out of range, dead battery, no hex, and the one that cost two
  // capture sessions an hour each: `friendly forces on target hex — fire
  // mission denied`). Every one of them returns through a `fail()` that pushes
  // a string into `report.events` and returns the blank report UNCHANGED —
  // `aborted: false`, `blind: false`, `dmgToDefender: 0` — and returns BEFORE
  // `Game.emit('unitAttacked')`, so vfx never hears about it either. From the
  // caller's side an order that was refused outright is shape-identical to one
  // that landed on empty ground. The player is told nothing at all.
  //
  // combat.js is not this module's to edit and its damage maths must not move,
  // so the fix is here, at the wrapper every caller already goes through, and
  // it is pure reporting:
  //   · DETECTION is the ammo/`fired` ledger, not a string match. Every refusal
  //     returns before `spendAttack()`, which is the single point of no return
  //     — it decrements ammo and sets `fired`. Every unit with the `indirect`
  //     trait carries ammo > 0 (spg 4, mlrs 3, loiter 3), so the ledger is
  //     decisive; the report's own damage/kill/infra/splash fields are used as
  //     an override so a mission that demonstrably landed can never be reported
  //     as declined even if the ledger is ever made ambiguous.
  //   · The returned object is made HONEST: `aborted`, `refused`, `fired` and
  //     `reason`. Nothing downstream reads `aborted` on this path (vfx only
  //     ever sees a report through `unitAttacked`, which a refusal never
  //     emits), so this cannot change what is drawn or what is damaged.
  //   · It is SURFACED once, for the player's own battery only: a comms-log
  //     line via the existing 'log' event and an 'orderRefused' event that
  //     hud.js turns into a toast. RED's declined missions stay silent — the
  //     player is not entitled to the enemy's fire-control problems.
  artilleryBarrage(unit, hex) {
    if (this.phase === 'over' || !unit || !hex) return null;
    const ledger = { fired: !!unit.fired, ammo: Number(unit.ammo) };
    const report = combatArtilleryBarrage(unit, hex);
    this._afterAction();
    if (!report) return report;

    const landed = report.dmgToDefender > 0 || !!report.killed || !!report.infra ||
      (Array.isArray(report.splash) && report.splash.length > 0);
    const spent = (!!unit.fired && !ledger.fired) ||
      (Number.isFinite(ledger.ammo) && Number(unit.ammo) < ledger.ammo);
    const declined = !landed && !spent;

    report.fired = !declined;
    if (!declined) return report;

    const events = Array.isArray(report.events) ? report.events : [];
    // combat.js appends its own "— fire mission denied" to the friendly-fire
    // string. Strip it here, once, so `report.reason` is a clean cause and
    // neither the log line nor the toast reads "…DENIED — … fire mission
    // denied."
    const reason = (events.length ? String(events[events.length - 1])
      : 'fire mission denied')
      .replace(/\s*[—–-]\s*fire mission denied\s*$/i, '').trim() ||
      'fire mission denied';
    report.aborted = true;
    report.refused = true;
    report.reason = reason;
    if (unit.faction === 'blue') {
      const who = (unit.type && unit.type.name) || 'Battery';
      this.emit('log', `${who} fire mission DENIED — ${reason}.`);
      this.emit('orderRefused', { unit, hex, kind: 'barrage', reason, report });
    }
    return report;
  },

  /** Dig in: spend the whole turn to gain a cover step immediately (§2). */
  entrench(unit) {
    if (this.phase === 'over' || !unit || !unit.alive) return false;
    if (unit.moved || unit.fired) return false;
    if (unit.type && unit.type.class === 'drone') return false;
    const max = hasTrait(unit, 'entrench_bonus') ? ENTRENCH_MAX_SAPPER : ENTRENCH_MAX;
    const before = unit.entrench || 0;
    unit.entrench = Math.min(max, before + 1);
    unit.moved = true;
    unit.fired = true;
    this.emit('entrench', unit);
    this.emit('log',
      `${unit.type.name} digs in (+${unit.entrench} cover${unit.entrench >= max ? ', fully prepared' : ''}).`);
    this._afterAction();
    return true;
  },

  // ---------------------------------------------------------------- economy

  canPurchase(typeId) {
    const type = UNIT_TYPES[typeId];
    if (!type || this.side !== 'blue' || this.phase !== 'play') return false;
    if (this.resources.blue < type.cost) return false;
    return this._freeDeployHexes().length > 0;
  },

  /** Buy a reinforcement at a west-edge deploy hex (one per hex per turn). */
  purchase(typeId, hex) {
    const type = UNIT_TYPES[typeId];
    if (!type) return null;
    if (this.side !== 'blue' || this.phase !== 'play') return null;
    if (this.resources.blue < type.cost) {
      this.emit('log', `Insufficient requisition for ${type.name} (${type.cost}).`);
      return null;
    }
    const free = this._freeDeployHexes();
    const spot = hex ? free.find((h) => sameHex(h, hex)) : free[0];
    if (!spot) {
      this.emit('log', 'No free deployment hex this turn.');
      return null;
    }
    this.resources.blue -= type.cost;
    this._deployUsed.add(key(spot));
    const unit = this._spawnUnit(typeId, 'blue', spot, { moved: true, fired: true });
    this.emit('resourcesChanged', {
      blue: this.resources.blue, red: this.resources.red,
      side: 'blue', delta: -type.cost,
    });
    this.emit('log', `${type.name} deploys at the staging area (−${type.cost}).`);
    return unit;
  },

  /**
   * Replacements (§6): a unit that skipped its turn beside a supply truck can
   * buy strength above the free supply cap, at cost/10 per hp. Veterancy is
   * kept — that is the whole point of preserving units.
   */
  buyReplacement(unit, hpWanted) {
    if (!unit || !unit.alive || unit.faction !== 'blue') return 0;
    if (this.side !== 'blue' || this.phase !== 'play') return 0;
    if (unit.moved || unit.fired) return 0;
    if (!this._adjacentSupply(unit)) return 0;
    const perHp = Math.ceil((unit.type.cost || 100) / 10);
    const want = Math.max(0, Math.min(
      hpWanted ?? (REPLACEMENT_MAX_HP - unit.hp), REPLACEMENT_MAX_HP - unit.hp));
    const afford = Math.floor(this.resources.blue / perHp);
    const got = Math.min(want, afford);
    if (got <= 0) return 0;
    this.resources.blue -= got * perHp;
    unit.hp += got;
    unit.moved = true;
    unit.fired = true;
    this.emit('resourcesChanged', {
      blue: this.resources.blue, red: this.resources.red,
      side: 'blue', delta: -got * perHp,
    });
    this.emit('log',
      `${unit.type.name} receives ${got} replacement${got > 1 ? 's' : ''} (−${got * perHp}).`);
    return got;
  },

  // ---------------------------------------------------------------- turns

  endTurn() {
    if (this.phase !== 'play' || this._turnBusy) return;
    // A player who hits END TURN while their last order is still animating must
    // not have the click swallowed — remember it and fire when the move lands.
    if (this._moving) { this._endTurnPending = true; return; }
    this._endTurnPending = false;
    this._turnBusy = true;
    Promise.resolve()
      .then(() => this._advance())
      .catch((err) => { console.warn('[Game] turn error:', err); })
      .then(() => { this._turnBusy = false; });
  },

  async _advance() {
    const ending = this.side;

    this._supplyTick(ending);
    this._entrenchTick(ending);
    this._captureTick(ending);
    this.emit('turnEnded', { turn: this.turn, side: ending });
    if (this.phase === 'over') return;

    if (ending === 'blue') {
      if (this._checkDecisive()) return;
      this.side = 'red';
      this._beginSide('red');
      try {
        await runAITurn(this);
      } catch (err) {
        console.warn('[Game] AI turn failed — RED passes:', err);
      }
      if (this.phase === 'over') return;
      await this._advance();                 // close out RED's turn
      return;
    }

    // RED just finished — roll the clock over to a new BLUE turn.
    if (this.turn >= this.maxTurns) {
      this._finalJudgement();
      return;
    }
    this.turn += 1;
    this.side = 'blue';
    this._beginSide('blue');
  },

  _beginSide(side) {
    for (const u of this.units) {
      if (!u.alive || u.faction !== side) continue;
      u.moved = false;
      u.fired = false;
    }
    if (side === 'blue') this._deployUsed = new Set();
    this._income(side);
    if (side === 'red') this._deliverWaves();
    this._safeFog();
    this.emit('turnStarted', { turn: this.turn, side });
    this.emit('log', side === 'blue'
      ? `TURN ${this.turn}/${this.maxTurns} — BLUE has the initiative.`
      : `RED phase — turn ${this.turn}/${this.maxTurns}.`);
    if (side === 'blue') this._checkSuddenDefeat();
  },

  _income(side) {
    let gain = 0;
    if (side === 'blue') {
      gain = INCOME.base;
      for (const o of this.objectives) {
        if (o.owner !== 'blue') continue;
        if (o.kind === 'town') gain += INCOME.town;
        else if (o.kind === 'bridge_exit') gain += INCOME.bridgeExit;
        else gain += INCOME.village;
      }
    } else {
      gain = RED_INCOME_BASE +
        (this.infraEffects.substationDead ? 0 : RED_SUBSTATION_INCOME);
    }
    this.resources[side] = (this.resources[side] || 0) + gain;
    this.emit('resourcesChanged', {
      blue: this.resources.blue, red: this.resources.red, side, delta: gain,
    });
    if (side === 'blue') {
      this.emit('log', `Requisition +${gain} (${this.resources.blue} available).`);
    }
  },

  /** §3.1: a unit holding station beside a supply truck rearms and patches up. */
  _supplyTick(side) {
    for (const u of this.units) {
      if (!u.alive || u.faction !== side) continue;
      if (u.moved || u.fired) continue;
      if (hasTrait(u, 'supply')) continue;
      if (!this._adjacentSupply(u)) continue;
      const maxAmmo = (u.type && u.type.ammo) || 0;
      const rearmed = maxAmmo > 0 && u.ammo < maxAmmo;
      const healed = u.hp < SUPPLY_HEAL_CAP;
      if (!rearmed && !healed) continue;
      if (rearmed) u.ammo = maxAmmo;
      if (healed) u.hp = Math.min(SUPPLY_HEAL_CAP, u.hp + SUPPLY_HEAL);
      this.emit('unitResupplied', { unit: u });
      if (side === 'blue') {
        this.emit('log',
          `${u.type.name} RESUPPLIED beside the truck — ${u.hp} hp, ammo full (${u.ammo}).`);
      }
    }
  },

  _adjacentSupply(unit) {
    return this.units.some((s) =>
      s.alive && s.faction === unit.faction && hasTrait(s, 'supply') &&
      hexDistance(s.hex, unit.hex) === 1);
  },

  /** §2: +1 entrenchment per full turn spent neither moving nor attacking. */
  _entrenchTick(side) {
    for (const u of this.units) {
      if (!u.alive || u.faction !== side) continue;
      if (u.moved || u.fired) continue;
      if (u.type && u.type.class === 'drone') continue;
      const max = hasTrait(u, 'entrench_bonus') ? ENTRENCH_MAX_SAPPER : ENTRENCH_MAX;
      if ((u.entrench || 0) < max) u.entrench = (u.entrench || 0) + 1;
    }
  },

  /** §6: capturing = ending a ground unit's turn on the objective hex. */
  _captureTick(side) {
    for (const o of this.objectives) {
      const holder = this.unitAt(o.hex);
      if (!holder || holder.faction !== side || !isGroundHolder(holder)) continue;
      if (o.owner === side) continue;
      o.owner = side;
      this.emit('objectiveTaken', o);
      this.emit('log', side === 'blue'
        ? `${o.name.toUpperCase()} SECURED.`
        : `${o.name.toUpperCase()} lost to RED.`);
    }
  },

  // ---------------------------------------------------------------- waves

  _deliverWaves() {
    for (const w of this._waves) {
      if (w.delivered || w.cancelled) continue;
      if ((w.turn || 0) > this.turn) continue;
      const anchor = w.viaEast
        ? (w.fallback || (this.deps.scenario && this.deps.scenario.edgeEntry))
        : (w.at || w.hex);
      const spots = this._freeHexesNear(anchor, (w.units || []).length);
      if (!spots.length) continue;
      w.delivered = true;
      let i = 0;
      for (const def of (w.units || [])) {
        const spot = spots[i++] || spots[spots.length - 1];
        if (!spot) break;
        this._spawnUnit(def.type, w.faction || 'red', spot,
          { moved: false, fired: false, entrench: def.entrench || 0 });
      }
      this.emit('log', w.viaEast
        ? 'RED reinforcements march on from the eastern map edge — delayed by the ruined yard.'
        : (w.label || 'RED reinforcements detrain at the rail yard.'));
    }
  },

  _onInfraDestroyed(obj) {
    if (!obj) return;
    if (obj.kind === 'bridge' || obj.kind === 'rail_bridge') {
      const tile = this.tileAt(obj.hex);
      if (tile) {
        tile.type = 'water';
        tile.bridge = false;
        tile.moveCost = Infinity;
        tile.cover = 0;
      }
      return;
    }
    if (obj.kind !== 'rail_yard') return;
    let delayed = 0;
    let cancelled = 0;
    for (const w of this._waves) {
      if (w.delivered || w.cancelled) continue;
      if ((w.turn || 0) <= this.turn + 2) {
        w.turn = (w.turn || this.turn) + 2;
        w.viaEast = true;
        delayed++;
      } else {
        w.cancelled = true;
        cancelled++;
      }
    }
    if (delayed || cancelled) {
      this.emit('log',
        `Rail net severed — ${delayed} RED wave(s) rerouted to the east edge, ` +
        `${cancelled} CANCELLED.`);
    }
  },

  _freeHexesNear(anchor, count) {
    const out = [];
    if (!anchor) return out;
    const want = Math.max(1, count || 1);
    const seen = new Set();
    const queue = [{ q: anchor.q, r: anchor.r }];
    let guard = 0;
    while (queue.length && out.length < want && guard++ < 400) {
      const h = queue.shift();
      const k = key(h);
      if (seen.has(k)) continue;
      seen.add(k);
      const tile = this.tileAt(h);
      if (tile && Number.isFinite(this.moveCostFor({ typeId: 'infantry' }, tile)) &&
          !this.unitAt(h)) {
        out.push(h);
      }
      for (const n of hexNeighbors(h)) {
        if (!seen.has(key(n))) queue.push(n);
      }
    }
    return out;
  },

  _freeDeployHexes() {
    const scen = (this.deps && this.deps.scenario) || {};
    return (scen.deployHexes || [])
      .filter((h) => !this._deployUsed.has(key(h)) && !this.unitAt(h) && this.tileAt(h));
  },

  /** Contract's `.deploy…`: put a brand-new unit on the map mid-scenario. */
  deployUnit(typeId, faction, hex, opts) {
    return this._spawnUnit(typeId, faction, hex, opts || {});
  },

  _spawnUnit(typeId, faction, hex, opts) {
    const o = opts || {};
    let unit = null;
    try {
      unit = createUnit(typeId, faction, hex);
    } catch (err) {
      console.warn('[Game] spawn failed:', typeId, err);
      return null;
    }
    unit.moved = !!o.moved;
    unit.fired = !!o.fired;
    unit.entrench = o.entrench || 0;
    unit.veterancy = o.veterancy || 0;
    if (o.name) unit.name = o.name;

    const engine = this.deps && this.deps.engine;
    if (engine && engine.scene && unit.mesh) engine.scene.add(unit.mesh);
    this.units.push(unit);
    this._occupyTile(unit);
    this.emit('unitDeployed', unit);
    this._safeFog();
    return unit;
  },

  // ---------------------------------------------------------------- victory

  _blueCombatCount() {
    return this.units.filter((u) =>
      u.alive && u.faction === 'blue' && u.type &&
      !NON_COMBAT_CLASSES.has(u.type.class)).length;
  },

  _primaryHeld() {
    return this.objectives.filter((o) => o.primary && o.owner === 'blue').length;
  },

  _checkDecisive() {
    const town = this.objectives.find((o) => o.kind === 'town');
    const exits = this.objectives.filter((o) => o.kind === 'bridge_exit');
    const townHeld = !!town && town.owner === 'blue';
    const exitsHeld = exits.filter((o) => o.owner === 'blue').length;
    if (townHeld && exits.length > 0 && exitsHeld === exits.length) {
      this._finish('blue', 'decisive',
        'Sokil and both crossings are in BLUE hands with the clock still running.');
      return true;
    }
    if (!this.units.some((u) => u.alive && u.faction === 'red')) {
      this._finish('blue', 'decisive', 'RED forces on this axis have been annihilated.');
      return true;
    }
    return this._checkSuddenDefeat();
  },

  _checkSuddenDefeat() {
    if (this.phase === 'over') return true;
    if (this._blueCombatCount() < MIN_BLUE_COMBAT_UNITS) {
      this._finish('red', 'defeat',
        'The brigade is combat-ineffective — fewer than four manoeuvre units remain.');
      return true;
    }
    return false;
  },

  _finalJudgement() {
    const town = this.objectives.find((o) => o.kind === 'town');
    const exits = this.objectives.filter((o) => o.kind === 'bridge_exit');
    const townHeld = !!town && town.owner === 'blue';
    const exitsHeld = exits.filter((o) => o.owner === 'blue').length;
    if (townHeld && exitsHeld === exits.length && exits.length > 0) {
      this._finish('blue', 'decisive', 'The objective line was taken before the clock ran out.');
    } else if (townHeld && exitsHeld >= 1) {
      this._finish('blue', 'marginal',
        'Sokil is held and one crossing is open — the axis is viable, barely.');
    } else {
      this._finish('red', 'defeat',
        'The clock ran out with the objective line still in RED hands.');
    }
  },

  _finish(winner, outcome, reason) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    const blueLosses = this.units.filter((u) => !u.alive && u.faction === 'blue').length;
    const redLosses = this.units.filter((u) => !u.alive && u.faction === 'red').length;
    const victory = winner === 'blue';
    let grade = 'D';
    if (victory) {
      const speed = Math.max(0, this.maxTurns - this.turn);
      const score = (outcome === 'decisive' ? 60 : 30) + speed * 3 - blueLosses * 6;
      grade = score >= 75 ? 'S' : score >= 55 ? 'A' : score >= 35 ? 'B' : 'C';
    }
    this.result = {
      winner,
      victory,
      outcome,
      result: outcome,
      reason,
      turn: this.turn,
      maxTurns: this.maxTurns,
      blueLosses,
      redLosses,
      objectivesHeld: this._primaryHeld(),
      grade,
    };
    this.emit('log', victory
      ? `OPERATION COMPLETE — ${outcome.toUpperCase()} VICTORY (grade ${grade}).`
      : 'OPERATION FAILED.');
    this.emit('gameOver', this.result);
  },

  // ---------------------------------------------------------------- internals

  _afterAction() {
    this._safeFog();
    if (this.phase === 'play') this._checkSuddenDefeat();
  },

  _safeFog() {
    try { refreshFog(); } catch (_) { /* fog is optional at boot */ }
  },

  _releaseTile(unit) {
    const tile = this.tileAt(unit.hex);
    if (tile && (tile.occupied === unit || tile.occupied === unit.id)) {
      tile.occupied = null;
    }
  },

  _occupyTile(unit) {
    if (!unit.alive) return;
    const tile = this.tileAt(unit.hex);
    if (tile) tile.occupied = unit;
  },

  /**
   * Normalise gameplay numbers onto whatever tiles the terrain module built,
   * and — only if the terrain clearly ignored the scenario (no water anywhere)
   * — paint the authored map from SCENARIO.terrain.types so movement, cover and
   * the river exist regardless of the terrain module's state.
   */
  _applyTerrainData() {
    const terrain = this.deps && this.deps.terrain;
    const scen = this.deps && this.deps.scenario;
    if (!terrain || !terrain.tiles) return;
    const data = scen && scen.terrain;

    const distinct = new Set();
    for (const t of terrain.tiles.values()) distinct.add(t.type);
    const authored = distinct.size > 1;      // the terrain built a real map
    const hasWater = distinct.has('water');  // …and it includes the Vovcha

    if (data && data.types && !authored) {
      // Uniform tiles = the terrain module never read the scenario. Paint the
      // authored map so movement, cover and the river exist regardless.
      for (const [k, tile] of terrain.tiles) {
        const type = data.types[k];
        if (type) tile.type = type;
      }
      if (Array.isArray(data.hills)) {
        const thr = scen.hillThreshold ?? 2.2;
        for (const h of data.hills) {
          const tile = terrain.tiles.get(key(h));
          if (tile && (tile.height || 0) < thr) tile.height = thr + 0.6;
        }
      }
    } else if (data && Array.isArray(data.water) && !hasWater) {
      // Terrain authored something but no river — the scenario is unplayable
      // without it, so carve the water in without touching anything else.
      for (const h of data.water) {
        const tile = terrain.tiles.get(key(h));
        if (tile) tile.type = 'water';
      }
    }

    if (data && Array.isArray(data.bridges)) {
      for (const b of data.bridges) {
        const tile = terrain.tiles.get(key(b.hex));
        if (!tile) continue;
        tile.bridge = true;
        if (tile.type === 'water') tile.type = 'road';
      }
    }

    // GAMEPLAY.md §2 is authoritative for cost/cover.
    for (const tile of terrain.tiles.values()) {
      const rule = TERRAIN_RULES[tile.type];
      if (!rule) continue;
      tile.moveCost = tile.bridge ? TERRAIN_RULES.road.moveCost : rule.moveCost;
      tile.cover = tile.bridge ? 0 : rule.cover;
    }
  },

  /**
   * Guarantee `features.infrastructure` exists. A finished features module
   * builds it (with meshes) from SCENARIO.infrastructure; if it did not, we
   * seed the same array with data-only objects so loiter strikes, artillery vs
   * structures and the strategic effects still work.
   */
  _ensureInfrastructure() {
    const features = this.deps && this.deps.features;
    const scen = this.deps && this.deps.scenario;
    if (!features || !scen || !Array.isArray(scen.infrastructure)) return;
    if (!Array.isArray(features.infrastructure)) features.infrastructure = [];
    if (features.infrastructure.length) return;
    for (const def of scen.infrastructure) {
      features.infrastructure.push({
        id: def.id,
        kind: def.kind,
        name: def.name,
        hex: { q: def.hex.q, r: def.hex.r },
        hp: def.hp,
        maxHp: def.maxHp ?? def.hp,
        alive: true,
        mesh: null,
      });
    }
    if (typeof features.damageInfrastructure !== 'function') {
      features.damageInfrastructure = (id, dmg) => {
        const obj = features.infrastructure.find((o) => o.id === id);
        if (!obj || !obj.alive) return null;
        obj.hp = Math.max(0, obj.hp - dmg);
        if (obj.hp === 0) obj.alive = false;
        return obj;
      };
    }
  },

  /** Apply scenario per-unit setup once Game.units has been populated. */
  _firstTimeSetup() {
    if (this._setupDone) return;
    this._setupDone = true;
    const scen = (this.deps && this.deps.scenario) || {};
    const defs = scen.units || [];
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const def = defs[i];
      if (def && def.type === u.typeId && def.faction === u.faction) {
        if (def.entrench) u.entrench = def.entrench;
        if (def.veterancy) u.veterancy = def.veterancy;
        if (def.name) u.name = def.name;
      }
      const terrain = this.deps && this.deps.terrain;
      if (terrain && terrain.heightAt && u.mesh) {
        u.mesh.position.y = terrain.heightAt(u.mesh.position.x, u.mesh.position.z);
      }
      this._occupyTile(u);
    }
    // objective ownership starts from whoever is actually standing on it
    for (const o of this.objectives) {
      const holder = this.unitAt(o.hex);
      if (holder && isGroundHolder(holder)) o.owner = holder.faction;
    }
  },
};
