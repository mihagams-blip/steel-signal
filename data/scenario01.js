// STEEL SIGNAL — data/scenario01.js
// "SIGNAL ON THE VOVCHA" — the v1 scenario: map data, order of battle,
// objectives, infrastructure and RED's rail-borne reinforcement waves.
// Numbers follow GAMEPLAY.md §5–§6.1; the roster ids come from units.js.
//
// Authoring convention -------------------------------------------------------
// The map is a 34 × 26 ODD-Q offset grid (flat-top hexes, odd columns pushed
// half a hex south) laid out west→east / north→south, exactly the layout the
// terrain module builds its tiles with:  q = col,  r = row − floor(col / 2).
// Everything below is authored in readable [col, row] pairs and converted once,
// so the exported data is pure axial {q, r}.
//
// Contract export: SCENARIO.
// The shape is additive over the seed stub — `terrain`, `infrastructure`,
// `reinforcements`, `deployHexes` and `hillThreshold` are new (see
// INTEGRATION_NOTES.md). `terrain.types` is a resolved "q,r" → terrain-type
// lookup so world/terrain.js can paint tiles in one pass, while the semantic
// lists (river / roads / rail / forest / town / hills) drive the visuals.

const WIDTH = 34;
const HEIGHT = 26;
const SEED = 20260807;

// --- offset ⇄ axial ---------------------------------------------------------
const ax = (col, row) => ({ q: col, r: row - (col >> 1) });
const rowOf = (h) => h.r + (h.q >> 1);
const K = (h) => `${h.q},${h.r}`;

function inMap(h) {
  const col = h.q;
  const row = rowOf(h);
  return col >= 0 && col < WIDTH && row >= 0 && row < HEIGHT;
}

// --- hex line (cube lerp) ---------------------------------------------------
function hexDistance(a, b) {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

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

function hexLine(a, b) {
  const n = hexDistance(a, b);
  if (n === 0) return [{ q: a.q, r: a.r }];
  const ax0 = a.q;
  const az0 = a.r;
  const ay0 = -ax0 - az0;
  const bx = b.q;
  const bz = b.r;
  const by = -bx - bz;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(cubeRound(
      ax0 + (bx - ax0) * t + 1e-6,
      ay0 + (by - ay0) * t + 1e-6,
      az0 + (bz - az0) * t - 2e-6));
  }
  return out;
}

// Walk a polyline of [col, row] waypoints into a contiguous, de-duplicated
// list of axial hexes (endpoints outside the map are allowed and clipped).
function polyline(points) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = ax(points[i][0], points[i][1]);
    const b = ax(points[i + 1][0], points[i + 1][1]);
    for (const h of hexLine(a, b)) {
      const k = K(h);
      if (seen.has(k)) continue;
      seen.add(k);
      if (inMap(h)) out.push(h);
    }
  }
  return out;
}

function cluster(pairs) {
  return pairs.map(([c, r]) => ax(c, r)).filter(inMap);
}

// ---------------------------------------------------------------------------
// 1. The Vovcha — a NE→SW river cutting the map in two.
//    Control points are chosen so the three crossings sit exactly on the water.
// ---------------------------------------------------------------------------
const RIVER = polyline([
  [22, -1], [20, 4], [17, 8], [15, 12], [13, 17], [11, 22], [10, 26],
]);

const BRIDGES = [
  { hex: ax(17, 8), kind: 'road' },   // main highway crossing (objective axis)
  { hex: ax(13, 17), kind: 'rail' },  // rail crossing (objective axis)
  { hex: ax(11, 22), kind: 'road' },  // southern farm ford — the flank option
];

// ---------------------------------------------------------------------------
// 2. Road net & rail line
// ---------------------------------------------------------------------------
// The highway crosses at (17,8); the river's east bank on that row is (18,9),
// which is therefore the exit hex the whole scenario is fought over.
const ROAD_PAVED = polyline([
  [0, 7], [5, 7], [10, 8], [14, 8], [17, 8], [18, 9], [21, 9], [24, 10], [24, 11],
]);

