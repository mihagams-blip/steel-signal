// STEEL SIGNAL — fx/markers.js
// The readability layer, and after round 1 the single most load-bearing file in
// the build. The critic's verdict was blunt: "sixteen friendly units on screen
// and I cannot name one." Panzer Corps 2 puts a strength badge and a national
// flag on every unit at every zoom, and that — not its shading — is why its
// screenshots are legible. This module is the answer to that.
//
// Three parts:
//   1. CRITIQUE FIX 3 — a ground ring per unit, coloured BY FACTION
//      (BLUE 0x6FA8DC / RED 0xD4675A, never the same near-white on both sides),
//      radius 0.62 × the hex inradius so it sits INSIDE the unit's own footprint
//      instead of decorating the hay bale next door, rendered with depthTest on
//      and a polygon offset so the model always wins the overlap;
//   2. CRITIQUE FIX 2 — a camera-facing counter on every unit. Constant screen
//      size across the whole RTS zoom band (camera distance 40 → 260) and faded
//      out below 30 units, where the model itself reads and the counter would
//      only be in the way.
//      ROUND-2 FIX 7: it is now 26 px tall instead of 45 and it hangs BELOW the
//      unit's ground contact point instead of floating over its turret, so the
//      model is the thing you see and the badge is the annotation.
//      ROUND-6 FIX 6 — the badge is redesigned. Round 6's verdict was that it
//      "reads as a debug overlay… a plain black rectangle with white monospace
//      text", and that it is "the second-most-damaging element in the build
//      after the trees". Both true, and the reason is a size mismatch nobody had
//      checked: the badge is ALWAYS drawn at ~21.6 screen px and it was carrying
//      five competing elements, none of which reached 6.2 px. It is now one
//      faction-tinted plate — silhouetted by affiliation, spined, beveled and
//      shadowed — carrying three: an APP-6 glyph at double the old size, a
//      strength numeral 47 % taller, and a 10-segment readiness bar in the HUD's
//      own phosphor/amber/red ramp. The three-letter type code is gone and its
//      information moved into the glyph (see the GLYPH table). See the P_* block
//      for the layout and the ruler it was designed against.
//   3. ROUND-2 FIXES 8 + 9 — the screen-space layout pass. Three independent
//      systems annotate the world in screen space and none of them can see the
//      others: the counters above (WebGL sprites), the damage floats in
//      fx/vfx.js (DOM, `#vfx-labels`) and the world place labels in ui/hud.js
//      (DOM, `#ss-worldlabels`). Left alone they stack into the "wall of dark
//      slabs" the critique measured, and SUPPRESSED lands on HLYBOKE. This file
//      is the only place that sees all three, so it arbitrates all three: one
//      AABB de-clutter pass per frame, plus a watchdog that kills any damage
//      float whose owning unit has died, gone under fog, or whose own timer has
//      stalled. It NEVER creates or destroys another module's elements — it
//      writes exactly three inline properties neither owner ever sets:
//      `style.top` (the de-clutter offset — both owners position with
//      `transform`, which is left alone, so the two compose), `style.visibility`
//      (the float watchdog) and, on world labels only, `style.opacity` (a name
//      that cannot yield far enough yields contrast instead). All three are
//      handed back on dispose.
//
// Integrator-owned module. It only reads Game state and parents child Object3Ds
// to unit meshes, so it never fights units.js, models.js or vfx.js for
// ownership — and because the counters are CHILDREN of the unit group they
// inherit fog-of-war visibility for free.
//
// Export: initMarkers(engine, Game) -> { dispose() }

import * as THREE from 'three';
import { HEX, camGroundDistance } from '../world/terrain.js';

// ---------------------------------------------------------------- palette

// Ring colours: ART_DIRECTION §4 "unit counters & ground rings" (critique fix 3).
// ---- ROUND-6 FIX 6: the plate palette --------------------------------------
// `plate`/`plateB` are the counter's body: a faction-TINTED dark glass rather
// than the old side-neutral `rgba(9,12,10,0.82)`. The critique's first sentence
// about the chit was that it is "a plain black rectangle" — a black rectangle is
// side-neutral, so at 21 screen pixels the ONLY thing carrying affiliation was a
// 42 px chip inside a 200 px canvas, i.e. 8.7 screen px of colour. Tinting the
// whole body puts affiliation into ~40 screen px instead of 8.7.
//
// The tint is deliberately dark. Composited at 0.85 over a sunlit wheat field
// the blue plate PREDICTS ~0.19 gamma-space luma against the old ~0.14 (model,
// not a measurement: 0.85·plate + 0.15·ground, plate luma 0.110 vs 0.044,
// ground taken at the frame p50 0.605). The lighting round is verified good and
// nothing here is allowed to become a new bright element.
const FACTION = {
  blue: {
    ring: '#6FA8DC',
    plate: 'rgba(17,30,42,0.85)',
    plateB: 'rgba(9,17,25,0.88)',
  },
  red: {
    ring: '#D4675A',
    plate: 'rgba(46,23,21,0.85)',
    plateB: 'rgba(26,12,11,0.88)',
  },
};

// The HUD's console palette, verbatim from css/ui.css and ART_DIRECTION §5. The
// critic rates the HUD's typography and comms log ABOVE PC2's; this is that
// language extended into the world, which is the whole point of fix 6.
//   --accent  #E8A33D  amber, structure: the cell divider, veterancy, no-ammo
//   --friendly#7ED88B  phosphor green — ART_DIRECTION literally names it "hp bars"
//   --warn    #F2C94C  strength 4–6
//   --enemy   #E05A4E  strength ≤3
//   --text    #D8DCD0  the numeral at full strength
const ACCENT = '#E8A33D';
const HP_GOOD = '#7ED88B';
const HP_WARN = '#F2C94C';
const HP_LOW = '#E05A4E';
const SUPPRESSED = '#9AB8FF';
const INK = '#D8DCD0';

// ------------------------------------------------------------- geometry sizes

// Flat-top hex, HEX.h is the across-flats height, so the inradius is half of it.
// 0.62 × that is the radius the critique asked for: inside the vehicle's own
// footprint, nowhere near the neighbouring scenery.
const INRADIUS = (HEX && HEX.h ? HEX.h : 10.3923) * 0.5;
const RING_R = INRADIUS * 0.62;              // 3.222 world units at HEX.size 6
const RING_TEX_FRAC = 0.86;                  // where the ring sits in its canvas
const RING_PLANE = (RING_R / RING_TEX_FRAC) * 2;
const SELECT_PLANE = RING_PLANE * 1.14;
const RING_Y = 0.18;                         // hugs the ground; the hull occludes it

// ---- ROUND-3 FIX 17: the ring is annotation, not artwork -------------------
// The critique called the pale-blue crescents "the single most eye-catching
// element in a vehicle close-up", and the arithmetic agrees. The ring is a
// FIXED-WORLD-SIZE object: the 7.49 u plane covers ~50 screen px at the 185 u
// boot camera but ~162 px at the 57 u close-up, so a stroke authored to read at
// strategic zoom is drawn 3.2× heavier the moment you lean in. Round 2 tuned it
// at RTS range and it went cartoon everywhere else.
//
// Three answers, and none of them is "make it thinner and lose it at range":
//   1. the stroke is authored ~30 % lighter (below, in makeMarkerTexture);
//   2. opacity is solved against camera distance instead of being a constant —
//      0.44 in the close-up frame the critic was looking at, rising to 0.76 at
//      RTS range where the same ring is barely a pixel wide and is the only
//      thing separating two adjacent hulls. This is the same "annotation obeys
//      the camera" rule the counters have always run on;
//   3. it is CONFORMED to the ground (see `conformRing`) rather than lying in
//      the XZ plane at a fixed 0.18, so on the 30.97 u of relief the world pass
//      shipped it stops floating over the downhill side and cutting into the
//      uphill side.
// ---- ROUND-4 FIX 10: the solve had two stops and the build has three --------
// Measured, at a 19.3 u camera: `unit-marker` covers 2.13 % of the frame at mean
// luma 0.572 and peak 0.939 against a frame mean of 0.354. Fix 17's distance
// solve works — but `RING_A_D0 = 62` made "62 u or nearer" ONE bucket, and this
// build now flies at 15–20 u, where the same 7.49 u plane spans ~390 screen px
// instead of the ~162 the constant was tuned against. Everything under 62 u was
// being drawn at the 62 u weight.
//
// Three stops now, and each one moves THREE things rather than only opacity —
// because opacity alone cannot fix a mark that is drawn 2.4× too thick:
//   · `a`  material opacity — 0.26 at 18 u, the value the critique asked for;
//   · `t`  the profile threshold that sets the stroke's WIDTH (see RING_BANDS
//          and makeMarkerTexture): 0.94 keeps only the core band, ~0.011 of the
//          canvas ≈ 4 screen px at 19 u, against the ~17 px the 0.044 liner
//          covers there. This is the critique's "scale the stroke width in
//          world units down with distance as well as the opacity";
//   · `v`  a flat linear multiplier on the material colour, so the core value
//          itself steps back at close range instead of only its coverage.
// Stops are camera GROUND distance (camGroundDistance), interpolated with a
// smoothstep inside each span so the whole thing is continuous — a ring that
// pops between two authored looks while the player dollies in is worse than one
// that is slightly wrong at one distance.
// ---- ROUND-6 FIX 6 (second clause) -----------------------------------------
// "At 24 u the annotation ring still out-punches the tank." The round-4 table
// made 18 u its near stop and then interpolated all the way to 62 u, so 24 u
// still solved to a 0.266 / v 0.786 — 92 % of the near-stop weight, at a range
// where the hull is ~600 screen px tall and needs no annotation at all. The
// counter layer already concedes this range (COUNTER_FADE_LO 30); the ring did
// not. A near stop at 16 u plus a second at 30 u — where the counter fade ends
// — makes the two annotation layers recede together instead of one of them
// staying at strategic weight while the player is looking at a vehicle.
// Punch (a·v, the product that actually sets how much the mark shouts):
//   18 u  0.203 → 0.093  (−54 %)      24 u  0.209 → 0.159  (−24 %)
//   30 u  0.239 → 0.216  (−10 %)      ≥62 u unchanged by construction.
// Arithmetic, not a photograph: the two stops at 62 and 150 are byte-identical
// to the shipped table, so the verified-good wide frame cannot move.
const RING_STOPS = [
  //  dist   a     t     v
  [16, 0.15, 0.96, 0.58],
  [30, 0.27, 0.93, 0.80],
  [62, 0.44, 0.40, 0.94],
  [150, 0.76, 0.30, 1.00],
];
// THE TRAP, written down because it cost a frame of thinking and would have
// shipped an invisible ring: three.js tests `diffuseColor.a` — which is
// `material.opacity × texel.a` — against `material.alphaTest`, NOT the texel
// alpha alone. A profile threshold of 0.94 written straight into `alphaTest`
// while opacity is 0.26 discards every pixel of the ring. The threshold is
// therefore always applied as `opacity × t`, and it must never reach exactly 0:
// `alphaTest > 0` is a shader DEFINE, so crossing zero recompiles the program
// mid-pan. The stops above keep it in [0.144, 0.261] (round 6 lowered the near
// end from 0.176 with the new 16 u stop; the ceiling still sits in the 30→62 u
// span, where opacity is climbing faster than the profile is opening).
const RING_CONFORM_E = 2.4;                  // gradient sample radius, world u

// The ring's cross-section, widest band first. Each band is stroked over the
// previous one, so the accumulated alpha staircases up toward the core and the
// `alphaTest` cut eats it from the outside in — one texture, no swapping, no
// second draw, and a stroke width that is continuous in the camera.
//   [stroke width as a fraction of the canvas, ACCUMULATED alpha, colour mix]
// Band 3 is 0.040 — where round 3's 0.044 liner sat — so the far-range ring is
// the ring that shipped, and the bands under it are the new close-range widths.
// The colour mix runs dark→faction outward-to-inward on purpose: whatever the
// cut leaves standing, the outermost surviving band is always darker than the
// core, so the ring keeps its own contrast over sunlit stubble at every width.
// That is what the old two-pass liner did, made scale-invariant.
const RING_BANDS = [
  [0.056, 0.12, 0.00],
  [0.048, 0.26, 0.00],
  [0.040, 0.42, 0.30],
  [0.033, 0.56, 0.30],
  [0.027, 0.68, 0.72],
  [0.021, 0.79, 0.72],
  [0.016, 0.90, 1.00],
  [0.011, 1.00, 1.00],
];

