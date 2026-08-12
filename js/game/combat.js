// STEEL SIGNAL — game/combat.js
// Full combat resolution per GAMEPLAY.md §3–§5 (constants copied from §9).
// Contract exports: resolveAttack, fpvStrike, loiterStrike, artilleryBarrage.
// Extra exports (documented in INTEGRATION_NOTES.md): previewAttack, effectiveMove.
//
// This module is AUTHORITATIVE for combat state mutation: it spends ammo, applies
// damage/suppression/veterancy, kills units (wreck via features.setWreck) and emits
// the canonical events itself: 'unitAttacked' (payload = report), 'unitKilled',
// 'infraDestroyed', plus 'log' lines. state.js `.attack()` should simply delegate
// here and must NOT re-emit those events.

import { Vector3 } from 'three';
import { hexDistance, hexNeighbors, hexToWorld } from '../world/terrain.js';
import { rng } from '../core/rng.js';
import { Game } from './state.js';
import { isVisible } from './fog.js';
import { playFPVDive } from '../fx/dronecam.js';

// ---------------------------------------------------------------------------
// Constants — GAMEPLAY.md §9 (copied verbatim)
// ---------------------------------------------------------------------------
const DMG_BASE = 3;
const DMG_SLOPE = 0.55;
const DMG_MAX = 7;
const MIN_DMG_DELTA = -5;            // delta > -5 → min dmg 1
const RETURN_FIRE_MULT = 0.5;
const COMBINED_ARMS = 2;
const RIVER_ATK = 3;
const SUPPRESS_MALUS = 2;
const SUPPRESS_AT = 3;               // dmg threshold (direct fire / return fire)
const SUPPRESS_AT_INDIRECT = 2;      // dmg threshold for indirect
const VET_KILLS_PER_STAR = 2;
const VET_MAX = 2;
const EW_RADIUS = 2;
const EW_DMG_MULT = 0.4;
const FPV_ABORT = 0.35;
const AA_INTERCEPT_FPV = 0.40;
const AA_INTERCEPT_LOITER = 0.50;
const AA_UMBRELLA = 2;
const BLIND_FIRE_MULT = 0.5;
const SPOTTED_ARTY_BONUS = 1;
const MLRS_SPLASH = 1;
const INFRA_FLAT_DEF = 8;
const NO_AMMO_DEF_MALUS = 2;
const FUEL_DEPOT_TURNS = 3;

// --- Drone lethality (DEVIATION from GAMEPLAY.md §9 — logged in ---------------
//     INTEGRATION_NOTES.md; critique round 2 item 18) ------------------------
// Measured before this change: FPV strikes landed 1, 1, 2, 2 on a 10 hp rifle
// squad — two operator teams' entire airframe load to kill one infantry unit,
// which inverts the game's whole pitch. The §3.1 curve is tuned for gun duels
// (DMG_BASE 3, ±0.55/point of delta) and a shaped charge dropped through a roof
// hatch is simply not that engagement. The drone paths therefore get their own
// base and a top-attack multiplier applied to the pre-roll raw value:
//
//   raw = (DRONE_BASE + DMG_SLOPE * delta) * topMult      (then ×roll, clamped)
//
// Resulting numbers at midpoint roll, veterancy 0, no combined arms:
//   FPV vs MBT (atk hard 10 / def 9, cover halved) ....... delta +1 → 7 (capped)
//   FPV vs dug-in MBT on a hill (DEF 10) ................. delta  0 → 6–7
//   FPV vs rifle squad in the open (atk soft 6 / def 7) .. delta −1 → 4–5
//   FPV vs entrenched squad in a town (DEF 9) ............ delta −3 → 2–4
//   Loiter vs MBT (atk hard 6) .......................... delta −3 → 3–5
//   Loiter vs rifle squad in the open (atk soft 7) ....... delta  0 → 4–6
// So: two airframes kill any vehicle, three kill infantry in the open, and cover
// still visibly protects. The counterplay is untouched and now actually matters
// — AA_INTERCEPT_FPV 0.40, FPV_ABORT 0.35, EW_DMG_MULT 0.4.
const FPV_DMG_BASE = 4;              // replaces DMG_BASE on mode 'fpv'
const LOITER_DMG_BASE = 4;           // replaces DMG_BASE on mode 'loiter'
const FPV_TOP_MULT_VEHICLE = 1.8;    // roof armour / engine deck
const FPV_TOP_MULT_FOOT = 1.3;       // fragmentation on dispersed infantry
const LOITER_TOP_MULT_VEHICLE = 1.6;
const LOITER_TOP_MULT_FOOT = 1.2;
const SUPPRESS_AT_FPV = 2;           // even a glancing FPV hit pins the target
const JAMMED_MIN_DMG = 1;            // a degraded strike that connects still hurts

// Target categories by typeId (GAMEPLAY.md §1.1)
const HARD_IDS = new Set(['mbt', 'ifv', 'apc', 'spg', 'mlrs', 'aa']);
const FOOT_IDS = new Set(['infantry', 'atgm_team']);       // benefit from crop cover
const VEHICLE_IDS = new Set(['mbt', 'ifv', 'apc', 'spg', 'mlrs', 'aa', 'ew', 'truck']);
// Who takes the ×VEHICLE top-attack multiplier: everything with a hull or a
// chassis. VEHICLE_IDS plus the truck-mounted loitering-munition launcher
// (GAMEPLAY.md §1 note). The remainder — infantry, atgm_team, fpv_drone (a
// dismounted operator team) — takes the ×FOOT multiplier.
const TOP_ATTACK_VEHICLE_IDS = new Set([...VEHICLE_IDS, 'loiter_munition']);