const ROAD_DIRT = [
  ...polyline([[0, 20], [5, 21], [9, 22], [11, 22], [12, 22], [16, 20], [19, 18], [21, 16]]),
  ...polyline([[12, 7], [14, 8]]),
  ...polyline([[17, 15], [19, 14], [21, 16]]),
  ...polyline([[23, 4], [22, 6], [21, 9]]),
  ...polyline([[24, 11], [26, 12]]),
  ...polyline([[24, 12], [22, 13]]),
  ...polyline([[21, 16], [23, 14], [24, 12]]),
];

const RAIL = polyline([
  [33, 18], [28, 17], [24, 16], [21, 16], [17, 17], [14, 17], [13, 17],
  [10, 16], [5, 15], [0, 14],
]);

// ---------------------------------------------------------------------------
// 3. Windbreak treelines — the signature graphic of the steppe front, and the
//    only cover in the open. Two of them decide the bridge fight.
// ---------------------------------------------------------------------------
const FOREST = [
  ...polyline([[14, 5], [14, 11]]),   // west-bank belt overwatching the crossing
  ...polyline([[19, 9], [19, 13]]),   // east-bank belt behind the bridge exit
  ...polyline([[18, 2], [23, 3]]),
  ...polyline([[8, 3], [11, 3]]),
  ...polyline([[6, 15], [10, 18]]),
  ...polyline([[26, 6], [29, 9]]),
  ...polyline([[19, 20], [24, 21]]),
  ...polyline([[27, 19], [30, 16]]),
  ...polyline([[2, 12], [5, 11]]),
];

// ---------------------------------------------------------------------------
// 4. Built-up areas
// ---------------------------------------------------------------------------
const TOWN_SOKIL = cluster([[24, 10], [25, 10], [24, 11], [25, 11], [24, 12]]);
const VILLAGE_HLYBOKE = cluster([[12, 7], [13, 7], [12, 8]]);   // west bank
const VILLAGE_LISOVA = cluster([[17, 15], [18, 15], [17, 16]]); // east bank, south
const VILLAGE_ZORIA = cluster([[23, 4], [24, 4], [23, 5]]);     // east bank, north

const BUILT_UP = [
  ...TOWN_SOKIL, ...VILLAGE_HLYBOKE, ...VILLAGE_LISOVA, ...VILLAGE_ZORIA,
];

// ---------------------------------------------------------------------------
// 5. Ridge lines (+1 sight, +1 DEF for the occupant — GAMEPLAY.md §2)
// ---------------------------------------------------------------------------
const HILLS = [
  ...polyline([[9, 4], [12, 3]]),
  ...polyline([[20, 13], [23, 14]]),
  ...polyline([[16, 20], [19, 21]]),
  ...polyline([[27, 10], [29, 12]]),
  ...polyline([[6, 9], [8, 11]]),
];

// ---------------------------------------------------------------------------
// 6. Resolve every hex to a terrain type.
//    Paint order matters: crops → treelines → roads → water → built-up →
//    bridges (a bridge is a road hex laid over water).
// ---------------------------------------------------------------------------
const types = Object.create(null);

function paint(list, type) {
  for (const h of list) {
    if (!inMap(h)) continue;
    types[K(h)] = type;
  }
}

const FIELDS = [];
const GRASS = [];
for (let col = 0; col < WIDTH; col++) {
  for (let row = 0; row < HEIGHT; row++) {
    const h = ax(col, row);
    // Strip mosaic with the long axis running NW–SE (ART_DIRECTION.md §3.1):
    // two 5-hex crop strips, then a fallow one.
    const crop = Math.floor((col - row + 96) / 5) % 3 !== 0;
    (crop ? FIELDS : GRASS).push(h);
    types[K(h)] = crop ? 'field' : 'grass';
  }
}

paint(FOREST, 'forest');
paint(ROAD_PAVED, 'road');
paint(ROAD_DIRT, 'road');
paint(RIVER, 'water');
paint(BUILT_UP, 'town');
paint(BRIDGES.map((b) => b.hex), 'road');

// ---------------------------------------------------------------------------
// 7. Order of battle
// ---------------------------------------------------------------------------
const U = (type, faction, col, row, extra) =>
  Object.assign({ type, faction, hex: ax(col, row) }, extra || null);