// ROUND-2 FIX 7. The counter was a 240×116 canvas drawn 45 px tall — a 93 px
// letterbox slab, and sixteen of them over ~15 hexes at the 185 u boot camera
// buried the army they were labelling. 200×104 at 26 px is the PC2 proportion:
// a badge, not a banner. The canvas stays deliberately ~4× the shipping CSS
// height so a Retina panel (devicePixelRatio 2) still gets a 2:1 supersample
// and the stems stay crisp under the mip chain.
//
// ---- ROUND-6 FIX 6: 224×116, and why the aspect barely moved ---------------
// 224/116 = 1.9310 against the old 200/104 = 1.9231 — a 0.4 % change, on
// purpose. Everything downstream of this badge (COUNTER_PUSH_ROWS, the lateral
// budget in badge widths, the de-clutter separation, the leader tick's px→scale
// identity) was tuned against a specific screen footprint over three rounds, and
// none of it needed to move: the defect was never the badge's SIZE, it was what
// is inside it. What DID change is how much of the canvas is plate. The old
// layout was a 194×78 panel with a separate 194×14 bar slung under it — two
// stacked dark slabs with a hole between them, 85.8 % ink. It is now ONE
// 210×100 plate with the bar built into its foot, 80.7 % ink, so the badge is
// both a smaller stain on the frame AND has more usable interior, because the
// interior is no longer split across two objects.
const CHIP_W = 224;                          // counter canvas
const CHIP_H = 116;
const CHIP_AR = CHIP_W / CHIP_H;
// ---- ROUND-6 FIX 6: the plate's own layout, in canvas pixels ---------------
// Every number below was chosen against the SHIPPING SCREEN SIZE, not against
// the canvas — which is the mistake the old layout made. At the default 1600×900
// the badge is `clamp(900 · 0.024, 20, 34)` = 21.6 px tall, so one screen pixel
// is CHIP_H / 21.6 = 5.37 canvas pixels, and an element that needs to read has
// to be ~40 canvas px before it is even 7.5 screen px. Measured against that
// ruler the old badge had FIVE elements competing inside 21.6 px — chip+glyph
// (5.2 px), three-letter code (5.6 px cap), chevrons (2.3 px), strength numeral
// (6.2 px cap) and pip bar (2.9 px) — which is why it collapses to "black
// rectangle, white text" at exactly the range it is always seen at.
// The redesign spends that budget on THREE reads instead of five:
//   · WHOSE  — plate tint + spine + silhouette (~40 × 20 screen px of signal)
//   · WHAT   — one APP-6 glyph at 10.4 × 8.9 screen px (was 5.2 × 4.2)
//   · HOW STRONG — numeral at 9.1 screen px cap (was 6.2) over a 10-segment
//     bar at 3.2 screen px in the HUD's own phosphor/amber/red readiness ramp
const P_X = 7;                               // plate origin / size
const P_Y = 5;
const P_W = 210;
const P_H = 100;
const P_SPINE = 16;                          // faction spine, left edge
const P_RAIL = 14;                           // status rail, right edge
const P_BAR = 20;                            // strength bar, plate foot
const P_GAP = 2;                             // rule between content and bar
const P_CHAMFER = 17;                        // hostile plate corner cut
const P_RADIUS = 11;                         // friendly plate corner radius
const P_DIV = 103;                           // glyph cell | numeral cell
const P_NUM_PX = 70;                         // strength numeral, canvas px
const COUNTER_PX_K = 0.024;                  // fraction of frame height
const COUNTER_PX_MIN = 20;
const COUNTER_PX_MAX = 34;
const COUNTER_GAP_PX = 2;                    // clear air under the running gear
const COUNTER_CENTER_Y = 1;                  // sprite.center.y: hang fully below
const COUNTER_FADE_LO = 30;                  // fully hidden at/below this distance
const COUNTER_FADE_HI = 40;                  // fully shown at/above it

// ---- ROUND-5 FIX 13: the counters obey the camera at the FAR end too -------
// The critique: "`SAM 10`, `MBT 10` etc. read as bright white/cyan slabs at
// every zoom, including the 330 u establishing shot where they cluster into a
// solid block. Fade opacity and desaturate with distance, and drop them
// entirely past ~250 u." The arithmetic behind it: the counter is a CONSTANT
// SCREEN SIZE object (COUNTER_PX_K, sizeAttenuation off), so zooming out never
// makes a badge smaller — it only packs more of them into the same pixels. At
// 330 u sixteen 26 px badges over ~40 screen-hexes tile into one slab, and the
// strength number inside each one is drawn in `#E4EEFB`, sRGB luma **0.929**,
// against a frame p50 of 0.498. It is, measurably, the brightest thing left.
//
// Three levers, each doing the one job the other two cannot:
//   · OPACITY  — continuous, on camera ground distance. Untouched below
//     COUNTER_FAR_LO (the 185 u default RTS frame keeps every badge at full
//     strength, with 20 u of headroom), gone by COUNTER_FAR_HI. The wide
//     establishing shot draws no counter layer at all.
//   · VALUE    — continuous, via `SpriteMaterial.color` (a scalar multiply on
//     the texel). Costs one uniform per material per frame and no re-bake, so
//     it can be solved every frame without touching a canvas.
//   · CHROMA   — `material.color` can only scale value; it cannot desaturate.
//     Real desaturation has to happen at bake time, so it is QUANTISED into
//     three bands (see TONE_BANDS) folded into the counter's signature: a band
//     change invalidates every signature and the existing 0.12 s sync repaints
//     the canvases exactly the way an hp change already does. Bands carry a
//     TONE_HYST deadband so a hand on the scroll wheel cannot thrash thirty
//     canvas repaints back and forth across one number.
const COUNTER_FAR_LO = 205;                  // camera ground distance: full above
const COUNTER_FAR_HI = 255;                  // ... and gone at/beyond this
const COUNTER_VAL_D0 = 130;                  // full value at/below
const COUNTER_VAL_D1 = 240;
const COUNTER_VAL_FAR = 0.72;                // material.color scalar at/above D1
// Bake-time chroma, keyed on camera ground distance. `enter` is the distance at
// which the band becomes the raw answer; TONE_HYST widens each boundary into a
// deadband. Chroma 0.42 still leaves the faction spine unambiguous — #6FA8DC
// folds to (144,157,169) and #D4675A to (137,110,105), which are plainly cool
// and plainly warm — it just stops them being a cyan block in the establishing
// shot. ROUND-6 NOTE: the plate TINT is an authored dark value and is exempt
// from the fold (see paintCounter), so affiliation survives at every band even
// though the spine's chroma does not.
const TONE_BANDS = [
  { enter: 0, chroma: 1.00 },
  { enter: 145, chroma: 0.70 },
  { enter: 210, chroma: 0.42 },
];
const TONE_HYST = 12;                        // world units of deadband per edge
// A flat trim on the badge's BRIGHT register, at every zoom, applied at bake.
// The number, the type code, the chevrons, the chip and the border all go
// through it; the near-black panel, the dividers and the dark outlines do not,
// so the badge's internal contrast is untouched — 0.929 × 0.88 = 0.818 against
// a panel at 0.82 alpha over ~0.04 is still better than 15:1, i.e. nothing on
// this badge becomes one shade harder to read. It simply stops being the
// highlight of the picture at working range, where the distance solves above
// are deliberately doing nothing.
const COUNTER_INK_K = 0.88;

// Screen-space de-clutter (fix 8) and the damage-float watchdog (fix 9).
const DECLUTTER_SEP = 2;                     // px of air the critique asked for
const DECLUTTER_MAX = 56;                    // px an annotation may ever move
const DECLUTTER_ITERS = 3;
// PHASE 2. A counter may travel further than a float, because it is a permanent
// layer that has to resolve into ROWS: sixteen units inside fifteen hexes at the
// 185 u boot camera routinely need three ranks of badge, and 56 px was two.
// The budget is expressed in badge heights rather than pixels so it means the
// same thing on a 720p laptop (where COUNTER_PX_MIN pins the badge at 20 px) and
// on a 4K panel (where COUNTER_PX_MAX pins it at 34) — a fixed pixel number
// silently becomes "three rows" on one and "two" on the other. The cap keeps
// the badge from ever drifting so far below the hull that it stops reading as
// that unit's badge, which is the failure mode in the other direction.
// ROUND-3 FIX 15. 3.2 rows / 76 px could not clear the four-deep LOG · IFV ·
// EWJ · ATG stack the critique photographed: four badges at 26 px with the 2 px
// separation need 3 × 28 = 84 px of travel and the budget stopped at 76, so the
// fourth one simply stayed where it was and overprinted its neighbour. The
// budget is now 4.8 rows, which clears five deep — and the reason it can be
// raised without the badge losing its owner is the leader tick added in this
// round (see TICK_*): a counter 120 px from its hull is unambiguous when a line
// is drawn between them, and was never unambiguous before.
const COUNTER_PUSH_ROWS = 4.8;
const COUNTER_PUSH_MIN = 76;
const COUNTER_PUSH_MAX = 124;
// ---- ROUND-4 FIX 11: the second axis ---------------------------------------
// The critique photographed the SAM · FPV · INF · MBT · SPG · IFV cluster in the
// default RTS frame with counters touching and occluding one another, and the
// arithmetic says why: a badge is ~26 px tall, so six of them stacked need
// 5 × 28 = 140 px of vertical travel and the budget above stops at 124. The
// sixth badge could not clear, so it sat exactly where it was and overprinted
// its neighbour — the round-3 pass did everything it was asked and then ran out
// of column.
//
// A vertical-only solver is a single-file queue. Given a badge 50 px wide and
// 26 px tall, one step sideways is worth roughly two rows: the same six-deep
// cluster resolves as two columns of three. So a counter that cannot clear
// vertically now tries four lateral slots (±0.62 and ±1.02 badge widths) and
// re-runs the vertical solve from its resting place at each one, keeping the
// first that comes out clean and falling back to the vertical-only result if
// none does — it never ends up worse than round 3.
//
// The side it tries FIRST is the side it is already on, which is free
// hysteresis: a badge that has settled to the right of its hull does not swap
// to the left because a neighbour drifted a pixel.
//
// This is only affordable because the leader line exists (see placeTick): a
// badge 50 px to the left of its hull is unreadable on its own and unambiguous
// with a line drawn to it, which is exactly what the critique asked for —
// "a screen-space repulsion pass with a minimum separation and a leader line
// when a counter is displaced".
const COUNTER_PUSH_X = 1.15;                 // badge widths of lateral budget
const LAT_TRIES = [0.62, 1.02];              // badge widths, each tried ±
// The anchor tick. 3 px wide as authored (1 px core between two liner columns,
// so it survives being drawn over both sunlit stubble and a mud scar), and only
// drawn once the badge has actually been pushed clear of its resting place —
// below that it would be a 2 px stub hanging off every unit on the map.
const TICK_PX = 3;
const TICK_MIN_PUSH = 5;                     // px of push before a tick appears
const TICK_ALPHA = 0.62;
const PRIO_FLOAT = 3;                        // transient, urgent — never yields
const PRIO_COUNTER = 2;                      // the order of battle
const PRIO_LABEL = 1;                        // ambient map furniture — yields
const FLOAT_ROOT_ID = 'vfx-labels';          // fx/vfx.js owns these elements
const LABEL_ROOT_ID = 'ss-worldlabels';      // ui/hud.js owns these elements
// A live damage float rewrites its own transform every single frame (it rises
// 42 px over 1.15 s). One that has not moved, changed text or changed opacity
// for this long is therefore not a float any more — its owner's timer has
// stalled and it is a zombie. 1.5 s > the 1.15 s design life, so a healthy
// float can never trip it.
const FLOAT_STALL_S = 1.5;
// PHASE 2 — a hard ceiling on the whole float, not merely on its stillness.
// fx/vfx.js gives a damage number a 1.15 s life and clears the pool on
// `turnStarted`, and the stall watchdog above catches a stopped timer; this is
// the third net under the exact defect the critique named — a SUPPRESSED label
// that outlived a full turn boundary and hung in empty air over a unit that had
// gone back under fog. At 2.6x the design life it can only ever catch something
// that is already broken, and it does not care WHY it broke.
const FLOAT_MAX_S = 3.0;
const LABEL_STEM_PX = 10;                    // the .wl stem hanging below its anchor

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------- ring textures

// A broken tactical bracket with the heading chevron INSIDE the ring. The old
// marker carried a soft radial core glow, and in C03 that glow — not any shadow
// — was the dark pool every tank appeared to hover over. It is gone; grounding
// is models.js's contact decal's job now.
// ROUND-4 FIX 10. Round 3 painted two passes — a 0.044 dark liner and a 0.026
// coloured core — which is a stroke of ONE authored width, and a fixed-world-size
// object drawn at one width is 2.4× too heavy the moment the camera halves its
// distance. It is now painted as a PROFILE: eight concentric bands whose
// accumulated alpha climbs from 0.12 at the outer edge to 1.00 at the core, so a
// single `alphaTest` uniform selects the width at draw time (see RING_STOPS).
// The far-range look is unchanged by construction — bands 3–4 sit exactly where
// the old 0.044 liner was — and everything under 62 u gets thinner instead of
// fatter.
const LINER_RGB = [10, 14, 11];