// ---------------------------------------------------------------------------
// Deps / RNG plumbing (lazy — never touch Game at module-eval time: state.js
// may import this module first in a circular graph)
// ---------------------------------------------------------------------------
function D() {
  const deps = Game && Game.deps ? Game.deps : null;
  if (deps) return deps;
  if (typeof window !== 'undefined' && window.STEEL) return window.STEEL;
  return {};
}

let _rng = null;
function getRng(ctx) {
  if (ctx && typeof ctx.rng === 'function') return ctx.rng;
  if (!_rng) {
    const seed = ((D().scenario && D().scenario.seed) || 1) ^ 0x5e0f00d;
    _rng = rng(seed >>> 0);
  }
  return _rng;
}

function log(msg) { Game.emit('log', msg); }

// --- deferred consequence narration ----------------------------------------
// A kill (and the veterancy star it earns) is resolved inside applyDamage(),
// i.e. BEFORE the resolver that called it can narrate the shot — logging there
// directly printed "RED T-72 DESTROYED." above "BLUE Abrams engages RED T-72 —
// 7 dmg.". Consequence lines are queued here instead and flushed by the
// resolver immediately after its own line. A microtask fallback guarantees the
// queue can never strand a line even if a future call site forgets to flush:
// worst case it prints at the end of the same synchronous block, still after
// the cause.
const pendingLog = [];
let pendingScheduled = false;

function flushLog() {
  while (pendingLog.length) Game.emit('log', pendingLog.shift());
}

function queueLog(msg) {
  pendingLog.push(msg);
  if (pendingScheduled) return;
  pendingScheduled = true;
  const run = () => { pendingScheduled = false; try { flushLog(); } catch (_) {} };
  if (typeof queueMicrotask === 'function') queueMicrotask(run);
  else if (typeof Promise === 'function') Promise.resolve().then(run);
  else if (typeof setTimeout === 'function') setTimeout(run, 0);
  else { pendingScheduled = false; flushLog(); }
}

function label(u) {
  const side = u.faction === 'blue' ? 'BLUE' : 'RED';
  return `${side} ${u.type && u.type.name ? u.type.name : u.typeId}`;
}

// ---------------------------------------------------------------------------
// Small queries
// ---------------------------------------------------------------------------
function hasTrait(u, t) {
  return !!(u && u.type && Array.isArray(u.type.traits) && u.type.traits.includes(t));
}

export function targetCategory(unit) {
  if (unit.typeId === 'recon_drone') return 'air';
  return HARD_IDS.has(unit.typeId) ? 'hard' : 'soft';
}

function tileAt(hex) {
  const terrain = D().terrain;
  if (!terrain || !terrain.tiles || !hex) return null;
  return terrain.tiles.get(`${hex.q},${hex.r}`) || null;
}

function hillAt(hex) {
  const tile = tileAt(hex);
  if (!tile) return false;
  const thr = (D().scenario && D().scenario.hillThreshold) || 2.2;
  return (tile.height || 0) >= thr;
}

function unitAt(hex) {
  return Game.units.find(
    (u) => u.alive && u.hex && u.hex.q === hex.q && u.hex.r === hex.r) || null;
}

function safeVisible(hex) {
  try { return isVisible(hex) !== false; } catch (_) { return true; }
}

// Another friendly unit of a DIFFERENT class adjacent to the defender.
function hasCombinedArms(attacker, defender) {
  return Game.units.some((u) =>
    u.alive && u !== attacker && u.faction === attacker.faction &&
    u.typeId !== 'recon_drone' &&
    u.type && attacker.type && u.type.class !== attacker.type.class &&
    hexDistance(u.hex, defender.hex) === 1);
}

// River rule: a direct (non-indirect) attack whose line crosses a plain water
// hex — i.e. some water tile is adjacent to both attacker and defender — takes
// ATK −3. Fighting from/onto a bridge hex is the sanctioned route (no penalty).
function riverCrossing(attacker, defender) {
  const dist = hexDistance(attacker.hex, defender.hex);
  if (dist < 1 || dist > 2) return false;
  const aTile = tileAt(attacker.hex);
  if (aTile && aTile.type === 'water') return false; // on a bridge over water etc.
  for (const n of hexNeighbors(attacker.hex)) {
    const t = tileAt(n);
    if (t && t.type === 'water' && hexDistance(n, defender.hex) === 1) return true;
  }
  return false;
}

// Nearest enemy SHORAD able to intercept a strike on `target` (§4.3).
function interceptingAA(targetHex, strikerFaction) {
  return Game.units.find((u) =>
    u.alive && u.faction !== strikerFaction && u.typeId === 'aa' &&
    !u.suppressed && u.ammo > 0 &&
    hexDistance(u.hex, targetHex) <= AA_UMBRELLA) || null;
}

// Enemy jammer covering a hex (§4.2). "Enemy" = enemy of the acting drone.
function ewCovering(hex, strikerFaction) {
  return Game.units.find((u) =>
    u.alive && u.faction !== strikerFaction && hasTrait(u, 'jammer') &&
    hexDistance(u.hex, hex) <= EW_RADIUS) || null;
}

function effSight(u) {
  let s = (u.type && u.type.sight) || 1;
  if (hillAt(u.hex)) s += 1;
  if (hasTrait(u, 'recon') && ewCovering(u.hex, u.faction)) s = 1; // jammed drone
  return s;
}

