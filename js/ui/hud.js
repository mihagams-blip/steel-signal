// STEEL SIGNAL — ui/hud.js
// Military field-console HUD: command bar, order-of-battle rail, sector minimap,
// unit card with APP-6-ish glyphs, fire-control action bar, typewriter comms log,
// hex tooltips, toasts, briefing + after-action screens, and the pointer/keyboard
// order layer (select / move / attack / fire mission / FPV / loiter / dig in).
// Contract: export function initHUD(Game, deps). Pure DOM — no framework.
//
// Optional Game APIs used when present (see INTEGRATION_NOTES.md):
//   Game.fpvStrike(u, t)  Game.loiterStrike(u, t)  Game.artilleryBarrage(u, hex)
//   Game.entrench(u)
// Fallbacks: the contract exports of combat.js, or Game.emit('entrench', u).
//
// The HUD also owns the `body.fpv-active` suppression class (css/ui.css): while
// the FPV feed is up every #hud-root panel fades out so the drone video is clean.
// It is driven from BOTH ends — dronecam.js sets it on dive start, and a
// MutationObserver on #fpv-overlay mirrors the overlay's own visibility, so the
// suppression is correct even if the dronecam module is replaced.

import { Raycaster, Vector2, Vector3 } from 'three';
import {
  HEX, hexDistance, hexToWorld, worldToHex, camGroundDistance,
} from '../world/terrain.js';
// `visibleHexes` is fog.js's documented extra export (INTEGRATION_NOTES.md).
// The sector map needs the BLUE set specifically — `isVisible` answers for
// whichever side is acting, so during the RED phase it would fog the player's
// own map from the enemy's point of view.
import { isVisible, visibleHexes } from '../game/fog.js';
import {
  fpvStrike, loiterStrike, artilleryBarrage, isAirUnit, canEngageAir,
} from '../game/combat.js';
// The mixer panel (music / SFX levels, master mute, [K]) is HUD chrome; the
// gain graph, the localStorage record and the FPV duck all live in audio.js.
// Every call below is safe before the audio context exists.
import { Audio } from '../audio/audio.js';

/* ---------------------------------------------------------------- lookups */

const TERRAIN_NAMES = {
  field: 'WHEAT FIELD', grass: 'STEPPE GRASS', forest: 'WINDBREAK',
  town: 'BUILT-UP AREA', water: 'RIVER', road: 'ROAD', mud: 'MUD FLAT',
};

// CRITIQUE fix 22. `field` is not one crop — terrain.js splats several of them
// in strips that cross hex boundaries, so the tooltip used to read WHEAT FIELD
// over a tile rendering as a solid block of sunflowers. Index order matches the
// ground shader's splat channels exactly and the minimap's MM_FIELD palette
// below: 0 wheat · 1 sunflower · 2 fallow grass · 3 ploughed earth · 4 stubble.
//
// The fifth channel arrived with the round-2 world pass and is a genuinely
// different hue on the ground (pale bone straw, not gold), so leaving it out
// would have re-created the exact defect this fix exists to remove — the label
// would read WHEAT FIELD over a parcel that is plainly cut and windrowed.
// `terrain.layout.fieldInfo()` deliberately clamps its published `field` to the
// original 0–3 range and reports stubble as wheat, so the truth has to be read
// off `crop` (its documented full-fidelity field) with `field` as the fallback.
const CROP_NAMES = ['WHEAT FIELD', 'SUNFLOWER FIELD', 'FALLOW GRASS',
  'PLOUGHED EARTH', 'STUBBLE FIELD'];
const CROP_INDEX = {
  wheat: 0, sunflower: 1, fallow: 2, plough: 3, ploughed: 3, stubble: 4,
};

// Resolve one splat sample to a crop channel. Never throws, never returns an
// index MM_FIELD / CROP_NAMES cannot answer.
function cropIndex(fi) {
  if (!fi) return 0;
  const named = CROP_INDEX[fi.crop];
  if (named !== undefined) return named;
  const f = fi.field | 0;
  return f < 0 ? 0 : f > 4 ? 4 : f;
}

const TRAIT_LABELS = {
  indirect: 'INDIRECT', expendable: 'EXPENDABLE', jammer: 'EW JAMMER',
  recon: 'RECON', supply: 'SUPPLY', atgm: 'ATGM',
  entrench_bonus: 'SAPPERS', intercept: 'INTERCEPT',
};

// PLAYER-FEEDBACK ROUND — "I do not know what Loiter means." One plain-language
// line per specialist type, shown on the unit card whenever that type is
// selected (and mirrored, for the ORDERS, by the action-bar data-tip bubbles).
// The truck's line is also the answer to "I do not know how to resupply":
// the §3.1 rule, stated where the player is already looking.
const ROLE_HINTS = {
  fpv_drone: 'FPV team — first-person kamikaze drones (range 4 hexes): top ' +
    'attack, strong vs armour; can be jammed by EW or shot down by AA. Each ' +
    'strike consumes an airframe.',
  loiter_munition: 'Loiter battery — loitering munitions (e.g. Lancet) circle ' +
    'and dive; range 10 hexes; the only weapon that can destroy infrastructure ' +
    'at distance.',
  recon_drone: 'Recon UAV — a flying spotter: artillery firing at targets it ' +
    'sees hits at full effect. Keep it forward, away from enemy SHORAD.',
  ew: 'EW jammer — projects a jamming bubble (radius 2): enemy FPV strikes ' +
    'can abort, drone damage drops, enemy recon inside is blinded.',
  truck: 'Supply truck — any unit that ends the turn on an adjacent hex ' +
    'without moving or firing refills its ammo and repairs +2 hp (up to 8).',
};

const INFRA_NAMES = {
  bridge: 'BRIDGE', substation: 'SUBSTATION', fuel_depot: 'FUEL DEPOT',
  rail_yard: 'RAIL YARD', comms_tower: 'COMMS TOWER',
};

// Roster labels — the full type names are far too long for a 248px rail, so the
// row shows the field abbreviation and carries the full name in its tooltip.
const SHORT_NAMES = {
  mbt: 'MBT', ifv: 'IFV', apc: 'APC', spg: 'SP HOWITZER', mlrs: 'MLRS',
  aa: 'SHORAD AD', ew: 'EW JAMMER', infantry: 'INFANTRY', atgm_team: 'ATGM TEAM',
  truck: 'SUPPLY', fpv_drone: 'FPV TEAM', recon_drone: 'RECON UAV',
  loiter_munition: 'LOITER BTY',
  // AUDIO/AIR ROUND. "SHORAD" alone did not read as anti-air to the owner, so
  // the rail abbreviation now carries "AD" too and the two air-defence types
  // sort together under one family.
  helo: 'ATTACK HELO', sam: 'SAM BATTERY',
};

// Order of battle sorts by combined-arms family, the way a real ORBAT is read.
// `air` sits directly after `aa` so the gunship and the batteries that answer it
// are read as one air problem, above the drones.
const CLASS_ORDER = {
  armor: 0, mech: 1, infantry: 2, artillery: 3, aa: 4, air: 5, drone: 6,
  support: 7,
};

/* ------------------------------------------------------- minimap palette */
// Derived from ART_DIRECTION §3 so the sector map reads as the same battlefield:
// the five splat channels (wheat / sunflower / fallow / ploughed / stubble)
// plus the surface overrides. RGB triplets, shaded per-pixel by the 14° sun.
const MM_VOID = [15, 18, 14];
const MM_SURFACE = {
  water: [40, 68, 74],
  forest: [44, 62, 34],
  town: [150, 139, 120],
  road: [116, 97, 72],
  mud: [74, 59, 42],
};
const MM_FIELD = [
  [201, 168, 92],   // 0 ripe wheat      0xC9A85C
  [197, 154, 56],   // 1 sunflower       0xC59A38
  [122, 125, 69],   // 2 fallow grass    0x7A7D45
  [138, 111, 77],   // 3 ploughed earth  0x8A6F4D
  [196, 186, 150],  // 4 stubble         0xC4BA96
];
const MM_WINDBREAK = [38, 54, 30];
// Sun direction (unit vector toward the sun) — ART_DIRECTION §1, elevation 14°.
const MM_SUN = { x: -0.912, y: 0.242, z: -0.332 };

/* ---------------------------------------------------------------- helpers */