function cssRgb(s) {
  const h = String(s || '').replace('#', '');
  const n = parseInt(h.length === 3
    ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h.slice(0, 6), 16);
  return Number.isFinite(n)
    ? [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    : [255, 255, 255];
}

function makeMarkerTexture(faction) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const col = FACTION[faction] || FACTION.blue;
  const cx = S / 2, cy = S / 2;
  const R = S * 0.5 * RING_TEX_FRAC;
  const ink = cssRgb(col.ring);

  g.clearRect(0, 0, S, S);
  g.lineCap = 'round';

  // `acc` is the alpha already laid down by the wider bands; source-over means
  // the per-pass alpha that reaches an accumulated target A is (A−acc)/(1−acc).
  let acc = 0;
  for (let b = 0; b < RING_BANDS.length; b++) {
    const w = RING_BANDS[b][0], A = RING_BANDS[b][1], mix = RING_BANDS[b][2];
    const a = acc >= 0.9999 ? 1 : (A - acc) / (1 - acc);
    acc = A;
    if (!(a > 0.001)) continue;
    const r = Math.round(LINER_RGB[0] + (ink[0] - LINER_RGB[0]) * mix);
    const gg = Math.round(LINER_RGB[1] + (ink[1] - LINER_RGB[1]) * mix);
    const bb = Math.round(LINER_RGB[2] + (ink[2] - LINER_RGB[2]) * mix);
    g.strokeStyle = `rgba(${r},${gg},${bb},${a.toFixed(4)})`;

    // the broken tactical bracket
    g.lineWidth = S * w;
    for (let i = 0; i < 4; i++) {
      const a0 = (Math.PI / 2) * i + 0.22;
      const a1 = (Math.PI / 2) * (i + 1) - 0.22;
      g.beginPath();
      g.arc(cx, cy, R, a0, a1);
      g.stroke();
    }
    // forward chevron (+x is the model's facing), kept inside the ring so the
    // whole marker stays within 0.62 × inradius. It carries the same profile at
    // 1.2× the width, so it thins with the bracket rather than surviving as a
    // fat arrow after the ring around it has been cut back to a hairline.
    g.lineWidth = S * w * 1.2;
    g.beginPath();
    g.moveTo(cx + R * 0.44, cy - S * 0.062);
    g.lineTo(cx + R * 0.78, cy);
    g.lineTo(cx + R * 0.44, cy + S * 0.062);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// The three-stop solve. `d` is camera ground distance; returns the opacity, the
// profile threshold and the value multiplier for that distance, smoothstepped
// inside each span and held flat outside the table.
const _ringSolve = { a: 0.44, t: 0.40, v: 0.94 };
function ringSolve(d) {
  let i = 0;
  while (i < RING_STOPS.length - 2 && d > RING_STOPS[i + 1][0]) i++;
  const s0 = RING_STOPS[i], s1 = RING_STOPS[i + 1];
  let k = (d - s0[0]) / (s1[0] - s0[0]);
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  k = k * k * (3 - 2 * k);
  _ringSolve.a = s0[1] + (s1[1] - s0[1]) * k;
  _ringSolve.t = s0[2] + (s1[2] - s0[2]) * k;
  _ringSolve.v = s0[3] + (s1[3] - s0[3]) * k;
  return _ringSolve;
}

// ---- ROUND-5 FIX 13: the counter's tone solve ------------------------------
// `rawToneBand` is the band the camera is standing in; `solveToneBand` adds the
// hysteresis, and is the one the frame loop calls. Passing the current band in
// (rather than keeping the state in here) keeps this pure and lets init seed the
// band from the boot camera with `rawToneBand` instead of flashing one 0.12 s
// sync of full-chroma badges at the wrong distance.
// Smoothstep of `d` across [a, b], clamped. Continuity matters here for the
// same reason it matters in ringSolve: an annotation layer that pops between
// two authored looks while the player dollies is worse than one that is
// slightly wrong at one distance.
function smooth01(d, a, b) {
  if (!(b > a)) return d >= b ? 1 : 0;
  const k = clamp((d - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
}

function rawToneBand(d) {
  let b = 0;
  for (let i = TONE_BANDS.length - 1; i >= 0; i--) {
    if (d >= TONE_BANDS[i].enter) { b = i; break; }
  }
  return b;
}

function solveToneBand(d, cur) {
  const b = rawToneBand(d);
  if (b === cur) return cur;
  // Only leave the band the badges are baked in once the camera is TONE_HYST
  // past the edge it wants to cross — in either direction.
  if (b > cur && d < TONE_BANDS[cur + 1].enter + TONE_HYST) return cur;
  if (b < cur && d > TONE_BANDS[cur].enter - TONE_HYST) return cur;
  return b;
}

// Fold a css colour toward its own luma by `chroma` and scale it by
// COUNTER_INK_K. Handles the two notations this file authors in (`#rrggbb` and
// `rgba(...)`) and hands anything else straight back rather than painting
// `NaN` — a colour that fails to parse must never take the badge down with it,
// because paintCounter's failure path hides the counter entirely.
// Memoised: a repaint asks for ~9 colours and there are 3 bands × 2 factions,
// so the map settles at a few dozen entries for the whole match.
const _toneCache = new Map();

function parseCss(css) {
  if (typeof css !== 'string') return null;
  if (css.charCodeAt(0) === 35) {              // '#'
    const h = css.slice(1);
    if (h.length === 3) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16), 1];
    }
    if (h.length >= 6) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16), 1];
    }
    return null;
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(css.trim());
  if (!m) return null;
  const p = m[1].split(',').map((s) => parseFloat(s));
  if (p.length < 3 || !p.slice(0, 3).every(Number.isFinite)) return null;
  const a = p.length > 3 && Number.isFinite(p[3]) ? p[3] : 1;
  return [p[0], p[1], p[2], a];
}

function toneCss(css, chroma) {
  const k = Number.isFinite(chroma) ? clamp(chroma, 0, 1) : 1;
  if (k >= 0.999 && COUNTER_INK_K >= 0.999) return css;
  const ck = `${css}|${k}`;
  const hit = _toneCache.get(ck);
  if (hit !== undefined) return hit;
  const p = parseCss(css);
  if (!p) { _toneCache.set(ck, css); return css; }
  const y = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  const ch = (v) => clamp(Math.round((y + (v - y) * k) * COUNTER_INK_K), 0, 255);
  const out = `rgba(${ch(p[0])},${ch(p[1])},${ch(p[2])},${p[3]})`;
  _toneCache.set(ck, out);
  return out;
}