// A hex is "spotted" for `faction` if one of its recon drones sees it and is
// not itself inside an enemy EW bubble (jammed drones are not spotters, §4.2).
function isSpottedBy(faction, hex) {
  return Game.units.some((u) =>
    u.alive && u.faction === faction && hasTrait(u, 'recon') &&
    !ewCovering(u.hex, u.faction) &&
    hexDistance(u.hex, hex) <= effSight(u));
}

// ---------------------------------------------------------------------------
// Core damage formula (GAMEPLAY.md §3.1)
// opts: { mode: 'direct'|'fpv'|'loiter'|'barrage'|'return',
//         rngFn, preview, combinedArms, river, spotted }
// ---------------------------------------------------------------------------
function strikeDamage(attacker, defender, opts) {
  const mode = opts.mode || 'direct';
  const indirectLike =
    mode === 'barrage' || mode === 'loiter' || hasTrait(attacker, 'indirect');
  const topAttack = indirectLike || mode === 'fpv';

  const cat = targetCategory(defender);
  const atkCol = (attacker.type && attacker.type.attack &&
    attacker.type.attack[cat]) || 0;

  const ATK = atkCol +
    (attacker.veterancy || 0) +
    (opts.combinedArms ? COMBINED_ARMS : 0) -
    (attacker.suppressed ? SUPPRESS_MALUS : 0) -
    (opts.river ? RIVER_ATK : 0) +
    (opts.spotted ? SPOTTED_ARTY_BONUS : 0);

  const tile = tileAt(defender.hex);
  let cover = (tile ? tile.cover || 0 : 0) +
    (hillAt(defender.hex) ? 1 : 0) +
    (defender.entrench || 0) +
    (tile && tile.type === 'field' && FOOT_IDS.has(defender.typeId) ? 1 : 0);
  if (topAttack) cover = Math.floor(cover / 2);

  const DEF = ((defender.type && defender.type.defense) || 0) + cover +
    (defender.veterancy || 0) -
    (defender.suppressed ? SUPPRESS_MALUS : 0) -
    (defender.type && defender.type.ammo > 0 && defender.ammo <= 0
      ? NO_AMMO_DEF_MALUS : 0);

  // Drone paths use their own base and a top-attack multiplier (see the
  // constants block). Artillery keeps the documented §3.1 curve untouched — the
  // multiplier is deliberately NOT applied to mode 'barrage'.
  let base = DMG_BASE;
  let topMult = 1;
  if (mode === 'fpv') {
    base = FPV_DMG_BASE;
    topMult = TOP_ATTACK_VEHICLE_IDS.has(defender.typeId)
      ? FPV_TOP_MULT_VEHICLE : FPV_TOP_MULT_FOOT;
  } else if (mode === 'loiter') {
    base = LOITER_DMG_BASE;
    topMult = TOP_ATTACK_VEHICLE_IDS.has(defender.typeId)
      ? LOITER_TOP_MULT_VEHICLE : LOITER_TOP_MULT_FOOT;
  }

  const delta = ATK - DEF;
  // Multiplier is applied to the raw value before the roll, so DMG_MAX still
  // caps the result and a hopeless delta (raw ≤ 0) is not "boosted" into damage.
  const raw = (base + DMG_SLOPE * delta) * topMult;
  const roll = opts.preview ? 1.0 : 0.8 + 0.4 * opts.rngFn();
  const minD = delta > MIN_DMG_DELTA ? 1 : 0;
  const dmg = Math.max(minD, Math.min(DMG_MAX, Math.round(raw * roll)));
  return { dmg, delta, cat, indirectLike, topMult };
}

// Arty vs structures: formula vs flat DEF 8, then max(1, floor(dmg/2)) (§5).
function infraShellDamage(unit, R, preview) {
  const atk = ((unit.type && unit.type.attack && unit.type.attack.hard) || 0) +
    (unit.veterancy || 0) - (unit.suppressed ? SUPPRESS_MALUS : 0);
  const delta = atk - INFRA_FLAT_DEF;
  const raw = DMG_BASE + DMG_SLOPE * delta;
  const roll = preview ? 1.0 : 0.8 + 0.4 * R();
  const minD = delta > MIN_DMG_DELTA ? 1 : 0;
  const dmg = Math.max(minD, Math.min(DMG_MAX, Math.round(raw * roll)));
  return Math.max(1, Math.floor(dmg / 2));
}

// ---------------------------------------------------------------------------
// State application
// ---------------------------------------------------------------------------
function applySuppression(victim, dmg, threshold) {
  if (!victim.alive) return false;
  if (dmg >= threshold) {
    if (!victim.suppressed) {
      victim.suppressed = true;
      Game.emit('unitSuppressed', victim);
    }
    return true;
  }
  return false;
}

function applyDamage(victim, dmg, attacker) {
  if (dmg <= 0 || !victim.alive) return false;
  victim.hp -= dmg;
  if (victim.hp > 0) return false;

  victim.hp = 0;
  victim.alive = false;
  victim.suppressed = false;
  const tile = tileAt(victim.hex);
  if (tile && (tile.occupied === victim || tile.occupied === victim.id)) {
    tile.occupied = null;
  }
  try {
    const features = D().features;
    if (features && typeof features.setWreck === 'function') {
      features.setWreck(victim.hex, (victim.type && victim.type.class) || 'armor');
    }
  } catch (_) { /* wreck visuals are optional */ }

  // Queued, not logged: the caller narrates the shot first (see queueLog).
  queueLog(`${label(victim)} ${targetCategory(victim) === 'air' ? 'SHOT DOWN' : 'DESTROYED'}.`);

  if (attacker && attacker.alive && attacker.faction !== victim.faction) {
    attacker.kills = (attacker.kills || 0) + 1;
    const stars = Math.min(VET_MAX, Math.floor(attacker.kills / VET_KILLS_PER_STAR));
    if (stars > (attacker.veterancy || 0)) {
      attacker.veterancy = stars;
      queueLog(`${label(attacker)} earns a veterancy star (★${stars}).`);
    }
  }

  Game.emit('unitKilled', victim, attacker || null);
  // Give VFX time for the death explosion before the hull disappears; the
  // features wreck stays behind.
  if (victim.mesh) {
    setTimeout(() => {
      if (!victim.alive && victim.mesh) victim.mesh.visible = false;
    }, 1400);
  }
  return true;
}

