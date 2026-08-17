// STEEL SIGNAL — units/units.js
// Unit roster + unit-instance factory.
// Stats are copied VERBATIM from GAMEPLAY.md §1 (roster table) — do not tune
// them here; GAMEPLAY.md is the authority and combat.js reads these fields.
//
// Contract exports: UNIT_TYPES, createUnit(typeId, faction, hex).
// Extra export (see INTEGRATION_NOTES.md): attachTerrain(terrain) — lets
// createUnit snap the mesh onto the ground itself, so units spawned after boot
// (reinforcement waves, purchases) sit on the terrain without the caller
// repeating main.js's heightAt() snap.

import { buildUnitMesh } from './models.js';
import { hexToWorld } from '../world/terrain.js';

// ---------------------------------------------------------------------------
// Terrain handle (optional). state.js hands it over in Game.init().
// ---------------------------------------------------------------------------
let _terrain = null;

export function attachTerrain(terrain) {
  _terrain = (terrain && typeof terrain.heightAt === 'function') ? terrain : null;
}

// ---------------------------------------------------------------------------
// Roster — GAMEPLAY.md §1
//
//  class    : combined-arms family ('armor'|'mech'|'artillery'|'aa'|'air'|
//             'support'|'infantry'|'drone'). combat.js grants +2 when an
//             adjacent friendly unit of a DIFFERENT class is working the same
//             target.
//  icon     : APP-6-ish glyph key consumed by ui/hud.js
//             ('armor'|'arty'|'aa'|'ew'|'infantry'|'supply'|'drone'|'recon').
//             ui/hud.js and fx/markers.js both key their glyph tables on
//             `typeId` FIRST and only fall back to this field, so a type they
//             have not heard of still draws a sane base symbol.
//  attack   : rated against the defender's target category (§1.1).
//
// AIR LAYER (rounds 7+). js/game/combat.js reads CAPABILITIES, never ids:
//   trait 'air'    (or class 'air')      -> the unit FLIES. It is an air TARGET
//                                          (only air defence may engage it), it
//                                          takes no terrain cover, ignores the
//                                          river malus, and attacks from above.
//   trait 'airdef' (or class 'aa')       -> may put its `attack.air` column on
//                                          an air target and auto-engages enemy
//                                          air inside its own `range`.
//   trait 'intercept'                    -> SHORAD point defence: additionally
//                                          swats inbound FPV / loitering rounds
//                                          (§4.3). `sam` deliberately does NOT
//                                          carry it — that stays the SHORAD's
//                                          one job.
// ---------------------------------------------------------------------------
function T(id, name, cls, icon, move, sight, range, soft, hard, air,
  defense, ammo, cost, traits, desc) {
  return {
    id,
    name,
    class: cls,
    icon,
    move,
    sight,
    range,
    attack: { soft, hard, air },
    defense,
    hp: 10,
    ammo,
    traits,
    cost,
    desc,
  };
}