function esc(s) {
  return String(s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// fictional operation clock: T1 = 0540Z, +20 min per turn
function zulu(turn) {
  const m = 5 * 60 + 40 + (Math.max(1, turn | 0) - 1) * 20;
  const hh = String(Math.floor(m / 60) % 24).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}${mm}Z`;
}

function fmtCost(c) {
  if (c === Infinity || c === undefined || c === null || c > 50) return '—';
  return c % 1 ? c.toFixed(1) : String(c);
}

// ---- ROUND-6 FIX 6 (the in-world half of it is fx/markers.js) --------------
// The class-symbol set is keyed on TYPE, not on `type.icon`. Eight icons cannot
// separate thirteen types — mbt/ifv/apc were all a bare oval, spg/mlrs the same
// dot, infantry/atgm_team the same cross — and the field chit used to paper over
// that with a three-letter code, which is the thing round 6 called debug output.
// The code is gone from the chit, so the glyph has to carry the distinction on
// its own, in BOTH places: this table and the GLYPH table in fx/markers.js are
// the same set and an edit to one is an edit to the other. It is duplicated
// rather than imported on purpose — ui/ must not take a dependency on fx/.
const GLYPH = {
  mbt: 'armor',
  ifv: 'armor_inf',
  apc: 'armor_carrier',
  spg: 'armor_arty',
  mlrs: 'armor_rocket',
  aa: 'aa',
  ew: 'ew',
  infantry: 'infantry',
  atgm_team: 'infantry_at',
  truck: 'supply',
  fpv_drone: 'drone_strike',
  recon_drone: 'recon',
  loiter_munition: 'drone_loiter',
  // AUDIO/AIR ROUND. Without these two the fallback drew `type.icon`, which
  // gave the SAM the SHORAD's identical arc — two different air-defence units
  // sharing one counter symbol, in the round whose whole point was that the
  // player could not tell which unit was the anti-air one.
  helo: 'helo',
  sam: 'aa_long',
};

// APP-6-ish glyph: friendly rounded rect / hostile diamond, class symbol inside.
// `typeId` selects the modified symbol; `icon` is the fallback base for a type
// the table has never heard of.
function glyphSVG(icon, faction, typeId) {
  const hostile = faction === 'red';
  const cx = 26, cy = 18;
  const hw = hostile ? 9.5 : 12.5;
  const hh = hostile ? 6 : 8;
  const frame = hostile
    ? `<polygon points="26,2 50,18 26,34 2,18" fill="rgba(0,0,0,0.42)" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>`
    : `<rect x="5.5" y="4.5" width="41" height="27" rx="3.5" fill="rgba(0,0,0,0.42)" stroke="currentColor" stroke-width="2.4"/>`;
  const L = (x1, y1, x2, y2, w) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="${w || 2.2}" stroke-linecap="round"/>`;
  const OVAL = `<ellipse cx="${cx}" cy="${cy}" rx="${hw * 0.9}" ry="${hh * 0.8}" fill="none" stroke="currentColor" stroke-width="2.2"/>`;
  const X = (k, w) =>
    L(cx - hw * k, cy - hh * k, cx + hw * k, cy + hh * k, w) +
    L(cx - hw * k, cy + hh * k, cx + hw * k, cy - hh * k, w);
  const DOT = (r, ox) =>
    `<circle cx="${cx + (ox || 0)}" cy="${cy}" r="${r}" fill="currentColor"/>`;
  const CHEV = (k, dy, w) =>
    `<path d="M ${cx - hw * k} ${cy + hh * k * 0.9 + dy} L ${cx} ${cy - hh * k + dy} L ${cx + hw * k} ${cy + hh * k * 0.9 + dy}" fill="none" stroke="currentColor" stroke-width="${w || 2.2}" stroke-linejoin="round"/>`;
  let sym;
  switch (GLYPH[typeId] || icon) {
    case 'infantry':
      sym = X(1);
      break;
    case 'infantry_at':                       // + anti-tank arrowhead, nested
      sym = X(1) + CHEV(0.42, -hh * 0.36, 1.8);
      break;
    case 'armor':
      sym = OVAL;
      break;
    case 'armor_inf':                         // oval + cross: mechanised
      sym = OVAL + X(0.48, 1.8);
      break;
    case 'armor_carrier':                     // oval + deck bar
      sym = OVAL + L(cx - hw * 0.5, cy, cx + hw * 0.5, cy, 1.8);
      break;
    case 'armor_arty':                        // oval + gun dot: SP artillery
      sym = OVAL + DOT(hh * 0.36);
      break;
    case 'armor_rocket':                      // oval + two gun dots: rockets
      sym = OVAL + DOT(hh * 0.26, -hw * 0.40) + DOT(hh * 0.26, hw * 0.40);
      break;
    case 'arty':
      sym = `<circle cx="${cx}" cy="${cy}" r="3.2" fill="currentColor"/>`;
      break;
    case 'aa':
      sym = `<path d="M ${cx - hw} ${cy + hh} Q ${cx} ${cy - hh - 3} ${cx + hw} ${cy + hh}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`;
      break;
    case 'aa_long':                           // AA arc + range bar = area defence
      sym = `<path d="M ${cx - hw} ${cy + hh} Q ${cx} ${cy - hh - 3} ${cx + hw} ${cy + hh}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
        L(cx - hw * 0.72, cy + hh * 0.92, cx + hw * 0.72, cy + hh * 0.92, 1.8);
      break;
    case 'helo':                              // rotor bar over a fuselage oval
      sym = L(cx - hw, cy - hh * 0.72, cx + hw, cy - hh * 0.72, 2.2) +
        `<ellipse cx="${cx}" cy="${cy + hh * 0.30}" rx="${hw * 0.62}" ry="${hh * 0.52}" fill="none" stroke="currentColor" stroke-width="2.2"/>` +
        L(cx, cy - hh * 0.72, cx, cy - hh * 0.18, 1.8);
      break;
    case 'ew':
      sym = `<polyline points="${cx - hw},${cy + 2} ${cx - hw / 2},${cy - hh * 0.8} ${cx},${cy + 2} ${cx + hw / 2},${cy - hh * 0.8} ${cx + hw},${cy + 2}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>`;
      break;
    case 'drone':
      sym = CHEV(1, 0);
      break;
    case 'drone_strike':                      // chevron + warhead dot
      sym = CHEV(1, -hh * 0.16) + DOT(hh * 0.30);
      break;
    case 'drone_loiter':                      // chevron + orbit bar
      sym = CHEV(1, -hh * 0.22) +
        L(cx - hw * 0.62, cy + hh * 0.86, cx + hw * 0.62, cy + hh * 0.86, 1.8);
      break;
    case 'supply':
      sym = L(cx - hw, cy + hh * 0.5, cx + hw, cy + hh * 0.5);
      break;
    case 'recon':
      sym = L(cx - hw, cy + hh, cx + hw, cy - hh);
      break;
    default:
      sym = `<circle cx="${cx}" cy="${cy}" r="2.6" fill="currentColor"/>`;
  }
  return `<svg class="ss-glyph" viewBox="0 0 52 36" aria-hidden="true">${frame}${sym}</svg>`;
}

/* ------------------------------------------------- unit-card portraits */
// CRITIQUE fix 26. The card used to show the same APP-6 class glyph as the
// roster — a bracketed oval for every tracked vehicle, a crossed box for every
// dismount — so LINE INFANTRY and ATGM TEAM had identical portraits. These are
// per-TYPE monoline silhouettes, one for each of the thirteen entries in
// units.js, authored on a 64×40 field with the ground line at y ≈ 31 and a
// single 1.9 stroke weight so the whole set reads as one instrument. Drawn in
// the HUD amber (currentColor, see .ss-type-icon in css/ui.css); affiliation
// stays on the small APP-6 chip in the corner of the sensor frame, so the card
// answers "what is it" and "whose is it" as two separate reads.
// Everything faces right — the direction BLUE attacks in this scenario.
const TYPE_ART = {
  mbt: `
    <rect x="4" y="24.6" width="55" height="7" rx="3.5"/>
    <circle cx="10.5" cy="28.1" r="2.1"/><circle cx="18.5" cy="28.1" r="2.1"/>
    <circle cx="26.5" cy="28.1" r="2.1"/><circle cx="34.5" cy="28.1" r="2.1"/>
    <circle cx="42.5" cy="28.1" r="2.1"/><circle cx="50.5" cy="28.1" r="2.1"/>
    <path d="M7 24.6 L10.5 18.4 H46.5 L53 21.2 L56.5 24.6"/>
    <path d="M20 18.4 L23.6 11.6 H37.4 L41 18.4"/>
    <path d="M26 11.6 V8.6 H30.6 V11.6"/>
    <path d="M41 14.6 H61.5"/><path d="M56.5 12.4 V16.8"/>`,
  ifv: `
    <rect x="4.5" y="25" width="54" height="6.4" rx="3.2"/>
    <circle cx="10" cy="28.2" r="1.9"/><circle cx="17" cy="28.2" r="1.9"/>
    <circle cx="24" cy="28.2" r="1.9"/><circle cx="31" cy="28.2" r="1.9"/>
    <circle cx="38" cy="28.2" r="1.9"/><circle cx="45" cy="28.2" r="1.9"/>
    <circle cx="52" cy="28.2" r="1.9"/>
    <path d="M7.5 25 L9.5 19.6 H41 L55 22.4 L57.5 25"/>
    <path d="M21 19.6 L23.4 14 H33.6 L36 19.6"/>
    <path d="M36 16.2 H53.5"/>
    <rect x="23.4" y="10.4" width="9.4" height="3.2" rx="0.8"/>`,
  apc: `
    <path d="M4.5 25.2 V19.4 L11.5 14.6 H45.5 L56.5 18.4 L58.5 21.6 V25.2 Z"/>
    <circle cx="12.5" cy="27.4" r="3.6"/><circle cx="23" cy="27.4" r="3.6"/>
    <circle cx="40" cy="27.4" r="3.6"/><circle cx="50.5" cy="27.4" r="3.6"/>
    <path d="M24 14.6 V10.8 H30.6 V14.6"/><path d="M30.6 12.2 H41.5"/>
    <path d="M15 18 h6.5 M25 18 h6.5 M35 18 h6.5"/>`,
  spg: `
    <rect x="4" y="24.6" width="55" height="7" rx="3.5"/>
    <circle cx="10.5" cy="28.1" r="2.1"/><circle cx="18.5" cy="28.1" r="2.1"/>
    <circle cx="26.5" cy="28.1" r="2.1"/><circle cx="34.5" cy="28.1" r="2.1"/>
    <circle cx="42.5" cy="28.1" r="2.1"/><circle cx="50.5" cy="28.1" r="2.1"/>
    <path d="M7 24.6 L9 19 H50 L56 22 L58.5 24.6"/>
    <path d="M11.5 19 L13.6 9.6 H38.5 L43 19"/>
    <path d="M40.5 12.4 L61 5.2"/><path d="M55.1 4.1 L57.1 9.7"/>
    <path d="M6 26 L1.8 31.4"/>`,
  mlrs: `
    <rect x="4.5" y="25" width="53" height="6.4" rx="3.2"/>
    <circle cx="10" cy="28.2" r="2"/><circle cx="17" cy="28.2" r="2"/>
    <circle cx="24" cy="28.2" r="2"/><circle cx="42" cy="28.2" r="2"/>
    <circle cx="49" cy="28.2" r="2"/><circle cx="55.5" cy="28.2" r="2"/>
    <path d="M8 25 V21 H38"/>
    <path d="M40 25 V18.6 H48 L56 22 V25"/>
    <g transform="rotate(-24 20 16.5)">
      <rect x="8" y="12" width="24" height="9" rx="1.2"/>
      <path d="M8 15 H32 M8 18 H32"/><path d="M32 12 V21"/>
    </g>`,
  aa: `
    <rect x="4.5" y="25" width="50" height="6.4" rx="3.2"/>
    <circle cx="10" cy="28.2" r="2"/><circle cx="17" cy="28.2" r="2"/>
    <circle cx="24" cy="28.2" r="2"/><circle cx="31" cy="28.2" r="2"/>
    <circle cx="38" cy="28.2" r="2"/><circle cx="45" cy="28.2" r="2"/>
    <path d="M7.5 25 L9.5 19.8 H44 L49 22 L52 25"/>
    <path d="M16 19.8 V14.6 H33 V19.8"/>
    <g transform="rotate(-16 24 11.6)">
      <rect x="14" y="9" width="20" height="5.2" rx="1"/>
      <path d="M14 11.6 H34"/>
    </g>
    <path d="M38 19.8 V12.3"/><path d="M34 15 A6.5 6.5 0 0 1 42.5 9.5"/>
    <path d="M38 12.3 L40.2 10.6"/>`,
  ew: `
    <path d="M4.5 25.4 V17.6 H30 V25.4 Z"/>
    <path d="M30 25.4 V19.6 H38.4 L44 22.6 V25.4 Z"/>
    <circle cx="11" cy="27.6" r="3.2"/><circle cx="24" cy="27.6" r="3.2"/>
    <circle cx="38.5" cy="27.6" r="3.2"/>
    <path d="M17 17.6 V5.6"/>
    <path d="M12.6 8.8 H21.4 M13.8 11.8 H20.2 M14.6 14.4 H19.4"/>
    <path d="M24.5 7.4 A9 9 0 0 1 24.5 16.4"/>
    <path d="M30 4.6 A13.5 13.5 0 0 1 30 19.2"/>`,
  infantry: `
    <path d="M9 31.6 H55" opacity="0.32"/>
    <circle cx="17" cy="12.6" r="2.6"/>
    <path d="M17 15.2 V22.4"/><path d="M17 22.4 L13 30.6 M17 22.4 L21.4 30.6"/>
    <path d="M17 17.6 L22.6 19.2"/>
    <path d="M12.6 21.6 L26.4 16.2"/><path d="M19.6 18.9 L20.7 21.4"/>
    <circle cx="39" cy="14.4" r="2.3"/>
    <path d="M39 16.7 V23"/><path d="M39 23 L35.5 30.6 M39 23 L42.6 30.6"/>
    <path d="M39 18.6 L43.8 19.9"/>
    <path d="M35.2 22.2 L47 17.6"/><path d="M41.3 19.8 L42.2 21.9"/>`,
  atgm_team: `
    <path d="M9 31.6 H55" opacity="0.32"/>
    <path d="M17.6 20.2 L45 13.4"/><path d="M18.4 23.4 L45.8 16.6"/>
    <path d="M17.6 20.2 L18.4 23.4"/><path d="M45 13.4 L45.8 16.6"/>
    <path d="M28.2 17.4 L29.6 13.8 H33.6 L32.2 17.4"/>
    <path d="M31.5 19 L26.4 30.8 M31.5 19 L34.6 30.8 M31.5 19 L38.6 29.6"/>
    <circle cx="13.4" cy="17.2" r="2.4"/>
    <path d="M13.4 19.6 L11.4 25 H17.8"/><path d="M17.8 25 V30.8"/>
    <path d="M13.2 21.4 L19.4 20.2"/>`,
  truck: `
    <path d="M5 14.2 V25.6 H33 V14.2"/>
    <path d="M5 14.2 Q19 9.6 33 14.2"/>
    <path d="M12 12.5 V25.6 M19 11.9 V25.6 M26 12.5 V25.6"/>
    <path d="M33 25.6 V17.6 H40.8 L46.8 21.6 V25.6 Z"/>
    <path d="M40.8 18.6 V21.4 H45.4"/>
    <circle cx="12" cy="28" r="3.4"/><circle cx="24.5" cy="28" r="3.4"/>
    <circle cx="41" cy="28" r="3.4"/>`,
  fpv_drone: `
    <path d="M32 19 L15.5 10.8 M32 19 L48.5 10.8"/>
    <path d="M32 19 L15.5 27.2 M32 19 L48.5 27.2"/>
    <circle cx="14" cy="10" r="6.4"/><circle cx="50" cy="10" r="6.4"/>
    <circle cx="14" cy="28" r="6.4"/><circle cx="50" cy="28" r="6.4"/>
    <circle cx="14" cy="10" r="1.1" fill="currentColor"/>
    <circle cx="50" cy="10" r="1.1" fill="currentColor"/>
    <circle cx="14" cy="28" r="1.1" fill="currentColor"/>
    <circle cx="50" cy="28" r="1.1" fill="currentColor"/>
    <rect x="25" y="14.4" width="14" height="9.2" rx="1.6"/>
    <path d="M39 16.4 L45.6 19 L39 21.6"/>`,
  recon_drone: `
    <path d="M13 17.6 H44 Q52 17.6 55.5 20 Q52 22.4 44 22.4 H13 Z"/>
    <path d="M38 17.6 L29 5 H24.5 L31 17.6"/>
    <path d="M38 22.4 L29 35 H24.5 L31 22.4"/>
    <path d="M17 18 L11 10 M17 22 L11 30"/>
    <ellipse cx="11.2" cy="20" rx="1.3" ry="7.2"/>
    <circle cx="48.6" cy="20" r="1.8"/>`,
  loiter_munition: `
    <path d="M55 20 L19 7.2 L13.5 20 L19 32.8 Z"/>
    <path d="M20.5 20 H49"/>
    <path d="M47 17.2 L42.5 10.8 M47 22.8 L42.5 29.2"/>
    <path d="M13.5 20 H9.4"/>
    <ellipse cx="9.4" cy="20" rx="1.3" ry="6.6"/>
    <circle cx="50.4" cy="20" r="1.6"/>`,
  _default: `
    <rect x="8" y="17.6" width="48" height="9.6" rx="2"/>
    <circle cx="18" cy="28.6" r="3.2"/><circle cx="46" cy="28.6" r="3.2"/>
    <path d="M18 17.6 V13 H34"/>`,
};

// Painted portraits live in art/units/<typeId>.png (320x320, dark charcoal
// ground, lit to match the HUD). They replace the monoline silhouette in the
// card only — the roster keeps the APP-6 glyph, which stays more legible at
// 32 px than any painting. Every id here must have a file on disk; anything
// missing falls back to TYPE_ART, and so does a decode failure at runtime
// (see the onerror below), so the card can never render empty.
const TYPE_PHOTO = new Set([
  'mbt', 'ifv', 'apc', 'spg', 'mlrs', 'aa', 'ew', 'infantry',
  'atgm_team', 'truck', 'fpv_drone', 'recon_drone', 'loiter_munition',
]);

function typeArtSVG(typeId, cls) {
  const art = TYPE_ART[typeId] || TYPE_ART._default;
  return `<svg class="${cls}" viewBox="0 0 64 40" aria-hidden="true">` +
    `<g fill="none" stroke="currentColor" stroke-width="1.9" ` +
    `stroke-linecap="round" stroke-linejoin="round">${art}</g></svg>`;
}

function typeIconSVG(typeId) {
  if (!TYPE_PHOTO.has(typeId)) return typeArtSVG(typeId, 'ss-type-icon');
  // On a decode failure swap in the silhouette rather than leaving a gap.
  const fallback = typeArtSVG(typeId, 'ss-type-icon').replace(/"/g, '&quot;');
  return `<img class="ss-type-photo" src="art/units/${typeId}.png" alt="" ` +
    `decoding="async" onerror="this.outerHTML='${fallback}'">`;
}

// Small APP-6 affiliation chip that rides in the corner of the sensor frame:
// friend = rounded rectangle, hostile = diamond. Colour comes from
// #ss-unitcard(.hostile) .uc-brackets, so the portrait stays amber.
function affSVG(faction) {
  return faction === 'red'
    ? `<svg class="ss-aff" viewBox="0 0 22 22" aria-hidden="true">` +
      `<polygon points="11,2.4 19.6,11 11,19.6 2.4,11" fill="rgba(8,10,8,0.66)" ` +
      `stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/></svg>`
    : `<svg class="ss-aff" viewBox="0 0 22 22" aria-hidden="true">` +
      `<rect x="2.6" y="5" width="16.8" height="12.4" rx="2" fill="rgba(8,10,8,0.66)" ` +
      `stroke="currentColor" stroke-width="2.1"/></svg>`;
}

function pipRow(cur, max) {
  const n = Math.max(0, Math.min(12, max | 0));
  let s = '';
  for (let i = 0; i < n; i++) s += `<b class="${i < cur ? 'on' : ''}"></b>`;
  return s;
}

/* ------------------------------------------------------------------ init */

export function initHUD(Game, deps = {}) {
  const root = document.getElementById('hud-root');
  if (!root) return;
  const engine = deps.engine || null;
  const terrain = deps.terrain || null;
  const features = deps.features || null;

  const reduceMotion = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ---- markup ---------------------------------------------------------- */

  root.innerHTML = `
    <div id="ss-worldlabels" aria-hidden="true"></div>

    <div id="ss-topbar" class="ss-panel">
      <div class="tb-brand">STEEL <b>SIGNAL</b></div>
      <div class="sep"></div>
      <div class="stat"><span class="k">Turn</span><span class="v accent" id="ss-turn">–</span></div>
      <div class="sep"></div>
      <div class="stat"><span class="k">Phase</span><span class="v friendly" id="ss-side">–</span></div>
      <div class="sep"></div>
      <div class="stat"><span class="k">Requisition</span><span class="v" id="ss-res">–</span></div>
      <div class="sep"></div>
      <div class="stat"><span class="k">Objectives</span><span class="v" id="ss-obj"></span></div>
    </div>

    <div id="ss-toasts" role="status" aria-live="polite" aria-atomic="false"></div>

    <div id="ss-mixer" class="ss-panel" role="group" aria-label="Audio mixer">
      <div class="mx-head">
        <span class="ss-head">Audio</span>
        <button class="mx-master" id="mx-master" type="button" aria-pressed="false"
                aria-label="Mute all audio (K)" title="Mute all audio [K]">
          <span class="mx-led" aria-hidden="true"></span><span class="mx-lbl">Mute</span>
        </button>
      </div>
      <div class="mx-row">
        <button class="mx-ch" id="mx-music-mute" type="button" aria-pressed="false"
                aria-label="Mute music" title="Mute music"><i aria-hidden="true">♪</i></button>
        <span class="mx-k">Mus</span>
        <input class="mx-slider" id="mx-music" type="range" min="0" max="100" step="1"
               value="55" aria-label="Music volume">
        <span class="mx-v" id="mx-music-v">55</span>
      </div>
      <div class="mx-row">
        <button class="mx-ch" id="mx-sfx-mute" type="button" aria-pressed="false"
                aria-label="Mute sound effects" title="Mute sound effects"><i aria-hidden="true">⌁</i></button>
        <span class="mx-k">Sfx</span>
        <input class="mx-slider" id="mx-sfx" type="range" min="0" max="100" step="1"
               value="100" aria-label="Sound effects volume">
        <span class="mx-v" id="mx-sfx-v">100</span>
      </div>
    </div>

    <div id="ss-oob" class="ss-panel">
      <div class="oob-head">
        <span class="ss-head">Order of battle</span>
        <span class="oob-count" id="oob-count">—</span>
        <button class="oob-toggle" id="oob-toggle" type="button"
                aria-expanded="true" aria-controls="oob-list"
                aria-label="Collapse roster (O)"
                title="Collapse roster [O]"></button>
      </div>
      <div class="oob-list" id="oob-list" role="group"
           aria-label="Order of battle"></div>
      <div class="oob-foot">
        <span><b class="lg mv">M</b>move left</span>
        <span><b class="lg fr">F</b>fire left</span>
      </div>
    </div>

    <div id="ss-minimap" class="ss-panel">
      <div class="mm-head">
        <span class="ss-head">Sector</span>
        <span class="mm-scale" id="mm-scale">—</span>
      </div>
      <div class="mm-body">
        <canvas id="mm-canvas" width="200" height="200"
                aria-label="Sector minimap"></canvas>
        <div class="mm-frame"></div>
      </div>
      <div class="mm-key">
        <span><i class="k-own"></i>OWN</span>
        <span><i class="k-en"></i>CONTACT</span>
        <span><i class="k-lk"></i>LAST SEEN</span>
      </div>
    </div>

    <div id="ss-unitcard" class="ss-panel hidden">
      <div class="uc-left">
        <div class="uc-brackets">
          <span id="uc-glyph"></span>
          <span class="uc-aff" id="uc-aff"></span>
        </div>
        <div class="uc-vet" id="uc-vet"></div>
      </div>
      <div class="uc-main">
        <div class="uc-name" id="uc-name">—</div>
        <div class="uc-sub" id="uc-sub">—</div>
        <div class="uc-bar"><span class="k">HP</span><span class="pips" id="uc-hp"></span></div>
        <div class="uc-bar"><span class="k">AMMO</span><span class="pips ammo" id="uc-ammo"></span></div>
        <div class="uc-stats" id="uc-stats"></div>
        <div class="uc-tags" id="uc-tags"></div>
        <div class="uc-hint hidden" id="uc-hint"></div>
      </div>
    </div>

    <div id="ss-actionbar" class="ss-panel" role="group" aria-label="Fire control">
      <button class="ss-act" data-act="move" aria-label="Move (M)"
              data-tip="Order movement [M]. Move and fire are separate actions — a unit that has moved can still fire."><i aria-hidden="true">M</i><span>Move</span></button>
      <button class="ss-act" data-act="attack" aria-label="Attack (T)"
              data-tip="Direct fire [T] at an enemy within range and sight."><i aria-hidden="true">T</i><span>Attack</span></button>
      <button class="ss-act" data-act="artillery" aria-label="Fire mission (R)"
              data-tip="Indirect artillery [R] — needs a spotted target for full effect; blind fire is weak."><i aria-hidden="true">R</i><span>Fire msn</span></button>
      <button class="ss-act" data-act="fpv" aria-label="FPV strike (F)"
              data-tip="First-person kamikaze drone [F] — top attack, strong vs armour; can be jammed by EW or shot down by AA. Consumes an airframe."><i aria-hidden="true">F</i><span>FPV</span></button>
      <button class="ss-act" data-act="loiter" aria-label="Loitering munition (L)"
              data-tip="Loitering munition [L] (kamikaze drone, e.g. Lancet) — circles and dives; long range; the only weapon that can destroy infrastructure at distance."><i aria-hidden="true">L</i><span>Loiter</span></button>
      <button class="ss-act" data-act="entrench" aria-label="Dig in (X)"
              data-tip="Entrench [X]: +defense next turn, lost on moving."><i aria-hidden="true">X</i><span>Dig in</span></button>
      <div class="ab-sep"></div>
      <button id="ss-endturn" class="ss-btn" aria-label="End turn (Enter)"
              title="End turn [Enter]">End turn</button>
    </div>

    <div id="ss-log" class="ss-panel">
      <div class="ss-head"><span>Comms log</span>
        <span class="log-live"><span class="dot"></span>NET OPEN</span></div>
      <div class="entries" id="ss-log-entries"></div>
    </div>

    <div id="ss-tooltip" class="hidden"></div>

    <div id="ss-briefing" class="ss-overlay" role="dialog" aria-modal="true"
         aria-label="Operation briefing">
      <div class="ss-screen ss-panel" id="ss-brief-panel"></div>
    </div>
    <div id="ss-gameover" class="ss-overlay hidden" role="dialog" aria-modal="true"
         aria-label="After-action report">
      <div class="ss-screen ss-panel" id="ss-go-panel"></div>
    </div>
  `;

  const $ = (id) => root.querySelector(id);
  const elTurn = $('#ss-turn');
  const elSide = $('#ss-side');
  const elRes = $('#ss-res');
  const elObj = $('#ss-obj');
  const elToasts = $('#ss-toasts');
  const elCard = $('#ss-unitcard');
  const elGlyph = $('#uc-glyph');
  const elAff = $('#uc-aff');
  const elVet = $('#uc-vet');
  const elName = $('#uc-name');
  const elSub = $('#uc-sub');
  const elHp = $('#uc-hp');
  const elAmmo = $('#uc-ammo');
  const elStats = $('#uc-stats');
  const elTags = $('#uc-tags');
  const elHint = $('#uc-hint');
  const elActs = [...root.querySelectorAll('.ss-act')];
  const elEndTurn = $('#ss-endturn');
  const elLog = $('#ss-log-entries');
  const elTip = $('#ss-tooltip');
  const elBriefing = $('#ss-briefing');
  const elBriefPanel = $('#ss-brief-panel');
  const elGameover = $('#ss-gameover');
  const elGoPanel = $('#ss-go-panel');
  const elOob = $('#ss-oob');
  const elOobList = $('#oob-list');
  const elOobCount = $('#oob-count');
  const elOobToggle = $('#oob-toggle');
  const elMini = $('#ss-minimap');
  const elMmCanvas = $('#mm-canvas');
  const elMmScale = $('#mm-scale');
  const elLabels = $('#ss-worldlabels');

  /* ---- local state ------------------------------------------------------ */

  let sel = null;              // selected unit
  let mode = 'none';           // none|move|attack|artillery|fpv|loiter
  let targets = [];            // attackable targets for 'attack' mode
  let targetSet = null;        // Set("q,r") of valid click hexes for the mode
  let busy = false;            // an order (move animation) is in flight
  let gridOn = false;
  let tipKey = null;
  let lastHover = 0;
  let fpvActive = false;       // FPV feed up → the whole HUD is suppressed
  let oobCollapsed = false;

  const overlayOpen = () =>
    !elBriefing.classList.contains('hidden') ||
    !elGameover.classList.contains('hidden');

  /* ---- panel layer: live or not at all ---------------------------------- */
  // CRITIQUE fix 23, third pass. Making the roster rows real <button>s is what
  // put them in the accessibility tree — and that cuts both ways, because a
  // real control stays focusable and stays readable by a screen reader even
  // when it is invisible. Two states make the whole panel layer invisible:
  //   · the briefing / after-action modal sitting on top of it, where plain TAB
  //     still belongs to the browser (the keydown layer deliberately does not
  //     swallow it while an overlay is up), so focus walked straight into the
  //     sixteen roster buttons BEHIND the dialog;
  //   · the FPV blackout, which fades every #hud-root panel to opacity 0 — a
  //     0-opacity button is still a button to the keyboard and to AT.
  // `inert` is the exact tool: no focus, no hit testing, no a11y exposure, and
  // it lifts again in one property write. The two overlays are deliberately
  // excluded — they ARE the live layer while they are up, which is what makes
  // their aria-modal="true" true rather than aspirational.
  // Nothing here changes a single pixel: inert has no rendering of its own, and
  // the pointer-events/opacity rules in css/ui.css are untouched.
  const panelEls = [...root.children].filter(
    (el) => el !== elBriefing && el !== elGameover);
  let panelsInert = null;

  function syncInert() {
    const on = overlayOpen() || fpvActive;
    if (on === panelsInert) return;
    panelsInert = on;
    for (const el of panelEls) {
      try { el.inert = on; } catch (err) { /* pre-inert browser: attribute only */ }
      if (on) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }
  }

  const arr = (fn) => {
    try { const v = fn(); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  };
  const keySet = (hexes) => new Set(hexes.map((h) => `${h.q},${h.r}`));

  const unitAt = (hex) => Game.units.find(
    (u) => u.alive && u.hex && u.hex.q === hex.q && u.hex.r === hex.r) || null;

  const infraAt = (hex) => ((features && features.infrastructure) || []).find(
    (i) => i.alive && i.hex && i.hex.q === hex.q && i.hex.r === hex.r) || null;

  const visibleHex = (hex) => {
    try { return isVisible(hex) !== false; } catch (e) { return true; }
  };

  const clearHl = () => { try { terrain && terrain.clearHighlights(); } catch (e) {} };

  function rangeHexes(u, minR, maxR) {
    const out = [];
    if (!terrain || !terrain.tiles) return out;
    for (const t of terrain.tiles.values()) {
      const d = hexDistance(u.hex, t);
      if (d >= minR && d <= maxR) out.push({ q: t.q, r: t.r });
    }
    return out;
  }

  /* ---- toasts ----------------------------------------------------------- */

  function toast(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = `ss-toast ${kind}`;
    el.textContent = text;
    elToasts.appendChild(el);
    while (elToasts.children.length > 4) elToasts.removeChild(elToasts.firstChild);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 350);
    }, 3400);
  }

  /* ---- typewriter comms log --------------------------------------------- */

  const typeQueue = [];
  let typeTimer = null;

  function typeTick() {
    // A busy turn can push a dozen lines at once; typing them at a fixed rate
    // puts the log minutes behind the battle (and the interval is clamped to
    // ~1 Hz in a background tab). Catch up by finishing the backlog instantly
    // and speeding up whatever is left.
    while (typeQueue.length > 3) {
      const old = typeQueue.shift();
      old.body.textContent = old.text;
    }
    const job = typeQueue[0];
    if (!job) { clearInterval(typeTimer); typeTimer = null; return; }
    const speed = 2 + typeQueue.length * 3;      // 2 ch/tick alone, 11 with a queue
    job.i = Math.min(job.text.length, job.i + speed);
    job.body.textContent = job.text.slice(0, job.i);
    if (job.i >= job.text.length) typeQueue.shift();
    elLog.scrollTop = elLog.scrollHeight;
  }

  // ---- ROUND-3 FIX 12: consecutive identical entries collapse -------------
  // A fire mission that lands on empty ground resolves once per shell, and the
  // log printed "BLUE SP Howitzer barrage lands on empty ground — no effect."
  // four times, byte for byte, in four consecutive rows. Four identical lines
  // do not read as four events; they read as a stuck renderer, and this is the
  // panel that currently carries the build's best UI impression.
  //
  // A repeat is only a repeat INSIDE ONE STAMP. Two identical lines an hour
  // apart on the Zulu clock are two different events and the second one gets
  // its own row with its own timestamp — collapsing those would make the log
  // lie about when something happened, which is worse than the defect.
  let lastRow = null;      // the row the previous message was written into
  let lastText = '';       // its body text, for the byte-identical test
  let lastStamp = '';      // its Zulu stamp
  let lastCount = 1;
  let lastRep = null;      // the ×N badge, created on the first repeat only

  function bumpRepeat() {
    lastCount++;
    if (!lastRep) {
      lastRep = document.createElement('span');
      lastRep.className = 'rep';
      lastRow.appendChild(lastRep);
    }
    lastRep.textContent = `×${lastCount}`;
    // Re-arm the 300 ms flash. Removing and re-adding a class inside one frame
    // is a no-op to the animation engine, so force a reflow between the writes
    // — otherwise the 3rd, 4th and 5th repeat land silently and the player
    // never sees the count move.
    if (!reduceMotion) {
      lastRep.classList.remove('hit');
      void lastRep.offsetWidth;
      lastRep.classList.add('hit');
    }
    elLog.scrollTop = elLog.scrollHeight;
  }

  function pushLog(msg) {
    const text = typeof msg === 'string' ? msg
      : (msg && typeof msg.text === 'string') ? msg.text : String(msg);
    const stamp = zulu(Game.turn);
    if (lastRow && lastRow.isConnected && text === lastText && stamp === lastStamp) {
      bumpRepeat();
      return;
    }
    const row = document.createElement('div');
    row.className = 'entry';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = stamp;
    const body = document.createElement('span');
    body.className = 'm';
    row.appendChild(t);
    row.appendChild(body);
    elLog.appendChild(row);
    lastRow = row; lastText = text; lastStamp = stamp; lastCount = 1; lastRep = null;
    while (elLog.children.length > 80) elLog.removeChild(elLog.firstChild);
    if (reduceMotion) {
      body.textContent = text;
      elLog.scrollTop = elLog.scrollHeight;
      return;
    }
    // Flush on push as well as on tick: the interval is clamped hard in a
    // background tab, and a log that is minutes behind the battle is worse than
    // no animation at all.
    while (typeQueue.length > 3) {
      const oldJob = typeQueue.shift();
      oldJob.body.textContent = oldJob.text;
    }
    typeQueue.push({ body, text, i: 0 });
    if (!typeTimer) typeTimer = setInterval(typeTick, 16);
  }

  /* ---- top bar ---------------------------------------------------------- */

  function refreshTop() {
    elTurn.textContent = `${Game.turn} / ${Game.maxTurns}`;
    const blue = Game.side === 'blue';
    elSide.textContent = blue ? 'BLUE — ORDERS' : 'RED — MOVING';
    elSide.className = `v ${blue ? 'friendly' : 'enemy'}`;
    elRes.textContent = String((Game.resources && Game.resources.blue) ?? 0);
    const objs = Game.objectives || [];
    const held = objs.filter((o) => o.owner === 'blue').length;
    elObj.innerHTML =
      `<span class="obj-count">${held}/${objs.length}</span>` +
      objs.map((o) => {
        const name = esc(o.name || o.id || 'OBJECTIVE');
        const cls = `pip${o.owner === 'blue' ? ' held' : ''}${o.primary ? ' primary' : ''}`;
        return `<span class="${cls}" title="${name} — ${o.owner === 'blue' ? 'HELD' : 'RED-HELD'}">◆</span>`;
      }).join('');
  }

  /* ---- unit card -------------------------------------------------------- */

  const statCell = (k, v, tip) =>
    `<span class="st"${tip ? ` title="${esc(tip)}"` : ''}><span class="k">${k}</span><span class="v">${v}</span></span>`;

  // ITEM 4 (round 2) — ranges are stated in hexes, in words, everywhere the
  // number appears. "RNG 4" answered a question the player did not know how to
  // ask; "4 HEX" plus a spelled-out title does.
  const hexN = (n) => `${n | 0} ${(n | 0) === 1 ? 'hex' : 'hexes'}`;

  function renderCard() {
    if (!sel || !sel.alive) { elCard.classList.add('hidden'); return; }
    const t = sel.type || {};
    elCard.classList.remove('hidden');
    elCard.classList.toggle('hostile', sel.faction !== 'blue');
    elGlyph.innerHTML = typeIconSVG(sel.typeId);
    if (elAff) elAff.innerHTML = affSVG(sel.faction);
    elName.textContent = t.name || sel.typeId;
    elSub.textContent =
      `${String(sel.typeId || '').replace(/_/g, ' ').toUpperCase()} · GRID ${sel.hex.q}·${sel.hex.r}`;
    elVet.textContent = '★'.repeat(Math.min(2, sel.veterancy | 0));
    elHp.innerHTML = pipRow(sel.hp, t.hp || 10);
    elHp.className = `pips ${sel.hp >= 7 ? 'ok' : sel.hp >= 4 ? 'mid' : 'low'}`;
    const maxAmmo = t.ammo | 0;
    elAmmo.innerHTML = maxAmmo > 0 ? pipRow(sel.ammo, maxAmmo)
      : '<span class="na">—</span>';
    elAmmo.className = `pips ammo${sel.ammo === 0 && maxAmmo > 0 ? ' low' : ''}`;
    const a = t.attack || {};
    const rng = t.range ?? 0;
    elStats.innerHTML = [
      statCell('ATK S·H·A', `${a.soft ?? 0}·${a.hard ?? 0}·${a.air ?? 0}`,
        'Attack vs soft / hard / air targets'),
      statCell('DEF', t.defense ?? 0, 'Defense'),
      statCell('MOV', t.move ?? 0, `Movement: ${hexN(t.move ?? 0)} per turn`),
      statCell('RNG', rng > 0 ? `${rng} HEX` : '—',
        rng > 0 ? `Weapon range: ${hexN(rng)}` : 'No weapon'),
      statCell('SGT', t.sight ?? 0, `Sight: ${hexN(t.sight ?? 0)}`),
    ].join('');
    const tags = [];
    for (const tr of (t.traits || [])) {
      tags.push(`<span class="tag">${TRAIT_LABELS[tr] || String(tr).toUpperCase()}</span>`);
    }
    if (sel.entrench > 0) tags.push(`<span class="tag good">DUG-IN +${sel.entrench}</span>`);
    if (sel.suppressed) tags.push('<span class="tag bad">SUPPRESSED</span>');
    // PLAYER-FEEDBACK ROUND — "I do not know how to resupply." A bare NO AMMO
    // tag told the player what is wrong and nothing about what to do; the tag
    // now names the remedy.
    if (sel.ammo === 0 && maxAmmo > 0) {
      tags.push('<span class="tag warn">OUT OF AMMO — RESUPPLY AT A SUPPLY TRUCK</span>');
    }
    if (sel.moved) tags.push('<span class="tag dim">MOVED</span>');
    if (sel.fired) tags.push('<span class="tag dim">FIRED</span>');
    // And the other half: when resupply is actually ON OFFER, say so before the
    // player wanders off. `Game.resupplyEligible` is the systems side of this
    // round's contract (see INTEGRATION_NOTES, GAMEPLAY ROUND entry) and
    // mirrors `_supplyTick` §3.1 exactly; the local fallback below keeps the
    // chip honest if the HUD ever boots against an older state.js.
    if (sel.faction === 'blue' && resupplyOnOffer(sel)) {
      tags.push('<span class="tag good">RESUPPLY — HOLD POSITION UNTIL END OF TURN</span>');
    }
    elTags.innerHTML = tags.join('');
    // Specialist role line — the loiter battery, FPV team, recon UAV, jammer
    // and supply truck each carry one sentence of doctrine on their card.
    if (elHint) {
      const hint = ROLE_HINTS[sel.typeId];
      elHint.textContent = hint || '';
      elHint.classList.toggle('hidden', !hint);
    }
  }

  // "Would ending the turn right now resupply this unit?" Prefer the state
  // layer's own answer (`Game.resupplyEligible`, this round's contract); the
  // fallback is a HUD-side mirror of `_supplyTick` §3.1 read from the same
  // Game.units array the mechanic reads, so it cannot disagree.
  function resupplyOnOffer(u) {
    if (typeof Game.resupplyEligible === 'function') {
      try { return !!Game.resupplyEligible(u); } catch (e) { /* fall through */ }
    }
    if (!u || !u.alive || !u.hex || u.moved || u.fired) return false;
    const t = u.type || {};
    if ((t.traits || []).includes('supply')) return false;
    const near = Game.units.some((s) => s !== u && s.alive &&
      s.faction === u.faction && s.hex && s.type &&
      (s.type.traits || []).includes('supply') &&
      hexDistance(s.hex, u.hex) === 1);
    if (!near) return false;
    const maxAmmo = t.ammo | 0;
    return (maxAmmo > 0 && u.ammo < maxAmmo) || u.hp < 8;
  }

  /* ---- action bar ------------------------------------------------------- */

  function canDo(act) {
    if (!sel || !sel.alive || sel.faction !== 'blue' || Game.side !== 'blue') return false;
    const t = sel.type || {};
    const traits = t.traits || [];
    const a = t.attack || {};
    switch (act) {
      case 'move':
        return !sel.moved;
      case 'attack':
        return !sel.fired && sel.ammo > 0 && (t.range || 0) >= 1 &&
          ((a.soft || 0) + (a.hard || 0) + (a.air || 0)) > 0 &&
          sel.typeId !== 'fpv_drone' && sel.typeId !== 'loiter_munition';
      case 'artillery':
        return traits.includes('indirect') && !traits.includes('expendable') &&
          !sel.fired && sel.ammo > 0;
      case 'fpv':
        return sel.typeId === 'fpv_drone' && !sel.fired && sel.ammo > 0;
      case 'loiter':
        return sel.typeId === 'loiter_munition' && !sel.fired && sel.ammo > 0;
      case 'entrench':
        // Nothing airborne digs in (§2) — state.js refuses it, so the button
        // must not offer it either. `isAirUnit` covers the helicopter, whose
        // class is 'air' and which the typeId list below would have missed.
        return !sel.moved && !sel.fired && !isAirUnit(sel) &&
          !['fpv_drone', 'recon_drone', 'loiter_munition'].includes(sel.typeId);
      default:
        return false;
    }
  }

  // PLAYER-FEEDBACK ROUND — "sometimes when I move a unit it is still green,
  // but I cannot move it again." Move and fire are separate actions by design;
  // the bar now SAYS so. A selected unit that has moved strikes the Move label
  // through (css/ui.css .ss-act.used) and its tooltip states the rule instead
  // of repeating "Order movement" over a button that will not take the order.
  const MOVE_TIP_FRESH = 'Order movement [M]. Move and fire are separate ' +
    'actions — a unit that has moved can still fire.';
  const MOVE_TIP_USED = 'Already moved this turn — move and fire are separate ' +
    'actions; this unit can still fire if it has a weapon and ammo.';

  // ITEM 4 (round 2) — the weapon tooltips state the selected unit's actual
  // reach in hexes. The generic strings stay for when nothing (or an enemy) is
  // selected; the moment a BLUE unit with that action is up, the bubble names
  // its number, so "how far can this shoot" is answered where the order is
  // given. Static text otherwise identical in doctrine to the shipped strings.
  const WEAPON_TIP_BASE = {
    attack: 'Direct fire [T] at an enemy within range and sight.',
    artillery: 'Indirect artillery [R] — needs a spotted target for full ' +
      'effect; blind fire is weak.',
    fpv: 'First-person kamikaze drone [F] — top attack, strong vs armour; ' +
      'can be jammed by EW or shot down by AA. Consumes an airframe.',
    loiter: 'Loitering munition [L] (kamikaze drone, e.g. Lancet) — circles ' +
      'and dives; long range; the only weapon that can destroy infrastructure ' +
      'at distance.',
  };

  function weaponTip(act) {
    const base = WEAPON_TIP_BASE[act];
    if (!sel || sel.faction !== 'blue' || !sel.type) return base;
    const R = sel.type.range | 0;
    if (R < 1 || !canDo(act)) return base;
    switch (act) {
      case 'attack':
        return `Direct fire [T] — range ${hexN(R)}, needs a spotted target ` +
          '(line of sight).';
      case 'artillery':
        return `Indirect artillery [R] — range ${hexN(R)}; needs a spotted ` +
          'target for full effect; blind fire is weak.';
      case 'fpv':
        return `FPV strike [F] — range ${hexN(R)}; top attack, strong vs ` +
          'armour; can be jammed by EW or shot down by AA. Consumes an airframe.';
      case 'loiter':
        return `Loitering munition [L] — range ${hexN(R)}; circles and dives; ` +
          'the only weapon that can destroy infrastructure at distance.';
      default:
        return base;
    }
  }

  function renderActions() {
    const movedSel = !!(sel && sel.alive && sel.faction === 'blue' && sel.moved);
    for (const btn of elActs) {
      const act = btn.dataset.act;
      btn.disabled = !canDo(act);
      btn.classList.toggle('active', mode === act);
      if (act === 'move') {
        btn.classList.toggle('used', movedSel);
        btn.setAttribute('data-tip', movedSel ? MOVE_TIP_USED : MOVE_TIP_FRESH);
      } else if (WEAPON_TIP_BASE[act]) {
        const tip = weaponTip(act);
        if (btn.getAttribute('data-tip') !== tip) btn.setAttribute('data-tip', tip);
      }
    }
    elEndTurn.disabled = Game.side !== 'blue' || Game.phase === 'over';
  }

  /* ---- mode machine ----------------------------------------------------- */

  function setMode(m) {
    mode = m;
    clearHl();
    targets = [];
    targetSet = null;
    if (m === 'none' || !sel || sel.faction !== 'blue') {
      mode = 'none';
      renderActions();
      return;
    }
    if (m === 'move') {
      const reach = arr(() => Game.reachableHexes(sel));
      targetSet = keySet(reach);
      if (reach.length && terrain) terrain.highlightHexes(reach, 'move');
    } else if (m === 'attack') {
      targets = arr(() => Game.attackableTargets(sel));
      // ITEM 4 honesty: the no-target fallback used to light the FULL range
      // ring, sight or no sight — implying hexes the unit could not legally
      // engage. Direct fire is spotting-limited (state.js attackableTargets),
      // so the fallback is clipped to what BLUE can currently see.
      const hexes = targets.length
        ? targets.map((t) => t.hex).filter(Boolean)
        : rangeHexes(sel, 1, (sel.type && sel.type.range) || 1).filter(visibleHex);
      targetSet = keySet(hexes);
      if (hexes.length && terrain) terrain.highlightHexes(hexes, 'attack');
    } else {
      // artillery / fpv / loiter: hex-targeted within weapon range
      const hexes = rangeHexes(sel, 1, (sel.type && sel.type.range) || 1);
      targetSet = keySet(hexes);
      if (hexes.length && terrain) {
        terrain.highlightHexes(hexes, m === 'artillery' ? 'attack' : 'drone');
      }
    }
    renderActions();
  }

  function applyDefaultMode() {
    if (!sel || sel.faction !== 'blue' || Game.side !== 'blue') { setMode('none'); return; }
    if (!sel.moved) setMode('move');
    else if (canDo('attack')) setMode('attack');
    else if (canDo('artillery')) setMode('artillery');
    else if (canDo('fpv')) setMode('fpv');
    else if (canDo('loiter')) setMode('loiter');
    else setMode('none');
  }

  /* ---- selection -------------------------------------------------------- */

  function selectUnit(u) {
    Game.selected = u;
    Game.emit('select', u);
  }

  function deselect() {
    if (!sel) { renderActions(); return; }
    Game.selected = null;
    Game.emit('deselect');
  }

  function cancelOrDeselect() {
    if (sel && sel.faction === 'blue' &&
      (mode === 'attack' || mode === 'artillery' || mode === 'fpv' || mode === 'loiter') &&
      !sel.moved) {
      setMode('move');
    } else {
      deselect();
    }
  }

  /* ---- orders ----------------------------------------------------------- */

  function afterOrder() {
    refreshTop();
    refreshRoster();
    if (sel && sel.alive) { renderCard(); applyDefaultMode(); }
    else deselect();
  }

  function orderMove(hex) {
    if (busy || !sel) return;
    let path = null;
    try { path = Game.pathTo(sel, hex); } catch (e) { path = null; }
    if (!path || (Array.isArray(path) && path.length === 0)) return;
    busy = true;
    clearHl();
    let p = null;
    try { p = Game.moveUnit(sel, path); } catch (e) { p = null; }
    Promise.resolve(p).catch(() => {}).finally(() => { busy = false; afterOrder(); });
  }

  function orderAttack(target) {
    if (busy || !sel || !target) return;
    busy = true;
    try { Game.attack(sel, target); } catch (e) {}
    busy = false;
    afterOrder();
  }

  function orderStrike(target, kind) {
    if (busy || !sel || !target) return;
    busy = true;
    try {
      if (kind === 'fpv') {
        if (typeof Game.fpvStrike === 'function') Game.fpvStrike(sel, target);
        else fpvStrike(sel, target);
      } else {
        if (typeof Game.loiterStrike === 'function') Game.loiterStrike(sel, target);
        else loiterStrike(sel, target);
      }
    } catch (e) {}
    busy = false;
    afterOrder();
  }

  function orderArtillery(hex) {
    if (busy || !sel) return;
    busy = true;
    try {
      if (typeof Game.artilleryBarrage === 'function') Game.artilleryBarrage(sel, hex);
      else artilleryBarrage(sel, hex);
    } catch (e) {}
    busy = false;
    afterOrder();
  }

  function orderEntrench() {
    if (!canDo('entrench')) return;
    try {
      if (typeof Game.entrench === 'function') Game.entrench(sel);
      else Game.emit('entrench', sel);
    } catch (e) {}
    renderCard();
    renderActions();
  }

  /* ---- hex click routing ------------------------------------------------ */

  // PLAYER-FEEDBACK ROUND — clicking a destination with a unit that has already
  // moved used to be pure silence, which read as a bug ("it is still green, but
  // I cannot move it again"). Every such click now answers with a toast and a
  // comms-log line naming the rule. Throttled: a frustrated double-click is one
  // explanation, not two.
  let movedNoteAt = 0;

  function noteAlreadyMoved() {
    if (!sel) return;
    const now = performance.now();
    if (now - movedNoteAt < 1500) return;
    movedNoteAt = now;
    const name = (sel.type && sel.type.name) || String(sel.typeId || 'Unit');
    const canFire = canDo('attack') || canDo('artillery') ||
      canDo('fpv') || canDo('loiter');
    if (canFire) {
      toast('ALREADY MOVED — CAN STILL FIRE', 'warn');
      pushLog(`${name} has already moved. Move and fire are separate actions — it can still fire this turn.`);
    } else if (sel.fired) {
      toast('UNIT SPENT — MOVED AND FIRED', 'warn');
      pushLog(`${name} has already moved and fired — no actions left this turn.`);
    } else {
      toast('ALREADY MOVED THIS TURN', 'warn');
      pushLog(`${name} has already moved this turn.`);
    }
  }

  // GAMEPLAY ROUND 2, ITEM 4 — "I often did not quite understand how far units
  // can shoot." Half of the answer is the always-on envelope boundary
  // (fx/markers.js); this is the other half: a rejected click in a targeting
  // mode now NAMES its reason instead of doing nothing. Same 1.4 s throttle
  // discipline as noteAlreadyMoved — a frustrated double-click is one
  // explanation, not two.
  let denyNoteAt = 0;

  function noteDenied(short, logLine) {
    const now = performance.now();
    if (now - denyNoteAt < 1400) return;
    denyNoteAt = now;
    toast(short, 'warn');
    if (logLine) pushLog(logLine);
  }

  function onHexClick(hex) {
    if (overlayOpen() || busy || fpvActive ||
        Game.side !== 'blue' || Game.phase === 'over') return;
    const u = unitAt(hex);
    const targeting = mode === 'attack' || mode === 'artillery' ||
      mode === 'fpv' || mode === 'loiter';

    if (targeting && sel) {
      if (u && u.faction === 'blue') { selectUnit(u); return; }
      const key = `${hex.q},${hex.r}`;
      const st = sel.type || {};
      const R = st.range || 1;
      const d = hexDistance(sel.hex, hex);
      const selName = st.name || String(sel.typeId || 'Unit');
      if (targetSet && targetSet.size && !targetSet.has(key)) {
        // Ground click outside the weapon envelope while the unit has already
        // moved: this is almost always an attempted second move. Say so.
        if (sel.moved && !u && d > R) { noteAlreadyMoved(); return; }
        // ITEM 4 — otherwise say WHY the hex is not a legal target.
        const maxAmmo = st.ammo | 0;
        if (maxAmmo > 0 && sel.ammo <= 0) {
          noteDenied('OUT OF AMMO — RESUPPLY AT A TRUCK',
            `${selName}: out of ammo — hold beside a supply truck to rearm.`);
        } else if (d > R) {
          noteDenied(`OUT OF RANGE — RNG ${R}`,
            `${selName}: that hex is ${d} hexes out — weapon range is ${R}.`);
        } else if (mode === 'attack' && !visibleHex(hex)) {
          noteDenied('NO LINE OF SIGHT — NOT SPOTTED',
            `${selName}: no line of sight — nothing is spotted on that hex.`);
        } else if (mode === 'attack' && u) {
          noteDenied(isAirUnit(u)
            ? 'ONLY AIR DEFENCE CAN ENGAGE AIR' : 'NO WEAPON EFFECT VS TARGET',
            isAirUnit(u) && !canEngageAir(sel)
              ? `${selName} cannot shoot at aircraft — bring SHORAD or the SAM battery.`
              : `${selName} cannot engage that target class.`);
        } else if (mode === 'attack') {
          noteDenied('NO TARGET — NEEDS A SPOTTED ENEMY',
            `${selName}: direct fire needs a spotted enemy unit on the hex.`);
        }
        return;
      }
      if (mode === 'attack') {
        const t = targets.find((x) => x.hex && x.hex.q === hex.q && x.hex.r === hex.r) ||
          (u && u.faction !== 'blue' ? u : null);
        if (t) { orderAttack(t); return; }
        // In-envelope hex with no engageable target (ITEM 4): explain.
        if (u && u.faction !== 'blue') {
          noteDenied(isAirUnit(u)
            ? 'ONLY AIR DEFENCE CAN ENGAGE AIR' : 'NO WEAPON EFFECT VS TARGET',
            isAirUnit(u) && !canEngageAir(sel)
              ? `${selName} cannot shoot at aircraft — bring SHORAD or the SAM battery.`
              : `${selName} cannot engage that target class.`);
        } else {
          noteDenied('NO TARGET — NEEDS A SPOTTED ENEMY',
            `${selName}: direct fire needs a spotted enemy unit on the hex.`);
        }
        return;
      }
      if (mode === 'artillery') { orderArtillery(hex); return; }
      if (mode === 'fpv') {
        if (u && u.faction !== 'blue') orderStrike(u, 'fpv');
        else {
          noteDenied('NO TARGET — NEEDS A SPOTTED ENEMY',
            `${selName}: an FPV strike needs a spotted enemy unit, not open ground.`);
        }
        return;
      }
      if (mode === 'loiter') {
        const target = (u && u.faction !== 'blue') ? u : infraAt(hex);
        if (target) orderStrike(target, 'loiter');
        else {
          noteDenied('NO TARGET — UNIT OR INFRASTRUCTURE',
            `${selName}: loitering munitions need an enemy unit or infrastructure.`);
        }
        return;
      }
      return;
    }

    if (u) {
      if (u.faction === 'blue') { selectUnit(u); return; }
      if (visibleHex(hex)) { selectUnit(u); return; } // inspect spotted enemy
    }

    if (sel && sel.faction === 'blue' && mode === 'move') {
      if (targetSet && targetSet.has(`${hex.q},${hex.r}`)) { orderMove(hex); return; }
    }
    // A fully spent unit (mode 'none') clicking open ground: keep the selection
    // and explain, rather than silently deselecting — the old behaviour looked
    // like the order was simply ignored.
    if (sel && sel.faction === 'blue' && sel.moved && mode === 'none' && !u) {
      noteAlreadyMoved();
      return;
    }
    deselect();
  }

  /* ---- tooltip ---------------------------------------------------------- */

  function hideTooltip() {
    tipKey = null;
    elTip.classList.add('hidden');
  }

  // CRITIQUE fix 22 — name the crop the player is actually looking at.
  // `terrain.layout.fieldInfo(x, z)` is the same splat sampler the ground shader
  // and the minimap read, so this cannot drift from what is rendered. A hex is
  // 10.4 units across and the strip mosaic ignores hex boundaries, so a single
  // centre sample would mislabel any tile a seam runs through: seven samples
  // (centre, double-weighted, plus a ring at 0.62 × the circumradius) and the
  // dominant channel wins. Static data — cached per hex, computed at most once.
  const CROP_RING = [
    [0, 0], [0.62, 0], [-0.62, 0],
    [0.31, 0.54], [-0.31, 0.54], [0.31, -0.54], [-0.31, -0.54],
  ];
  const cropNames = new Map();

  function cropName(tile) {
    const k = `${tile.q},${tile.r}`;
    const hit = cropNames.get(k);
    if (hit) return hit;
    const layout = (terrain && terrain.layout) || null;
    const fieldInfo = layout && typeof layout.fieldInfo === 'function'
      ? layout.fieldInfo : null;
    let name = CROP_NAMES[0];
    let wx = tile.x, wz = tile.z;
    if (!Number.isFinite(wx) || !Number.isFinite(wz)) {
      const w = hexToWorld(tile.q, tile.r);
      wx = w.x; wz = w.z;
    }
    if (fieldInfo) {
      const tally = [0, 0, 0, 0, 0];
      let n = 0;
      for (let i = 0; i < CROP_RING.length; i++) {
        const s = CROP_RING[i];
        let fi = null;
        try { fi = fieldInfo(wx + s[0] * HEX.size, wz + s[1] * HEX.size); }
        catch (e) { fi = null; }
        if (!fi) continue;
        // a windbreak seam ploughs the ground under it in the splat (terrain.js
        // surfaceInfo pushes w3 by 1.6·k inside 9 units), so it has to read as
        // ploughed earth here too — but only where it genuinely dominates the
        // strip's own crop, which is inside ~3.5 units of the seam line
        const idx = (fi.seam < 3.5) ? 3 : cropIndex(fi);
        tally[idx] += i === 0 ? 2 : 1;
        n++;
      }
      if (n) {
        let best = 0;
        for (let i = 1; i < tally.length; i++) if (tally[i] > tally[best]) best = i;
        name = CROP_NAMES[best] || CROP_NAMES[0];
      }
    }
    cropNames.set(k, name);
    return name;
  }

  function terrainName(tile) {
    if (tile.type === 'field') return cropName(tile);
    return TERRAIN_NAMES[tile.type] || String(tile.type).toUpperCase();
  }

  function showTooltip(hex, x, y) {
    if (!terrain || !terrain.tiles) { hideTooltip(); return; }
    const tile = terrain.tiles.get(`${hex.q},${hex.r}`);
    if (!tile) { hideTooltip(); return; }
    const key = `${hex.q},${hex.r}`;
    if (key !== tipKey) {
      tipKey = key;
      const rows = [];
      rows.push(`<div class="tt-head">GRID ${hex.q}·${hex.r} — ${esc(terrainName(tile))}</div>`);
      rows.push(`<div class="tt-row"><span>MOVE</span><b>${fmtCost(tile.moveCost)}</b><span>COVER</span><b>${tile.cover ?? 0}</b></div>`);
      const inf = infraAt(hex);
      if (inf) {
        rows.push(`<div class="tt-row infra"><span>${esc(inf.name || INFRA_NAMES[inf.kind] || 'INFRASTRUCTURE')}</span><b>${inf.hp ?? '—'} HP</b></div>`);
      }
      const u = unitAt(hex);
      if (u && (u.faction === 'blue' || visibleHex(hex))) {
        rows.push(`<div class="tt-unit ${u.faction === 'blue' ? 'fr' : 'en'}">${glyphSVG(u.type && u.type.icon, u.faction, u.typeId)}<span>${esc((u.type && u.type.name) || u.typeId)}</span><b>${u.hp}/10</b></div>`);
      }
      elTip.innerHTML = rows.join('');
      elTip.classList.remove('hidden');
    }
    const r = elTip.getBoundingClientRect();
    elTip.style.left = `${Math.min(x + 16, window.innerWidth - r.width - 10)}px`;
    elTip.style.top = `${Math.min(y + 18, window.innerHeight - r.height - 10)}px`;
  }

  /* ---- FPV feed suppression --------------------------------------------- */
  // While the drone feed is up the main HUD must get out of the way: the whole
  // point of the dive is a clean video frame. `body.fpv-active` fades every
  // #hud-root panel out over 180 ms and pulls the action bar entirely
  // (css/ui.css). dronecam.js sets the class itself; the observer below mirrors
  // #fpv-overlay's own visibility so the behaviour survives a dronecam rewrite
  // and always clears if a dive is aborted mid-flight.

  function setFpvActive(on) {
    on = !!on;
    if (on === fpvActive) return;
    fpvActive = on;
    document.body.classList.toggle('fpv-active', on);
    syncInert();
    if (on) hideTooltip();
    // The dive is the one moment the game asks for the player's whole
    // attention, so the music steps back 6 dB and comes back after. This is
    // separate from the player's own music fader and never overwrites it.
    try { Audio.duckMusic(on); } catch (err) { /* audio is never fatal */ }
  }

  (function watchFpvOverlay() {
    const ov = document.getElementById('fpv-overlay');
    if (!ov || typeof MutationObserver !== 'function') return;
    const read = () => {
      const el = document.getElementById('fpv-overlay');
      if (!el || !el.isConnected) { setFpvActive(false); return; }
      const hidden = el.classList.contains('hidden') ||
        el.style.display === 'none' || el.style.visibility === 'hidden';
      const op = el.style.opacity;
      const faded = op !== '' && parseFloat(op) < 0.05;
      setFpvActive(!hidden && !faded);
    };
    try {
      new MutationObserver(read).observe(ov, {
        attributes: true, attributeFilter: ['class', 'style'],
      });
    } catch (e) { /* observation is a nicety, never fatal */ }
    read();
  }());

  /* ---- audio mixer ------------------------------------------------------- */
  // Two independent faders, because "turn the music down" and "turn the guns
  // down" are different requests: conflating them would mean the only way to
  // silence the soundtrack is to silence the game. Each channel has its own
  // mute; [K] is the master kill. audio.js owns the levels and persists them
  // to localStorage, so a reload comes back exactly as the player left it.

  const elMixerPanel = $('#ss-mixer');
  const elMxMaster = $('#mx-master');
  const elMxMusic = $('#mx-music');
  const elMxSfx = $('#mx-sfx');
  const elMxMusicMute = $('#mx-music-mute');
  const elMxSfxMute = $('#mx-sfx-mute');
  const elMxMusicV = $('#mx-music-v');
  const elMxSfxV = $('#mx-sfx-v');

  // While the player is dragging a fader, the readout must follow the pointer
  // and not the round-trip through audio.js — otherwise the number stutters.
  let mxDragging = null;

  function paintMixer(mix) {
    if (!mix) return;
    const master = !!mix.muted;
    const rows = [
      [elMxMusic, elMxMusicV, elMxMusicMute, mix.music, mix.musicMuted],
      [elMxSfx, elMxSfxV, elMxSfxMute, mix.sfx, mix.sfxMuted],
    ];
    for (const [slider, out, btn, value, chMuted] of rows) {
      if (!slider) continue;
      const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
      if (slider !== mxDragging) slider.value = String(pct);
      // the amber fill is drawn by the track gradient in css/ui.css
      slider.style.setProperty('--mx-fill', `${pct}%`);
      // A master-muted rack still takes adjustments — the player sets the
      // level they want and then unmutes. Nothing here is ever `disabled`;
      // the channels only *look* dead.
      const off = master || chMuted;
      slider.classList.toggle('off', off);
      if (out) {
        out.textContent = off ? '––' : String(pct);
        out.classList.toggle('off', off);
      }
      if (btn) {
        btn.setAttribute('aria-pressed', chMuted ? 'true' : 'false');
        btn.classList.toggle('off', chMuted);
      }
    }
    if (elMxMaster) {
      elMxMaster.setAttribute('aria-pressed', master ? 'true' : 'false');
      elMxMaster.classList.toggle('off', master);
      const lbl = elMxMaster.querySelector('.mx-lbl');
      if (lbl) lbl.textContent = master ? 'Muted' : 'Mute';
      elMxMaster.setAttribute('aria-label',
        master ? 'Unmute all audio (K)' : 'Mute all audio (K)');
      elMxMaster.title = master ? 'Unmute all audio [K]' : 'Mute all audio [K]';
    }
    if (elMixerPanel) elMixerPanel.classList.toggle('all-muted', master);
  }

  function readMix() {
    try { return Audio.getMix(); } catch (err) { return null; }
  }
  function pushMix(patch) {
    try { return Audio.setMix(patch); } catch (err) { return readMix(); }
  }

  if (elMxMusic) {
    const onSlide = (e) => {
      mxDragging = e.currentTarget;
      const v = Number(e.currentTarget.value) / 100;
      const ch = e.currentTarget === elMxSfx ? 'sfx' : 'music';
      e.currentTarget.style.setProperty('--mx-fill', `${e.currentTarget.value}%`);
      const out = ch === 'sfx' ? elMxSfxV : elMxMusicV;
      if (out) { out.textContent = e.currentTarget.value; out.classList.remove('off'); }
      paintMixer(pushMix({ [ch]: v }));
    };
    const endSlide = () => { mxDragging = null; };
    for (const el of [elMxMusic, elMxSfx]) {
      if (!el) continue;
      el.addEventListener('input', onSlide);
      el.addEventListener('change', (e) => { onSlide(e); endSlide(); });
      el.addEventListener('pointerup', endSlide);
      el.addEventListener('blur', endSlide);
      // A range input inside the HUD must not leak arrow keys to the camera
      // rig or the order layer — while it has focus the arrows are ITS arrows.
      el.addEventListener('keydown', (ev) => ev.stopPropagation());
    }
  }

  if (elMxMusicMute) {
    elMxMusicMute.addEventListener('click', (e) => {
      if (e.detail > 0 && elMxMusicMute.blur) elMxMusicMute.blur();
      const m = readMix();
      paintMixer(pushMix({ musicMuted: !(m && m.musicMuted) }));
    });
  }
  if (elMxSfxMute) {
    elMxSfxMute.addEventListener('click', (e) => {
      if (e.detail > 0 && elMxSfxMute.blur) elMxSfxMute.blur();
      const m = readMix();
      paintMixer(pushMix({ sfxMuted: !(m && m.sfxMuted) }));
    });
  }
  function toggleMasterMute() {
    let mix = null;
    try { mix = Audio.toggleMute(); } catch (err) { mix = readMix(); }
    paintMixer(mix);
    if (mix) toast(mix.muted ? 'AUDIO MUTED' : 'AUDIO ON');
  }
  if (elMxMaster) {
    elMxMaster.addEventListener('click', (e) => {
      if (e.detail > 0 && elMxMaster.blur) elMxMaster.blur();
      toggleMasterMute();
    });
  }

  // Anything else that changes the mix (the hotkey, a console call) repaints
  // the panel through the same door.
  try { Audio.onMixChange(paintMixer); } catch (err) { /* older audio module */ }
  paintMixer(readMix());

  /* ---- sector minimap ---------------------------------------------------- */
  // 200×200 logical. The terrain plate is baked ONCE from the same data the
  // ground shader splats (field channel + windbreak seam + relief lit by the
  // 14° sun), then composited under the live layer: camera footprint, objective
  // pips, infrastructure and unit blips in APP-6 shape language (friendly
  // rectangle / hostile diamond). Click or drag to slew the camera.

  const MM = 200;        // logical size in CSS px
  const MM_RES = 256;    // bake resolution of the terrain plate
  const mmCtx = elMmCanvas ? elMmCanvas.getContext('2d') : null;
  let mmProj = null;     // world → minimap projection
  let mmBase = null;     // baked terrain plate (canvas)
  let mmBakeFailed = false;
  let mmMaxRay = 1200;   // longest ground ray the camera footprint may cast
  const mmContacts = new Map();   // red unit id -> { q, r, turn } last sighting

  /* ---- ROUND-3 FIX 13: fog of war on the sector map ---------------------- */
  // The map shipped with NO fog layer at all: a fully-baked terrain plate under
  // a camera footprint whose corner rays were run out to t = 4000 whenever they
  // left over the horizon. At any RTS pitch that made the footprint a cream-
  // filled, amber-stroked wedge sprawling off three sides of the panel — the
  // "illegible bright-yellow smear with no readable shape" the critic filed as
  // a broken fog-of-war "seen" region. They were reading the right defect off
  // the wrong object, and the honest fix is both halves: bound the footprint
  // (mmMaxRay, below) and give the panel the three-state fog a fogged wargame
  // map is supposed to carry.
  //
  //   LIVE   — currently observed by BLUE. Full-colour terrain plus a thin warm
  //            wash: the saturated yellow now means exactly one thing, "we have
  //            eyes on this", which is what the critique asked it to mean.
  //   SEEN   — explored, no current observation. The terrain colour DESATURATED
  //            and darkened, composited at 0.55. It is the same landform, the
  //            same river, the same road net, one register quieter — so it
  //            relates to the map around it instead of denying it.
  //   UNSEEN — never observed. The same dim plate at 0.88: the briefed terrain
  //            is still faintly legible (you were given a map before you were
  //            given eyes) but it can never be mistaken for live coverage.
  //
  // Everything is rebuilt only when the visible set actually changes, and the
  // hex masks are rasterised at half the plate's resolution and scaled up, so
  // the fog boundary is a soft sensor edge rather than a honeycomb cut-out.
  const MM_MASK_RES = 128;
  const MM_FOG_SEEN = 0.55;       // the value the critique specified
  const MM_FOG_UNSEEN = 0.88;
  const MM_FOG_MIN_DT = 0.2;      // s between rebuilds, however often fog moves
  const mmSeen = new Set();       // hex keys BLUE has ever had eyes on
  let mmDim = null;               // desaturated + darkened copy of the plate
  let mmFogLayer = null;          // dim plate masked by fog strength
  let mmLiveLayer = null;         // warm wash over the currently-observed set
  let mmFogDirty = true;
  let mmFogOk = true;             // false once a build has failed for good
  let mmFogAge = 99;

  const mmReady = () => !!(mmCtx && mmProj);
  const mmX = (x) => mmProj.offX + (x - mmProj.minX) * mmProj.s;
  const mmY = (z) => mmProj.offY + (z - mmProj.minZ) * mmProj.s;
  const mmWorldX = (px) => (px - mmProj.offX) / mmProj.s + mmProj.minX;
  const mmWorldZ = (py) => (py - mmProj.offY) / mmProj.s + mmProj.minZ;

  function mmSetup() {
    if (!elMmCanvas || !mmCtx || !terrain || !terrain.bounds) return false;
    const b = terrain.bounds;
    const pad = HEX.size * 1.15;
    const w = (b.maxX - b.minX) + pad * 2;
    const h = (b.maxZ - b.minZ) + pad * 2;
    if (!(w > 1) || !(h > 1)) return false;
    // A ground ray that misses the horizon used to be run 4000 units out, which
    // is ~10 map diagonals: the footprint became an unbounded wedge. One map
    // diagonal is the furthest any corner of the view can usefully claim.
    mmMaxRay = Math.sqrt(w * w + h * h);
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    elMmCanvas.width = Math.round(MM * dpr);
    elMmCanvas.height = Math.round(MM * dpr);
    mmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = Math.min(MM / w, MM / h);
    mmProj = {
      s,
      minX: b.minX - pad,
      minZ: b.minZ - pad,
      offX: (MM - w * s) / 2,
      offY: (MM - h * s) / 2,
    };
    if (elMmScale) {
      elMmScale.textContent = `${terrain.cols || 0}×${terrain.rows || 0} GRID`;
    }
    return true;
  }

  function mmBake() {
    const c = document.createElement('canvas');
    c.width = c.height = MM_RES;
    const g = c.getContext('2d');
    if (!g) return null;
    const img = g.createImageData(MM_RES, MM_RES);
    const d = img.data;
    const step = MM / MM_RES;
    const layout = terrain.layout || {};
    const fieldInfo = typeof layout.fieldInfo === 'function' ? layout.fieldInfo : null;
    const hAt = typeof terrain.heightAt === 'function' ? terrain.heightAt : null;
    const tileAt = typeof terrain.tileAt === 'function'
      ? (h) => terrain.tileAt(h)
      : (h) => (terrain.tiles ? terrain.tiles.get(`${h.q},${h.r}`) || null : null);
    const hash = typeof layout.hash === 'function'
      ? layout.hash
      : (i, j) => (Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1;
    const E = 2.6; // relief sampling radius, world units

    for (let j = 0; j < MM_RES; j++) {
      const wz = mmWorldZ((j + 0.5) * step);
      for (let i = 0; i < MM_RES; i++) {
        const wx = mmWorldX((i + 0.5) * step);
        const o = (j * MM_RES + i) * 4;
        const tile = tileAt(worldToHex(wx, wz));
        let cr, cg, cb;

        if (!tile) {
          // Off-sheet: the hex field's own ragged edge becomes the map border.
          const n = 0.85 + Math.abs(hash(i * 3, j * 3)) * 0.35;
          cr = MM_VOID[0] * n; cg = MM_VOID[1] * n; cb = MM_VOID[2] * n;
        } else {
          const surf = MM_SURFACE[tile.type];
          if (surf) {
            cr = surf[0]; cg = surf[1]; cb = surf[2];
          } else {
            // field / grass — read the splat exactly as the ground shader does
            let idx = 2, seam = Infinity;
            if (fieldInfo) {
              const fi = fieldInfo(wx, wz);
              if (fi) {
                idx = cropIndex(fi);
                seam = Number.isFinite(fi.seam) ? fi.seam : Infinity;
              }
            }
            if (tile.type === 'grass') idx = 2;
            const f = MM_FIELD[idx] || MM_FIELD[0];
            cr = f[0]; cg = f[1]; cb = f[2];
            // windbreak seam — the darkest line on the map, and the signature
            // graphic of the whole art direction
            if (seam < 9) {
              const k = 1 - Math.min(1, Math.max(0, seam / 9));
              const kk = k * k * 0.92;
              cr += (MM_WINDBREAK[0] - cr) * kk;
              cg += (MM_WINDBREAK[1] - cg) * kk;
              cb += (MM_WINDBREAK[2] - cb) * kk;
            }
          }

          // relief: raking light from the 14° WNW sun, N ∝ (-dh/dx, 1, -dh/dz)
          let shade = 1;
          if (hAt && tile.type !== 'water') {
            const gx = (hAt(wx + E, wz) - hAt(wx - E, wz)) / (2 * E);
            const gz = (hAt(wx, wz + E) - hAt(wx, wz - E)) / (2 * E);
            const lam = MM_SUN.y - MM_SUN.x * gx - MM_SUN.z * gz;
            shade = 0.86 + (lam - MM_SUN.y) * 2.4;
            if (shade < 0.58) shade = 0.58;
            else if (shade > 1.46) shade = 1.46;
          }
          const grain = 0.965 + Math.abs(hash(i, j)) * 0.07;
          const m = shade * grain;
          cr *= m; cg *= m; cb *= m;
        }

        d[o] = cr < 0 ? 0 : cr > 255 ? 255 : cr;
        d[o + 1] = cg < 0 ? 0 : cg > 255 ? 255 : cg;
        d[o + 2] = cb < 0 ? 0 : cb > 255 ? 255 : cb;
        d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    // Roads, rail and the river's bridges drawn as real cartography on top.
    const k = MM_RES / MM;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const chain = (hexes, color, width, dash) => {
      if (!hexes || hexes.length < 2) return;
      g.save();
      g.strokeStyle = color;
      g.lineWidth = Math.max(0.9, width * k);
      if (dash) g.setLineDash(dash.map((v) => v * k));
      g.beginPath();
      for (let n = 0; n < hexes.length; n++) {
        const w = hexToWorld(hexes[n].q, hexes[n].r);
        const px = mmX(w.x) * k, py = mmY(w.z) * k;
        if (n === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
      g.restore();
    };
    for (const rd of (layout.roads || [])) {
      chain(rd.hexes, rd.kind === 'paved'
        ? 'rgba(102,100,94,0.9)' : 'rgba(158,132,96,0.7)', rd.kind === 'paved' ? 1.3 : 1.0);
    }
    const rail = layout.rail && layout.rail.hexes;
    chain(rail, 'rgba(52,46,38,0.9)', 1.2);
    chain(rail, 'rgba(206,212,196,0.42)', 1.2, [1.4, 2.6]);
    for (const br of (layout.bridges || [])) {
      chain(br.hexes, 'rgba(198,194,182,0.85)', 1.6);
    }
    return c;
  }

  // The dim plate: the SAME image, desaturated 80 % toward its own luma, taken
  // down to just over half value and lifted a couple of counts toward the HUD's
  // slate so it never goes to dead black. Built once, from the baked plate, so
  // every road, seam and relief shade the bake authored survives into the fog.
  function mmMakeDim(base) {
    const c = document.createElement('canvas');
    c.width = c.height = MM_RES;
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(base, 0, 0);
    let img;
    try { img = g.getImageData(0, 0, MM_RES, MM_RES); } catch (e) { return null; }
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      d[i] = (d[i] * 0.20 + l * 0.80) * 0.52 + 6;
      d[i + 1] = (d[i + 1] * 0.20 + l * 0.80) * 0.52 + 8;
      d[i + 2] = (d[i + 2] * 0.20 + l * 0.80) * 0.52 + 9;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  const MM_HEXPT = [];
  for (let i = 0; i < 6; i++) {
    MM_HEXPT.push([Math.cos((Math.PI / 3) * i), Math.sin((Math.PI / 3) * i)]);
  }

  // One filled flat-top hexagon per tile, at mask resolution, slightly over-size
  // so adjacent fills overlap and the region has no hairline seams through it.
  function mmHexPath(g, cx, cy, r) {
    g.moveTo(cx + MM_HEXPT[0][0] * r, cy + MM_HEXPT[0][1] * r);
    for (let i = 1; i < 6; i++) {
      g.lineTo(cx + MM_HEXPT[i][0] * r, cy + MM_HEXPT[i][1] * r);
    }
    g.closePath();
  }

  function mmBuildFog() {
    if (!mmFogOk || !mmBase || !terrain || !terrain.tiles) return;
    if (!mmDim) {
      mmDim = mmMakeDim(mmBase);
      if (!mmDim) { mmFogOk = false; return; }
    }
    let live;
    try { live = visibleHexes('blue'); } catch (e) { live = null; }
    // No fog module, or a set that has not been computed yet: show the whole
    // plate rather than blacking out a map we have no information about.
    if (!live || live.size === 0) { mmFogLayer = null; mmLiveLayer = null; return; }
    for (const k of live) mmSeen.add(k);

    const K = MM_MASK_RES / MM;
    const hr = HEX.size * mmProj.s * K * 1.14;
    const mask = document.createElement('canvas');
    mask.width = mask.height = MM_MASK_RES;
    const mg = mask.getContext('2d');
    const warm = document.createElement('canvas');
    warm.width = warm.height = MM_MASK_RES;
    const wg = warm.getContext('2d');
    if (!mg || !wg) { mmFogOk = false; return; }

    // Two batched paths, one fill each — 884 tiles cost two draw calls, not 884.
    mg.fillStyle = `rgba(255,255,255,${MM_FOG_UNSEEN})`;
    mg.beginPath();
    let anyUnseen = false;
    for (const [k, t] of terrain.tiles) {
      if (live.has(k) || mmSeen.has(k)) continue;
      mmHexPath(mg, mmX(t.x) * K, mmY(t.z) * K, hr);
      anyUnseen = true;
    }
    if (anyUnseen) mg.fill();

    mg.fillStyle = `rgba(255,255,255,${MM_FOG_SEEN})`;
    mg.beginPath();
    let anySeen = false;
    for (const [k, t] of terrain.tiles) {
      if (live.has(k) || !mmSeen.has(k)) continue;
      mmHexPath(mg, mmX(t.x) * K, mmY(t.z) * K, hr);
      anySeen = true;
    }
    if (anySeen) mg.fill();

    wg.fillStyle = 'rgba(240,199,104,0.16)';
    wg.beginPath();
    let anyLive = false;
    for (const k of live) {
      const t = terrain.tiles.get(k);
      if (!t) continue;
      mmHexPath(wg, mmX(t.x) * K, mmY(t.z) * K, hr);
      anyLive = true;
    }
    if (anyLive) wg.fill();

    // Mask the dim plate down to the fog strength: `destination-in` multiplies
    // the destination's alpha by the source's, so one plate serves both the
    // 0.55 SEEN wash and the 0.88 UNSEEN veil with no second image.
    const layer = document.createElement('canvas');
    layer.width = layer.height = MM_RES;
    const lg = layer.getContext('2d');
    if (!lg) { mmFogOk = false; return; }
    lg.drawImage(mmDim, 0, 0);
    lg.globalCompositeOperation = 'destination-in';
    lg.imageSmoothingEnabled = true;
    lg.drawImage(mask, 0, 0, MM_RES, MM_RES);
    lg.globalCompositeOperation = 'source-over';

    mmFogLayer = layer;
    mmLiveLayer = anyLive ? warm : null;
  }

  function mmDiamond(g, x, y, r) {
    g.beginPath();
    g.moveTo(x, y - r);
    g.lineTo(x + r, y);
    g.lineTo(x, y + r);
    g.lineTo(x - r, y);
    g.closePath();
  }

  const _mmV = new Vector3();

  // Camera footprint: the four view-frustum corner rays intersected with the
  // ground plane. Rays that leave over the horizon are run far out instead —
  // the polygon is clipped by the panel, which is exactly what a real map does.
  function mmFootprint() {
    const cam = engine && engine.camera;
    if (!cam) return null;
    const cp = cam.position;
    const out = [];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let i = 0; i < 4; i++) {
      _mmV.set(corners[i][0], corners[i][1], 0.5).unproject(cam);
      const dx = _mmV.x - cp.x, dy = _mmV.y - cp.y, dz = _mmV.z - cp.z;
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return null;
      let t = dy < -1e-4 ? (0 - cp.y) / dy : mmMaxRay;
      if (!(t > 0)) t = mmMaxRay;
      if (t > mmMaxRay) t = mmMaxRay;
      out.push([cp.x + dx * t, cp.z + dz * t]);
    }
    return out;
  }

  function mmDraw() {
    if (!mmReady()) return;
    if (!mmBase && !mmBakeFailed) {
      try { mmBase = mmBake(); } catch (e) { mmBase = null; }
      if (!mmBase) mmBakeFailed = true;
    }
    const g = mmCtx;
    g.clearRect(0, 0, MM, MM);
    if (mmBase) g.drawImage(mmBase, 0, 0, MM, MM);
    else { g.fillStyle = '#0e1210'; g.fillRect(0, 0, MM, MM); }

    // ---- fog of war (fix 13) ---------------------------------------------
    if (mmFogOk && mmBase && (mmFogDirty || !mmFogLayer) && mmFogAge >= MM_FOG_MIN_DT) {
      mmFogAge = 0;
      mmFogDirty = false;
      try { mmBuildFog(); } catch (e) { mmFogOk = false; mmFogLayer = null; }
    }
    if (mmFogLayer) g.drawImage(mmFogLayer, 0, 0, MM, MM);
    if (mmLiveLayer) g.drawImage(mmLiveLayer, 0, 0, MM, MM);

    // Camera footprint. Bounded to one map diagonal (see mmSetup) and pulled
    // back to a quiet hairline: it is a "you are here", not a highlight, and it
    // must not be the loudest thing in a panel that now carries real fog.
    const fp = mmFootprint();
    if (fp) {
      g.save();
      g.beginPath();
      for (let i = 0; i < fp.length; i++) {
        const px = mmX(fp[i][0]), py = mmY(fp[i][1]);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fillStyle = 'rgba(232,228,208,0.055)';
      g.fill();
      g.strokeStyle = 'rgba(226,214,178,0.42)';
      g.lineWidth = 1;
      g.stroke();
      g.restore();
    }

    // infrastructure — quiet, but the bridges/depots are what the loiter
    // battery is hunting, so they belong on the map
    const infra = (features && features.infrastructure) || [];
    for (const inf of infra) {
      if (!inf || !inf.hex) continue;
      const w = hexToWorld(inf.hex.q, inf.hex.r);
      const px = mmX(w.x), py = mmY(w.z);
      if (inf.alive) {
        g.fillStyle = 'rgba(206,212,196,0.55)';
        g.fillRect(px - 1.5, py - 1.5, 3, 3);
      } else {
        g.strokeStyle = 'rgba(224,90,78,0.85)';
        g.lineWidth = 1.1;
        g.beginPath();
        g.moveTo(px - 2.2, py - 2.2); g.lineTo(px + 2.2, py + 2.2);
        g.moveTo(px + 2.2, py - 2.2); g.lineTo(px - 2.2, py + 2.2);
        g.stroke();
      }
    }

    // objectives
    for (const o of (Game.objectives || [])) {
      if (!o || !o.hex) continue;
      const w = hexToWorld(o.hex.q, o.hex.r);
      const px = mmX(w.x), py = mmY(w.z);
      const r = o.primary ? 5 : 3.6;
      mmDiamond(g, px, py, r);
      g.fillStyle = '#F2C94C';
      g.fill();
      g.lineWidth = 1.4;
      g.strokeStyle = o.owner === 'blue' ? '#7ED88B' : '#E05A4E';
      g.stroke();
      if (o.primary) {
        mmDiamond(g, px, py, r + 2.6);
        g.lineWidth = 0.9;
        g.strokeStyle = o.owner === 'blue'
          ? 'rgba(126,216,139,0.55)' : 'rgba(224,90,78,0.5)';
        g.stroke();
      }
    }

    // last-known contact — the whole point of a minimap on a fogged map.
    // Every RED unit we have eyes on is filed with the turn it was seen; the
    // moment fog closes over it the solid blip is replaced by a hollow, dashed
    // diamond that decays over six turns and carries the turn stamp of the
    // sighting. Dead contacts are struck off. This is the difference between a
    // decorative map and one you plan a bound from.
    for (const u of Game.units) {
      if (!u || u.faction === 'blue') continue;
      if (!u.alive) { mmContacts.delete(u.id); continue; }
      if (u.hex && visibleHex(u.hex)) {
        mmContacts.set(u.id, { q: u.hex.q, r: u.hex.r, turn: Game.turn });
      }
    }
    for (const [id, c] of [...mmContacts]) {
      const u = Game.units.find((x) => x.id === id);
      if (!u || !u.alive) { mmContacts.delete(id); continue; }
      if (u.hex && visibleHex(u.hex)) continue;         // live blip wins
      const age = Math.max(0, (Game.turn | 0) - c.turn);
      if (age > 6) { mmContacts.delete(id); continue; }
      const w = hexToWorld(c.q, c.r);
      const px = mmX(w.x), py = mmY(w.z);
      g.save();
      g.globalAlpha = Math.max(0.2, 0.72 - age * 0.09);
      g.strokeStyle = '#E05A4E';
      g.lineWidth = 1.1;
      g.setLineDash([1.6, 1.5]);
      mmDiamond(g, px, py, 3.4);
      g.stroke();
      g.restore();
    }

    // units — APP-6 shape language: friendly rectangle, hostile diamond
    const now = performance.now();
    for (const u of Game.units) {
      if (!u || !u.alive || !u.hex) continue;
      const mine = u.faction === 'blue';
      if (!mine && !visibleHex(u.hex)) continue;
      const w = hexToWorld(u.hex.q, u.hex.r);
      const px = mmX(w.x), py = mmY(w.z);
      const spent = mine && u.moved && u.fired;
      g.globalAlpha = spent ? 0.45 : 1;
      g.beginPath();
      if (mine) g.rect(px - 2.5, py - 2.1, 5, 4.2);
      else mmDiamond(g, px, py, 3.1);
      g.fillStyle = mine ? '#7ED88B' : '#E05A4E';
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(8,11,8,0.8)';
      g.stroke();
      g.globalAlpha = 1;
      if (sel && sel.id === u.id) {
        const pulse = reduceMotion ? 1 : 0.55 + 0.45 * Math.sin(now / 260);
        g.beginPath();
        g.arc(px, py, 6.2, 0, Math.PI * 2);
        g.strokeStyle = `rgba(255,255,255,${(0.35 + 0.5 * pulse).toFixed(3)})`;
        g.lineWidth = 1.3;
        g.stroke();
      }
    }
  }

  if (mmSetup()) {
    // Bake on the next frame, not inside init: the plate costs ~40 ms and the
    // briefing screen is still fading in.
    requestAnimationFrame(() => { try { mmDraw(); } catch (e) {} });

    let mmAcc = 0;
    if (engine && typeof engine.onFrame === 'function') {
      engine.onFrame((dt) => {
        mmAcc += dt;
        mmFogAge += dt;
        if (mmAcc < 0.062) return;   // ~16 Hz is plenty for a 200 px map
        mmAcc = 0;
        if (fpvActive || !elMini || elMini.classList.contains('hidden')) return;
        try { mmDraw(); } catch (e) {}
      });
    }

    // click / drag to slew the camera — every wargame minimap does this
    let mmDrag = false;
    const mmSlew = (e, instant) => {
      if (!mmReady()) return;
      const r = elMmCanvas.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      const px = ((e.clientX - r.left) / r.width) * MM;
      const py = ((e.clientY - r.top) / r.height) * MM;
      const x = mmWorldX(px), z = mmWorldZ(py);
      try {
        if (engine && typeof engine.focusOn === 'function') {
          const y = terrain && typeof terrain.heightAt === 'function'
            ? terrain.heightAt(x, z) : 0;
          engine.focusOn({ x, y, z }, instant ? { instant: true } : { duration: 0.4 });
        }
      } catch (err) { /* camera slew is never fatal */ }
    };
    elMmCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || overlayOpen() || fpvActive) return;
      mmDrag = true;
      try { elMmCanvas.setPointerCapture(e.pointerId); } catch (err) {}
      mmSlew(e, false);
      e.preventDefault();
    });
    elMmCanvas.addEventListener('pointermove', (e) => {
      if (mmDrag) mmSlew(e, true);
    });
    const mmRelease = (e) => {
      if (!mmDrag) return;
      mmDrag = false;
      try { elMmCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    elMmCanvas.addEventListener('pointerup', mmRelease);
    elMmCanvas.addEventListener('pointercancel', mmRelease);
    elMmCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  } else if (elMini) {
    elMini.classList.add('hidden');   // no terrain → no map, never a dead panel
  }

  /* ---- world labels ------------------------------------------------------ */
  // CRITIQUE fix 24. PC2 stamps VERDUN / METZ / MOSCOW straight onto the map;
  // without that you are looking at an anonymous field and reading place names
  // out of the comms log. These are DOM labels projected from their hex each
  // frame rather than sprites: they get the real HUD typeface at real subpixel
  // crispness at every zoom, they cost one matrix transform each, and by living
  // inside #hud-root they inherit the FPV blackout and the briefing fade for
  // free. They come UP above camera distance 90 (below that the settlement is
  // on screen and the name is just in the way), de-clutter by priority so two
  // names never overprint, and repaint their owner chip the moment an objective
  // changes hands.

  const LABEL_LIFT = { town: 8.4, bridge_exit: 4.8, village: 5.8, river: 1.4 };
  const LABEL_RANK = { town: 4, bridge_exit: 3, village: 2, river: 1 };
  const LABEL_SUB = {
    town: 'TOWN · OBJECTIVE', bridge_exit: 'EAST EXIT · OBJECTIVE',
    village: 'VILLAGE · OBJECTIVE', river: '',
  };
  // "Road Bridge East Exit" is a 21-character banner in a stencil face at 0.24em
  // tracking — 210 px of map furniture. The bearing goes in the sub-line where
  // it costs 8.5 px instead of 12.
  const LABEL_TRIM = /\s*(?:east|west|north|south)\s+exit\s*$/i;
  // ROUND-3 FIX 16 — the depth curve. REF is the camera-to-label distance at
  // which a banner draws at its authored CSS size; the boot camera sits ~185 u
  // out and the settlements it looks at are 120–220 u away, so the default
  // frame lands almost exactly on 1.0 and the tuned type sizes are what ships.
  // The clamp span (1.08 / 0.88 = 1.23) is deliberately tighter than the
  // town-to-village type step (18 / 13 = 1.38): rank must never be readable as
  // distance, and distance must never be readable as rank.
  const LABEL_REF_D = 150;
  const LABEL_S_MIN = 0.88;
  const LABEL_S_MAX = 1.08;
  const labels = [];
  const _lp = new Vector3();
  const _lfwd = new Vector3();
  let labelGate = -1;

  function labelPos(hex, kind) {
    const w = hexToWorld(hex.q, hex.r);
    const h = (terrain && typeof terrain.heightAt === 'function')
      ? terrain.heightAt(w.x, w.z) : 0;
    return {
      x: w.x,
      y: (Number.isFinite(h) ? h : 0) + (LABEL_LIFT[kind] ?? 5.5),
      z: w.z,
    };
  }

  function addLabel(name, hex, kind, obj) {
    if (!elLabels || !hex || !Number.isFinite(hex.q) || !Number.isFinite(hex.r)) return;
    const el = document.createElement('div');
    el.className = `wl wl-${kind} off`;
    const sub = LABEL_SUB[kind] || '';
    el.innerHTML =
      `<span class="wl-name">${esc(String(name).toUpperCase())}</span>` +
      (kind === 'river' ? '' :
        `<span class="wl-rule"></span>` +
        `<span class="wl-sub"><i class="wl-pip"></i>${esc(sub)}</span>`);
    elLabels.appendChild(el);
    labels.push({
      el, obj: obj || null, kind,
      hex: { q: hex.q, r: hex.r },
      pos: labelPos(hex, kind),
      rank: LABEL_RANK[kind] ?? 1,
      sx: 0, sy: 0, w: 0, h: 0, s: 1, vis: false, on: false, owner: '',
    });
  }

  function buildLabels() {
    if (!elLabels || !terrain) return;
    for (const o of (Game.objectives || [])) {
      if (!o || !o.hex) continue;
      const kind = o.kind === 'town' ? 'town'
        : o.kind === 'bridge_exit' ? 'bridge_exit' : 'village';
      let name = String(o.name || o.id || 'OBJECTIVE');
      if (kind === 'bridge_exit') name = name.replace(LABEL_TRIM, '') || name;
      addLabel(name, o.hex, kind, o);
    }
    // One terrain-feature label so the map names the ground it is fought over,
    // the way a real operations overlay does. Placed on the middle of the
    // authored river chain, styled as a feature (no rule, no owner chip).
    const river = terrain.layout && terrain.layout.river;
    const chain = river && river.hexes;
    if (chain && chain.length > 6) {
      addLabel('Vovcha', chain[Math.floor(chain.length / 2)], 'river', null);
    }
    refreshLabelOwners();
  }

  function refreshLabelOwners() {
    for (const rec of labels) {
      if (!rec.obj) continue;
      // an objective can be relocated onto a dry hex during boot (see the world
      // integrator's note 3), so re-anchor before repainting the chip
      const h = rec.obj.hex;
      if (h && (h.q !== rec.hex.q || h.r !== rec.hex.r)) {
        rec.hex = { q: h.q, r: h.r };
        rec.pos = labelPos(h, rec.kind);
      }
      const owner = rec.obj.owner === 'blue' ? 'blue' : 'red';
      if (owner === rec.owner) continue;
      rec.owner = owner;
      rec.el.classList.toggle('held', owner === 'blue');
    }
  }

  function setLabelOn(rec, on) {
    if (rec.on === on) return;
    rec.on = on;
    rec.el.classList.toggle('off', !on);
  }

  function updateLabels() {
    if (!labels.length || !elLabels) return;
    const cam = engine && engine.camera;
    const cvs = engine && engine.renderer && engine.renderer.domElement;
    if (!cam || !cvs || !Number.isFinite(cam.position.x)) return;

    if (overlayOpen() || fpvActive) {
      if (labelGate !== 0) { labelGate = 0; elLabels.style.opacity = '0'; }
      return;
    }
    // fade in above 90 units of camera-to-ground distance (CRITIQUE fix 24)
    const d = camGroundDistance(cam);
    let gate = (d - 90) / 30;
    gate = gate < 0 ? 0 : gate > 1 ? 1 : gate;
    gate = gate * gate * (3 - 2 * gate);
    if (Math.abs(gate - labelGate) > 0.015 || (gate === 0) !== (labelGate === 0)) {
      labelGate = gate;
      elLabels.style.opacity = gate.toFixed(3);
    }
    if (gate <= 0) {
      for (const rec of labels) setLabelOn(rec, false);
      return;
    }

    const W = cvs.clientWidth || window.innerWidth;
    const H = cvs.clientHeight || window.innerHeight;
    cam.getWorldDirection(_lfwd);
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    const live = [];
    for (const rec of labels) {
      const p = rec.pos;
      // behind-camera rejection before project(): the perspective divide flips
      // the sign behind the eye and a rejected label would land on screen
      const ddx = p.x - cx, ddy = p.y - cy, ddz = p.z - cz;
      if (ddx * _lfwd.x + ddy * _lfwd.y + ddz * _lfwd.z <= 1) {
        rec.vis = false;
        continue;
      }
      _lp.set(p.x, p.y, p.z).project(cam);
      if (!Number.isFinite(_lp.x) || !Number.isFinite(_lp.y)) { rec.vis = false; continue; }
      let sx = (_lp.x * 0.5 + 0.5) * W;
      let sy = (-_lp.y * 0.5 + 0.5) * H;

      // ---- ROUND-3 FIX 16 -------------------------------------------------
      // (a) TIER, NOT DEPTH. These are DOM banners at fixed CSS px, so until
      // now a town on the far bank and a village under the camera drew at
      // exactly the same distance-independent size, and the only size signal in
      // the frame was the 17 / 12.5 / 12 px class step — a 4 % difference
      // between a village and a bridge exit, which is far too small to read as
      // a rank and just large enough to read as a mistake. The class sizes are
      // now two real tiers (18 px town, 13 px everything else — css/ui.css) and
      // a SINGLE shared depth curve is applied on top, hard-clamped to
      // [0.88, 1.08]. The clamp is the whole point: its 1.23 span is narrower
      // than the 1.38 tier step, so a town is *always* larger than a village no
      // matter where either one stands. Depth modulates; tier decides.
      const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      let s = Math.sqrt(LABEL_REF_D / (dist > 1 ? dist : 1));
      if (s < LABEL_S_MIN) s = LABEL_S_MIN; else if (s > LABEL_S_MAX) s = LABEL_S_MAX;

      // Measured before it is placed, because the clamp below needs the real
      // block width. `.wl` is nowrap and its text never changes, so this is one
      // layout read per label for the whole match.
      if (!(rec.w > 0)) {
        rec.w = rec.el.offsetWidth || 110;
        rec.h = rec.el.offsetHeight || 34;
      }
      const bw = rec.w * s, bh = rec.h * s;

      // (b) CLAMP, DO NOT CLIP. The old test culled on the ANCHOR being within
      // 26 px of the edge, but the banner is centred on that anchor and "ROAD
      // BRIDGE" is ~160 px wide — so an anchor 60 px from the right edge passed
      // the test and then hung 20 px off the frame. Cull only when the anchor
      // has genuinely left the view, then pull the whole block back inside with
      // the 24 px margin the critique asked for. The stem stays pointing down
      // at the ground it names; a banner that slid 40 px along the edge still
      // labels the right place, a banner sliced in half does not.
      if (sx < -90 || sx > W + 90 || sy < -40 || sy > H + 40) { rec.vis = false; continue; }
      const mx = 24 + bw * 0.5;
      if (bw + 48 >= W) sx = W * 0.5;
      else if (sx < mx) sx = mx;
      else if (sx > W - mx) sx = W - mx;
      const my = 24 + bh;
      if (sy < my) sy = my;
      if (sy > H + 40) { rec.vis = false; continue; }

      rec.sx = sx; rec.sy = sy; rec.s = s; rec.vis = true;
      live.push(rec);
    }
    // de-clutter: the town outranks a crossing outranks a village outranks the
    // river; on a tie the nearer (lower on screen) label wins the slot. The
    // overlap test is measured now rather than assumed at a flat 104 px — the
    // banners are scaled, and half of them are nowhere near that wide.
    live.sort((a, b) => (b.rank - a.rank) || (b.sy - a.sy));
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      if (!a.vis) continue;
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j];
        if (!b.vis) continue;
        const gapX = (a.w * a.s + b.w * b.s) * 0.5 + 10;
        if (Math.abs(a.sx - b.sx) < gapX && Math.abs(a.sy - b.sy) < 32) b.vis = false;
      }
    }
    for (const rec of labels) {
      if (rec.vis) {
        // `transform-origin: 0 0` (css/ui.css) is load-bearing here: with the
        // origin at the element's own top-left, translate(-50%,-100%) maps the
        // block's BOTTOM-CENTRE onto (0,0) before the scale is applied, so the
        // anchor point is scale-invariant and the banner grows away from the
        // hex it names instead of sliding off it.
        rec.el.style.transform =
          `translate3d(${rec.sx.toFixed(1)}px, ${rec.sy.toFixed(1)}px, 0) ` +
          `scale(${rec.s.toFixed(3)}) translate(-50%, -100%)`;
        // CRITIQUE fix 8 — publish the anchor and the measured block for the
        // cross-layer de-clutter pass in fx/markers.js, which is the only place
        // that can see the world labels AND the unit counters at once. The
        // element is bottom-centre anchored (translate -50%, -100%), so this box
        // is {x: centre, y: bottom, w, h}. The measurement is taken above, and
        // the published box carries the DEPTH SCALE — markers.js separates by
        // painted pixels, not by CSS layout pixels, and the two now differ.
        rec.el.__ssBox = { x: rec.sx, y: rec.sy, w: rec.w * rec.s, h: rec.h * rec.s };
      }
      setLabelOn(rec, rec.vis);
    }
  }

  if (elLabels && terrain && engine && engine.camera) {
    buildLabels();
    // Allerta Stencil arrives from the CDN with display=swap. A width measured
    // before the face resolves is the FALLBACK's width, and every clamp and
    // de-clutter decision below is made against it for the rest of the match —
    // so drop the cached measurements once the real faces land.
    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          for (const rec of labels) { rec.w = 0; rec.h = 0; }
        }).catch(() => {});
      }
    } catch (e) { /* no font loading API — the fallback stack measures fine */ }
    if (labels.length && typeof engine.onFrame === 'function') {
      engine.onFrame(() => { try { updateLabels(); } catch (e) {} });
    }
  } else if (elLabels) {
    elLabels.classList.add('hidden');
  }

  /* ---- order of battle --------------------------------------------------- */
  // The left rail: every friendly unit, sorted the way an ORBAT is read
  // (armor → mech → infantry → guns → air defence → drones → support), with
  // glyph, HP bar, grid reference and remaining MOVE / FIRE capability. A unit
  // that has both moved and fired dims out, so "what have I not used this turn"
  // is answerable at a glance. Click centres the camera; hover pulses its hex.

  const oobRows = new Map();   // unit.id -> row element refs
  let oobSig = '';
  let oobHoverId = 0;

  function rosterList() {
    const mine = Game.units.filter((u) => u && u.alive && u.faction === 'blue');
    mine.sort((a, b) => {
      const ca = CLASS_ORDER[(a.type && a.type.class)] ?? 9;
      const cb = CLASS_ORDER[(b.type && b.type.class)] ?? 9;
      if (ca !== cb) return ca - cb;
      if (a.typeId !== b.typeId) return a.typeId < b.typeId ? -1 : 1;
      return a.id - b.id;
    });
    return mine;
  }

  function buildRoster(list) {
    if (!elOobList) return;
    oobRows.clear();
    elOobList.textContent = '';
    const frag = document.createDocumentFragment();
    for (const u of list) {
      const t = u.type || {};
      // CRITIQUE fix 23 — a real control, not a div with a click handler. The
      // roster is the fastest way to reach a unit and it was invisible to the
      // keyboard and to assistive tech (an accessibility-tree read of the whole
      // page returned 8 interactive elements for a 16-unit brigade). The live
      // accessible name is rewritten in refreshRoster() so it carries strength,
      // grid and readiness rather than the run-together glyph text.
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'oob-row';
      row.dataset.id = String(u.id);
      row.setAttribute('aria-pressed', 'false');
      row.title = `${t.name || u.typeId} — click to centre`;
      row.innerHTML = `
        <span class="oob-glyph">${glyphSVG(t.icon, 'blue', u.typeId)}</span>
        <span class="oob-main">
          <span class="oob-top">
            <span class="oob-name">${esc(SHORT_NAMES[u.typeId] ||
              String(u.typeId).replace(/_/g, ' ').toUpperCase())}</span>
            <span class="oob-vet"></span>
            <span class="oob-grid"></span>
          </span>
          <span class="oob-hp"><i></i></span>
        </span>
        <span class="oob-st"><b class="mv">M</b><b class="fr">F</b></span>`;
      frag.appendChild(row);
      oobRows.set(u.id, {
        row,
        hp: row.querySelector('.oob-hp'),
        fill: row.querySelector('.oob-hp i'),
        grid: row.querySelector('.oob-grid'),
        vet: row.querySelector('.oob-vet'),
        mv: row.querySelector('.mv'),
        fr: row.querySelector('.fr'),
        aria: '',
        pressed: false,
      });
    }
    elOobList.appendChild(frag);
  }

  function refreshRoster() {
    if (!elOobList) return;
    const list = rosterList();
    const sig = list.map((u) => u.id).join(',');
    if (sig !== oobSig) { oobSig = sig; buildRoster(list); }
    let ready = 0;
    for (const u of list) {
      const rec = oobRows.get(u.id);
      if (!rec) continue;
      const maxHp = (u.type && u.type.hp) || 10;
      const pct = Math.max(0, Math.min(1, u.hp / maxHp));
      rec.fill.style.width = `${(pct * 100).toFixed(1)}%`;
      rec.hp.className = `oob-hp ${pct >= 0.7 ? 'ok' : pct >= 0.4 ? 'mid' : 'low'}`;
      rec.grid.textContent = u.hex ? `${u.hex.q}·${u.hex.r}` : '—';
      rec.vet.textContent = '★'.repeat(Math.min(2, u.veterancy | 0));
      const maxAmmo = (u.type && u.type.ammo) | 0;
      const canFire = !u.fired && (maxAmmo === 0 ? false : u.ammo > 0);
      rec.mv.classList.toggle('on', !u.moved);
      rec.fr.classList.toggle('on', canFire);
      rec.fr.classList.toggle('dry', maxAmmo > 0 && u.ammo === 0);
      const spent = u.moved && !canFire;
      const picked = !!(sel && sel.id === u.id);
      rec.row.classList.toggle('spent', spent);
      rec.row.classList.toggle('sel', picked);
      rec.row.classList.toggle('hurt', pct < 0.4);
      rec.row.classList.toggle('sup', !!u.suppressed);
      // CRITIQUE fix 23 — the accessible name says what the row shows, in
      // words: "ATGM team, grid 12·7, 8 of 10 strength, can move, no fire".
      // Rewritten only when it actually changes; a screen reader must not be
      // handed sixteen identical mutations every time the roster ticks.
      const aria = `${(u.type && u.type.name) || String(u.typeId).replace(/_/g, ' ')}, ` +
        `grid ${u.hex ? `${u.hex.q}·${u.hex.r}` : 'unknown'}, ` +
        `${Math.max(0, Math.round(u.hp))} of ${maxHp} strength` +
        `${u.veterancy ? `, veterancy ${u.veterancy | 0}` : ''}` +
        `${u.suppressed ? ', suppressed' : ''}` +
        `${spent ? ', spent' : `, ${u.moved ? 'held' : 'can move'}` +
          `${canFire ? ', can fire' : (maxAmmo > 0 && u.ammo === 0 ? ', out of ammunition' : ', fired')}`}`;
      if (aria !== rec.aria) {
        rec.aria = aria;
        rec.row.setAttribute('aria-label', aria);
      }
      if (rec.pressed !== picked) {
        rec.pressed = picked;
        rec.row.setAttribute('aria-pressed', picked ? 'true' : 'false');
      }
      if (!spent) ready++;
    }
    if (elOobCount) elOobCount.textContent = `${ready}/${list.length}`;
  }

  function revealRosterRow(u) {
    if (!u) return;
    const rec = oobRows.get(u.id);
    if (!rec || oobCollapsed || !rec.row.scrollIntoView) return;
    try { rec.row.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }

  function setOobCollapsed(on) {
    oobCollapsed = !!on;
    if (elOob) elOob.classList.toggle('collapsed', oobCollapsed);
    if (elOobToggle) {
      elOobToggle.setAttribute('aria-expanded', String(!oobCollapsed));
      elOobToggle.title = oobCollapsed ? 'Expand roster [O]' : 'Collapse roster [O]';
      elOobToggle.setAttribute('aria-label',
        oobCollapsed ? 'Expand roster (O)' : 'Collapse roster (O)');
    }
  }

  if (elOobToggle) {
    elOobToggle.addEventListener('click', () => setOobCollapsed(!oobCollapsed));
  }

  if (elOobList) {
    const rowUnit = (target) => {
      const row = target && target.closest ? target.closest('.oob-row') : null;
      if (!row) return null;
      const id = Number(row.dataset.id);
      return Game.units.find((u) => u.id === id && u.alive) || null;
    };
    elOobList.addEventListener('click', (e) => {
      if (overlayOpen() || busy) return;
      const u = rowUnit(e.target);
      if (!u) return;
      // A pointer click must not leave the row focused: the player's next
      // ENTER is "end turn", not "re-select the same unit". Keyboard
      // activation (detail === 0) keeps its focus ring, as it must.
      if (e.detail > 0) {
        const row = e.target.closest ? e.target.closest('.oob-row') : null;
        if (row && row.blur) row.blur();
      }
      selectUnit(u);
      try {
        if (engine && typeof engine.focusOn === 'function' && u.mesh) {
          engine.focusOn(u.mesh.position);
        }
      } catch (err) {}
    });
    // Roving arrow-key navigation inside the rail (CRITIQUE fix 23). Stopped
    // from propagating so the camera rig and the global hotkey layer never see
    // a keystroke that was meant for the roster.
    elOobList.addEventListener('keydown', (e) => {
      if (e.code !== 'ArrowDown' && e.code !== 'ArrowUp') return;
      const rows = [...elOobList.querySelectorAll('.oob-row')];
      const i = rows.indexOf(document.activeElement);
      if (i < 0 || rows.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.code === 'ArrowDown' ? 1 : -1;
      const next = rows[(i + step + rows.length) % rows.length];
      if (next && next.focus) next.focus();
    });
    elOobList.addEventListener('pointerover', (e) => {
      const u = rowUnit(e.target);
      const id = u ? u.id : 0;
      if (id === oobHoverId) return;
      oobHoverId = id;
      if (!u || !u.hex) return;
      try { terrain && terrain.pulseHex(u.hex); } catch (err) {}
    });
    elOobList.addEventListener('pointerleave', () => { oobHoverId = 0; });
  }

  /* ---- pointer layer ---------------------------------------------------- */

  const canvas = engine && engine.renderer && engine.renderer.domElement;
  if (canvas && terrain && engine.camera) {
    const ray = new Raycaster();
    const ndc = new Vector2();
    let downX = 0, downY = 0, downT = 0, dragged = false;

    // INTEGRATION (round 2, integrator): picking used to be a ground-only
    // raycast, so a unit whose MESH is not over its own hex could never be
    // clicked — the recon UAV sits 8.4 units up and the FPV quad hovers, and a
    // click on either passed straight through to the hex BEHIND them. On a
    // 40°-polar camera that is two hexes of parallax: "I cannot select my own
    // drone." The unit pass runs first and only reports a hit when the ray
    // genuinely strikes a visible hull, so ground picking is otherwise
    // unchanged (a hull sitting on its own hex resolves to that same hex).
    // Deliberately limited to class 'drone'. Those are the only models whose
    // visible geometry is NOT over its own hex (models.js parks the airframe in
    // a `lift` sub-tree at up to 8.4 u while the root stays on the ground), and
    // an airframe is above the terrain, so a hit on one can never be an
    // occluded false positive. Widening this to every hull would put unit
    // meshes ahead of the ground with no depth test to arbitrate — a tank on a
    // ridge would start eating clicks meant for the valley behind it.
    const pickList = [];
    const unitIdOf = (obj) => {
      let o = obj;
      while (o) {
        if (o.userData && o.userData.unitId != null) return o.userData.unitId;
        o = o.parent;
      }
      return null;
    };
    const pickAirframeHex = () => {
      pickList.length = 0;
      for (const u of Game.units) {
        if (!u.alive || !u.mesh || !u.mesh.visible) continue;
        if (!u.type || u.type.class !== 'drone') continue;
        pickList.push(u.mesh);
      }
      if (!pickList.length) return null;
      const hits = ray.intersectObjects(pickList, true);
      for (const h of hits) {
        const o = h.object;
        if (!o || o.isSprite) continue;
        if (o.name === 'unit-marker' || o.name === 'selection-ring' ||
            o.name === 'unit-counter') continue;
        const id = unitIdOf(o);
        if (id == null) continue;
        const u = Game.units.find((x) => x.id === id && x.alive);
        if (u && u.hex) return { q: u.hex.q, r: u.hex.r };
      }
      return null;
    };

    const pick = (cx, cy) => {
      try {
        const r = canvas.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, engine.camera);
        const onAir = pickAirframeHex();
        if (onAir) return onAir;
        return terrain.raycastHex(ray);
      } catch (e) { return null; }
    };

    canvas.addEventListener('pointerdown', (e) => {
      downX = e.clientX; downY = e.clientY;
      downT = performance.now();
      dragged = false;
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons !== 0 && Math.hypot(e.clientX - downX, e.clientY - downY) > 6) {
        dragged = true;
      }
      const now = performance.now();
      if (now - lastHover < 45) return;
      lastHover = now;
      if (overlayOpen() || fpvActive || e.buttons !== 0) { hideTooltip(); return; }
      const h = pick(e.clientX, e.clientY);
      if (h) showTooltip(h, e.clientX, e.clientY);
      else hideTooltip();
    });

    canvas.addEventListener('pointerup', (e) => {
      const dt = performance.now() - downT;
      // no upper time bound: the drag test already separates a camera drag from
      // a click, and a slow, still press is still a click.
      if (e.button === 0 && !dragged && dt >= 0) {
        const h = pick(e.clientX, e.clientY);
        if (h) onHexClick(h);
      }
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!dragged && !overlayOpen()) cancelOrDeselect();
    });

    canvas.addEventListener('pointerleave', hideTooltip);
  }

  /* ---- keyboard --------------------------------------------------------- */

  function cycleUnits(dir) {
    const mine = Game.units.filter((u) => u.alive && u.faction === 'blue');
    if (!mine.length) return;
    const ready = mine.filter((u) => !u.moved || !u.fired);
    const pool = ready.length ? ready : mine;
    const i = pool.indexOf(sel);
    const next = pool[((i + dir) % pool.length + pool.length) % pool.length];
    selectUnit(next);
    try {
      if (engine && typeof engine.focusOn === 'function' && next.mesh) {
        engine.focusOn(next.mesh.position);
      }
    } catch (e) {}
  }

  // CRITIQUE fix 23, second half. Making the roster rows real <button>s exposes
  // them to assistive tech, but it does not make them *reachable*: this module
  // swallows every TAB the map ever sees (TAB is the wargame's cycle-units key),
  // and after the briefing closes focus is back on <body> — so without an entry
  // point the sixteen roster buttons, the fire-control strip and END TURN are
  // keyboard-navigable in name only. SHIFT+TAB from the map is the way in
  // (plain TAB keeps its contracted meaning), ESC inside the panels is the way
  // back out, and normal browser traversal does everything in between.
  //
  // Entry lands on the selected unit's own row when there is one, so the focus
  // ring appears where the player is already looking. Every candidate is tried
  // by actually focusing it and asking whether it took — that is the only test
  // that is correct for a disabled button, a collapsed rail and a panel hidden
  // by the FPV blackout all at once.
  function focusPanels() {
    const cands = [];
    if (!oobCollapsed && elOobList) {
      const rec = sel ? oobRows.get(sel.id) : null;
      if (rec && rec.row) cands.push(rec.row);
      if (elOobList.firstElementChild) cands.push(elOobList.firstElementChild);
    }
    for (let i = 0; i < elActs.length; i++) cands.push(elActs[i]);
    cands.push(elEndTurn, elOobToggle);
    for (let i = 0; i < cands.length; i++) {
      const el = cands[i];
      if (!el || el.disabled || typeof el.focus !== 'function') continue;
      // Plain focus(), deliberately: html/body are `overflow: hidden`, so the
      // only thing a scroll-into-view can move is #oob-list itself — which is
      // precisely what should happen when entry lands on a row below the fold.
      try { el.focus(); } catch (err) { continue; }
      if (document.activeElement === el) return true;
    }
    return false;
  }

  function tryAct(act) {
    if (!canDo(act)) return;
    if (act === 'entrench') { orderEntrench(); return; }
    if (mode === act) applyDefaultMode();
    else setMode(act);
  }

  window.addEventListener('keydown', (e) => {
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
    // AUDIO MASTER MUTE — deliberately the first thing this handler does, and
    // the only hotkey above the modal/FPV guards. "Make it stop" has to work
    // at the exact moment the player wants it to: mid-dive, behind the OPORD,
    // on the after-action screen. K is the only letter not already an order or
    // a view (M T R F L X G O are taken; Tab/Enter/Esc are structural).
    if (e.code === 'KeyK' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggleMasterMute();
      return;
    }
    // The drone feed owns the keyboard while it is up (Esc = abort feed).
    if (fpvActive) return;
    if (!elBriefing.classList.contains('hidden')) {
      if (e.code === 'Enter' || e.code === 'NumpadEnter' ||
          e.code === 'Space' || e.code === 'Escape') {
        e.preventDefault();
        commence();
      }
      return;
    }
    if (!elGameover.classList.contains('hidden')) return;
    // CRITIQUE fix 23 — the HUD now contains real focusable controls (sixteen
    // roster buttons, the fire-control strip). While focus is inside the panel
    // layer, TAB belongs to the browser and ENTER belongs to the focused
    // control; stealing either would make the roster keyboard-reachable in name
    // only. On the map, both keep their wargame meaning.
    // `tgt` is only guaranteed to be an EventTarget, not a Node: a keydown
    // dispatched at `window` (or delivered while `document` itself is the
    // target, which Chrome does when the focused element has just been removed)
    // makes `Node.contains()` throw a TypeError and kills the whole handler —
    // every hotkey on the map dies with it. Gate on nodeType, not truthiness.
    const inPanels = !!(tgt && tgt.nodeType === 1
      && tgt !== document.body && root.contains(tgt));
    switch (e.code) {
      case 'Tab':
        if (inPanels) break;
        e.preventDefault();
        // SHIFT+TAB is the doorway into the control layer (see focusPanels).
        // If nothing there can take focus — the rail is collapsed, every order
        // is unavailable and END TURN is disabled during the RED phase — fall
        // back to the reverse unit cycle rather than eating the keystroke.
        if (e.shiftKey && focusPanels()) break;
        cycleUnits(e.shiftKey ? -1 : 1);
        break;
      case 'Enter':
      case 'NumpadEnter':
        if (inPanels) break;
        if (Game.side === 'blue' && Game.phase !== 'over') Game.endTurn();
        break;
      case 'KeyG':
        gridOn = !gridOn;
        try { terrain && terrain.showGrid(gridOn); } catch (err) {}
        break;
      case 'Escape':
        // …and the way back out to the map, so TAB means "cycle units" again
        // and ENTER means END TURN again.
        if (inPanels && typeof tgt.blur === 'function') tgt.blur();
        cancelOrDeselect();
        break;
      case 'KeyO':
        setOobCollapsed(!oobCollapsed);
        break;
      case 'KeyM': tryAct('move'); break;
      case 'KeyT': tryAct('attack'); break;
      case 'KeyR': tryAct('artillery'); break;
      case 'KeyF': tryAct('fpv'); break;
      case 'KeyL': tryAct('loiter'); break;
      case 'KeyX': tryAct('entrench'); break;
      default: break;
    }
  });

  /* ---- briefing --------------------------------------------------------- */

  const scen = (Game.deps && Game.deps.scenario) || {};
  const objRows = (Game.objectives || []).map((o) => `
      <div class="br-obj"><span class="pip">◆</span>
        <span class="n">${esc(o.name || o.id || 'OBJECTIVE')}</span>
        <span class="s ${o.owner === 'blue' ? 'held' : ''}">${o.owner === 'blue' ? 'HELD' : 'RED-HELD'}</span>
      </div>`).join('');

  elBriefPanel.innerHTML = `
    <div class="br-kicker">OPORD 01 · 47 MECH BDE · ${Game.maxTurns} TURNS</div>
    <h2 class="br-title">${esc(scen.name || 'Signal on the Vovcha')}</h2>
    <p class="br-body">RED holds the far bank of the Vovcha, dug in around the town
      and both crossings, with rail reinforcements inbound from the east.
      Cross, take the town, and hold both bridge exits before turn ${Game.maxTurns}.
      Your FPV teams, loiter battery and jammer are the edge — armor alone
      will not carry the town.</p>
    <div class="br-objectives">${objRows}</div>
    <button id="ss-brief-go" class="ss-btn br-go">Commence operation</button>
    <div class="br-hint">TAB cycle · SHIFT+TAB panels · M move · T attack ·
      R fire msn · F fpv · L loiter · X dig in · G grid · K mute ·
      ENTER end turn · ESC cancel</div>
  `;

  function commence() {
    if (elBriefing.classList.contains('hidden')) return;
    elBriefing.classList.add('hidden');
    syncInert();                 // hand the panel layer back to the keyboard
    toast(`TURN ${Game.turn} — ISSUE ORDERS`);
  }
  elBriefPanel.querySelector('#ss-brief-go').addEventListener('click', commence);

  /* ---- ROUND-4 FIX 14: the clock does not run behind the briefing --------- */
  // The critic advanced from turn 1 to turn 8 without ever dismissing SIGNAL ON
  // THE VOVCHA, and RED reinforced from 16 to 18 units while the OPORD was still
  // on screen. Both of the HUD's own doors were already shut — the keydown
  // handler returns early while `#ss-briefing` is up, and `syncInert()` makes
  // every panel (END TURN included) `inert` behind a modal, which is not
  // clickable and not focusable. What was open was the third door: a direct
  // `Game.endTurn()` from a console or a capture harness, which is exactly how
  // an automated run drives the game.
  //
  // "The player has not been briefed yet" is a UI fact — the modal is a UI
  // object, the state layer has never heard of it — so the gate belongs here,
  // and it is installed as a wrapper rather than as a fourth call-site check so
  // that it holds for callers this module has never met. It is deliberately
  // narrow:
  //   · it only ever refuses BLUE's own advance while `overlayOpen()`;
  //   · RED's phase does not route through `endTurn()` at all (state.js drives
  //     it by recursing into `_advance()`), so nothing internal can deadlock on
  //     this — and BLUE cannot end its turn, so RED never gets a turn to be
  //     stuck in;
  //   · `endTurn()` is fire-and-forget and returns undefined, so the refusal is
  //     shape-identical to the real call;
  //   · it warns once, because a harness that hits this is broken and silence is
  //     how it stayed broken for four rounds.
  // `Game.ui` is the supported way through it: `Game.ui.dismissBriefing()` is
  // exactly what the Commence button does.
  const _endTurn = Game.endTurn;
  if (typeof _endTurn === 'function' && !Game.__ssTurnGate) {
    let warned = false;
    Game.__ssTurnGate = true;
    Game.endTurn = function ssGatedEndTurn(...args) {
      if (overlayOpen() && this.side === 'blue' && this.phase !== 'over') {
        if (!warned) {
          warned = true;
          console.warn('[HUD] endTurn ignored: a modal is still up. ' +
            'Call Game.ui.dismissBriefing() first (or click Commence operation).');
        }
        return undefined;
      }
      return _endTurn.apply(this, args);
    };
  }

  // A small, documented surface for whoever is driving this build without a
  // mouse — the capture harness, the AI test rig, the console.
  //
  // ROUND-4 FIX 15 / ROUND-5 FIX 19 — CLOSED, and the other half landed where
  // it belonged. `Game.reachableHexes(u)` answers with plain `{q, r}` hexes and
  // `Game.moveUnit(u, path)` wanted a PATH — an array of hexes each adjacent to
  // the last — so `Game.moveUnit(u, Game.reachableHexes(u)[0])` and
  // `Game.moveUnit(u, Game.reachableHexes(u))` both failed the
  // `hexDistance(...) !== 1` guard on their first step and returned silently.
  // js/game/state.js now normalises the contract at the door: a destination hex
  // and a one-element array both resolve their own path, a real path still
  // walks byte-for-byte the way it always did, and the one genuinely ambiguous
  // shape — a multi-hex NON-contiguous array, i.e. a `reachableHexes()` set —
  // is refused with a console.error naming the call to make instead. It also
  // exposes `Game.moveTo(unit, hex)`.
  //
  // `Game.ui.moveTo` therefore no longer papers over anything; it survives
  // because it is the SYNCHRONOUS spelling. `Game.moveTo` is async and its
  // promise is truthy even for a refused order, so a harness written as
  // `if (Game.moveTo(u, h))` would read every refusal as a success. This one
  // resolves the path first and answers a plain boolean before the walk starts.
  Game.ui = Game.ui || {};
  Game.ui.modalOpen = () => overlayOpen();
  Game.ui.dismissBriefing = () => { commence(); };
  Game.ui.moveTo = (unit, hex) => {
    let path = null;
    try { path = Game.pathTo(unit, hex); } catch (err) { path = null; }
    if (!Array.isArray(path) || !path.length) return false;
    Game.moveUnit(unit, path);
    return true;
  };

  /* ---- after-action screen ---------------------------------------------- */

  function showGameOver(result) {
    const r = result || {};
    const out = String((r.outcome ?? r.result ?? '') || '').toLowerCase();
    const win = r.victory === true || r.winner === 'blue' ||
      /victory|decisive|marginal/.test(out);
    const decisive = /decisive/.test(out);
    const title = win
      ? (decisive ? 'DECISIVE VICTORY' : 'OBJECTIVES SECURED')
      : 'OPERATION FAILED';
    const blueLost = Game.units.filter((u) => !u.alive && u.faction === 'blue').length;
    const redLost = Game.units.filter((u) => !u.alive && u.faction === 'red').length;
    const held = (Game.objectives || []).filter((o) => o.owner === 'blue').length;
    const reason = r.reason || r.message || '';
    elGoPanel.innerHTML = `
      <div class="br-kicker">AFTER-ACTION REPORT · TURN ${Game.turn} · ${zulu(Game.turn)}</div>
      <h2 class="br-title ${win ? 'good' : 'bad'}">${title}</h2>
      ${reason ? `<p class="br-body">${esc(reason)}</p>` : ''}
      <div class="go-stats">
        <div><span>${blueLost}</span>FRIENDLY LOSSES</div>
        <div><span>${redLost}</span>ENEMY DESTROYED</div>
        <div><span>${held}/${(Game.objectives || []).length}</span>OBJECTIVES HELD</div>
      </div>
      <button id="ss-go-again" class="ss-btn br-go">Return to briefing</button>
    `;
    elGameover.classList.remove('hidden');
    syncInert();                 // the report is the only live control now
    elGoPanel.querySelector('#ss-go-again')
      .addEventListener('click', () => window.location.reload());
    hideTooltip();
    clearHl();
  }

  /* ---- Game event wiring ------------------------------------------------ */

  Game.on('select', (u) => {
    sel = u || null;
    applyDefaultMode();
    renderCard();
    refreshRoster();
    if (sel && sel.faction === 'blue') revealRosterRow(sel);
  });

  Game.on('deselect', () => {
    sel = null;
    mode = 'none';
    clearHl();
    renderCard();
    renderActions();
    refreshRoster();
  });

  Game.on('turnStarted', () => {
    refreshTop();
    renderActions();
    refreshRoster();
    refreshLabelOwners();
    if (Game.side === 'red') {
      deselect();
      toast('RED PHASE — ENEMY MOVING', 'bad');
    } else if (!overlayOpen()) {
      toast(`TURN ${Game.turn} — YOUR ORDERS`);
    }
  });

  Game.on('turnEnded', () => {
    deselect();
    hideTooltip();
  });

  Game.on('resourcesChanged', refreshTop);

  Game.on('objectiveTaken', (o) => {
    refreshTop();
    refreshLabelOwners();
    const name = (o && (o.name || o.id)) || 'OBJECTIVE';
    if (o && o.owner === 'blue') toast(`${String(name).toUpperCase()} SECURED`, 'good');
    else toast(`${String(name).toUpperCase()} LOST`, 'bad');
  });

  Game.on('infraDestroyed', (o) => {
    const name = (o && (o.name || INFRA_NAMES[o.kind])) || 'INFRASTRUCTURE';
    toast(`${String(name).toUpperCase()} DESTROYED`, 'warn');
  });

  Game.on('unitKilled', (u) => {
    if (u && u.type) {
      if (u.faction === 'blue') toast(`${u.type.name.toUpperCase()} LOST`, 'bad');
      else toast(`${u.type.name.toUpperCase()} DESTROYED`, 'good');
    }
    if (sel && u && sel.id === u.id) deselect();
    refreshTop();
    refreshRoster();
  });

  Game.on('unitMoved', (u) => {
    if (sel && u && sel.id === u.id) renderCard();
    refreshTop();
    refreshRoster();
  });

  Game.on('unitAttacked', () => {
    renderCard();
    renderActions();
    refreshTop();
    refreshRoster();
  });

  // ROUND-5 FIX 18 — an order the game refuses is now told to the player.
  // `Game.artilleryBarrage()` used to decline a fire mission (friendlies on the
  // target hex, out of range, dry) by burying the string in `report.events` and
  // playing nothing: the gun did not traverse, no shell flew, the ammo counter
  // did not move, and the HUD said nothing at all — so the order looked like it
  // had been given. state.js now emits this for BLUE's own batteries only
  // (RED's fire-control problems are not the player's business), with the
  // report flags corrected on the returned object as well. The comms-log line
  // arrives on the normal 'log' path; this is the glance-level half.
  Game.on('orderRefused', (o) => {
    if (!o) return;
    // The reason is the whole point — "denied" alone leaves the player clicking
    // the same hex again. state.js hands over a clean cause; it is only capped
    // here, because `.ss-toast` is `white-space: nowrap` and the strip is
    // centred, so an unbounded string would run off both edges of the frame.
    let why = String(o.reason || '').trim();
    if (why.length > 38) why = `${why.slice(0, 37)}…`;
    toast(why ? `FIRE MISSION DENIED — ${why.toUpperCase()}` : 'FIRE MISSION DENIED',
      'warn');
    renderCard();
    renderActions();
  });

  Game.on('unitDeployed', () => {
    refreshTop();
    refreshRoster();
  });

  Game.on('entrench', () => refreshRoster());

  // GAMEPLAY ROUND contract (state.js): `_supplyTick` announces every unit it
  // touches. The per-unit comms-log line arrives on the normal 'log' path; this
  // handler is the glance-level half — ammo pips, hp bars and the card catch up
  // immediately instead of on the next unrelated repaint.
  Game.on('unitResupplied', (p) => {
    const u = p && p.unit;
    refreshRoster();
    if (sel && u && sel.id === u.id) renderCard();
  });

  // The sector map's fog is a cached composite; these are exactly the four
  // events game/fog.js recomputes its visible sets on, and fog.js registers its
  // own handlers in initFog() — which main.js calls BEFORE initHUD() — so by
  // the time these run the sets are already the new ones. The flag only marks
  // the composite stale; the rebuild itself happens inside mmDraw, rate-limited
  // to MM_FOG_MIN_DT, so a ten-unit RED phase cannot cost ten rebuilds a frame.
  const mmFogTouch = () => { mmFogDirty = true; };
  Game.on('unitMoved', mmFogTouch);
  Game.on('unitKilled', mmFogTouch);
  Game.on('turnStarted', mmFogTouch);
  Game.on('unitDeployed', mmFogTouch);

  Game.on('gameOver', showGameOver);

  Game.on('log', pushLog);

  /* ---- controls --------------------------------------------------------- */

  // `e.detail > 0` is a pointer activation; a keyboard Enter/Space reports 0 and
  // keeps its focus ring. See the roster handler for why the pointer path blurs.
  for (const btn of elActs) {
    btn.addEventListener('click', (e) => {
      if (e.detail > 0 && btn.blur) btn.blur();
      tryAct(btn.dataset.act);
    });
  }
  elEndTurn.addEventListener('click', (e) => {
    if (e.detail > 0 && elEndTurn.blur) elEndTurn.blur();
    if (Game.side === 'blue' && Game.phase !== 'over') Game.endTurn();
  });

  /* ---- initial paint ---------------------------------------------------- */

  refreshTop();
  renderActions();
  renderCard();
  refreshRoster();
  setOobCollapsed(false);
  syncInert();                   // boots with the briefing up: panels are inert
}