function spendAttack(unit) {
  if (unit.type && unit.type.ammo > 0) unit.ammo = Math.max(0, unit.ammo - 1);
  unit.fired = true;
  unit.entrench = 0; // reset on attack
}

function blankReport(mode, attacker, defender) {
  return {
    mode,
    attacker,
    defender: defender || null,
    dmgToDefender: 0,
    dmgToAttacker: 0,
    killed: null,
    suppressed: false,
    attackerSuppressed: false,
    intercepted: false,
    aborted: false,
    blind: false,
    splash: [],
    events: [],
  };
}

function strikeWorldPos(target) {
  if (target.mesh && target.mesh.position) {
    return new Vector3().copy(target.mesh.position);
  }
  const { x, z } = hexToWorld(target.hex.q, target.hex.r);
  const terrain = D().terrain;
  const y = terrain && typeof terrain.heightAt === 'function'
    ? terrain.heightAt(x, z) : 0;
  return new Vector3(x, y, z);
}

// ---------------------------------------------------------------------------
// Infrastructure effects (§5) — permanent strategic consequences
// ---------------------------------------------------------------------------
const processedInfra = new Set();

function infraFx() {
  if (!Game.infraEffects) {
    Game.infraEffects = {
      substationDead: false,
      railYardDead: false,
      commsDead: false,
      fuelDepotTurns: 0,
      deadBridges: [],
    };
  }
  return Game.infraEffects;
}

function applyInfraEffect(obj) {
  const fx = infraFx();
  switch (obj.kind) {
    case 'bridge':
    case 'rail_bridge': {
      const tile = tileAt(obj.hex);
      if (tile) {
        tile.type = 'water';
        tile.moveCost = Infinity;
        tile.cover = 0;
        tile.bridge = false;
      }
      fx.deadBridges.push(`${obj.hex.q},${obj.hex.r}`);
      log(`${obj.name || 'BRIDGE'} DESTROYED — the crossing is now impassable water.`);
      break;
    }
    case 'substation':
      fx.substationDead = true;
      log('SUBSTATION DESTROYED — RED income −10/turn for the rest of the operation.');
      break;
    case 'fuel_depot':
      fx.fuelDepotTurns = FUEL_DEPOT_TURNS;
      log('FUEL DEPOT DESTROYED — RED vehicles move −2 (min 1) for 3 turns.');
      break;
    case 'rail_yard':
      fx.railYardDead = true;
      log('RAIL YARD DESTROYED — imminent RED waves delayed +2 turns (east edge); later waves CANCELLED.');
      break;
    case 'comms_tower':
      fx.commsDead = true;
      log('COMMS TOWER DESTROYED — RED artillery fires blind; RED command reverts to defend posture.');
      break;
    default:
      log(`${obj.name || obj.kind} destroyed.`);
  }
}

function onInfraDestroyed(obj) {
  if (!obj || obj.id == null || processedInfra.has(obj.id)) return;
  processedInfra.add(obj.id);
  applyInfraEffect(obj);
}

function infraAt(hex) {
  const features = D().features;
  const list = (features && features.infrastructure) || [];
  return list.find((o) =>
    o.alive && o.hex && o.hex.q === hex.q && o.hex.r === hex.r) || null;
}

function damageInfra(obj, dmg, report) {
  const features = D().features;
  const amount = Math.max(0, Math.round(dmg) || 0);
  const before = Math.max(0, Number(obj.hp) || 0);
  const maxHp = Number(obj.maxHp) || before || 0;
  const after = Math.max(0, before - amount);

  // LOG ORDERING (critique round 1): the hit must be narrated BEFORE its
  // consequence. Every 'infraDestroyed' consumer runs synchronously — world/
  // features.js emits the event from inside damageInfrastructure, and this
  // module's own applyInfraEffect prints the "… DESTROYED" banner off it — so
  // logging after the call put "VOVCHA ROAD BRIDGE DESTROYED" above "takes 4
  // structural damage (0/8 hp)". The reported hp is exact, not a guess: this
  // module and features.js clamp identically with max(0, hp - dmg).
  report.events.push(`${obj.name || obj.kind}: ${amount} structural dmg`);
  log(`${obj.name || obj.kind} takes ${amount} structural damage (${after}/${maxHp || '—'} hp).`);

  let res = obj;
  try {
    if (features && typeof features.damageInfrastructure === 'function') {
      res = features.damageInfrastructure(obj.id, amount) || obj;
    } else {
      obj.hp = after;
      if (obj.hp === 0) obj.alive = false;
    }
  } catch (_) { /* keep going with local object */ }
  // features implementations may emit 'infraDestroyed' themselves inside
  // damageInfrastructure — the processedInfra set makes this idempotent.
  if (!res.alive && !processedInfra.has(res.id)) {
    Game.emit('infraDestroyed', res);
  }
}