export const UNIT_TYPES = {
  mbt: T('mbt', 'Main Battle Tank', 'armor', 'armor',
    5, 2, 1, 8, 9, 1, 9, 6, 220, [],
    'Composite-armoured spearhead. Wins any open-field duel and loses its ' +
    'temper against dug-in infantry in a town.'),

  ifv: T('ifv', 'Infantry Fighting Vehicle', 'mech', 'armor',
    6, 3, 1, 7, 5, 2, 6, 8, 140, [],
    'Autocannon carrier. The assault partner that turns a suppressed ' +
    'defender into a dead one.'),

  apc: T('apc', 'Armored Personnel Carrier', 'mech', 'armor',
    6, 2, 1, 5, 2, 1, 5, 8, 90, [],
    'Cheap battlefield taxi with a pintle gun. Do not fight it toe to toe.'),

  spg: T('spg', 'SP Howitzer', 'artillery', 'arty',
    4, 1, 5, 8, 6, 0, 3, 4, 200, ['indirect'],
    'Self-propelled 152 mm battery. Halves cover, suppresses on 2 damage, ' +
    'and is helpless if anything reaches it.'),

  mlrs: T('mlrs', 'Rocket Artillery', 'artillery', 'arty',
    4, 1, 7, 9, 5, 0, 2, 3, 260, ['indirect'],
    'Saturation rockets: deepest reach on the map plus 1 splash damage to ' +
    'everything beside the impact hex.'),

  // Attack helicopter — the only manoeuvre unit that flies. Range 2 with the
  // second-best hard column in the game and NOTHING on the ground able to
  // answer it: its entire counter is the two air-defence types below, which is
  // why it is priced above an MBT and given defence 3 and four rounds of ammo.
  helo: T('helo', 'Attack Helicopter', 'air', 'drone',
    7, 3, 2, 5, 10, 0, 3, 4, 240, ['air'],
    'Flies: crosses rivers, mud and zones of control at 7 hexes a turn, and ' +
    'kills armour from two hexes out with no reply from the ground. It takes ' +
    'no cover and cannot dig in, so air defence eats it alive — a SHORAD ' +
    'burst is 6 damage and a SAM is 7. Four missiles, then it needs the truck.'),

  // Renamed (player feedback round 7): the owner played a whole scenario
  // without realising "SHORAD" WAS the anti-air unit. The stat line is
  // untouched — only the display name and the description changed.
  aa: T('aa', 'SHORAD Air Defence', 'aa', 'aa',
    5, 3, 2, 2, 1, 9, 5, 6, 130, ['intercept'],
    'Short-range anti-aircraft: the gun/missile mount that shoots helicopters ' +
    'and recon UAVs out of the sky two hexes out, and the ONLY thing that ' +
    'swats an inbound FPV or loitering munition off your tanks. Keep it with ' +
    'the column, not behind it.'),

  // Long-range area air defence. Deliberately NOT an upgrade of the SHORAD:
  // double the envelope and a better air column, bought with half the mobility,
  // one point less armour, no interception and no ground attack whatsoever.
  sam: T('sam', 'SAM Air Defence Battery', 'aa', 'aa',
    3, 4, 4, 1, 0, 10, 4, 4, 190, ['airdef'],
    'Long-range anti-aircraft: a search radar and four canisters that deny ' +
    'the sky FOUR hexes out — an umbrella you park over what matters, not a ' +
    'unit you drive. It cannot intercept FPV drones (that is SHORAD work) and ' +
    'it cannot shoot at the ground at all. Screen it or lose it.'),

  ew: T('ew', 'EW Jammer Truck', 'support', 'ew',
    4, 2, 0, 0, 0, 0, 3, 0, 120, ['jammer'],
    'Projects a jamming bubble two hexes wide: enemy FPV aborts, drone ' +
    'damage ×0.4, enemy recon blinded. Unarmed and soft — protect it.'),

  infantry: T('infantry', 'Line Infantry', 'infantry', 'infantry',
    3, 2, 1, 6, 3, 1, 7, 6, 60, ['entrench_bonus'],
    'Holds towns and treelines, digs in to +3, and dies in the open. ' +
    'Nothing else takes ground and keeps it.'),

  atgm_team: T('atgm_team', 'ATGM Team', 'infantry', 'infantry',
    3, 3, 2, 2, 9, 0, 5, 3, 80, ['atgm'],
    'Tank ambush from range 2 — the target cannot reply. Three missiles, ' +
    'then it is just three men in a ditch.'),

  truck: T('truck', 'Supply Truck', 'support', 'supply',
    7, 1, 0, 0, 0, 0, 2, 0, 50, ['supply'],
    'Rearms and patches adjacent units that hold their turn. Unit ' +
    'preservation lives or dies with this vehicle.'),

  fpv_drone: T('fpv_drone', 'FPV Strike Team', 'drone', 'drone',
    3, 2, 4, 6, 10, 0, 4, 2, 70, ['expendable'],
    'Two airframes, top attack, no return fire. A 70-point team that can ' +
    'gut a 220-point tank — until EW or SHORAD says otherwise.'),

  recon_drone: T('recon_drone', 'Recon UAV', 'drone', 'recon',
    8, 4, 0, 0, 0, 0, 4, 0, 60, ['recon'],
    'Flies over everything, sees four hexes, and turns blind artillery ' +
    'into guided artillery. Only SHORAD can touch it.'),

  loiter_munition: T('loiter_munition', 'Loitering Munition Battery', 'drone', 'drone',
    3, 1, 10, 7, 6, 0, 3, 3, 180, ['indirect', 'expendable'],
    'Three Shahed-class rounds with map-deep reach — the only weapon that ' +
    'can kill enemy infrastructure. Spend them on the right target.'),
};

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------
let nextId = 1;

/**
 * Build a live unit instance.
 * @param {string} typeId  key of UNIT_TYPES
 * @param {'blue'|'red'} faction
 * @param {{q:number,r:number}} hex  axial coordinates
 */
export function createUnit(typeId, faction, hex) {
  const type = UNIT_TYPES[typeId];
  if (!type) throw new Error(`Unknown unit type: ${typeId}`);

  const mesh = buildUnitMesh(typeId, faction);
  const { x, z } = hexToWorld(hex.q, hex.r);
  const y = _terrain ? _terrain.heightAt(x, z) : 0;
  mesh.position.set(x, y, z);
  // Models face +X. BLUE attacks east, RED faces the assault.
  mesh.rotation.y = faction === 'blue' ? 0 : Math.PI;

  const unit = {
    id: nextId++,
    typeId,
    type,
    faction,
    hex: { q: hex.q, r: hex.r },
    hp: type.hp,
    ammo: type.ammo,
    moved: false,
    fired: false,
    entrench: 0,
    suppressed: false,
    veterancy: 0,
    kills: 0,
    mesh,
    alive: true,
  };

  mesh.userData.unitId = unit.id;
  mesh.userData.faction = faction;
  mesh.userData.typeId = typeId;
  return unit;
}