// BLUE — 47th Mechanised, attacking west→east off the highway.
const BLUE_FORCE = [
  U('mbt', 'blue', 5, 7, { name: 'Vovk 1' }),
  U('mbt', 'blue', 4, 9, { name: 'Vovk 2' }),
  U('ifv', 'blue', 5, 8),
  U('ifv', 'blue', 4, 11),
  U('infantry', 'blue', 4, 7),
  U('infantry', 'blue', 3, 9),
  U('infantry', 'blue', 5, 12),
  U('atgm_team', 'blue', 3, 11),
  U('spg', 'blue', 3, 8),
  U('aa', 'blue', 2, 7),
  U('ew', 'blue', 2, 11),
  U('truck', 'blue', 1, 9),
  U('fpv_drone', 'blue', 3, 7, { name: 'Ptakhy A' }),
  U('fpv_drone', 'blue', 3, 13, { name: 'Ptakhy B' }),
  U('loiter_munition', 'blue', 4, 13, { name: 'Deep Strike Bty' }),
  U('recon_drone', 'blue', 6, 10, { name: 'Oko' }),
];

// RED — dug in on the far bank, with two forward outposts west of the water.
const RED_FORCE = [
  // forward screen (west bank)
  U('infantry', 'red', 12, 7, { entrench: 2 }),        // Hlyboke garrison
  U('atgm_team', 'red', 14, 10, { entrench: 1 }),      // treeline ambush
  // the crossings
  U('infantry', 'red', 18, 9, { entrench: 2 }),        // road-bridge exit
  U('atgm_team', 'red', 19, 10, { entrench: 1 }),
  U('infantry', 'red', 14, 17, { entrench: 2 }),       // rail-bridge exit
  // the town
  U('infantry', 'red', 24, 11, { entrench: 2, veterancy: 1 }),
  U('infantry', 'red', 25, 10, { entrench: 1 }),
  // manoeuvre element
  U('mbt', 'red', 21, 9),
  U('ifv', 'red', 19, 12),
  U('ifv', 'red', 22, 6),
  // fires and enablers
  U('spg', 'red', 23, 9),
  U('mlrs', 'red', 26, 13),
  U('aa', 'red', 23, 11),
  U('ew', 'red', 20, 8),
  U('fpv_drone', 'red', 22, 12),
  U('truck', 'red', 25, 14),
];

// ---------------------------------------------------------------------------
// 8. Objectives — GAMEPLAY.md §6.1
//    kind drives the income table: town 15, bridge_exit 5, village 5.
// ---------------------------------------------------------------------------
const OBJECTIVES = [
  {
    id: 'sokil', name: 'Sokil', kind: 'town', primary: true,
    hex: ax(24, 11), owner: 'red', income: 15,
  },
  {
    id: 'exit_road', name: 'Road Bridge East Exit', kind: 'bridge_exit', primary: true,
    hex: ax(18, 9), owner: 'red', income: 5,
  },
  {
    id: 'exit_rail', name: 'Rail Bridge East Exit', kind: 'bridge_exit', primary: true,
    hex: ax(14, 17), owner: 'red', income: 5,
  },
  {
    id: 'hlyboke', name: 'Hlyboke', kind: 'village', primary: false,
    hex: ax(12, 7), owner: 'red', income: 5,
  },
  {
    id: 'lisova', name: 'Lisova', kind: 'village', primary: false,
    hex: ax(17, 15), owner: 'red', income: 5,
  },
  {
    id: 'zoria', name: 'Zoria', kind: 'village', primary: false,
    hex: ax(23, 4), owner: 'red', income: 5,
  },
];

// ---------------------------------------------------------------------------
// 9. Infrastructure — hp values verbatim from GAMEPLAY.md §5
// ---------------------------------------------------------------------------
const INFRASTRUCTURE = [
  {
    id: 'bridge_road', kind: 'bridge', name: 'Vovcha Road Bridge',
    hex: ax(17, 8), hp: 8, maxHp: 8,
  },
  {
    id: 'bridge_rail', kind: 'rail_bridge', name: 'Vovcha Rail Bridge',
    hex: ax(13, 17), hp: 8, maxHp: 8,
  },
  {
    id: 'bridge_ford', kind: 'bridge', name: 'Novhorodske Ford Bridge',
    hex: ax(11, 22), hp: 8, maxHp: 8,
  },
  {
    id: 'substation', kind: 'substation', name: 'Sokil Substation',
    hex: ax(26, 12), hp: 6, maxHp: 6,
  },
  {
    id: 'fuel_depot', kind: 'fuel_depot', name: 'Kamyanka Fuel Depot',
    hex: ax(22, 13), hp: 6, maxHp: 6,
  },
  {
    id: 'rail_yard', kind: 'rail_yard', name: 'Sokil Rail Yard',
    hex: ax(21, 16), hp: 8, maxHp: 8,
  },
  {
    id: 'comms_tower', kind: 'comms_tower', name: 'Relay Mast 41',
    hex: ax(21, 5), hp: 4, maxHp: 4,
  },
];