// ---------------------------------------------------------------------------
// Deferred init: event listeners (registered post-module-graph via microtask
// so the circular import with state.js can never hit a TDZ binding).
// ---------------------------------------------------------------------------
let _init = false;

function onUnitMoved(arg) {
  // Auto-engage: enemy recon_drone ending a move inside an AA umbrella (§4.3).
  const u = arg && arg.typeId ? arg : (arg && arg.unit ? arg.unit : null);
  if (!u || !u.alive || u.typeId !== 'recon_drone') return;
  const aa = interceptingAA(u.hex, u.faction);
  if (!aa) return;
  aa.ammo = Math.max(0, aa.ammo - 1); // free action, costs 1 ammo, no fired flag
  const R = getRng(null);
  const { dmg } = strikeDamage(aa, u, { mode: 'direct', rngFn: R });
  const report = blankReport('aa_auto', aa, u);
  report.dmgToDefender = dmg;
  const killed = applyDamage(u, dmg, aa);
  report.killed = killed ? u : null;
  report.events.push(`SHORAD auto-engagement: ${dmg} dmg`);
  log(`${label(aa)} auto-engages ${label(u)} — ${dmg} dmg.`);
  flushLog();
  Game.emit('unitAttacked', report);
}

function ensureInit() {
  if (_init) return;
  if (!Game || typeof Game.on !== 'function') return;
  _init = true;
  Game.on('infraDestroyed', onInfraDestroyed);
  Game.on('unitMoved', (arg) => { try { onUnitMoved(arg); } catch (_) {} });
  Game.on('turnStarted', (info) => {
    // Suppression clears at the start of the suppressed side's own turn.
    const side = info && info.side;
    if (!side) return;
    for (const u of Game.units) {
      if (u.faction === side && u.suppressed) u.suppressed = false;
    }
  });
  Game.on('turnEnded', (info) => {
    const fx = infraFx();
    if (info && info.side === 'red' && fx.fuelDepotTurns > 0) fx.fuelDepotTurns -= 1;
  });
}

// Register listeners as soon as the module graph has finished evaluating so
// the AA auto-engage hook is live before the first player move.
if (typeof setTimeout === 'function') {
  setTimeout(() => { try { ensureInit(); } catch (_) {} }, 0);
}

// ---------------------------------------------------------------------------
// Extra export: effective movement (fuel-depot malus, §5) — for state.js/ai.js
// ---------------------------------------------------------------------------
export function effectiveMove(unit) {
  let m = (unit.type && unit.type.move) || 0;
  const fx = infraFx();
  if (fx.fuelDepotTurns > 0 && unit.faction === 'red' &&
      VEHICLE_IDS.has(unit.typeId)) {
    m = Math.max(1, m - 2);
  }
  return m;
}

// ---------------------------------------------------------------------------
// resolveAttack — router + direct-fire resolution (contract)
// ---------------------------------------------------------------------------
export function resolveAttack(attacker, defender, ctx = {}) {
  ensureInit();
  const report = blankReport('direct', attacker, defender);
  const fail = (msg) => { report.events.push(msg); return report; };

  if (!attacker || !attacker.alive) return fail('attacker unavailable');
  if (!defender || !defender.alive) return fail('target already destroyed');
  if (attacker.faction === defender.faction) return fail('friendly target');

  // Route special weapon systems through their dedicated resolvers.
  if (attacker.typeId === 'fpv_drone') return fpvStrike(attacker, defender, ctx);
  if (attacker.typeId === 'loiter_munition') return loiterStrike(attacker, defender, ctx);
  if (hasTrait(attacker, 'indirect')) return artilleryBarrage(attacker, defender.hex, ctx);

  const cat = targetCategory(defender);
  if (cat === 'air' && attacker.typeId !== 'aa') {
    return fail('only SHORAD can engage aerial targets');
  }
  const atkCol = (attacker.type.attack && attacker.type.attack[cat]) || 0;
  if (atkCol <= 0) return fail('no effective weapon vs target');
  if (attacker.type.ammo > 0 && attacker.ammo <= 0) return fail('out of ammunition');
  const range = attacker.type.range || 0;
  const dist = hexDistance(attacker.hex, defender.hex);
  if (range < 1 || dist < 1 || dist > range) return fail('target out of range');

  const R = getRng(ctx);
  spendAttack(attacker);

  const ca = hasCombinedArms(attacker, defender);
  const river = riverCrossing(attacker, defender);
  const { dmg } = strikeDamage(attacker, defender,
    { mode: 'direct', rngFn: R, combinedArms: ca, river });

  report.dmgToDefender = dmg;
  if (ca) report.events.push('combined arms +2');
  if (river) report.events.push('river crossing −3');
  report.suppressed = applySuppression(defender, dmg, SUPPRESS_AT);
  const defenderDied = applyDamage(defender, dmg, attacker);
  // A destroyed unit is not "suppressed" — applyDamage already clears the flag,
  // and leaving it true in the report makes vfx float SUPPRESSED over a wreck
  // (critique round 2: orphaned floats) and makes the log read
  // "7 dmg, suppressed." immediately above "… DESTROYED."
  if (defenderDied) { report.killed = defender; report.suppressed = false; }

  // Return fire (§3.1): defender alive, unsuppressed (incl. just applied),
  // attacker in the defender's range and reach, half damage, costs 1 ammo.
  if (!defenderDied && !defender.suppressed &&
      canReturnFire(defender, attacker, dist)) {
    if (defender.type.ammo > 0) defender.ammo = Math.max(0, defender.ammo - 1);
    const rf = strikeDamage(defender, attacker, { mode: 'return', rngFn: R });
    const rdmg = Math.floor(RETURN_FIRE_MULT * rf.dmg);
    report.dmgToAttacker = rdmg;
    if (rdmg > 0) {
      report.attackerSuppressed = applySuppression(attacker, rdmg, SUPPRESS_AT);
      const attackerDied = applyDamage(attacker, rdmg, defender);
      if (attackerDied) {
        report.attackerSuppressed = false;
        if (!report.killed) report.killed = attacker;
      }
    }
  }

  const bits = [`${report.dmgToDefender} dmg`];
  if (report.suppressed) bits.push('suppressed');
  if (report.dmgToAttacker > 0) bits.push(`return fire ${report.dmgToAttacker}`);
  log(`${label(attacker)} engages ${label(defender)} — ${bits.join(', ')}.`);
  flushLog();
  Game.emit('unitAttacked', report);
  return report;
}