// ROUND-3 FIX 15 — the anchor tick. A 6×4 stamp: two liner columns, two core
// columns, drawn at TICK_PX across so the core lands on ~1 screen px with a
// dark half-pixel either side. Mipmaps off — it is stretched along v, never
// minified, and a mip chain on a 6 px texture would grey the core away.
function makeTickTexture(faction) {
  const c = document.createElement('canvas');
  c.width = 6; c.height = 4;
  const g = c.getContext('2d');
  const col = FACTION[faction] || FACTION.blue;
  g.clearRect(0, 0, 6, 4);
  g.fillStyle = 'rgba(8,11,8,0.66)';
  g.fillRect(1, 0, 4, 4);
  g.fillStyle = col.ring;
  g.fillRect(2, 0, 2, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// The selection ring: a bright dashed circle, animated by scale + alpha.
function makeSelectTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const R = S * 0.5 * RING_TEX_FRAC;
  const N = 20;
  g.lineCap = 'butt';
  for (const pass of [0, 1]) {
    g.strokeStyle = pass === 0 ? 'rgba(10,14,11,0.5)' : '#FFD98A';
    g.lineWidth = pass === 0 ? S * 0.042 : S * 0.026;
    for (let i = 0; i < N; i++) {
      const a0 = (Math.PI * 2 * i) / N;
      const a1 = a0 + (Math.PI * 2 / N) * 0.56;
      g.beginPath();
      g.arc(S / 2, S / 2, R, a0, a1);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ------------------------------------------------------------ APP-6 counter

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

// ---- ROUND-6 FIX 6: the glyph replaces the three-letter code ---------------
// The old badge carried BOTH a class glyph and a three-letter code, because the
// glyph set was keyed on `type.icon` and eight icons cannot separate thirteen
// types — `mbt`, `ifv` and `apc` were all a bare oval, `spg` and `mlrs` were the
// same dot, `infantry` and `atgm_team` the same cross. The code existed to
// disambiguate a glyph that had been drawn too coarsely.
//
// So the code is gone and the glyph does the job it should always have done.
// This is not information thrown away: it is the SAME information carried by
// APP-6 base-symbol + modifier — an oval is armour, an oval with a cross inside
// is mechanised infantry, an oval with a filled dot is self-propelled artillery
// — which is real symbology a wargame audience already reads, instead of three
// letters that measured 5.6 screen pixels of cap height and read as debug
// output. It is also what buys the redesign its room: dropping the code frees
// 43 % of the plate's width, which is where the doubled glyph and the +47 %
// numeral come from. PC2's chit has no type code either, for the same reason.
//
// Keyed on `typeId` first (the thirteen entries in units.js), falling back to
// `type.icon` so a type this table has never heard of still draws a sane base
// symbol rather than nothing. `ui/hud.js` glyphSVG carries the identical set —
// the two must never disagree, so any edit here is an edit there.
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
};

function glyphKey(unit) {
  const byType = unit && GLYPH[unit.typeId];
  if (byType) return byType;
  return (unit && unit.type && unit.type.icon) || 'armor';
}

// Class symbol, same visual language as the HUD unit card (ui/hud.js glyphSVG)
// so the counter on the field and the card in the corner never disagree.
// `hw`/`hh` are the half-extents of the BASE symbol and EVERY modifier is drawn
// inside them, including the two that APP-6 puts above the frame. That is a
// deliberate departure and it is the size ruler that forces it: the glyph cell
// is 11.2 × 9.7 screen px, the plate leaves 11.9 canvas px (2.2 screen px) of
// headroom above the oval, and a 2.2 px spike is a nub, not a modifier. Nesting
// keeps every symbol one optical size and spends the whole cell on the mark.
//
// The other consequence of that ruler: a modifier has to survive at ~2.5 screen
// px, which rules out anything whose meaning lives in its OUTLINE. So the
// modifiers here are all counts and positions — one dot vs two dots, a cross, a
// bar — never a shape distinction (a triangle instead of a circle, a doubled
// ring) that resolves to the same two-pixel blob either way. Rocket artillery is
// two gun dots rather than the standard rocket spike for exactly this reason.
function drawGlyph(g, key, cx, cy, hw, hh, colour, width) {
  const w = width || 6;
  g.strokeStyle = colour;
  g.fillStyle = colour;
  g.lineWidth = w;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  const oval = () => {
    g.beginPath();
    g.ellipse(cx, cy, hw * 0.94, hh * 0.86, 0, 0, Math.PI * 2);
    g.stroke();
  };
  const cross = (k) => {
    g.beginPath();
    g.moveTo(cx - hw * k, cy - hh * k); g.lineTo(cx + hw * k, cy + hh * k);
    g.moveTo(cx - hw * k, cy + hh * k); g.lineTo(cx + hw * k, cy - hh * k);
    g.stroke();
  };
  const dot = (r, ox) => {
    g.beginPath();
    g.arc(cx + (ox || 0), cy, r, 0, Math.PI * 2);
    g.fill();
  };
  const chevron = (k, dy) => {
    g.beginPath();
    g.moveTo(cx - hw * k, cy + hh * k * 0.85 + dy);
    g.lineTo(cx, cy - hh * k + dy);
    g.lineTo(cx + hw * k, cy + hh * k * 0.85 + dy);
    g.stroke();
  };

  switch (key) {
    case 'infantry':                                   // crossed diagonals
      cross(1);
      break;
    case 'infantry_at':                                // + anti-tank arrowhead
      cross(1);                                        // nested in the top wedge
      g.lineWidth = w * 0.8;
      chevron(0.36, -hh * 0.42);
      break;
    case 'armor':                                      // oval
      oval();
      break;
    case 'armor_inf':                                  // oval + cross: mech inf
      oval();
      g.lineWidth = w * 0.8;
      cross(0.48);
      break;
    case 'armor_carrier':                              // oval + deck bar
      oval();
      g.lineWidth = w * 0.85;
      g.beginPath();
      g.moveTo(cx - hw * 0.50, cy); g.lineTo(cx + hw * 0.50, cy);
      g.stroke();
      break;
    case 'armor_arty':                                 // oval + gun dot: SP arty
      oval();
      dot(hh * 0.36);
      break;
    case 'armor_rocket':                               // oval + TWO gun dots
      oval();
      dot(hh * 0.26, -hw * 0.40);
      dot(hh * 0.26, hw * 0.40);
      break;
    case 'arty':                                       // dot in circle
      g.beginPath();
      g.arc(cx, cy, hh * 0.94, 0, Math.PI * 2);
      g.stroke();
      dot(hh * 0.40);
      break;
    case 'aa':                                         // arc
      g.beginPath();
      g.moveTo(cx - hw, cy + hh);
      g.quadraticCurveTo(cx, cy - hh * 2.1, cx + hw, cy + hh);
      g.stroke();
      break;
    case 'ew':                                         // zigzag
      g.beginPath();
      g.moveTo(cx - hw, cy + hh * 0.60);
      g.lineTo(cx - hw * 0.5, cy - hh * 0.90);
      g.lineTo(cx, cy + hh * 0.60);
      g.lineTo(cx + hw * 0.5, cy - hh * 0.90);
      g.lineTo(cx + hw, cy + hh * 0.60);
      g.stroke();
      break;
    case 'drone':                                      // chevron
      chevron(1, 0);
      break;
    case 'drone_strike':                               // chevron + warhead dot
      chevron(1, -hh * 0.16);
      dot(hh * 0.30);
      break;
    case 'drone_loiter':                               // chevron + orbit bar
      chevron(1, -hh * 0.22);
      g.lineWidth = w * 0.85;
      g.beginPath();
      g.moveTo(cx - hw * 0.62, cy + hh * 0.86);
      g.lineTo(cx + hw * 0.62, cy + hh * 0.86);
      g.stroke();
      break;
    case 'supply':                                     // bar
      g.beginPath();
      g.moveTo(cx - hw, cy + hh * 0.45);
      g.lineTo(cx + hw, cy + hh * 0.45);
      g.stroke();
      break;
    case 'recon':                                      // single diagonal
      g.beginPath();
      g.moveTo(cx - hw, cy + hh); g.lineTo(cx + hw, cy - hh);
      g.stroke();
      break;
    default:
      dot(hh * 0.5);
  }
}

const NUM_FONT = '"IBM Plex Mono", "SF Mono", Menlo, monospace';

// ROUND-6 FIX 6 — strength is now read on two channels with one ramp, and the
// ramp is the HUD's, not this file's invention: ART_DIRECTION §5 names
// `--friendly #7ED88B` "phosphor green — BLUE data, hp bars", and css/ui.css
// runs `.pips.hp` through friendly → warn → enemy. The bar takes that ramp on
// BOTH sides, because it encodes CONDITION, not affiliation — affiliation is
// carried three other ways (plate tint, spine, silhouette) and does not need a
// fourth. That is also what makes the layer worth looking at across a whole
// frame: at 21 screen pixels you cannot read sixteen numerals, but you can
// absolutely see which six units have gone amber.
//
// The numeral stays neutral ink at full strength — a green numeral on a red
// unit reads as "friendly" to anyone who has played a wargame — and only breaks
// neutrality when there is damage to warn about.
function hpBarColour(hp) {
  if (hp <= 3) return HP_LOW;
  if (hp <= 6) return HP_WARN;
  return HP_GOOD;
}

function hpNumColour(hp) {
  if (hp <= 3) return HP_LOW;
  if (hp <= 6) return HP_WARN;
  return INK;
}

// ---- ROUND-6 FIX 6: affiliation is in the SILHOUETTE ------------------------
// APP-6 puts affiliation in the frame's shape before it puts it in colour —
// friendly is a rounded rectangle, hostile is a diamond — and `ui/hud.js`
// glyphSVG has always drawn it that way in the corner card. The in-world chit
// was the one place that ignored it: both sides got the same rounded black
// rectangle. They now differ in outline, which is the only affiliation channel
// that survives BOTH the chroma fold at 210 u (where the spine desaturates to
// near-grey) and a colour-blind player. Hostile is the diamond's angularity
// rendered as a plate: all four corners cut at 45°, so the badge is an octagon
// against the friendly badge's rounded rectangle, and the two are told apart at
// a glance without reading anything inside them.
function platePath(g, x, y, w, h, hostile) {
  if (!hostile) {
    roundRectPath(g, x, y, w, h, P_RADIUS);
    return;
  }
  const c = P_CHAMFER;
  g.beginPath();
  g.moveTo(x + c, y);
  g.lineTo(x + w - c, y);
  g.lineTo(x + w, y + c);
  g.lineTo(x + w, y + h - c);
  g.lineTo(x + w - c, y + h);
  g.lineTo(x + c, y + h);
  g.lineTo(x, y + h - c);
  g.lineTo(x, y + c);
  g.closePath();
}

// Strength, clamped and NaN-proof. The number is drawn AND drives the pip bar,
// so an undefined hp used to paint the string "NaN" across the cell and light
// zero pips — a counter that is technically rendering and telling the player
// nothing. Every consumer of hp in this function goes through here.
function counterHp(u) {
  const raw = Number(u && u.hp);
  return Number.isFinite(raw) ? clamp(Math.round(raw), 0, 10) : 0;
}

// Redraw a unit's counter. Called only when hp / veterancy / state changes, or
// when the camera crosses a chroma band (ROUND-5 FIX 13) — and only through
// repaintCounter(), which owns the failure path.
//
// `chroma` is the band's desaturation factor. It is applied ONLY to the badge's
// bright register (spine, edge, accent divider, strength number, bar segments,
// veterancy, class glyph); the plate TINT, the plate gradient, the bar's dark
// bed and every dark outline are authored values and stay exactly where they
// are, so desaturating the badge never costs it internal contrast — and, new in
// round 6, affiliation survives the fold even at 210 u, because the tint that
// carries it is exempt.
//
// ---- ROUND-6 FIX 6: what this badge is now ---------------------------------
// One 210×100 plate, read in three passes at the only size it is ever seen at
// (21.6 screen px at 1600×900; see the P_* block):
//
//   ┌───────────────────────────────────┐
//   │▐▌ │   ⬭   │        7        │  ▌ │   spine · glyph · strength · rail
//   │▐▌ │       │                 │  ▌ │
//   ├───────────────────────────────────┤
//   │███████████████████████░░░░░░░░░░░░│   10-segment readiness bar
//   └───────────────────────────────────┘
//
// Nothing in it is drawn in a monospace face except the numeral, nothing in it
// is a rectangle both sides share, and the whole plate — not a 21 %-width chip —
// carries the faction. The three-letter code that made the old badge read as
// debug output is gone; see the GLYPH table for where its information went.
function paintCounter(ctx, unit, chroma) {
  const base = FACTION[unit.faction] || FACTION.blue;
  const K = Number.isFinite(chroma) ? chroma : 1;
  const hostile = unit.faction === 'red';
  const edgeC = toneCss(base.ring, K);
  const inkC = toneCss(INK, K);
  const accentC = toneCss(ACCENT, K);
  const suppC = toneCss(SUPPRESSED, K);
  const hp = counterHp(unit);
  const barC = toneCss(hpBarColour(hp), K);
  const numC = toneCss(hpNumColour(hp), K);
  const vet = clamp(unit.veterancy | 0, 0, 3);
  const spent = !!(unit.moved && unit.fired);
  const noAmmo = unit.ammo === 0 && !!(unit.type && unit.type.ammo > 0);
  const supp = !!unit.suppressed;

  // derived cell geometry — all in canvas px, all from the P_* block
  const CONTENT_B = P_Y + P_H - P_BAR - P_GAP;   // content zone bottom, 83
  const CX0 = P_X + P_SPINE;                     // content left,        23
  const CX1 = P_X + P_W - P_RAIL;                // content right,      203
  const CY = (P_Y + CONTENT_B) * 0.5;            // content centreline,  44
  const BAR_Y = P_Y + P_H - P_BAR;               // bar top,             85

  ctx.clearRect(0, 0, CHIP_W, CHIP_H);
  ctx.globalAlpha = spent ? 0.60 : 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // ---- the plate --------------------------------------------------------
  // A drop shadow, once, at bake time. The old badge had no separation from the
  // ground at all — it was a flat dark rectangle sitting ON a sunlit wheat field
  // with nothing between the two values, which is most of why it read as an
  // overlay rather than as an object in the picture. The canvas margins (7 px of
  // side, 5 of top, 11 of foot) are sized so blur 6 at offset +3 cannot reach a
  // texture edge and get smeared around the wrap by the mip chain.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;
  platePath(ctx, P_X, P_Y, P_W, P_H, hostile);
  ctx.fillStyle = base.plate;
  ctx.fill();
  ctx.restore();

  ctx.save();
  platePath(ctx, P_X, P_Y, P_W, P_H, hostile);
  ctx.clip();

  // body gradient — the bevel the critique asked for. Light off the top face,
  // the plate's own colour through the middle, a shadowed foot.
  const pg = ctx.createLinearGradient(0, P_Y, 0, P_Y + P_H);
  pg.addColorStop(0, 'rgba(255,255,255,0.09)');
  pg.addColorStop(0.42, 'rgba(255,255,255,0)');
  pg.addColorStop(1, 'rgba(0,0,0,0.26)');
  ctx.fillStyle = pg;
  ctx.fillRect(P_X, P_Y, P_W, P_H);
  // and a second, deeper wash under the bar so the plate has a foot
  ctx.fillStyle = base.plateB;
  ctx.fillRect(P_X, BAR_Y - P_GAP, P_W, P_BAR + P_GAP);

  // ---- faction spine ----------------------------------------------------
  // The old chip was 42 of 200 canvas px — 8.7 screen px of affiliation. The
  // spine is narrower (3.0 screen px) and carries LESS of the signal, because
  // the plate behind it now carries most of it; what the spine adds is a
  // saturated edge that survives being drawn over sunlit stubble, where a tint
  // at 0.85 alpha does not.
  ctx.fillStyle = edgeC;
  ctx.fillRect(P_X, P_Y, P_SPINE, CONTENT_B - P_Y);
  const sg = ctx.createLinearGradient(P_X, P_Y, P_X, CONTENT_B);
  sg.addColorStop(0, 'rgba(255,255,255,0.10)');
  sg.addColorStop(0.5, 'rgba(255,255,255,0)');
  sg.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = sg;
  ctx.fillRect(P_X, P_Y, P_SPINE, CONTENT_B - P_Y);

  // veterancy: amber rank stripes on the spine, read from the bottom up. They
  // are 1.9 screen px wide and 1.7 tall, so at working range the honest read is
  // "amber on the shoulder = veteran" and the COUNT is the reward for leaning
  // in — which is the right way round for a badge this size, and is what the old
  // 2.3 px chevrons under the type code failed at in both directions.
  if (vet > 0) {
    ctx.fillStyle = accentC;
    for (let i = 0; i < vet; i++) {
      ctx.fillRect(P_X + 2, CONTENT_B - 14 - i * 15, P_SPINE - 4, 11);
    }
  }

  // ---- status rail ------------------------------------------------------
  // Mirrors the spine on the right edge and is empty unless there is something
  // to say. Out of ammo is the one unit state that changes what the player can
  // DO with the unit this turn, so it gets an edge of its own rather than the
  // old 2 px amber ring that nobody could see.
  if (noAmmo) {
    ctx.fillStyle = accentC;
    ctx.fillRect(CX1, P_Y, P_RAIL, CONTENT_B - P_Y);
    const rg = ctx.createLinearGradient(CX1, P_Y, CX1, CONTENT_B);
    rg.addColorStop(0, 'rgba(255,255,255,0.10)');
    rg.addColorStop(1, 'rgba(0,0,0,0.20)');
    ctx.fillStyle = rg;
    ctx.fillRect(CX1, P_Y, P_RAIL, CONTENT_B - P_Y);
  }

  // ---- class glyph ------------------------------------------------------
  // Suppression tints the whole glyph cell rather than adding a pip: a wash
  // across 15 × 15 screen px is visible at working range; a 5.6 px dot on a
  // 200 px canvas never was.
  if (supp) {
    ctx.fillStyle = 'rgba(154,184,255,0.20)';
    ctx.fillRect(CX0, P_Y, P_DIV - CX0, CONTENT_B - P_Y);
  }
  // A dark backing pass under the glyph so it holds its shape over the plate's
  // own gradient, then the glyph. Same trick the numeral uses.
  const gx = (CX0 + P_DIV) * 0.5;
  const gkey = glyphKey(unit);
  drawGlyph(ctx, gkey, gx, CY, 30, 26, 'rgba(6,9,7,0.85)', 9.5);
  drawGlyph(ctx, gkey, gx, CY, 30, 26, supp ? suppC : inkC, 5.2);

  // ---- cell divider -----------------------------------------------------
  // Amber, not black. This is the single most visible place the HUD's console
  // language reaches the world: a warm structural hairline splitting the plate,
  // exactly the register css/ui.css uses `--accent` in.
  // 5 canvas px, not the 3 a hairline wants: 5 is 0.93 screen px, and anything
  // under a whole pixel is handed to the mip chain as a grey suggestion.
  ctx.fillStyle = accentC;
  ctx.globalAlpha *= 0.60;
  ctx.fillRect(P_DIV - 2.5, P_Y + 9, 5, CONTENT_B - P_Y - 18);
  ctx.globalAlpha = spent ? 0.60 : 1;

  // ---- strength numeral -------------------------------------------------
  // IBM Plex Mono ships 400/500 only (see index.html), so the weight is built
  // rather than requested: dark outline for contrast against wheat, then fill,
  // then a hairline stroke in the fill colour to thicken the stems.
  // The fit check is not decoration — a fallback face with a wider advance
  // (Menlo is 0.602 em, but a user-installed "IBM Plex Mono" variant need not
  // be) would otherwise push "10" into the status rail.
  const hpTxt = String(hp);
  const numCx = (P_DIV + CX1) * 0.5;
  const cellW = CX1 - P_DIV - 12;
  let numPx = P_NUM_PX;
  ctx.font = `500 ${numPx}px ${NUM_FONT}`;
  const wNum = ctx.measureText(hpTxt).width;
  if (wNum > cellW && wNum > 0) {
    numPx = Math.max(38, Math.floor(numPx * (cellW / wNum)));
    ctx.font = `500 ${numPx}px ${NUM_FONT}`;
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(6,9,7,0.92)';
  ctx.strokeText(hpTxt, numCx, CY);
  ctx.fillStyle = numC;
  ctx.fillText(hpTxt, numCx, CY);
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = numC;
  ctx.strokeText(hpTxt, numCx, CY);

  // ---- readiness bar ----------------------------------------------------
  // Ten segments in the HUD's own hp ramp, on a dark bed, built INTO the plate's
  // foot instead of hanging under it as a second slab. 3.4 × 2.6 screen px per
  // segment: individually small, collectively a bar you read as a length.
  //
  // The segments are drawn at 0.75, and that number is a measurement, not a
  // taste call. Rendered at true screen size over ripe wheat (`#C9A85C`, sRGB
  // luma 0.6648) and box-filtered 8×8 the way the mip chain filters it, a solid
  // `--friendly` segment measures 0.660 — level with the field it is drawn on.
  // An annotation layer that matches the value of the world behind it does not
  // annotate, it glows: the first cut of this bar put 27.8 % of the badge above
  // 0.60 luma against the shipped badge's 8.1 %. At 0.75 over the dark bed the
  // segment lands at ~0.52, which is unmistakably green, is still the second
  // strongest read on the plate, and is below the ground — so the badge's
  // brightest element stays the numeral, where it belongs.
  ctx.fillStyle = 'rgba(6,9,7,0.55)';
  ctx.fillRect(P_X, BAR_Y, P_W, P_BAR);
  const segW = (P_W - 6) / 10;
  const barA = ctx.globalAlpha;
  for (let i = 0; i < 10; i++) {
    ctx.globalAlpha = i < hp ? barA * 0.75 : barA;
    ctx.fillStyle = i < hp ? barC : 'rgba(216,220,208,0.10)';
    ctx.fillRect(P_X + 3 + i * segW + 1, BAR_Y + 3, segW - 2, P_BAR - 6);
  }
  ctx.globalAlpha = barA;
  // the rule that separates the bar from the content zone
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(P_X, BAR_Y - P_GAP, P_W, P_GAP);

  // ---- inner top highlight ----------------------------------------------
  ctx.fillStyle = 'rgba(255,255,255,0.09)';
  ctx.fillRect(P_X + P_RADIUS, P_Y + 2, P_W - P_RADIUS * 2, 2.5);
  ctx.restore();

  // ---- edge -------------------------------------------------------------
  // Drawn last and outside the clip so it is a full-weight stroke rather than
  // the half-weight one a clipped path gives you.
  ctx.lineJoin = 'round';
  platePath(ctx, P_X, P_Y, P_W, P_H, hostile);
  ctx.strokeStyle = edgeC;
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------- module

export function initMarkers(engine, Game) {
  if (!engine || !engine.scene || !Game) return { dispose() {} };

  // ---- faction rings (CRITIQUE FIX 3) -----------------------------------
  const geo = new THREE.PlaneGeometry(RING_PLANE, RING_PLANE);
  geo.rotateX(-Math.PI / 2);

  const texes = { blue: makeMarkerTexture('blue'), red: makeMarkerTexture('red') };
  // depthTest true + a deliberately SMALL polygon offset. At y 0.18 the ring is
  // already ~400× the depth resolution clear of the ground, so the offset is not
  // fighting z-fighting — it buys the ring roughly 0.2 world units of headroom on
  // a slope, which covers ~11 % gradient across its 3.2 u radius. Any larger and
  // it starts punching up through the bottom of a track run, which is the same
  // bug in the other direction: in C04 the ring drew over the infantry squad and
  // no amount of depth testing could save it, because it genuinely floated above
  // a prone rifleman's back at the old y 0.42.
  const ringMat = (faction) => new THREE.MeshBasicMaterial({
    map: texes[faction],
    transparent: true,
    opacity: 0.92,
    // ROUND-4 FIX 10 — the width knob. Non-zero at construction so USE_ALPHATEST
    // is compiled in once; the frame loop only ever changes its VALUE, which is
    // a uniform write. Always `opacity × profile threshold` (see RING_STOPS).
    alphaTest: 0.18,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -6,
  });
  const mats = { blue: ringMat('blue'), red: ringMat('red') };

  // ---- ROUND-3 FIX 17: conform the rings to the ground -------------------
  // A ring is a flat quad at y 0.18 with ~0.2 u of polygon-offset headroom. On
  // the plate that shipped in round 1 that was invisibly correct; on the 30.97 u
  // of relief the phase-2 world pass shipped it is not — across the ring's
  // 6.4 u span a 10 % grade is 0.64 u, so the downhill half floats and the
  // uphill half is depth-clipped away, which is precisely the "floating, not
  // clipped to the ground" the critique filed.
  //
  // The ground under a 6.4 u disc is planar to well within a pixel, so the fix
  // is a TILT, not a conforming mesh: solve the terrain gradient at the unit's
  // own position and rotate the quad onto that normal. Two height samples per
  // axis, taken on the 0.12 s marker sync rather than per frame, against a
  // per-vertex resample of a subdivided ring every frame for 30 units.
  //
  // The parent (`unit.mesh`) carries YAW ONLY — units.js sets rotation.y and
  // nothing else touches x or z — so the world normal is rotated into the
  // parent's frame with the inverse-Y rotation rather than a full matrix solve.
  const terrainRef = (Game.deps && Game.deps.terrain) || null;
  const heightAt = (terrainRef && typeof terrainRef.heightAt === 'function')
    ? terrainRef.heightAt : null;
  const _up = new THREE.Vector3(0, 1, 0);
  const _norm = new THREE.Vector3();

  // Always writes the quaternion, including on the no-terrain and NaN paths.
  // The selection ring composes its spin ON TOP of this every frame, so an
  // early return that left the quaternion alone would turn `rotateY` from an
  // absolute angle into an accumulator and the ring would spin up without
  // bound. Identity is the correct answer for "flat, or unknown".
  function conformRing(mesh, x, z, yaw) {
    if (!mesh) return;
    if (!heightAt) { mesh.quaternion.identity(); return; }
    const e = RING_CONFORM_E;
    const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) {
      mesh.quaternion.identity();
      return;
    }
    // world normal ∝ (−dh/dx, 1, −dh/dz); world → local is a −yaw rotation:
    //   l.x = w.x·cos y − w.z·sin y     l.z = w.x·sin y + w.z·cos y
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const nx = -dx, nz = -dz;
    _norm.set(nx * c - nz * s, 1, nx * s + nz * c).normalize();
    mesh.quaternion.setFromUnitVectors(_up, _norm);
  }

  const selTex = makeSelectTexture();
  const selMat = new THREE.MeshBasicMaterial({
    map: selTex,
    transparent: true,
    opacity: 0.9,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -6,
  });
  const selGeo = new THREE.PlaneGeometry(SELECT_PLANE, SELECT_PLANE);
  selGeo.rotateX(-Math.PI / 2);
  const selRing = new THREE.Mesh(selGeo, selMat);
  selRing.name = 'selection-ring';
  selRing.renderOrder = 3;
  selRing.visible = false;
  selRing.userData.unit = null;
  engine.scene.add(selRing);

  const attached = new WeakSet();
  // { unit, sprite, ctx, tex, mat, sig, doff, ready, dead, fails }
  const counters = [];

  // ROUND-5 FIX 13 — the chroma band the counter canvases are currently baked
  // in. It is part of the signature, so a band change is repainted by exactly
  // the machinery an hp change already goes through: no second code path, no
  // extra bookkeeping, and the failure path (a canvas that refuses to paint)
  // stays the one place it has always been. Seeded from the boot camera so the
  // first bake is already right rather than flashing 0.12 s of full chroma.
  let toneBand = 0;
  try {
    if (engine.camera) toneBand = rawToneBand(camGroundDistance(engine.camera));
  } catch (err) { /* band 0 is a safe start; screenPass corrects it in a frame */ }

  function counterSig(u) {
    return `${counterHp(u)}|${clamp(u.veterancy | 0, 0, 3)}|${u.suppressed ? 1 : 0}` +
      `|${u.ammo === 0 ? 1 : 0}|${(u.moved && u.fired) ? 1 : 0}|${toneBand}`;
  }

  // PHASE-2 FIX — a counter that cannot be drawn HIDES; it never ships a
  // half-painted slab. The critic caught the old behaviour in
  // `09-fpv-water-overlay-artifacts.png`: a faction-coloured rectangle with no
  // glyph, no code and no strength number, which is strictly worse than no
  // counter at all — it still claims screen space, it still pushes its
  // neighbours around in the de-clutter pass, and it still reads as a unit.
  //
  // Three things can go wrong and they now all end in the same place. The 2D
  // context can be refused outright (a long session can exhaust the browser's
  // canvas budget); a paint can throw part-way through, leaving exactly that
  // rectangle-with-no-text on the canvas; and either can happen on the very
  // first bake, before there is anything good to fall back on. So: the canvas
  // is cleared, `ready` stays false, and screenPass() simply never shows the
  // sprite. The signature is deliberately NOT advanced on a failure, so the
  // next 0.12 s sync retries — a transient (a font that has not resolved, a
  // hostile text metric) heals itself. After three consecutive failures the
  // counter is retired for good rather than burning eight exceptions a second
  // for the rest of the match.
  const COUNTER_MAX_FAILS = 3;

  function retireCounter(c) {
    c.dead = true;
    c.ready = false;
    c.sprite.visible = false;
    if (c.tick) c.tick.visible = false;
  }

  function repaintCounter(c) {
    if (c.dead) return false;
    if (!c.ctx) { retireCounter(c); return false; }
    try {
      paintCounter(c.ctx, c.unit, TONE_BANDS[toneBand].chroma);
    } catch (err) {
      c.fails++;
      c.ready = false;
      c.sprite.visible = false;
      if (c.tick) c.tick.visible = false;
      try {
        c.ctx.clearRect(0, 0, CHIP_W, CHIP_H);   // never ship a partial bake
        c.tex.needsUpdate = true;
      } catch (e2) { retireCounter(c); return false; }
      if (c.fails >= COUNTER_MAX_FAILS) retireCounter(c);
      return false;
    }
    c.fails = 0;
    c.tex.needsUpdate = true;
    c.ready = true;
    return true;
  }

  // ---- counters (CRITIQUE FIX 2) ----------------------------------------
  // ROUND-3 FIX 15 — two tick TEXTURES for the whole map (one per faction); the
  // material is per-unit because its opacity has to track that unit's own
  // counter fade across the 30 → 40 u band, and a tick that outlives the badge
  // it points at is a line to nowhere. A SpriteMaterial is ~200 bytes.
  const tickTexes = { blue: makeTickTexture('blue'), red: makeTickTexture('red') };
  const tickMat = (faction) => new THREE.SpriteMaterial({
    map: tickTexes[faction] || tickTexes.blue,
    transparent: true,
    opacity: TICK_ALPHA,
    depthTest: false,          // it belongs to the badge layer, not the world
    depthWrite: false,
    toneMapped: false,
    sizeAttenuation: false,
    fog: false,
  });

  function attachCounter(unit) {
    const c = document.createElement('canvas');
    c.width = CHIP_W;
    c.height = CHIP_H;
    let ctx = null;
    try { ctx = c.getContext('2d'); } catch (err) { ctx = null; }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    // The counter is drawn at a CONSTANT screen size, i.e. a constant ~2.6×
    // minification of this canvas — so mipmaps stay on (they are the difference
    // between crisp stems and crawling stair-steps on every camera nudge) and
    // anisotropy is maxed, because the sprite is never seen head-on.
    tex.anisotropy = 8;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,          // the order of battle is never occluded
      depthWrite: false,
      toneMapped: false,
      sizeAttenuation: false,    // constant screen size at any zoom
      fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.name = 'unit-counter';
    // ROUND-2 FIX 7 — the badge hangs BELOW the unit's ground contact point.
    // The anchor is the model's own origin (units.js parks every root on the
    // terrain, so local y ≈ 0 IS the contact point) and `center.y = 1` puts the
    // whole sprite under it: three.js builds the quad as
    //     aligned = (corner − (center − 0.5)) · scale
    // so center.y = 1 maps the corners to [−scale, 0], i.e. the counter's TOP
    // edge sits on the anchor — exactly the "offset −0.5 × counter height"
    // the critique asked for, measured from a centred badge. The extra
    // COUNTER_GAP_PX (and any de-clutter push) is added per frame in
    // screenPass(), because it is expressed in pixels and the sprite's own
    // height in pixels is only known there.
    sprite.position.y = 0.05;
    sprite.center.set(0.5, COUNTER_CENTER_Y);
    sprite.renderOrder = 12;
    // Nothing is shown until a bake has actually succeeded (see repaintCounter).
    sprite.visible = false;
    unit.mesh.add(sprite);
    // The leader tick shares the badge's anchor exactly (same position, same
    // center.y = 1), so it hangs straight down from the unit's ground contact
    // point and its LENGTH — set per frame in screenPass — is the gap the
    // de-clutter pass opened. It draws under the badge, never over it.
    const tmat = tickMat(unit.faction);
    const tick = new THREE.Sprite(tmat);
    tick.name = 'counter-tick';
    tick.position.y = 0.05;
    tick.center.set(0.5, 1);
    tick.renderOrder = 11;
    tick.visible = false;
    unit.mesh.add(tick);
    const rec = {
      unit, sprite, tick, tmat, ctx, tex, mat, sig: '', doff: 0, dxoff: 0,
      ready: false, dead: false, fails: 0, fade: 1,
    };
    counters.push(rec);
    // Bake immediately rather than waiting for the next 0.12 s sync: a unit
    // deployed mid-turn would otherwise carry an empty badge for up to seven
    // frames, and the first thing the player does with a new unit is look at it.
    if (repaintCounter(rec)) rec.sig = counterSig(unit);
    return rec;
  }

  function attach(unit) {
    if (!unit || !unit.mesh || attached.has(unit)) return;
    const mat = mats[unit.faction] || mats.blue;
    const m = new THREE.Mesh(geo, mat);
    m.name = 'unit-marker';
    // The ring hugs the ground now (0.18, was 0.42). A prone rifleman's back is
    // higher than that, which is the point: at 0.42 the ring floated over the
    // squad and depth testing could never save it.
    m.position.y = RING_Y;
    m.renderOrder = 3;
    m.castShadow = false;
    m.receiveShadow = false;
    unit.mesh.add(m);
    unit.mesh.userData.marker = m;
    const rec = attachCounter(unit);
    unit.mesh.userData.counter = rec.sprite;
    attached.add(unit);
  }

  function sync() {
    const list = Game.units || [];
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (!u || !u.mesh) continue;
      if (!attached.has(u)) attach(u);
      const m = u.mesh.userData.marker;
      if (!m) continue;
      // a dead unit's wreck keeps no marker; a spent/acted unit dims
      if (!u.alive) { m.visible = false; continue; }
      m.visible = true;
      const spent = u.moved && u.fired;
      m.material = mats[u.faction] || mats.blue;
      m.scale.setScalar(spent ? 0.88 : 1);
      // ROUND-3 FIX 17 — lay it on the ground it is standing on. 0.12 s of lag
      // behind a moving hull is one frame of a 0.4 s move tween at the outside
      // and is not visible; a per-frame solve for thirty units would be.
      conformRing(m, u.mesh.position.x, u.mesh.position.z, u.mesh.rotation.y);
    }
    // repaint any counter whose data changed
    for (let i = counters.length - 1; i >= 0; i--) {
      const c = counters[i];
      const u = c.unit;
      if (!u.alive) {
        c.sprite.visible = false;
        c.tick.visible = false;
        continue;
      }
      // `!c.ready` re-arms a counter whose last bake failed, so a transient
      // (an unresolved font face, a text metric that threw once) heals on the
      // next sync instead of leaving the unit unlabelled for the whole match.
      const sig = counterSig(u);
      if (sig !== c.sig || !c.ready) {
        if (repaintCounter(c)) c.sig = sig;
        else c.sig = '';
      }
    }
  }

  // CRITIQUE fix 6 — the selection ring's WANTED state and its VISIBLE state are
  // now two different things. `08-fpv-overlay-leak-topdown.png` is a first-person
  // drone frame filled edge to edge with the launcher's own selection ring: the
  // ring cannot simply be switched off during a dive, because the unit is still
  // selected and the ring has to be back the instant the feed cuts. So the
  // handlers write intent here and the frame loop decides what is drawn.
  let selWanted = false;
  Game.on('unitDeployed', (u) => attach(u));
  Game.on('select', (u) => {
    if (u && u.mesh && u.alive) {
      selWanted = true;
      selRing.position.copy(u.mesh.position);
      selRing.position.y += RING_Y + 0.02;
      selRing.userData.unit = u;
    } else {
      selWanted = false;
      selRing.visible = false;
      selRing.userData.unit = null;
    }
  });
  Game.on('deselect', () => {
    selWanted = false;
    selRing.visible = false;
    selRing.userData.unit = null;
  });
  Game.on('unitKilled', (u) => {
    if (selRing.userData.unit === u) {
      selWanted = false;
      selRing.visible = false;
      selRing.userData.unit = null;
    }
  });

  // ====================================================================
  // SCREEN-SPACE LAYOUT — round-2 critique fixes 8 and 9
  // ====================================================================
  // Counter sizing. With sizeAttenuation off, a sprite's scale is measured
  // against the view frustum: the renderer multiplies it by -mvPosition.z before
  // projection, so the on-screen height in pixels is
  //     px = scale.y · viewportH / (2·tan(fov/2))
  // — constant at every camera distance, which is precisely the "same badge at
  // every zoom" that makes a PC2 screenshot readable. Recomputed each frame
  // because the dronecam retunes the fov and the window can be resized.
  const _sz = new THREE.Vector2();
  const _wp = new THREE.Vector3();
  const _fwd = new THREE.Vector3();

  // Reused every frame — this pass must not allocate, it runs at 60 Hz.
  const items = [];            // de-clutter candidates, all three layers
  const projUnits = [];        // flat [unit, screenX, screenY, …]
  const floatRecs = new Map(); // vfx label element -> our bookkeeping
  const labelRecs = new Map(); // hud label element  -> our bookkeeping
  let floatRoot = null;
  let labelRoot = null;
  let domTouched = false;      // we have inline offsets/visibility to restore

  // Both DOM writers anchor bottom-centre and put the two pixel numbers first:
  //   vfx.js   translate(Xpx,Ypx) translate(-50%,-100%)
  //   hud.js   translate3d(Xpx, Ypx, 0) translate(-50%, -100%)
  // hud.js additionally publishes `el.__ssBox = {x, y, w, h}`, which is used in
  // preference to parsing (see INTEGRATION_NOTES, HUD round 3).
  const XYPX = /(-?\d+(?:\.\d+)?)px/g;

  function ensureRoots() {
    if (!floatRoot || !floatRoot.isConnected) {
      floatRoot = document.getElementById(FLOAT_ROOT_ID);
    }
    if (!labelRoot || !labelRoot.isConnected) {
      labelRoot = document.getElementById(LABEL_ROOT_ID);
    }
  }

  // Greedy separation. Highest priority first, then top-down; each item is only
  // ever pushed away from items already placed, in ITS OWN yield direction —
  // counters and floats hang below their anchor so they yield downwards, world
  // labels are banners above their anchor with a stem, so they yield upwards
  // and keep pointing at the place they name. Overlap + 2 px, three passes,
  // exactly as the critique specified.
  // The 2 px the critique asked for is enforced on BOTH axes: two badges that
  // stop 1 px apart horizontally are "touching" in exactly the sense the frame
  // was filed under, so a sub-separation horizontal gap counts as an overlap and
  // is resolved like any other.
  function boxHit(it, p) {
    if (it.x1 + DECLUTTER_SEP <= p.x0 || it.x0 >= p.x1 + DECLUTTER_SEP) return false;
    if (it.y1 <= p.y0 || it.y0 >= p.y1) return false;
    return true;
  }

  // Greedy vertical separation for item `i` against everything already placed,
  // from wherever its box currently sits. Returns the priority of whatever is
  // still standing on it (0 = clear), so the caller can decide what to do next.
  function solveVertical(it, i) {
    for (let pass = 0; pass < DECLUTTER_ITERS; pass++) {
      let push = 0;
      for (let j = 0; j < i; j++) {
        const p = items[j];
        if (!boxHit(it, p)) continue;
        const need = it.dir > 0
          ? (p.y1 - it.y0 + DECLUTTER_SEP)
          : (it.y1 - p.y0 + DECLUTTER_SEP);
        if (need > push) push = need;
      }
      if (push <= 0) break;
      const room = it.max - Math.abs(it.offs);
      if (room <= 0) break;
      if (push > room) push = room;
      const d = it.dir * push;
      it.offs += d;
      it.y0 += d;
      it.y1 += d;
    }
    let blockedBy = 0;
    for (let j = 0; j < i; j++) {
      const p = items[j];
      if (!boxHit(it, p)) continue;
      if (p.prio > blockedBy) blockedBy = p.prio;
    }
    return blockedBy;
  }

  function resolveItems() {
    // x0 is a tiebreak, not a preference: two annotations at the same screen Y
    // must not swap places between frames, or the eased offsets wobble.
    items.sort((a, b) => (b.prio - a.prio) || (a.y0 - b.y0) || (a.x0 - b.x0));
    for (let i = 1; i < items.length; i++) {
      const it = items[i];
      let blockedBy = solveVertical(it, i);
      // ---- ROUND-4 FIX 11: out of column? take a step sideways -------------
      // Only counters carry a lateral budget (`maxX`); a damage float is a
      // 1.15 s event that must stay over the hull it belongs to, and a place
      // name is anchored to a place. Each candidate is evaluated from the
      // badge's own resting height, not from wherever the vertical pass pushed
      // it, so a lateral slot competes on its merits instead of inheriting a
      // 120 px push it no longer needs.
      if (blockedBy && it.maxX > 0) {
        const homeY0 = it.y0 - it.offs, homeY1 = it.y1 - it.offs;
        const homeX0 = it.x0, homeX1 = it.x1;
        const fbOffs = it.offs, fbBlocked = blockedBy;
        for (let s = 0; s < LAT_TRIES.length * 2 && blockedBy; s++) {
          let dx = LAT_TRIES[s >> 1] * it.pxW * ((s & 1) ? -it.side : it.side);
          if (dx > it.maxX) dx = it.maxX;
          else if (dx < -it.maxX) dx = -it.maxX;
          it.xoff = dx;
          it.x0 = homeX0 + dx; it.x1 = homeX1 + dx;
          it.y0 = homeY0; it.y1 = homeY1; it.offs = 0;
          blockedBy = solveVertical(it, i);
        }
        if (blockedBy) {                       // nothing cleared — keep round 3's
          it.xoff = 0;
          it.x0 = homeX0; it.x1 = homeX1;
          it.y0 = homeY0 + fbOffs; it.y1 = homeY1 + fbOffs;
          it.offs = fbOffs;
          blockedBy = fbBlocked;
        }
      }
      // Did it get clear? A place name that CANNOT clear must not just sit
      // there overprinted — it is the lowest-priority layer, so it yields
      // contrast as well as position. The response is graded by WHO is standing
      // on it, because the two cases have opposite lifetimes:
      //   · a damage float is a 1.15 s event, so the name gets out of its way
      //     completely (`blockedBy = PRIO_FLOAT`) and comes back — the critique
      //     asked that SUPPRESSED never land on HLYBOKE, and this is the only
      //     answer that is literally true rather than "true at 22 % opacity";
      //   · a unit counter can stand on that pixel for the rest of the match,
      //     and blanking a village name for ten turns loses real information,
      //     so the name steps back to a ghost and stays readable.
      // Either way the .wl transition in css/ui.css makes it a 170 ms fade.
      // (`blockedBy` is whatever survived the solve above — the verdict is now
      // returned by solveVertical rather than recomputed here, so the lateral
      // pass and the contrast fallback cannot disagree about who is blocked.)
      it.blocked = blockedBy > 0;
      it.blockedBy = blockedBy;
    }
  }

  // Damage floats. fx/vfx.js owns the elements, their text, their transform and
  // their life; we own exactly two properties it never writes — `top` (the
  // de-clutter offset) and `visibility` (the watchdog) — and we hand both back
  // the moment the pool slot goes idle or the module is disposed.
  function collectFloats(sdt) {
    if (!floatRoot) return;
    const kids = floatRoot.children;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      let rec = floatRecs.get(el);
      if (!rec) {
        rec = {
          live: false, text: '', w: 0, h: 0, ax: 0, ay: 0, op: -1,
          tf: '', opStr: '',
          still: 0, age: 0, owner: null, hidden: false, offs: 0, applied: 0,
        };
        floatRecs.set(el, rec);
      }
      if (el.style.display === 'none') {          // idle pool slot — hands off
        if (rec.hidden) { el.style.visibility = ''; rec.hidden = false; }
        if (rec.applied !== 0) { el.style.top = '0px'; rec.applied = 0; }
        rec.offs = 0;
        rec.live = false; rec.owner = null; rec.still = 0; rec.age = 0;
        rec.op = -1;
        rec.tf = ''; rec.opStr = '';
        continue;
      }
      const tf = el.style.transform || '';
      XYPX.lastIndex = 0;
      const mx = XYPX.exec(tf);
      const my = mx ? XYPX.exec(tf) : null;
      if (!my) { rec.live = false; continue; }
      const ax = parseFloat(mx[1]);
      const ay = parseFloat(my[1]);
      const op = parseFloat(el.style.opacity);
      const text = el.textContent;
      if (!Number.isFinite(ax) || !Number.isFinite(ay)) { rec.live = false; continue; }

      // A pooled slot being recycled for a NEW float: it was idle, or the text
      // changed, or the opacity jumped back up, or the anchor jumped DOWN (a
      // live float only ever rises). Any of those re-arms the watchdog.
      const opUp = Number.isFinite(op) && op > rec.op + 0.02;
      const fresh = !rec.live || text !== rec.text || opUp || (ay - rec.ay) > 12;
      // Stillness is EXACT inequality of the three properties vfx.js rewrites on
      // every single frame of a float's life, not a pixel threshold. A float
      // rises 42 px over 1.15 s: 0.61 px per frame at 60 Hz but 0.15 px at
      // 240 Hz, so any threshold big enough to ignore rounding noise is also big
      // enough to call a perfectly healthy float "still" on a fast display and
      // expire it early. String comparison is rate-independent and is exactly
      // the rule this watchdog is documented to enforce.
      const opStr = el.style.opacity;
      const changed = tf !== rec.tf || text !== rec.text || opStr !== rec.opStr;

      if (text !== rec.text || !(rec.w > 0)) {
        const r = el.getBoundingClientRect();     // size only; `top` never changes it
        rec.w = r.width || 60;
        rec.h = r.height || 18;
      }
      rec.still = (fresh || changed) ? 0 : rec.still + sdt;
      rec.age = fresh ? 0 : rec.age + sdt;
      rec.text = text; rec.ax = ax; rec.ay = ay; rec.op = op; rec.live = true;
      rec.tf = tf; rec.opStr = opStr;

      if (fresh) {
        // Attribute an owner: the nearest on-screen unit under the float.
        // vfx.js spawns it 2.2 world units above the unit, so on screen it sits
        // a little way ABOVE the hull's ground point and then rises 42 px.
        // Ground and infrastructure strikes legitimately have no owner — they
        // simply fall through to the stall watchdog.
        rec.owner = null;
        let best = 1e9;
        for (let j = 0; j < projUnits.length; j += 3) {
          const ux = projUnits[j + 1];
          const uy = projUnits[j + 2];
          const ddx = Math.abs(ux - ax);
          const ddy = uy - ay;                    // > 0 when the float is above
          if (ddx > 70 || ddy < -40 || ddy > 170) continue;
          const score = ddx * 1.6 + Math.abs(ddy - 55);
          if (score < best) { best = score; rec.owner = projUnits[j]; }
        }
        // Only guard floats that were born over a LIVE, VISIBLE unit — the
        // DESTROYED float is spawned on a corpse and must be allowed to play.
        const o = rec.owner;
        if (!(o && o.alive && o.mesh && o.mesh.visible !== false)) rec.owner = null;
      }

      // ---- FIX 9: a float must never outlive its context -----------------
      const o = rec.owner;
      const orphan = !!o && (!o.alive || !o.mesh || o.mesh.visible === false);
      const kill = orphan || rec.still > FLOAT_STALL_S || rec.age > FLOAT_MAX_S;
      if (kill !== rec.hidden) {
        rec.hidden = kill;
        el.style.visibility = kill ? 'hidden' : '';
        domTouched = true;
      }
      if (kill) {
        rec.offs = 0;
        if (rec.applied !== 0) { el.style.top = '0px'; rec.applied = 0; }
        continue;                                  // reserves no screen space
      }

      items.push({
        // `snap`: a float on its first frame takes its de-cluttered slot
        // immediately instead of easing into it. The pool recycles elements, so
        // easing would slide the new number in from wherever the previous
        // tenant of that slot had been pushed to — a -7 that visibly drifts
        // into place reads as a bug, and a damage number is a 1.15 s event that
        // cannot afford a quarter of a second of travel.
        kind: 1, el, rec, dir: 1, offs: 0, prio: PRIO_FLOAT, max: DECLUTTER_MAX,
        snap: fresh,
        x0: ax - rec.w * 0.5, x1: ax + rec.w * 0.5, y0: ay - rec.h, y1: ay,
      });
    }
  }

  // World place labels. ui/hud.js owns them and already de-clutters them
  // against EACH OTHER by rank; what it cannot see is the counter layer, which
  // is why RAIL BRIDGE · EAST EXIT kept getting stamped over.
  function collectLabels() {
    if (!labelRoot) return;
    const gateStr = labelRoot.style.opacity;
    const gate = gateStr === '' ? 1 : parseFloat(gateStr);
    if (!(gate > 0.02)) {
      for (const [el, rec] of labelRecs) {
        rec.offs = 0;
        if (rec.applied !== 0) { el.style.top = '0px'; rec.applied = 0; }
        if (rec.dim) { el.style.opacity = ''; rec.dim = ''; }
      }
      return;
    }
    const kids = labelRoot.children;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      let rec = labelRecs.get(el);
      if (!rec) {
        rec = { w: 0, h: 0, text: '', offs: 0, applied: 0, dim: '' };
        labelRecs.set(el, rec);
      }
      if (el.classList.contains('off')) {
        rec.offs = 0;
        if (rec.applied !== 0) { el.style.top = '0px'; rec.applied = 0; }
        if (rec.dim) { el.style.opacity = ''; rec.dim = ''; }
        continue;
      }
      let ax = NaN, ay = NaN;
      const pub = el.__ssBox;
      if (pub && Number.isFinite(pub.x) && Number.isFinite(pub.y)) {
        ax = pub.x; ay = pub.y;
        if (pub.w > 0) { rec.w = pub.w; rec.h = pub.h; }
      } else {
        const tf = el.style.transform || '';
        XYPX.lastIndex = 0;
        const mx = XYPX.exec(tf);
        const my = mx ? XYPX.exec(tf) : null;
        if (!my) continue;
        ax = parseFloat(mx[1]);
        ay = parseFloat(my[1]);
      }
      if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
      if (!(rec.w > 0) || rec.text !== el.textContent) {
        const r = el.getBoundingClientRect();
        rec.text = el.textContent;
        rec.w = r.width || 110;
        rec.h = r.height || 34;
      }
      items.push({
        // 30 px, not 56: a banner is already ~52 px above its hex and ui/hud.js
        // culls anchors above y = 58, so a bigger lift would post the name off
        // the top of the frame instead of next to the place it names.
        kind: 2, el, rec, dir: -1, offs: 0, prio: PRIO_LABEL, max: 30,
        x0: ax - rec.w * 0.5, x1: ax + rec.w * 0.5,
        y0: ay - rec.h, y1: ay + LABEL_STEM_PX,
      });
    }
  }

  // ---- ROUND-3 FIX 15: the leader line -----------------------------------
  // The badge and its tick share ONE anchor (the unit's ground contact point)
  // and one `center.y = 1`, so a tick whose on-screen height equals the gap the
  // de-clutter pass opened spans hull → badge exactly, at any zoom and at any
  // push, with no second projection and no screen-space bookkeeping.
  //
  // `sy` is the scale that renders the badge at `pxH` pixels, so `sy / pxH` is
  // this module's px → sprite-scale conversion; both sprite axes share it (with
  // sizeAttenuation off, three.js divides x by the horizontal half-extent and y
  // by the vertical one, and the aspect ratio cancels), which is the same
  // identity `sx = sy * CHIP_AR` already relies on.
  //
  // Below TICK_MIN_PUSH the badge is still sitting in its resting slot 2 px
  // under the hull and a tick would be a stub on every unit on the map, so it
  // is not drawn at all. The line only exists when there is a gap to explain.
  // ROUND-4 FIX 11 — the leader line now leans. With a lateral offset in play
  // the badge is no longer straight below its hull, so a tick that only ever
  // hangs down points at nothing. `SpriteMaterial.rotation` is exactly the right
  // tool and costs one uniform: three.js rotates the quad about its `center`,
  // which for this sprite IS the hull's ground contact point, in a view space
  // whose two axes map to screen pixels with the SAME factor while
  // sizeAttenuation is off (the horizontal half-extent carries the aspect and
  // the projection divides it straight back out — the identity `sx = sy·CHIP_AR`
  // already leans on this). So an angle here is an angle on screen.
  //
  // Unrotated the sprite runs from the anchor down the view's −y; rotating by θ
  // sends its tip to (sin θ·L, −cos θ·L). The badge's top-centre sits `dx` right
  // and `dy` down of the anchor, so θ = atan2(dx, dy) and L = hypot(dx, dy) —
  // the line spans hull → badge exactly, at any zoom, push or side, with no
  // second projection and no screen-space bookkeeping.
  function placeTick(c, pxH, sy, fade) {
    const t = c.tick;
    if (!t) return;
    const dy = COUNTER_GAP_PX + (c.doff > 0 ? c.doff : 0);
    const dx = c.dxoff || 0;
    const lead = Math.sqrt(dx * dx + dy * dy);
    if (!(fade > 0.02) || lead < TICK_MIN_PUSH || !(pxH > 0)) {
      t.visible = false;
      return;
    }
    const k = sy / pxH;
    t.scale.set(TICK_PX * k, lead * k, 1);
    c.tmat.rotation = Math.atan2(dx, dy);
    c.tmat.opacity = TICK_ALPHA * fade;
    t.visible = true;
  }

  // One pass per frame — a strict superset of "every sync()", which the
  // critique asked for; at 60 Hz a counter must not lag its own hull by 120 ms
  // while the camera pans.
  function screenPass(cam, seized, sdt) {
    let W = 1600, H = 900;
    try {
      engine.renderer.getSize(_sz);
      if (_sz.x > 1 && _sz.y > 1) { W = _sz.x; H = _sz.y; }
    } catch (err) { /* defaults are only used before the first resize */ }

    const pxH = clamp(H * COUNTER_PX_K, COUNTER_PX_MIN, COUNTER_PX_MAX);
    const pxW = pxH * CHIP_AR;
    const fov = (cam && cam.fov) || 40;
    const sy = (pxH * 2 * Math.tan(THREE.MathUtils.degToRad(fov) * 0.5)) / H;
    const sx = sy * CHIP_AR;
    const span = COUNTER_FADE_HI - COUNTER_FADE_LO;
    // ---- ROUND-5 FIX 13 ---------------------------------------------------
    // The far end of the same "annotation obeys the camera" rule the ring has
    // run on since round 3. `camGroundDistance` is the zoom level, not the
    // per-unit slant range, on purpose: the counter layer has to recede as ONE
    // layer, or a wide frame keeps a ragged handful of badges along its near
    // edge — which is the cluster the critique photographed, just smaller.
    let camD = 160;
    try { camD = camGroundDistance(cam); } catch (err) { /* keep the default */ }
    toneBand = solveToneBand(camD, toneBand);
    const farK = 1 - smooth01(camD, COUNTER_FAR_LO, COUNTER_FAR_HI);
    const valK = 1 - (1 - COUNTER_VAL_FAR) *
      smooth01(camD, COUNTER_VAL_D0, COUNTER_VAL_D1);
    const baseCenter = COUNTER_CENTER_Y + COUNTER_GAP_PX / pxH;
    const lerp = sdt > 0 ? clamp(sdt * 14, 0, 1) : 1;
    const counterMax = clamp(pxH * COUNTER_PUSH_ROWS,
      COUNTER_PUSH_MIN, COUNTER_PUSH_MAX);
    const counterMaxX = pxW * COUNTER_PUSH_X;   // ROUND-4 FIX 11

    items.length = 0;
    projUnits.length = 0;
    cam.getWorldDirection(_fwd);
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;

    for (let i = 0; i < counters.length; i++) {
      const c = counters[i];
      const u = c.unit;
      const mesh = u.mesh;
      const live = !!(u.alive && mesh && mesh.visible !== false);
      let ax = 0, ay = 0, onScreen = false;
      if (live) {
        const p = mesh.position;
        // behind-camera rejection before project(): the perspective divide
        // flips the sign behind the eye and a rejected unit would land in the
        // middle of the frame and shove real counters around
        if ((p.x - cx) * _fwd.x + (p.y - cy) * _fwd.y + (p.z - cz) * _fwd.z > 0.5) {
          _wp.set(p.x, p.y, p.z).project(cam);
          if (Number.isFinite(_wp.x) && Number.isFinite(_wp.y)) {
            ax = (_wp.x * 0.5 + 0.5) * W;
            ay = (-_wp.y * 0.5 + 0.5) * H;
            onScreen = true;
            projUnits.push(u, ax, ay);            // float ownership, below
          }
        }
      }
      // Suppressed entirely while another system owns the camera: the FPV dive
      // disables controls (and sets engine.cinematic when dronecam.js supports
      // it) — its telemetry frame should own the screen, not sixteen RTS
      // counters, and a half-faded counter degrading to a blank slab is worse
      // than no counter at all. `dead` / `!ready` is the same principle applied
      // to a bake that failed: an unpainted badge takes no slot in the layout
      // pass and is never drawn.
      if (!live || seized || c.dead || !c.ready) {
        c.sprite.visible = false;
        c.tick.visible = false;
        c.doff = 0;
        c.dxoff = 0;
        continue;
      }
      const p = mesh.position;
      const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // near fade (the model reads on its own below 30 u) × far fade (fix 13)
      const fade = clamp((d - COUNTER_FADE_LO) / span, 0, 1) * farK;
      if (fade <= 0.02) {
        c.sprite.visible = false;
        c.tick.visible = false;
        c.doff = 0;
        c.dxoff = 0;
        continue;
      }
      c.sprite.visible = true;
      c.sprite.scale.set(sx, sy, 1);
      c.mat.opacity = fade;
      c.mat.color.setScalar(valK);   // ROUND-5 FIX 13 — value, per frame
      c.fade = fade;
      if (!onScreen) {
        // no slot in the pass — let any push it is carrying relax back home
        c.doff += (0 - c.doff) * lerp;
        if (Math.abs(c.doff) < 0.05) c.doff = 0;
        c.dxoff += (0 - c.dxoff) * lerp;
        if (Math.abs(c.dxoff) < 0.05) c.dxoff = 0;
        c.sprite.center.set(0.5 - c.dxoff / pxW, baseCenter + c.doff / pxH);
        placeTick(c, pxH, sy, fade);
        continue;
      }
      c.sprite.center.set(0.5 - c.dxoff / pxW, baseCenter + c.doff / pxH);
      const top = ay + COUNTER_GAP_PX;
      items.push({
        kind: 0, ref: c, dir: 1, offs: 0, prio: PRIO_COUNTER,
        pxH, max: counterMax,
        // ROUND-4 FIX 11 — the lateral budget, and the side to try first: the
        // one it is already on, so a settled cluster does not flip sides when a
        // neighbour drifts a pixel.
        pxW, maxX: counterMaxX, xoff: 0, side: c.dxoff < -0.5 ? -1 : 1,
        x0: ax - pxW * 0.5, x1: ax + pxW * 0.5, y0: top, y1: top + pxH,
      });
    }

    ensureRoots();
    collectFloats(sdt);
    collectLabels();

    if (items.length > 1) resolveItems();

    // Apply. Offsets are eased rather than snapped: a badge that teleports two
    // rows when a neighbour scrolls past reads as a bug, one that slides reads
    // as deliberate. DOM writes are gated on a half-pixel of change so a static
    // frame costs zero style invalidations.
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 0) {
        const c = it.ref;
        c.doff += (it.offs - c.doff) * lerp;
        if (Math.abs(c.doff) < 0.05) c.doff = 0;
        // ROUND-4 FIX 11 — the lateral offset is eased on the same clock as the
        // vertical one, so a badge that changes column slides there instead of
        // teleporting, and `sprite.center.x` is the write: three.js builds the
        // quad as (corner − (center − 0.5))·scale, so a badge moves RIGHT by
        // LOWERING center.x — the mirror of the `center.y` push above.
        c.dxoff += (it.xoff - c.dxoff) * lerp;
        if (Math.abs(c.dxoff) < 0.05) c.dxoff = 0;
        c.sprite.center.set(0.5 - c.dxoff / it.pxW, baseCenter + c.doff / it.pxH);
        placeTick(c, it.pxH, sy, c.fade);
      } else {
        const rec = it.rec;
        if (it.snap) rec.offs = it.offs;
        else rec.offs += (it.offs - rec.offs) * lerp;
        if (Math.abs(rec.offs) < 0.05) rec.offs = 0;
        if (Math.abs(rec.offs - rec.applied) > 0.4 ||
            (rec.offs === 0 && rec.applied !== 0)) {
          rec.applied = rec.offs;
          it.el.style.top = `${rec.offs.toFixed(1)}px`;
          domTouched = true;
        }
        // world labels only: yield contrast when yielding position was not
        // enough. Damage floats are the top priority and are never blocked.
        if (it.kind === 2) {
          const dim = it.blocked ? (it.blockedBy >= PRIO_FLOAT ? '0' : '0.22') : '';
          if (dim !== rec.dim) {
            rec.dim = dim;
            it.el.style.opacity = dim;
            domTouched = true;
          }
        }
      }
    }
  }

  // Hand every borrowed inline property back to its owner.
  function releaseDom() {
    if (!domTouched) return;
    domTouched = false;
    for (const [el, rec] of floatRecs) {
      rec.offs = 0;
      if (rec.applied !== 0) { rec.applied = 0; el.style.top = '0px'; }
      if (rec.hidden) { rec.hidden = false; el.style.visibility = ''; }
    }
    for (const [el, rec] of labelRecs) {
      rec.offs = 0;
      if (rec.applied !== 0) { rec.applied = 0; el.style.top = '0px'; }
      if (rec.dim) { rec.dim = ''; el.style.opacity = ''; }
    }
  }

  let acc = 0;
  const off = engine.onFrame((dt, elapsed) => {
    // The float watchdog counts in seconds, so it must not be handed the
    // enormous dt a background tab produces when it comes back to the front —
    // that would expire every float on the resume frame.
    const sdt = dt > 0.1 ? 0.1 : (dt > 0 ? dt : 0);
    acc += dt;
    if (acc > 0.12) { acc = 0; sync(); }        // marker state is not per-frame data

    const cam = engine.camera;
    const seized = !!(engine.cinematic ||
      (engine.controls && engine.controls.enabled === false));
    if (cam) {
      try { screenPass(cam, seized, sdt); }
      catch (err) { /* readability must never break the frame */ }
    }

    // ---- CRITIQUE fix 6: the map layer does not enter the drone feed --------
    // Counters are handled inside screenPass(); these are the two remaining
    // world-space annotations this module owns. A faction ground ring and a
    // pulsing dashed selection ring are top-down tactical furniture — inside a
    // first-person camera at 30 m they are the whole frame (see
    // `critique-shots/round2/08-fpv-overlay-leak-topdown.png`). They come back
    // on the first frame after the feed cuts, not on the next 0.12 s sync.
    const u = selRing.userData.unit;
    if (seized) {
      selRing.visible = false;
      for (let i = 0; i < counters.length; i++) {
        const mesh = counters[i].unit.mesh;
        const mk = mesh && mesh.userData ? mesh.userData.marker : null;
        if (mk) mk.visible = false;
      }
      return;
    }
    for (let i = 0; i < counters.length; i++) {
      const c = counters[i];
      const mesh = c.unit.mesh;
      const mk = mesh && mesh.userData ? mesh.userData.marker : null;
      if (mk) mk.visible = !!c.unit.alive;
    }

    // ---- ROUND-3 FIX 17: the ring obeys the camera ------------------------
    // One write per faction per frame. The ring is a fixed-world-size object,
    // so its screen weight triples between RTS range and a vehicle close-up;
    // holding its opacity constant across that band is what made it the loudest
    // thing in the critic's close-up while being barely adequate at altitude.
    // Same easing the counters use, so the two annotation layers breathe
    // together instead of crossing each other.
    if (cam) {
      let camD = 160;
      try { camD = camGroundDistance(cam); } catch (err) { /* keep the default */ }
      // ROUND-4 FIX 10 — three writes per faction per frame instead of one.
      // `alphaTest` is multiplied by the opacity because three.js tests
      // `material.opacity × texel.a`; see the note on RING_STOPS.
      const s = ringSolve(camD);
      const at = s.a * s.t;
      mats.blue.opacity = s.a;
      mats.red.opacity = s.a;
      mats.blue.alphaTest = at;
      mats.red.alphaTest = at;
      mats.blue.color.setScalar(s.v);
      mats.red.color.setScalar(s.v);
    }

    if (selWanted && !selRing.visible && u && u.mesh && u.alive) selRing.visible = true;

    if (selRing.visible && u && u.mesh && u.alive) {
      selRing.position.copy(u.mesh.position);
      selRing.position.y += RING_Y + 0.02;
      const k = 1 + 0.05 * Math.sin(elapsed * 3.4);
      selRing.scale.setScalar(k);
      // The selection ring lives in scene space, so its parent carries no yaw
      // and the terrain normal goes in unrotated. It spins on its own axis, so
      // the conform has to be applied FIRST and the spin composed on top of it
      // — writing `rotation.y` after `quaternion` would throw the tilt away.
      conformRing(selRing, selRing.position.x, selRing.position.z, 0);
      selRing.rotateY(elapsed * 0.35);
      selMat.opacity = 0.74 + 0.20 * Math.sin(elapsed * 3.4);
    } else if (selRing.visible && (!u || !u.alive)) {
      selRing.visible = false;
    }
  });

  sync();

  // Saira Condensed / IBM Plex Mono arrive from the CDN with `display=swap`, so
  // the very first bake can land in a fallback face. Invalidate every signature
  // once the faces resolve and the next sync repaints them in the real type.
  let fontsPending = true;
  try {
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (!fontsPending) return;
        for (const c of counters) c.sig = '';
        acc = 1;                                   // force a sync next frame
      }).catch(() => { /* never break the frame */ });
    }
  } catch (err) { /* no font loading API — the fallback stack is fine */ }

  return {
    dispose() {
      fontsPending = false;
      try { off(); } catch (err) { /* noop */ }
      try { releaseDom(); } catch (err) { /* noop */ }
      floatRecs.clear();
      labelRecs.clear();
      items.length = 0;
      projUnits.length = 0;
      engine.scene.remove(selRing);
      selGeo.dispose(); selMat.dispose(); selTex.dispose();
      geo.dispose();
      mats.blue.dispose(); mats.red.dispose();
      texes.blue.dispose(); texes.red.dispose();
      tickTexes.blue.dispose(); tickTexes.red.dispose();
      for (const c of counters) {
        if (c.sprite.parent) c.sprite.parent.remove(c.sprite);
        if (c.tick && c.tick.parent) c.tick.parent.remove(c.tick);
        if (c.tmat) c.tmat.dispose();
        c.tex.dispose(); c.mat.dispose();
        const mesh = c.unit && c.unit.mesh;
        const ring = mesh && mesh.userData ? mesh.userData.marker : null;
        if (ring && ring.parent) ring.parent.remove(ring);
        if (mesh && mesh.userData) { mesh.userData.marker = null; mesh.userData.counter = null; }
      }
      counters.length = 0;
    },
  };
}