// ---------------------------------------------------------------------------
// 10. RED reinforcement waves — GAMEPLAY.md §6.1 (T4 / T8 / T12), detraining at
//     the rail yard. Killing the yard delays imminent waves to the east edge
//     (+2 turns) and cancels everything later (§5).
// ---------------------------------------------------------------------------
const REINFORCEMENTS = [
  {
    id: 'wave1', turn: 4, faction: 'red', via: 'rail',
    at: ax(21, 16), fallback: ax(32, 17),
    units: [{ type: 'ifv' }, { type: 'infantry' }],
    label: 'RED rail movement: IFV + infantry detrain at Sokil yard.',
  },
  {
    id: 'wave2', turn: 8, faction: 'red', via: 'rail',
    at: ax(21, 16), fallback: ax(32, 17),
    units: [{ type: 'mbt' }, { type: 'ifv' }],
    label: 'RED rail movement: armour platoon detrains at Sokil yard.',
  },
  {
    id: 'wave3', turn: 12, faction: 'red', via: 'rail',
    at: ax(21, 16), fallback: ax(32, 17),
    units: [{ type: 'mbt' }, { type: 'spg' }],
    label: 'RED rail movement: tank + howitzer detrain at Sokil yard.',
  },
];

// ---------------------------------------------------------------------------
// SCENARIO
// ---------------------------------------------------------------------------
export const SCENARIO = {
  id: 'scenario01',
  name: 'Signal on the Vovcha',
  subtitle: 'OPORD 01 · 47 Mechanised Brigade · 16 turns',
  briefing:
    'RED holds the far bank of the Vovcha, dug in around Sokil and both ' +
    'crossings, with rail reinforcements inbound from the east. Cross, take ' +
    'the town, and hold both bridge exits before the clock runs out.',

  seed: SEED,
  width: WIDTH,
  height: HEIGHT,
  maxTurns: 16,
  hillThreshold: 2.2,

  startResources: { blue: 200, red: 120 },

  // west-edge staging hexes where BLUE may buy replacements (one per turn each)
  deployHexes: [ax(1, 7), ax(1, 13)],

  // where a delayed RED wave walks on if the rail yard is gone
  edgeEntry: ax(32, 17),

  terrain: {
    hillThreshold: 2.2,
    types,                       // "q,r" → 'field'|'grass'|'forest'|'town'|'water'|'road'
    water: RIVER.filter((h) => types[K(h)] === 'water'),
    bridges: BRIDGES,
    roadsPaved: ROAD_PAVED,
    roadsDirt: ROAD_DIRT,
    rail: RAIL,
    forest: FOREST,
    town: TOWN_SOKIL,
    villages: [
      { id: 'hlyboke', name: 'Hlyboke', hexes: VILLAGE_HLYBOKE },
      { id: 'lisova', name: 'Lisova', hexes: VILLAGE_LISOVA },
      { id: 'zoria', name: 'Zoria', hexes: VILLAGE_ZORIA },
    ],
    fields: FIELDS,
    grass: GRASS,
    hills: HILLS,
  },

  units: [...BLUE_FORCE, ...RED_FORCE],
  objectives: OBJECTIVES,
  infrastructure: INFRASTRUCTURE,
  reinforcements: REINFORCEMENTS,

  victory: {
    decisive: 'Hold Sokil and both bridge exits at the end of any turn.',
    marginal: 'Hold Sokil and at least one bridge exit when the clock runs out.',
    defeat: 'Anything less — or fewer than four BLUE combat units still fighting.',
  },
};