function canReturnFire(defender, attacker, dist) {
  if (!defender.alive || defender.suppressed) return false;
  if (hasTrait(attacker, 'indirect')) return false;
  // ATGM ambush: no reply against the team when it fires at range 2.
  if (hasTrait(attacker, 'atgm') && dist === 2) return false;
  const range = defender.type.range || 0;
  if (range < 1 || dist > range) return false;
  const cat = targetCategory(attacker);
  if (cat === 'air' && defender.typeId !== 'aa') return false;
  if (((defender.type.attack && defender.type.attack[cat]) || 0) <= 0) return false;
  if (defender.type.ammo > 0 && defender.ammo <= 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// fpvStrike (contract) — §3.3 / §4
// ---------------------------------------------------------------------------
export function fpvStrike(unit, targetUnit, ctx = {}) {
  ensureInit();
  const report = blankReport('fpv', unit, targetUnit);
  const fail = (msg) => { report.events.push(msg); return report; };

  if (!unit || !unit.alive) return fail('operator team unavailable');
  if (!targetUnit || !targetUnit.alive) return fail('target already destroyed');
  if (targetUnit.faction === unit.faction) return fail('friendly target');
  if (targetUnit.typeId === 'recon_drone') return fail('cannot engage aerial target');
  if (unit.ammo <= 0) return fail('no airframes remaining');
  const range = unit.type.range || 4;
  const dist = hexDistance(unit.hex, targetUnit.hex);
  if (dist < 1 || dist > range) return fail('target beyond FPV control range');

  const R = getRng(ctx);
  spendAttack(unit);
  Game.emit('fpvLaunched', { unit, target: targetUnit });

  // 1) SHORAD interception — checked BEFORE EW (§4.3).
  const aa = interceptingAA(targetUnit.hex, unit.faction);
  if (aa && R() < AA_INTERCEPT_FPV) {
    aa.ammo = Math.max(0, aa.ammo - 1);
    report.intercepted = true;
    report.events.push('airframe INTERCEPTED by SHORAD');
    log(`${label(aa)} intercepts the ${label(unit)} airframe — strike destroyed inbound.`);
    Game.emit('strikeIntercepted', { unit, target: targetUnit, aa, kind: 'fpv' });
    Game.emit('unitAttacked', report);
    return report;
  }

  // 2) EW abort / degradation (§4.2).
  const ew = ewCovering(targetUnit.hex, unit.faction);
  if (ew && R() < FPV_ABORT) {
    report.aborted = true;
    report.events.push('ABORTED — EW interference, airframe lost');
    log(`${label(unit)} strike ABORTED — EW interference. Airframe lost.`);
    Game.emit('unitAttacked', report);
    return report;
  }

  const ca = hasCombinedArms(unit, targetUnit);
  const shot = strikeDamage(unit, targetUnit,
    { mode: 'fpv', rngFn: R, combinedArms: ca });
  // A jammed airframe that still connects always does at least 1 — the ×0.4 is
  // a degraded link, not a dud warhead. Guard on base > 0 so the floor can never
  // manufacture damage out of a genuine no-effect result.
  const dmg = ew && shot.dmg > 0
    ? Math.max(JAMMED_MIN_DMG, Math.round(shot.dmg * EW_DMG_MULT))
    : shot.dmg;

  report.dmgToDefender = dmg;
  if (ca) report.events.push('combined arms +2');
  report.events.push(`top attack ×${shot.topMult}`);
  if (ew) report.events.push('signal degraded through jamming ×0.4');
  report.suppressed = applySuppression(targetUnit, dmg, SUPPRESS_AT_FPV);
  const killed = applyDamage(targetUnit, dmg, unit);
  if (killed) { report.killed = targetUnit; report.suppressed = false; }
  log(`${label(unit)} FPV top attack on ${label(targetUnit)} — ${dmg} dmg` +
    `${ew ? ' (link jammed)' : ''}${report.suppressed ? ', suppressed' : ''}.`);
  flushLog();

  // Cinematic: state is already final; visuals fire at impact.
  const engine = D().engine;
  const impact = () => Game.emit('unitAttacked', report);
  if (engine) {
    report.done = new Promise((resolve) => {
      try {
        playFPVDive(engine, unit, strikeWorldPos(targetUnit), () => {
          impact();
          resolve(report);
        });
      } catch (_) { impact(); resolve(report); }
    });
  } else {
    impact();
    report.done = Promise.resolve(report);
  }
  return report;
}

// ---------------------------------------------------------------------------
// loiterStrike (contract) — units OR infrastructure, §3.3 / §5
// ---------------------------------------------------------------------------
export function loiterStrike(unit, target, ctx = {}) {
  ensureInit();
  const isInfra = !!(target && target.kind && !target.typeId);
  const report = blankReport('loiter', unit, isInfra ? null : target);
  if (isInfra) report.infra = target;
  const fail = (msg) => { report.events.push(msg); return report; };

  if (!unit || !unit.alive) return fail('launcher unavailable');
  if (!target) return fail('no target');
  if (isInfra && !target.alive) return fail('structure already destroyed');
  if (!isInfra && !target.alive) return fail('target already destroyed');
  if (!isInfra && target.faction === unit.faction) return fail('friendly target');
  if (!isInfra && target.typeId === 'recon_drone') return fail('cannot engage aerial target');
  if (unit.ammo <= 0) return fail('no rounds remaining');
  const range = unit.type.range || 10;
  const dist = hexDistance(unit.hex, target.hex);
  if (dist < 1 || dist > range) return fail('target beyond loiter range');

  const R = getRng(ctx);
  spendAttack(unit);
  Game.emit('loiterLaunched', { unit, target });

  // SHORAD interception — before EW (§4.3).
  const aa = interceptingAA(target.hex, unit.faction);
  if (aa && R() < AA_INTERCEPT_LOITER) {
    aa.ammo = Math.max(0, aa.ammo - 1);
    report.intercepted = true;
    report.events.push('round INTERCEPTED by SHORAD');
    log(`${label(aa)} intercepts the loitering munition — airburst, no damage.`);
    Game.emit('strikeIntercepted', { unit, target, aa, kind: 'loiter' });
    Game.emit('unitAttacked', report);
    return report;
  }

  const ew = ewCovering(target.hex, unit.faction);
  if (ew) report.events.push('terminal guidance jammed ×0.4');

  if (isInfra) {
    let dmg = 3 + Math.round(2 * R()); // 3–5 structural (§5)
    if (ew) dmg = Math.max(1, Math.round(dmg * EW_DMG_MULT));
    report.dmgToDefender = dmg;
    damageInfra(target, dmg, report);
  } else {
    const shot = strikeDamage(unit, target,
      { mode: 'loiter', rngFn: R, combinedArms: hasCombinedArms(unit, target) });
    const dmg = ew && shot.dmg > 0
      ? Math.max(JAMMED_MIN_DMG, Math.round(shot.dmg * EW_DMG_MULT))
      : shot.dmg;
    report.dmgToDefender = dmg;
    report.events.push(`top attack ×${shot.topMult}`);
    report.suppressed = applySuppression(target, dmg, SUPPRESS_AT_INDIRECT);
    const killed = applyDamage(target, dmg, unit);
    if (killed) { report.killed = target; report.suppressed = false; }
    log(`${label(unit)} top-attack on ${label(target)} — ${dmg} dmg` +
      `${ew ? ' (guidance jammed)' : ''}${report.suppressed ? ', suppressed' : ''}.`);
  }

  flushLog();
  Game.emit('unitAttacked', report);
  return report;
}

// ---------------------------------------------------------------------------
// artilleryBarrage (contract) — hex-targeted indirect fire, §3.3 / §4.1
// ---------------------------------------------------------------------------
export function artilleryBarrage(unit, hex, ctx = {}) {
  ensureInit();
  const report = blankReport('barrage', unit, null);
  report.hex = hex;
  const fail = (msg) => { report.events.push(msg); return report; };

  if (!unit || !unit.alive) return fail('battery unavailable');
  if (!hex || hex.q == null) return fail('no target hex');
  if (!hasTrait(unit, 'indirect')) return fail('unit has no indirect-fire capability');
  if (unit.type.ammo > 0 && unit.ammo <= 0) return fail('out of ammunition');
  const range = unit.type.range || 0;
  const dist = hexDistance(unit.hex, hex);
  if (dist < 1 || dist > range) return fail('target hex out of range');

  let occupant = unitAt(hex);
  if (occupant && occupant.faction === unit.faction) {
    return fail('friendly forces on target hex — fire mission denied');
  }
  if (occupant && targetCategory(occupant) === 'air') occupant = null; // can't shell a UAV

  const R = getRng(ctx);
  spendAttack(unit);

  const fx = infraFx();
  const forcedBlind = unit.faction === 'red' && fx.commsDead;
  const seen = !forcedBlind && safeVisible(hex);
  report.blind = !seen;

  if (occupant) {
    report.defender = occupant;
    const spotted = seen && isSpottedBy(unit.faction, occupant.hex);
    if (spotted) report.events.push('recon-spotted +1');
    let dmg = strikeDamage(unit, occupant, {
      mode: 'barrage', rngFn: R, spotted,
      combinedArms: hasCombinedArms(unit, occupant),
    }).dmg;
    if (!seen) {
      dmg = Math.floor(dmg * BLIND_FIRE_MULT);
      report.events.push('blind fire ×0.5, no suppression');
    }
    report.dmgToDefender = dmg;
    if (seen) report.suppressed = applySuppression(occupant, dmg, SUPPRESS_AT_INDIRECT);
    const killed = applyDamage(occupant, dmg, unit);
    if (killed) { report.killed = occupant; report.suppressed = false; }
    log(`${label(unit)} barrage on ${label(occupant)} — ${dmg} dmg` +
      `${report.suppressed ? ', suppressed' : ''}${!seen ? ' (blind)' : ''}.`);
    flushLog();
  } else {
    const infra = infraAt(hex);
    if (infra) {
      let dmg = infraShellDamage(unit, R, false);
      if (!seen) dmg = Math.max(1, Math.floor(dmg * BLIND_FIRE_MULT));
      report.infra = infra;
      report.dmgToDefender = dmg;
      damageInfra(infra, dmg, report);
    } else {
      report.events.push('no effect on target hex');
      log(`${label(unit)} barrage lands on empty ground — no effect.`);
    }
  }

  // MLRS saturation: 1 splash dmg (no suppression) to enemies adjacent (§3.3).
  if (unit.typeId === 'mlrs') {
    for (const n of hexNeighbors(hex)) {
      const v = unitAt(n);
      if (v && v.alive && v.faction !== unit.faction &&
          targetCategory(v) !== 'air') {
        const killed = applyDamage(v, MLRS_SPLASH, unit);
        report.splash.push({ unit: v, dmg: MLRS_SPLASH, killed });
        log(`Rocket splash hits ${label(v)} — ${MLRS_SPLASH} dmg.`);
        flushLog();
      }
    }
  }

  flushLog();
  Game.emit('barrageFired', { unit, hex, report });
  Game.emit('unitAttacked', report);
  return report;
}

// ---------------------------------------------------------------------------
// previewAttack (extra export) — pure expected-value estimate for AI/HUD.
// Never mutates state, never spends ammo, midpoint roll with probability
// multipliers folded in. Returns { mode, dmg, returnDmg }.
// ---------------------------------------------------------------------------
export function previewAttack(attacker, defender, opts = {}) {
  const out = { mode: 'direct', dmg: 0, returnDmg: 0 };
  try {
    if (!attacker || !attacker.alive || !defender) return out;
    const isInfra = !!(defender.kind && !defender.typeId);
    const dist = hexDistance(attacker.hex, defender.hex);

    if (attacker.typeId === 'fpv_drone') {
      out.mode = 'fpv';
      if (isInfra || defender.typeId === 'recon_drone') return out;
      if (attacker.ammo <= 0 || dist < 1 || dist > (attacker.type.range || 4)) return out;
      let d = strikeDamage(attacker, defender, {
        mode: 'fpv', preview: true,
        combinedArms: hasCombinedArms(attacker, defender),
      }).dmg;
      if (d > 0 && ewCovering(defender.hex, attacker.faction)) {
        // Mirror the resolver: jammed link degrades to ×0.4 with a floor of 1,
        // and the airframe aborts outright FPV_ABORT of the time.
        d = (1 - FPV_ABORT) * Math.max(JAMMED_MIN_DMG, d * EW_DMG_MULT);
      }
      if (interceptingAA(defender.hex, attacker.faction)) d *= 1 - AA_INTERCEPT_FPV;
      out.dmg = d;
      return out;
    }

    if (attacker.typeId === 'loiter_munition') {
      out.mode = 'loiter';
      if (!isInfra && defender.typeId === 'recon_drone') return out;
      if (attacker.ammo <= 0 || dist < 1 || dist > (attacker.type.range || 10)) return out;
      let d = isInfra ? 4 : strikeDamage(attacker, defender, {
        mode: 'loiter', preview: true,
        combinedArms: hasCombinedArms(attacker, defender),
      }).dmg;
      if (d > 0 && ewCovering(defender.hex, attacker.faction)) {
        d = Math.max(JAMMED_MIN_DMG, d * EW_DMG_MULT);
      }
      if (interceptingAA(defender.hex, attacker.faction)) d *= 1 - AA_INTERCEPT_LOITER;
      out.dmg = d;
      return out;
    }

    if (hasTrait(attacker, 'indirect')) {
      out.mode = 'barrage';
      if (attacker.ammo <= 0 || dist < 1 || dist > (attacker.type.range || 0)) return out;
      if (isInfra) { out.dmg = infraShellDamage(attacker, null, true); return out; }
      if (targetCategory(defender) === 'air') return out;
      const fx = infraFx();
      const forcedBlind = attacker.faction === 'red' && fx.commsDead;
      const seen = !forcedBlind && safeVisible(defender.hex);
      const spotted = seen && isSpottedBy(attacker.faction, defender.hex);
      let d = strikeDamage(attacker, defender, {
        mode: 'barrage', preview: true, spotted,
        combinedArms: hasCombinedArms(attacker, defender),
      }).dmg;
      if (!seen) d *= BLIND_FIRE_MULT;
      out.dmg = d;
      return out;
    }

    // direct
    if (isInfra) return out;
    const cat = targetCategory(defender);
    if (cat === 'air' && attacker.typeId !== 'aa') return out;
    if (((attacker.type.attack && attacker.type.attack[cat]) || 0) <= 0) return out;
    if (attacker.type.ammo > 0 && attacker.ammo <= 0) return out;
    const range = attacker.type.range || 0;
    if (range < 1 || dist < 1 || dist > range) return out;
    const d = strikeDamage(attacker, defender, {
      mode: 'direct', preview: true,
      combinedArms: hasCombinedArms(attacker, defender),
      river: riverCrossing(attacker, defender),
    }).dmg;
    out.dmg = d;
    const wouldSuppress = d >= SUPPRESS_AT;
    if (!wouldSuppress && canReturnFire(defender, attacker, dist)) {
      const rf = strikeDamage(defender, attacker, { mode: 'return', preview: true }).dmg;
      out.returnDmg = Math.floor(RETURN_FIRE_MULT * rf);
    }
    return out;
  } catch (_) {
    return out;
  }
}
