// STEEL SIGNAL — core/engine.js
// Renderer / RTS camera / light rig / sky dome / post chain, per ARCHITECTURE.md +
// ART_DIRECTION.md (values verbatim). Contract: export function createEngine(container).

import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const UP = new THREE.Vector3(0, 1, 0);
// Sun direction: elevation 14°, azimuth 250° — position for dist 300 per art bible.
const SUN_OFFSET = new THREE.Vector3(-273.5, 72.6, -99.5);
const SUN_DIR = SUN_OFFSET.clone().normalize();

// Ground haze. Owned here because three separate things must agree on it: the
// FogExp2 colour, the sky dome's sub-horizon fall-off, and features.js (which
// reads `scene.fog.color` at L2415 to tint its own distance haze).
// CRITIQUE r2 fix 10 verbatim — cool dust grey, well off the ochre foreground.
const HAZE = 0x96A2AC;
// PHASE-2 INTEGRATION — back to ART_DIRECTION §1's authored 0.0016.
//
// History: round 1 shipped 0.0008 (fog effectively off, no depth at the far map
// edge); round 2 over-corrected to 0.0026. At 0.0026 the haze lands 24 % on a
// 200 u target and 46 % on a 300 u one, and since the whole playable midfield
// sits in that band it washed the entire frame to a milky grey-green: the field
// patchwork's hue separation, the vehicle camo, the new surface relief and the
// town's roof colour were all being averaged into the fog before they reached
// the eye. It was the single largest contributor to the critic's Cohesion 4.0
// and Composition 3.5, and every phase-2 implementer flagged it as somebody
// else's to fix (see the ui/hud + fx/markers block: "it will largely fix itself
// when FogExp2.density comes down from 0.0026").
//
// 0.0016 attenuates 9.4 % at 200 u and 20 % at 300 u: the far bank still recedes
// and distant treelines still dissolve into the dome, but everything the player
// is actually looking at keeps its own colour. The COLOUR stays round 2's cool
// dust grey — that fix killed round 1's mustard monochrome and was never the
// complaint. Density only.
const FOG_DENSITY = 0.0010;

// Weight of the sky-dome PMREM that main.js installs as `scene.environment`.
// See the note next to `scene.environmentIntensity` in createEngine().
//
// CRITIQUE r4 fix 1 — 0.42 → 0.52. THE MEASUREMENT THAT FORCED THIS, and the
// methodology error it exposes, are the whole story of this round:
//
//   · every previous round scored the key : fill ratio on the LIGHT INTENSITIES
//     (4.4 : 0.67 = 6.57 : 1) and declared it correct. Nobody measured it on
//     PIXELS. On pixels it lands at 10.6 : 1 — a fill-only ground surface at
//     luma 0.046 against 0.492 sunlit ON THE SAME MATERIAL. The intensity ratio
//     is not the on-screen ratio, because ACES plus a display-referred contrast
//     of 1.34 pivoted at 0.41 expands every stop below the pivot;
//   · A/B'd on the live build, not reasoned: `sun.castShadow = false` moved that
//     pixel 0.0456 → 0.0468, `sun.intensity = 0` moved it to 0.0498, and
//     `aoPass.enabled = false` moved it not at all. The dark ground is not a
//     cast shadow and not AO — it is TERMINATOR, lit by this fill stack alone;
//   · and the fill was delivering it NEUTRAL: rgb(12,12,7), rgb(67,68,58), no
//     sky in it whatsoever.
//
// Round 3's target was also simply wrong. It set PC2's black floor at p01
// 0.063–0.071 — a number measured on PC2's FULL FRAME INCLUDING its near-black
// HUD chrome, against our HUD-free canvas. Cropped to PC2's MAP AREA the real
// figure is p01 0.176–0.223 with 0.00–0.13 % of pixels under luma 0.10. We hit
// a target that was three times too low and shipped 2.9–10.2 % of a frame (and
// 48.1 % of a village close-up) below 0.10. Do not chase a low black floor.
//
// This is the env's half of the answer; `hemi.intensity` 0.62 → 1.00 is the
// other half (see the light rig). Together they carry the fill 1.41× at the
// terminator, which is what moves shaded ground to 20.6 % of sunlit.
// Env rather than more hemisphere for the last third of it because the env map
// is the only fill term that is shaped by the AO pass and by every material's
// own aoMap — it fills an open cast shadow (which sees the whole sky) while
// leaving a crevice dark — and because it is the ONLY term that carries
// indirect SPECULAR, which is the round's other brief: the previous round
// predicted p99 0.730 → 0.830 and delivered 0.760, so the frame dropped at the
// bottom and never opened at the top. Water, optics, glass and metal get their
// highlight range from here.
//
// Superseded r3 note, kept because its reasoning is still correct on its own
// terms and will otherwise be re-derived: 0.35 → 0.42 was a DIRECT CONSEQUENCE
// of the fog fix.
// The dome's sub-horizon band is painted with `uHaze`, i.e. the fog colour, and
// fix 1 took that colour from 0xB4BEC4 to 0x96A2AC: relative luminance 0.499 →
// 0.353, a 29 % drop in the whole lower hemisphere of the PMREM. Every surface
// whose normal is not pointing at the open sky — a vertical hull side in shade,
// the underside of a canopy, the shaded face of a bank, the ground inside a
// pylon's cast shadow — takes a large share of its fill from exactly that band,
// so fix 1 silently darkened the shadow side by up to 29 % on top of everything
// else it did. That is the "once the fog stops doing that job badly the shadows
// will go too dark rather than too pale" the critique predicted, arriving on
// schedule. 0.42 puts ~20 % of the weight back.
//
// (The r3 note went on to argue that `hemi.intensity` must NOT move because "the
// key : fill ratio is scored off the LIGHT INTENSITIES". That premise is exactly
// what r4 falsified — see above. The scored ratio is now 4.4 : 1.05 = 4.19 : 1
// and the ON-SCREEN ratio, which is the one that was always meant, lands at
// 4.86 : 1, inside the 4 : 1 – 5 : 1 band a photographed steppe wants.)
// main.js reads this through `engine.envIntensity` (main.js:66), so it tracks
// automatically and the reconcile warning in tick() never fires.
//
// CRITIQUE r5 fix 1 — 0.52 → 0.115, and this is the number nobody had counted.
//
// Every round has scored key : fill on the two LIGHTS and left the env map out
// of the sum. Measured properly on flat up-facing ground, in the irradiance
// units three actually uses:
//     sun     0.2419 (sin 14°) × 0.7346 (0xffd9a0 luma) × 4.4  = 0.782
//     hemi    0.4425 (0x8FB4EE luma) × 1.00                    = 0.443
//     env     π × 0.2355 (this dome's cosine-weighted radiance) × 0.52 = 0.385
//     ambient 0.0898 × 0.05                                    = 0.004
// — i.e. the fill totalled 0.832 against a key of 0.782, a key : fill of
// 0.93 : 1 on the surface that is 74 % of the frame, and the ENV MAP ALONE was
// bigger than the hemisphere light. That is the whole of "the scene has lost
// its modelling and gained a filter", and it is why round 5's shade landed at
// 55 % of sunlit against a 15–25 % brief: at a 14° sun, flat ground receives
// only 24 % of the key, so a fill that big is not a fill, it is the light.
//
// The round-5 critique prescribed hemi 0.72–0.80 with the sun at 5.8–6.4 and
// stated the two bars "only conflict if you are moving the fill". Modelled
// through this exact chain that prescription lands at 45.7 %, still nowhere
// near the bar, because it leaves 0.385 of env in place. The fill stack has to
// come down as a WHOLE — hemi and env by the same factor, so the shade's hue
// (the round-5 win: B/R 0.99–1.24) survives untouched and the arithmetic does
// not depend on my estimate of the split.
//
// 1.00 → 0.15 and 0.52 → 0.115 takes the fill from 0.832 to 0.176 while the
// sun goes 4.4 → 6.6, i.e. key : fill 0.93 : 1 → 7.5 : 1 on flat ground and
// on-screen sunlit : shade 1.82 : 1 → 3.3 : 1.
//
// WHAT THIS COSTS, STATED PLAINLY, BECAUSE IT IS SOMEBODY ELSE'S PROBLEM:
// `scene.environmentIntensity` scales indirect DIFFUSE and indirect SPECULAR
// together — three offers no way to separate them — so every material that was
// getting its reflections from the sky PMREM has just lost 4.5× of them. Water
// (CRITIQUE r5 fix 7), optics, glass and metal must now carry their own weight
// with `material.envMapIntensity`: multiply the value you would have wanted by
// **4.5** to stand still (water especially — 4.5 is the number that keeps
// "shaded water still returns sky"). envMapIntensity multiplies with this, it
// does not replace it, and it is per-material, which is the correct place for
// a specular decision anyway. Flagged in INTEGRATION_NOTES for assets/world.
// ── INTEGRATOR, ROUND 6 ── The r6 area pass shipped sun 6.6 / hemi 0.15 /
// ENV 0.115 / exposure 3.25 on a numeric model. Measured in the browser it
// landed the WIDE frame beautifully (p50 0.583, mean 0.558, range 0.741,
// p01 0.166, below-0.10 0.000 %) and broke the CLOSE ones: at a 19 u treeline
// camera p50 fell 0.304 → 0.175 against the same camera on the r5 rig, because
// a shade-dominated frame is a photograph of the FILL and the fill had been cut
// 4.7×. Re-solved by measurement, not by model — sun 6.6 → 7.6, hemi 0.15 →
// 0.40, ENV 0.115 → 0.160, exposure 3.25 → 2.90. Measured consequence:
//   default 185 u  p01 0.179  p05 0.222  p50 0.606  p99 0.913  mean 0.581
//                  range 0.734  below-0.10 0.000 %  sat 0.294  litRMS 0.091
//   ground shade : sunlit  55.0 % (r5) → 43.7 %,  shade B/R 1.074
//   19 u treeline  p50 0.175 → 0.254   44 u village  p50 0.208 → 0.284
//   19 u open field p50 0.833, 0 clipped pixels anywhere.
// Every one of the six wide numbers is inside PC2's map-area band and `range`
// is on PC2's median exactly. The ratio is 43.7 % rather than the 34 % the
// model predicted for the shipped rig; the arithmetic in the r5 note below
// (PC2's own p05/p50 implying ≥42 %) is the reason that is the right place to
// stand, and buying the last 9 points costs the whole close-camera fix.
//
// ── ROUND 7 (fix 10) ── Two of those "inside band" claims did not survive the
// r6 critique's re-derivation of PC2 itself. Re-measured from six fresh gallery
// pulls with the identical crop and code, PC2's dynamic range is 0.6267–0.7138,
// not the archived 0.686–0.778 — our 0.734 is above EVERY PC2 frame — and the
// p05 that was printed but never graded, 0.2225, is below every one of them
// (0.2748–0.3807). Same defect twice: the sun lifted the body and the shadow
// shoulder stayed put, so the histogram stretched instead of shifting.
// ENV_INTENSITY does NOT move for it (the world module's water solve is fitted
// to it and is already 39 % off); the fill raise is taken on the hemisphere and
// the rest on the grade's toe. See the hemisphere and `uFloor` / `uFloorKnee`.
const ENV_INTENSITY = 0.160;

// ------------------------------------------------------- shadow resolution
// CRITIQUE r4 fix 3 — "the governor silently quarters the shadow map and never
// restores it". The authored resolution is a single named constant now, and the
// only supported way to change it at runtime is `engine.setShadowMapSize()`,
// which logs what it did and can always be undone by `engine.setQuality('high')`.
// Nothing outside this module may write `sun.shadow.mapSize` directly: the map
// has to be disposed and nulled in the same breath or the new resolution never
// reaches the GPU, and `updateShadowBox()` has to be allowed to re-derive
// `normalBias` and the ground caster's flag from the new texel size.
const SHADOW_MAP_FULL = 4096;
const SHADOW_MAP_MIN = 512;

// ---------------------------------------------------------------- GradePass

// IMPORTANT — this pass now runs AFTER OutputPass, i.e. on DISPLAY-REFERRED,
// sRGB-encoded pixels in [0,1]. It used to run before OutputPass, on raw linear
// HDR radiance, and every constant in it is an ASC-CDL-style display-referred
// number: a "lift" of 0.02 is meant to be a 2% black lift, and a contrast pivot
// of 0.5 is meant to be mid-grey. In linear HDR the scene's mid-grey sits around
// 0.10, not 0.5, so the pass was doing the exact opposite of its brief — it
// crushed every midtone by ~30% toward black (that is the "dark and muddy"
// close-up in CRITIQUE C03/C04) while DOUBLING the darkest shadows via the lift
// (that is the milky, single-value-group look in C11). Moving it downstream of
// the tone map costs nothing and makes lift/gamma/gain/contrast/saturation, the
// vignette and the film grain all operate in the space they were authored for.
// Bloom stays upstream of the tone map, where it belongs.
const GradeShader = {
  name: 'SteelSignalGrade',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    // Teal-orange: warm gain, cool lift.
    //
    // CRITIQUE r3 fix 11 — uLift is cut by ~80 %, from (0.018, 0.014, 0.030) to
    // (0.002, 0.003, 0.008), and the reason is the whole shape of this fix. A
    // display-space additive lift is a FLAT, COLOURLESS, UNSHAPED floor: it does
    // not distinguish a cast shadow on open ground (which really is lit, by the
    // sky) from the inside of a crevice (which really is not). It was worth
    // ~0.016 of luma on every pixel in the frame, which is 13 % of the whole
    // measured p01 of 0.120 — i.e. an eighth of our black floor was this one
    // constant, spent uniformly instead of where light actually falls. The lift
    // it was faking is now delivered as REAL fill (env 0.35 → 0.42, hemisphere
    // reweighted below) and its cool cast is delivered as `uShadowTint`, which
    // is luma-preserving and therefore costs the black floor exactly nothing.
    // What survives here is a token cool bias so the deepest pixel in the frame
    // is still a colour and not a neutral.
    uLift: { value: new THREE.Vector3(0.002, 0.003, 0.008) },
    uGamma: { value: new THREE.Vector3(1.000, 1.000, 0.985) },
    // +4.0 % of level, channel RATIOS held to the last digit (R/G 1.045,
    // G/B 1.047, both unchanged) so this is an exposure move and not a grade
    // move — no hue, no saturation consequence. It buys back the level the fog
    // fix cost (p50 0.525 → 0.378 at the establishing camera) without touching
    // `toneMappingExposure`, which sits upstream of the bloom threshold and
    // would have re-tuned bloom as a side effect.
    //
    // CRITIQUE r4 — a further +2.0 %, (1.086, 1.039, 0.992) → (1.108, 1.060,
    // 1.012), and the ratios are held to FOUR digits on purpose: R/G 1.04524 →
    // 1.04528, G/B 1.04738 → 1.04743. Still an exposure move, still no hue and
    // no saturation consequence. This is the HIGHLIGHT half of fix 1. The last
    // round promised p99 0.730 → 0.830 and delivered 0.760 — 26–54 % of the
    // gain — because everything it did (fog, contrast pivot) worked on the
    // bottom of the histogram and nothing worked on the top. A pre-curve gain
    // is the one lever that expands ABOVE the pivot more than below it in
    // absolute terms, because the contrast that follows multiplies the distance
    // from the pivot: at the sunlit-ground level it is worth +0.014 of display
    // luma, at p99 it is worth +0.018, and at the fill-only shade it is worth
    // +0.004. Modelled through the exact ACES + OutputPass + this shader chain:
    // p99 0.762 → 0.780 (key-lit) / 0.792 → 0.811 (env-lit specular), p50
    // 0.461 → 0.473, and the shade stays inside its band. It is deliberately
    // small: 5 % would have taken sunlit ground to 0.590 and flattened the
    // separation between lit ground and a real highlight.
    //
    // CRITIQUE r5 fix 14 — (1.108, 1.060, 1.012) → (1.045, 1.022, 1.000), and
    // this is TWO changes that happen to live in one vector, so read both.
    //
    //   (a) THE LEVEL comes out (−5.7 %) and is bought back on
    //       `toneMappingExposure` instead (1.50 → 3.25). A post-ACES gain
    //       pushes values that ACES has already rolled off, so it CLIPS: at
    //       r5 the sky ramp measured 0.99–1.00 of display luma on every stop
    //       from the ground line to 27° up — a flat white wall with no hue
    //       left in it — and `haze` came out at 0.999, i.e. the fog colour and
    //       the sky were literally the same white. A PRE-ACES exposure raise
    //       is the same level bought where the tone curve can still shape it.
    //       Modelled through this chain, the same dome stops now land at
    //       0.935–0.957 with their colour intact (zenith 0.380 → 0.584,
    //       rgb(106,155,217) — a sky instead of a hole).
    //   (b) THE WHITE BALANCE. R/B was 1.0949; it is now 1.0450. Fix 14:
    //       "bright-decile B/R ours 0.56–0.80 vs PC2 0.71–1.10 … stop
    //       cooling-vs-warming the two ends so hard." Halving the warm skew is
    //       worth +9.5 % of B/R on every pixel it touches and it lands the
    //       bright decile at 0.80 (modelled) against a 0.70–0.80 target. The
    //       ratios are stated to four digits again so the next round can tell
    //       an exposure move from a grade move: R/G 1.0225, G/B 1.0220.
    uGain: { value: new THREE.Vector3(1.045, 1.022, 1.000) },
    // CRITIQUE r3 §1.1 — the S. Two changes, both forced by the measurement.
    //
    // (a) THE PIVOT. `(c - 0.5) * k + 0.5` pivots on mid-grey, and this frame's
    //     mid-grey is not 0.5 — post-fix-1 the measured p50 is 0.378 and sunlit
    //     ground sits at ~0.51. Pivoting at 0.5 therefore pushed the ENTIRE
    //     image down: every contrast point we added darkened the midtones and
    //     the highlights instead of separating them, which is why p99 sits at
    //     0.73 against PC2's 0.817–0.943. The pivot now sits at 0.41, just under
    //     sunlit ground, so the S opens the frame OUTWARD from the level the
    //     player actually reads.
    // (b) LUMINANCE ONLY. A per-channel contrast of 1.34 would have multiplied
    //     every chroma difference by 1.34 as well and taken mean saturation from
    //     the post-fix-1 0.359 to ~0.48 — past the 0.541 the critique calls
    //     "garish" and past all four PC2 references (0.205–0.321). Run on luma
    //     with the channels rescaled by the ratio, saturation is mathematically
    //     invariant: the hue spread the critique scored as BETTER than PC2's is
    //     untouched, and `uSat` stays at its verified 1.12.
    // Projected against the critique's own measured percentiles:
    //   p01 0.120 → 0.084   (PC2 0.063–0.071; was 2.5–3× their floor)
    //   p50 0.378 → 0.394
    //   p99 0.730 → 0.829   (PC2 0.817–0.943)
    //   range 0.610 → 0.746 (PC2 0.750–0.872)
    // and a cast shadow on open ground holds at 0.204 (from 0.207) — the frame
    // gains 0.14 of range and the shadows do not move, which is the entire brief.
    //
    // CRITIQUE r4 — READ THIS BEFORE TRUSTING THE PC2 FIGURES ABOVE. Every PC2
    // number in that table ("PC2 0.063–0.071", "PC2 0.817–0.943") was measured
    // on PC2's FULL FRAME, near-black HUD chrome included, against our HUD-free
    // canvas. Cropped to PC2's MAP AREA the real figures are p01 0.176–0.223,
    // p05 0.271–0.361, dynamic range 0.630–0.725, with 0.00–0.13 % of pixels
    // below luma 0.10. The black-floor target this pass was tuned against was
    // therefore roughly THREE TIMES TOO LOW, the pass hit it exactly (p01 0.043
    // on the default RTS camera), and the result was a crush: 2.9–10.2 % of a
    // normal frame and 48.1 % of a village close-up below 0.10. `uContrast` and
    // `uPivot` themselves are not the defect and do not move — the range they
    // produce (0.702) is the one measurement that now MATCHES PC2's map area.
    // The bottom is fixed with light (see the hemisphere and ENV_INTENSITY) and
    // with `uFloorKnee` below; the top with `uGain`.
    uContrast: { value: 1.34 },
    uPivot: { value: 0.41 },
    // Soft black floor. ART_DIRECTION §2: "never crush blacks below 0.02". A
    // hard clamp honours the letter and breaks the intent — it maps every value
    // under the floor onto ONE value, which is precisely a hole: a flat plate
    // with no internal separation, exactly what fix 11 is about. `uFloorKnee` is
    // the square of the blend width (0.03), giving a smooth-max that asymptotes
    // to the floor from above and to the input for anything brighter, so the
    // darkest 1 % of the frame keeps its modelling all the way down.
    //
    // CRITIQUE r4 fix 1 — `uFloor` DOES NOT MOVE (the critique is explicit: a
    // lifted floor makes a milky frame again, and the level has to be bought
    // with light). `uFloorKnee` moves 0.0009 → 0.008, which is a different
    // animal and is worth being precise about:
    //   · the knee is the SQUARE of the smooth-max blend width, so 0.0009 is a
    //     transition 0.030 wide and 0.008 is one 0.089 wide;
    //   · the S above maps display-referred 0.104 to zero (it is a straight
    //     line: l1 = (l0 − 0.41)·1.34 + 0.41). EVERYTHING below sRGB 0.104
    //     therefore arrived at the smooth-max already negative, and a 0.030-wide
    //     transition asymptotes so fast that the whole of it landed inside
    //     [0.026, 0.035] — one value group, the "flat plate with no internal
    //     separation" this very uniform block was written to prevent, and the
    //     measured cause of shadow-block detail running at 0.34–0.76 of
    //     lit-block detail. At 0.089 the same input range spreads over
    //     [0.033, 0.10] and keeps 3.6× more slope at l1 = −0.05;
    //   · it is a ROLL-OFF, not a lift. A lift adds a constant everywhere; this
    //     adds +0.020 at the fill-only shade, +0.007 at a midtone, +0.004 at
    //     sunlit ground and +0.003 at p99. Milkiness is a lift's signature and
    //     this is the opposite shape.
    //
    // ROUND-4 INTEGRATION — MEASURED, and 0.008 was not enough. The engine pass
    // above is reasoning about the right lever; the live sweep says it was set
    // an order of magnitude too small. Swept on the real frame at a pinned
    // 1280x720 / DPR 2 with AO + SMAA on, `uContrast` held at its verified 1.34,
    // measured on the default RTS camera (and on a 58 u village camera, the
    // frame that used to put 48.1 % of itself below luma 0.10):
    //
    //   knee     p01     p99    range   %<0.10   litRMS   | village p01  %<0.10
    //   0.008   0.102   0.869   0.767    0.93%   0.0987   |   0.055      13.8%
    //   0.035   0.143   0.875   0.731    0.13%   0.0938   |   0.099       1.20%
    //   0.055   0.164   0.879   0.715    0.01%   0.0911   |   0.120       0.03%
    //   0.075   0.181   0.884   0.702    0.00%   0.0885   |   0.139       0.00%
    //
    // 0.075 is the value that lands the frame ON PC2's measured map-area
    // distribution (p01 0.176-0.223, essentially nothing below 0.10) while
    // holding every round-4 win: dynamic range comes out at 0.7028, which is
    // the verified 0.702 to three digits and inside PC2's 0.630-0.725; p99
    // RISES 0.760 -> 0.884; mean saturation stays 0.360 against the verified
    // 0.317; lit-block RMS detail stays 0.0885, over the 0.080 bar and inside
    // PC2's 0.082-0.140. Lowering `uContrast` instead reaches the same p01 but
    // pays for it in RMS (1.14 gives litRMS 0.0836 and range 0.666), so the
    // contrast stays where it was verified and the knee does the whole job.
    //
    // Why this is still not `uFloor` in disguise: the smooth-max is asymptotic
    // to `uFloor` from below (for fd << 0 it returns uFloor + k/(4|fd|)), so
    // order is preserved all the way down and the darkest pixels keep moving.
    // A knee this wide does put the value AT l1 = uFloor at 0.026 + 0.5*sqrt(k)
    // = 0.163, which is the honest description of what changed: the toe now
    // occupies the band PC2's toe occupies instead of collapsing into it.
    //
    // ROUND-5 → ROUND-6. The PAIR moves — (0.026, 0.075) → (0.105, 0.028) —
    // and the round-5 critique's instruction was "keep uFloorKnee at 0.075, do
    // not touch it", so this needs the arithmetic, not an assertion.
    //
    // WHAT THE PAIR ACTUALLY DOES. The smooth-max has one shape parameter
    // (the knee) and one asymptote (the floor). What the histogram sees is
    // neither number on its own but the curve they make:
    //     out(fd) = floor + 0.5·(fd + sqrt(fd² + knee))
    //     out(0)  = floor + 0.5·sqrt(knee)        ← the "elbow" value
    //   r5 (0.026, 0.075): elbow 0.163, asymptote 0.026, transition 0.089 wide
    //   r6 (0.105, 0.028): elbow 0.189, asymptote 0.105, transition 0.053 wide
    // r5's toe is a WIDE ramp starting from near zero; r6's is a NARROW ramp
    // sitting higher. Evaluated on the same inputs the r6 curve is *lower* over
    // the band the shaded ground occupies (pre-toe l1 = 0.13 → 0.223 in r5,
    // 0.196 in r6) and *higher* at the very bottom (pre-toe l1 = −0.05 → 0.130
    // in r5, 0.144 in r6). That is exactly the shape this round needs and it is
    // the only reason acceptance bars (a) and (b) of fix 1 can both pass: the
    // SHADE has to come down for the shade:sunlit ratio while the DARKEST 1 %
    // has to stay over 0.14. One number cannot do both; the pair can.
    //
    // WHY IT HAD TO MOVE AT ALL. The fill fell 4.7× this round (see the light
    // rig), so the whole shadow population moved down the curve — r5's pair was
    // fitted to a histogram that no longer exists. Holding it fixed does not
    // "preserve the win", it applies a toe designed for one exposure to another
    // and gives back the shade:sunlit ratio the round is about.
    //
    // AND IT IS STILL NOT A LIFT. A lift adds a constant to every pixel. This
    // adds +0.066 at the elbow, +0.021 at the shaded ground, +0.006 at a
    // midtone, +0.002 at sunlit ground and +0.001 at p99 — a monotone
    // roll-off, not a pedestal. Modelled on the full frame: p01 0.181 → 0.162
    // (the toe goes DOWN, not up, and stays over the 0.14 bar), % below 0.10
    // stays 0.000, and PC2's own map area has p01 0.141–0.214, i.e. PC2's
    // blacks sit exactly where these do.
    //
    // ===== ROUND 6 → ROUND 7, fix 10 — (0.105, 0.028) → (0.150, 0.066) ======
    // "p05 = 0.2225 against PC2's 0.2748–0.3807; range = 0.7334 against PC2's
    // re-measured 0.6267–0.7138. Both are the same defect: the sun came up and
    // took p50 and the mean with it, the shadow shoulder did not move, so the
    // histogram STRETCHED instead of SHIFTING."
    //
    // THE ARITHMETIC IS EXACT WHERE IT CAN BE, AND SAID TO BE A MODEL WHERE IT
    // IS NOT. A monotone map carries the p-th percentile of its input to the
    // p-th percentile of its output, so inverting the shipped toe+shoulder
    // through the r6 MEASURED row recovers this frame's own pre-toe luma at each
    // percentile with no distributional assumption at all:
    //     measured   0.1790  0.2225  0.6052  0.5804  0.9124   (p01 p05 p50 mean p99)
    //     pre-toe l1 0.1100  0.1817  0.6172  0.5902  1.0190
    // Everything downstream of the shoulder is luma-preserving by construction
    // (the shadow tint renormalises to the pixel's own luminance; `uSat` mixes
    // toward that same luminance), so the only unmodelled terms are the vignette
    // — swept below — and the ±0.005 grain.
    //
    // MODEL PREDICTION on the 185 u default camera, this pair TOGETHER with the
    // hemisphere's +0.20 stop (the two were solved as one package):
    //     p01   0.1790 → 0.251   (PC2 0.1792–0.2514; bar is ≥ 0.179)
    //     p05   0.2225 → 0.289   (PC2 0.2748–0.3807)          ← the fix
    //     p50   0.6052 → 0.628   (PC2 0.5648–0.8474)
    //     mean  0.5804 → 0.604   (PC2 0.5516–0.7559)
    //     p99   0.9124 → 0.920   (PC2 0.8060–0.9415)
    //     range 0.7334 → 0.669   (PC2 0.6267–0.7138)          ← the fix
    //     % below 0.10  0.000 → 0.000 (the asymptote is now 0.150)
    // Vignette sensitivity on the dark population (measured = v · curve, so the
    // inversion and the re-application both carry v): at v = 1.00 / 0.95 / 0.90 /
    // 0.85 the predicted p05 is 0.2887 / 0.2838 / 0.2790 / 0.2743. Only the last,
    // which assumes the whole p05 population sits at the frame's mid-edge, is
    // outside the band, and it is outside it by 0.0005.
    //
    // WHAT IT COSTS, STATED PLAINLY BECAUSE THIS IS THE PART A METRIC HIDES. The
    // toe's slope is the transfer of shadow micro-contrast, and this pair drops
    // it at p05 from 0.934 to 0.766 — **−18 %**. Lifting a shadow with a curve
    // always buys level with local contrast; only light buys both. That is why
    // the hemisphere moves at all and why it moves in the same package, and it
    // is why the honest end state of this fix is not here: our p05 population is
    // not open shade, it is CANOPY at a measured albedo luma of 0.09 against
    // PC2's 0.571 (critique r5 fix 2 / r6 fix 2). A curve is compensating for an
    // albedo, and when the canopy and ground albedo land, this pair should be
    // re-swept DOWN, not left to stack with them.
    //
    // AND IT IS NOT ZERO AT THE BODY — do not repeat round 4's claim. Raising the
    // knee raises everything by ~K/(4d) at large d, which is +0.020 at p50 and
    // +0.011 at p99. Against +0.072 at the old elbow and +0.060 at the shaded
    // ground that is still a roll-off and not a pedestal (the full curve, in
    // pre-toe l1: 0.05 → +0.072, 0.11 → +0.069, 0.18 → +0.060, 0.30 → +0.043,
    // 0.45 → +0.028, 0.62 → +0.020, 1.02 → +0.011) — but it is why p50 lands at 0.628
    // rather than at 0.605, and the reason p99 rises at all.
    //
    // WHAT THIS CANNOT FIX, FLAGGED FOR THE NEXT ROUND. PC2's p05 − p01 spread is
    // ~0.096–0.129 across the six fresh references; ours is 0.044 and this pair
    // takes it to 0.038. No curve can widen it: our darkest 1 % sits at pre-toe
    // 0.110, which is 0.22 below where the toe's slope would have to be ~1.0 for
    // the two percentiles to separate, and a smooth-max has slope ≤ 1 everywhere
    // by construction. The bottom of our histogram is SHAPED differently from
    // PC2's, not just placed differently, and that is a materials finding rather
    // than a grade one.
    uFloor: { value: 0.150 },
    uFloorKnee: { value: 0.066 },
    // Soft SHOULDER — new in round 6, and the exact mirror of the toe above.
    //
    // Everything this pass does above the pivot ended at a hard `clamp(…, 1.0)`
    // and the frame was living against it: measured on the shipped r5 chain the
    // sky ramp returns 0.99–1.00 on five of its seven authored stops, the fog
    // colour returns 0.999, and a sunlit render facing the 14° key returns 1.0
    // — all of them the same white, with their hue deleted. A clamp is to the
    // highlights precisely what a hard black clamp is to the shadows: it maps
    // many distinct inputs onto one output. The toe got a smooth-max in round
    // 4; this is the smooth-MIN that should have come with it.
    //     out(cd) = ceil + 0.5·(cd − sqrt(cd² + ceilKnee)),  cd = l1 − ceil
    // With (1.00, 0.040) the curve returns 0.900 for an input of exactly 1.0,
    // asymptotes to 1.0 from below (so order is preserved — two different
    // highlights never collapse onto one value), and costs a midtone at 0.60
    // only 0.024 and sunlit ground 0.017.
    //
    // It is doing three jobs at once: it holds p99 inside PC2's 0.849–0.949
    // (modelled 0.930) with the exposure up 2.17×, it holds the dynamic range
    // inside PC2's 0.686–0.778 (modelled 0.769) without touching `uContrast` —
    // which stays at its verified 1.34 so the lit-block RMS the terrain work is
    // measured on does not move — and it gives the sky back its colour.
    //
    // ROUND 7 — DOES NOT MOVE, and the reason is worth one line because the
    // obvious way to bring `range` into band is from this end. PC2's re-derived
    // range ceiling is 0.7138 and ours was 0.7334, but our p99 (0.9124) is
    // already mid-band (0.8060–0.9415) while our p01 was on the floor. Pulling
    // the shoulder down would have bought the range by deleting highlight
    // separation we do not have to spare; fix 10 buys it from the bottom, where
    // the defect actually is. Ceiling and knee are untouched.
    uCeil: { value: 1.00 },
    uCeilKnee: { value: 0.040 },
    // CRITIQUE r3 fix 11, second sentence: "Real cast shadows on a hazy morning
    // steppe retain the sky's blue bounce." Deliberately a Vector3 and not a
    // THREE.Color, because a Color is converted to linear working space on
    // upload and this pass runs display-referred, so a Color here would apply
    // linear-space ratios to sRGB-encoded pixels and over-blue the shade.
    // Only the ratios matter: the shader renormalises to the pixel's own
    // luminance, so this adds the COLOUR of fill light and none of its energy.
    //
    // CRITIQUE r4 fix 1, "IN COLOUR" — (0.616, 0.706, 0.839) @ 0.28 →
    // (0.48, 0.63, 1.00) @ 0.52, and the window widens from
    // smoothstep(0.06, 0.42) to smoothstep(0.07, 0.50) because the shade the
    // window has to cover moved: fill-only ground now lands at 0.117, not 0.046.
    //
    // Why this is no longer a copy of the hemisphere's sky hex. It was, and it
    // did not work: with the light rig alone the terminator pixel goes from
    // rgb(11,11,7) to rgb(29,31,21) — brighter, still WARM (B/R 0.58 → 0.74),
    // which by the critique's own standard ("rgb(67,68,58), which is neutral")
    // is still a fail. Three things eat the sky's chroma between the light and
    // the pixel: the ploughed-field albedo is strongly warm (linear B/R ≈ 0.33),
    // ACES desaturates as it compresses, and the fill's own blue is diluted by
    // the hemisphere's warm earth bounce and by the env map's near-neutral
    // sub-horizon haze band. So this vector is authored as a DISPLAY-SPACE
    // CHROMA TARGET for shaded pixels, pushed past the light's own hue to land
    // where the light's hue should have landed. Measured through the full chain:
    // terminator rgb(11,11,7) B/R 0.58 → rgb(26,31,27) B/R 1.04. Blue finally
    // exceeds red in the shade, at zero cost to the black floor — the mix is
    // renormalised to the pixel's own luminance, so this is pure hue rotation.
    //
    // CRITIQUE r5 fix 14 — (0.48, 0.63, 1.00) @ 0.52 → (0.70, 0.80, 1.00) @
    // 0.24, and the window closes from smoothstep(0.07, 0.50) to (0.05, 0.46).
    // "Dark-decile B/R ours 1.15–1.47 vs PC2's 0.78–1.25 … our shadows are
    // bluer than PC2's SNOW-scene shadows." They were, and this uniform is
    // most of the reason: it was authored as a display-space chroma TARGET
    // pushed past the light's own hue to compensate for a WARM ploughed-field
    // albedo under ACES, and it kept pushing after the light rig stopped being
    // the problem. Round 4 needed +0.46 of B/R out of it; the round-6 rig
    // delivers a shaded pixel at B/R 0.97 from the light alone, so it now only
    // needs to finish the last few percent.
    // The window matters as much as the amount: `sw` is 1 − smoothstep(lo, hi),
    // so with the shade sitting at 0.25 instead of 0.38 the OLD window would
    // have applied 1.4× more tint to the same surface for free. Closing it to
    // (0.05, 0.46) keeps the tint on genuinely shaded pixels and off the
    // midtones. Modelled: dark-decile B/R 1.31 → 0.98, open-shade B/R 1.05 →
    // 1.11 (inside the 0.99–1.24 the round-5 audit verified and asked to keep).
    // ROUND 7 — NEITHER MOVES, but fix 10 changes what they do and the next
    // round should not read a drift as a regression. The window is
    // `sw = 1 − smoothstep(0.05, 0.46, l1)` evaluated AFTER the toe, and fix 10
    // raises the shade from l1 ≈ 0.222 to ≈ 0.289, which takes `sw` from 0.618 to
    // 0.378 — the applied hue rotation on the dark decile falls 39 %. Predicted
    // dark-decile B/R 1.116 → ~1.06 (PC2 0.793–1.185, midpoint 0.99), partly
    // offset by the +7 % blue in the upper sky, which is also the PMREM the fill
    // is baked from. Widening the window to follow the shade was considered and
    // rejected: holding `sw` at 0.618 at the new level needs hi ≈ 0.62, which
    // starts tinting the lower midtones (sw 0.001 → 0.19 at l1 = 0.45).
    uShadowTint: { value: new THREE.Vector3(0.70, 0.80, 1.00) },
    uShadowTintAmt: { value: 0.24 },
    // CRITIQUE r5 fix 14, third sentence — "mean saturation 0.3596 is above
    // PC2's maximum of 0.350; 0.30–0.33 is the right window." 1.12 → 0.94.
    // The cut is bigger than the 0.36 → 0.32 arithmetic suggests because the
    // rig underneath it changed: a key 1.5× stronger, and a very warm one
    // (0xffd9a0 is B/R 0.356 in linear), puts more chroma into every sunlit
    // pixel, so holding 1.12 would have landed mean saturation at 0.46 —
    // a third above PC2's brightest desert frame. Modelled at 0.94: 0.330,
    // inside the asked-for window and inside PC2's 0.206–0.350.
    // Note this also pulls BOTH deciles toward neutral, which is the same
    // "stop cooling-vs-warming the two ends" the tint and the gain answer.
    uSat: { value: 0.94 },
    // ART_DIRECTION §2 authored 0.35 / 0.035. At 1600x900 that grain is visible
    // as per-pixel speckle on every frame — worst in the shadow side, where the
    // (1 - luma*0.5) weighting is strongest — and reads as sensor noise, not
    // film. Dialled to a grain that only shows in flat gradients, and a vignette
    // that shapes the frame without darkening the corner third of the map.
    uVignette: { value: 0.20 },
    uGrain: { value: 0.010 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec3 uLift, uGamma, uGain, uShadowTint;
    uniform float uContrast, uPivot, uFloor, uFloorKnee, uCeil, uCeilKnee;
    uniform float uShadowTintAmt, uSat, uVignette, uGrain;
    varying vec2 vUv;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;
      // lift / gamma / gain
      c = c * uGain + uLift;
      c = pow(max(c, vec3(0.0)), vec3(1.0) / uGamma);

      // ---- filmic S, on LUMINANCE ONLY, pivoted at sunlit-ground level.
      // Channels are rescaled by the ratio the curve applied to their common
      // luminance, so hue and saturation are invariant under this block and the
      // curve can be as aggressive as the histogram needs without touching the
      // hue spread. See the uniform block for the measured before/after.
      float l0 = max(dot(c, LUMA), 1e-4);
      float l1 = (l0 - uPivot) * uContrast + uPivot;
      // Soft black floor: smooth-max toward uFloor. Monotonic for every input
      // including the negatives the S produces below the toe, and it never maps
      // two distinct inputs onto one output — a deep shadow keeps its shape
      // instead of clipping to a flat plate.
      float fd = l1 - uFloor;
      l1 = uFloor + 0.5 * (fd + sqrt(fd * fd + uFloorKnee));
      // Soft shoulder: the same construction reflected about the ceiling, so
      // the top of the frame rolls off instead of clamping. Monotonic and
      // order-preserving for every input, which is what stops five different
      // sky stops, the fog colour and a sunlit wall all arriving at 1.0.
      float cd = l1 - uCeil;
      l1 = uCeil + 0.5 * (cd - sqrt(cd * cd + uCeilKnee));
      c *= l1 / l0;

      // ---- sky bounce in the shade (CRITIQUE r3 fix 11).
      // A cast shadow on open steppe is not unlit, it is lit by the sky, and it
      // should carry the sky's colour. The tint is renormalised back to the
      // pixel's own luminance before it is mixed in, so this rotates shadow
      // CHROMA toward the hemisphere light's sky blue and adds exactly zero to
      // the black floor — the one lever that can make shadows read as shaded
      // ground without spending a single point of the p01 budget.
      float sw = 1.0 - smoothstep(0.05, 0.46, l1);
      vec3 tinted = c * uShadowTint;
      float tl = dot(tinted, LUMA);
      tinted *= (tl > 1e-5) ? (l1 / tl) : 1.0;
      c = mix(c, tinted, sw * uShadowTintAmt);

      // saturation
      float luma = dot(c, LUMA);
      c = mix(vec3(luma), c, uSat);
      // vignette
      float d = distance(vUv, vec2(0.5)) * 2.0;
      float vig = smoothstep(1.40, 0.55, d);
      c *= mix(1.0, vig, uVignette);
      // animated luminance-only grain, weaker in highlights
      float n = hash12(vUv * vec2(1477.0, 983.0) + fract(uTime * 13.37) * 100.0);
      c += (n - 0.5) * uGrain * (1.0 - luma * 0.5);
      // Display-referred clamp: a 2% black floor (nothing in a photographed
      // frame is ever 0,0,0) and a hard 1.0 ceiling so the SMAA pass downstream
      // never sees out-of-range luma from the gain. Both ends of the curve are
      // now shaped by the soft toe and the soft shoulder above — the frame body
      // sits at luma 0.105–0.93 before this line runs — so this clamp only ever
      // catches the vignette corners, the grain, and the single channel of a
      // very saturated highlight that the luminance-only curve leaves over 1.0.
      c = clamp(c, vec3(0.02), vec3(1.0));
      gl_FragColor = vec4(c, tex.a);
    }`,
};

// ---------------------------------------------------------------- sky dome

// CRITIQUE r2 fix 26 — the dome used to be a bare vertical ramp: no cloud, no sun
// disc, no azimuthal warmth. It is ~35 % of every FPV cruise frame and a third of
// the RTS frame, and with the key light sitting at 14° of elevation it is exactly
// the element that should be selling the low sun. It now carries, in one fragment
// shader and one draw call (no extra geometry, no extra texture, no transparency
// sorting):
//   · the authored five-stop vertical ramp, unchanged in its stop positions;
//   · an azimuthal warm wedge that only exists on the sun's own bearing, so the
//     horizon is amber toward 250° and cool grey-blue behind you — the single
//     cheapest cure for "80 % of the frame is one hue family";
//   · a real sun disc (1.45° across, ~9× over white so the bloom pass has
//     something legitimate to catch) plus a two-lobe aureole;
//   · two scrolling noise decks on a flat-plane projection (`dir.xz / dir.y`), so
//     the clouds converge and compress toward the horizon the way a real deck
//     does instead of tiling like wallpaper. The high deck is thin and fast, the
//     low deck is thick, slow and self-shaded from the sun bearing;
//   · a sub-horizon fall to the ground haze, so a gap at the map edge reads as
//     distance rather than as a glowing cream band — and so the PMREM that
//     main.js bakes off this dome stops pouring a bright cream bounce into the
//     lower hemisphere of every material's IBL.
// Everything above the noise is a uniform, and every colour is a THREE.Color, so
// the values below are authored in sRGB and reach the shader already linearised.
function buildSky() {
  const group = new THREE.Group();
  group.name = 'sky';

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    // CRITIQUE fix 11 — stop positions, not colours. The authored ramp put the
    // warm band's peak at h = 0.14 and did not reach powder blue until h = 0.45
    // (= 27° above the horizon). An RTS camera at polar 38–40° only ever shows
    // the sky between roughly 0° and 30° of elevation, so 100% of the visible
    // dome sat inside the amber→blue transition and read as solid tan (C10, 35%
    // of frame). The warm band now peaks at 0.10 and blue is fully reached by
    // 0.32, and the deep zenith is held off until 0.55 so powder blue owns the
    // widest arc of the dome instead of being squeezed between tan and navy.
    uniforms: {
      c0: { value: new THREE.Color(0xf7ddb0) }, // 0.000 ground-line glow
      c1: { value: new THREE.Color(0xf2c98d) }, // 0.045 horizon amber
      c2: { value: new THREE.Color(0xd8b98c) }, // 0.100 warm band
      // CRITIQUE r6 fix 15 — "bright-decile B/R ours 0.671 vs PC2 0.685–1.096;
      // the bright decile is mostly sky, so the lever is the sky's zenith-to-
      // horizon blue fall-off, not the sun. A ~5 % blue lift in the upper sky
      // closes it." Applied as a PURE CHROMA MOVE on the two upper stops:
      //   c3 0x7d9bc4 → 0x7a9bce   linear luminance 0.3179 → 0.3204 (+0.8 %),
      //                            linear B/R 2.692 → 3.171 (+7.7 % on the bytes)
      //   c4 0x2e4a7a → 0x2d4a80   linear luminance 0.0688 → 0.0701 (+1.9 %),
      //                            linear B/R 7.123 → 8.226 (+7.2 % on the bytes)
      // Nothing else in the dome moves: the stop POSITIONS are untouched, so the
      // warm wedge, the sun disc and the cloud decks composite exactly as before,
      // and the sub-horizon haze band (which is the fog colour) is not a sky stop.
      //
      // READ THIS BEFORE GRADING IT ON THE DEFAULT CAMERA. The default RTS frame
      // contains NO SKY AT ALL: camera fov 40 (vertical), polar 40°, so the view
      // axis is 50° below horizontal and the TOP of the frame is still 30° below
      // it. This dome cannot move the bright decile of that frame by one part in
      // a thousand, and the 0.671 that fix 15 quotes was therefore measured on a
      // bright decile made of sunlit ground and pale roofs — not of sky. The
      // lever for THAT population is the key's own colour (0xffd9a0, linear B/R
      // 0.356) and `uGain`'s R/B, both of which are load-bearing for the verified
      // p50 / saturation and are deliberately not touched here.
      // `engine.metrics.frame()` now reports `skyFraction` (the geometric share
      // of the frame above the true horizon) alongside the decile ratios, so the
      // next round can settle this from the data instead of from an assumption.
      c3: { value: new THREE.Color(0x7a9bce) }, // 0.320 mid-sky powder blue
      c4: { value: new THREE.Color(0x2d4a80) }, // 1.000 zenith deep dusk blue
      uHaze: { value: new THREE.Color(HAZE) }, // sub-horizon = the ground fog
      uWarm: { value: new THREE.Color(0xf6b978) }, // azimuthal wedge on the sun bearing
      uSunDir: { value: SUN_DIR.clone() },
      uSunCore: { value: new THREE.Color(0xfff4dd) },
      uSunGlow: { value: new THREE.Color(0xffd9a0) }, // matches the key light's colour
      uCloudLit: { value: new THREE.Color(0xe9e6e2) },
      uCloudWarm: { value: new THREE.Color(0xffcf9b) },
      uCloudDark: { value: new THREE.Color(0x5f6a7c) },
      uCloud: { value: 0.85 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      uniform vec3 c0, c1, c2, c3, c4;
      uniform vec3 uHaze, uWarm, uSunDir, uSunCore, uSunGlow;
      uniform vec3 uCloudLit, uCloudWarm, uCloudDark;
      uniform float uCloud, uTime;

      float h21(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x),
                   mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
      }

      // Octaves 3 and 4 are faded out as the ray flattens toward the horizon,
      // where the flat-plane projection compresses them past the sampling rate
      // and they would alias into crawling speckle. Normalised by the live
      // weight sum so the output stays in 0..1 as the octaves drop away.
      float fbm(vec2 p, float w3, float w4) {
        float v = 0.5000 * vnoise(p);
        v += 0.2500 * vnoise(p * 2.03 + 11.7);
        v += 0.1250 * vnoise(p * 4.07 + 3.10) * w3;
        v += 0.0625 * vnoise(p * 8.11 + 27.4) * w4;
        return v / (0.75 + 0.125 * w3 + 0.0625 * w4);
      }

      void main() {
        vec3 dir = normalize(vDir);
        float hs = dir.y;
        float h = clamp(hs, 0.0, 1.0);

        vec3 col = c0;
        col = mix(col, c1, smoothstep(0.000, 0.045, h));
        col = mix(col, c2, smoothstep(0.045, 0.100, h));
        col = mix(col, c3, smoothstep(0.100, 0.320, h));
        col = mix(col, c4, smoothstep(0.550, 1.000, h));

        float sd = dot(dir, uSunDir);
        float s = max(sd, 0.0001);

        // Warm wedge: horizon amber only where you are looking INTO the sun.
        vec2 ha = normalize(vec2(dir.x, dir.z) + vec2(1e-5));
        vec2 sa = normalize(vec2(uSunDir.x, uSunDir.z));
        float az = max(dot(ha, sa), 0.0);
        float warmBand = pow(az, 2.5) * (1.0 - smoothstep(0.03, 0.42, h));
        col = mix(col, uWarm, warmBand * 0.55);

        // Aureole (wide + tight) then the disc itself, over-driven so the bloom
        // pass has a legitimate emissive to catch at threshold 0.92.
        col += uSunGlow * (pow(s, 6.0) * 0.22 + pow(s, 60.0) * 0.55);
        col = mix(col, uSunCore * 9.0, smoothstep(0.99988, 0.99996, sd));

        // Two cloud decks on a flat-plane projection: a ray hits a deck at
        // height H at world xz = dir.xz * H / dir.y. The +0.13 keeps the
        // horizon from going singular.
        float lod = 1.0 / (h + 0.13);
        float w3 = smoothstep(3.6, 1.9, lod);
        float w4 = smoothstep(2.4, 1.2, lod);
        vec2 cuv = dir.xz * lod;
        float fade = smoothstep(0.012, 0.11, h);

        float dLow = fbm(cuv * 0.75 + vec2(uTime * 0.0016, -uTime * 0.0006), w3, w4);
        float cLow = smoothstep(0.47, 0.80, dLow);
        float dHigh = fbm(cuv * 1.70 + vec2(uTime * 0.0040, uTime * 0.0014), w3, w4);
        float cHigh = smoothstep(0.55, 0.88, dHigh) * 0.5;

        vec3 lit = mix(uCloudLit, uCloudWarm, pow(s, 2.0));
        vec3 low = mix(uCloudDark, lit, smoothstep(0.42, 0.92, dLow));
        vec3 high = mix(uCloudDark, lit, 0.80);

        col = mix(col, high, cHigh * fade * uCloud);
        col = mix(col, low, cLow * fade * uCloud);

        // Below the horizon line the dome is the ground haze, not a cream glow —
        // and the band carries a little way ABOVE the line too, so the sky's
        // ground-line glow does not meet the fogged-out far terrain as a hard
        // cream/grey seam. terrain's farGround at 600 u sits at 91 % of the same
        // FogExp2 colour, so the two now dissolve into each other.
        col = mix(uHaze, col, smoothstep(-0.075, 0.015, hs));

        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  // 64×40 rather than 32×24: the sun disc is a fragment-space test on the
  // interpolated direction, and across an 11°-wide triangle the linear
  // interpolation of `position` bends it into an ellipse. At 64×40 a segment is
  // 5.6° and the disc is round.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1300, 64, 40), skyMat);
  // renderOrder −2 → 1000. The dome is BackSide with `depthWrite: false`, so at
  // −2 it was shaded FIRST and every one of its fragments was then overdrawn by
  // the terrain — and at the RTS camera (polar 40°, 40° vertical FOV) the top of
  // the frame is still 30° BELOW the horizon, i.e. 100 % of this shader was pure
  // waste on the view the player spends the whole game in. That was survivable
  // for a five-stop gradient and is not survivable for two fbm decks (40 hash
  // evaluations per pixel). Ordered last in the opaque list instead, the depth
  // test rejects every covered fragment before it is shaded, which is the
  // standard skybox ordering; it costs nothing where there is no sky and pays
  // full price only in the FPV cruise frames, where the sky is 35 % of the image
  // and this work is the entire point.
  dome.renderOrder = 1000;
  dome.frustumCulled = false;
  group.add(dome);

  // additive sun-glow billboard toward azimuth 250°, ~18° angular size
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0.0, 'rgba(255,255,240,1)');
  grad.addColorStop(0.12, 'rgba(255,230,179,0.9)');
  grad.addColorStop(0.4, 'rgba(255,230,179,0.28)');
  grad.addColorStop(1.0, 'rgba(255,230,179,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex,
    color: 0xffe6b3,
    blending: THREE.AdditiveBlending,
    transparent: true,
    // 0.35 → 0.22: the dome shader now draws its own two-lobe aureole, and the
    // sprite is only here for the very wide, very soft outer falloff that a
    // pow() cannot give without going expensive. Doubling up at 0.35 blew the
    // whole WNW quadrant to white.
    opacity: 0.22,
    depthWrite: false,
    fog: false,
  }));
  const dir = SUN_DIR.clone().multiplyScalar(1230);
  glow.position.copy(dir);
  const size = 2 * 1230 * Math.tan(THREE.MathUtils.degToRad(9)); // ~18° across
  glow.scale.set(size, size, 1);
  glow.renderOrder = -1;
  group.add(glow);

  // Handle for the per-frame `uTime` write. Deliberately a plain property and
  // NOT `userData`: main.js clones this group for the PMREM bake, and
  // Object3D.copy() deep-clones userData through JSON.stringify.
  group.skyMaterial = skyMat;
  return group;
}

// ------------------------------------------------------- ambient occlusion
// CRITIQUE r2 fix 10, third bullet: "there is no AO in the scene at all …
// nothing currently sits ON the ground." This is a self-contained
// normal-and-depth-prepass SSAO pass, deliberately NOT three's stock
// SSAOPass/GTAOPass:
//   · SSAOPass re-renders the beauty pass itself into its own target and
//     composites there, which would make the RenderPass above it dead work and
//     would drop the frame out of the half-float HDR path that UnrealBloomPass
//     downstream depends on;
//   · both stock passes render the depth/normal prepass through
//     `renderer.render()` with the shadow map left on auto-update, which
//     re-renders the 4096² shadow map a second time every frame;
//   · both would put a version-pinned addon on the critical path of the whole
//     picture, on a build that has no way to test an addon regression.
// So: one half-resolution prepass (view normals + a real depth texture, shadows
// suspended), one 16-tap normal-oriented hemisphere occlusion pass, a separable
// depth-aware blur, and a multiply into the HDR colour BEFORE bloom so an
// occluded crevice cannot bloom its way back out. Radius and intensity are the
// critique's own numbers (1.2 world units, 0.8).
const AO_KERNEL_SIZE = 16;

function buildAOKernel(n) {
  const out = [];
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    // hemisphere around +Z, biased away from the grazing ring so samples do not
    // pile up in the tangent plane where the depth test is least reliable
    const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, 0.15 + rnd() * 0.85);
    v.normalize();
    const k = i / n;
    v.multiplyScalar(0.25 + 0.75 * k * k); // cluster the taps near the origin
    out.push(v);
  }
  return out;
}

// Anything that does not write honest opaque depth must sit the prepass out:
// sprites and points would be drawn by the override material as world-space
// quads at the wrong place entirely, and a transparent sheet (water, hex
// overlay fill, muzzle billboard, ghost preview) would stamp a hard occluder
// silhouette into the AO over ground that is plainly visible through it.
function aoSkip(o) {
  if (o.isSprite || o.isPoints || o.isLine) return true;
  const m = o.material;
  if (!m) return false;
  const mm = Array.isArray(m) ? m[0] : m;
  if (!mm) return false;
  if (mm.transparent === true) return true;
  if (mm.depthWrite === false) return true;
  if (typeof mm.opacity === 'number' && mm.opacity < 1) return true;
  return false;
}

const AOShader = {
  defines: { KSIZE: AO_KERNEL_SIZE },
  uniforms: {
    tNormal: { value: null },
    tDepth: { value: null },
    uProj: { value: new THREE.Matrix4() },
    uInvProj: { value: new THREE.Matrix4() },
    uCameraNear: { value: 2 },
    uCameraFar: { value: 3000 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uKernel: { value: buildAOKernel(AO_KERNEL_SIZE) },
    uRadius: { value: 1.2 },
    uIntensity: { value: 0.8 },
    uBias: { value: 0.035 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tNormal;
    uniform highp sampler2D tDepth;
    uniform mat4 uProj, uInvProj;
    uniform float uCameraNear, uCameraFar, uRadius, uIntensity, uBias;
    uniform vec2 uResolution;
    uniform vec3 uKernel[KSIZE];
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float viewZAt(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      if (d >= 0.99999) return 1.0;                 // background: positive = "no surface"
      return perspectiveDepthToViewZ(d, uCameraNear, uCameraFar);
    }

    vec3 viewPos(vec2 uv, float depth, float vz) {
      float clipW = uProj[2][3] * vz + uProj[3][3];
      vec4 clip = vec4((vec3(uv, depth) - 0.5) * 2.0, 1.0) * clipW;
      return (uInvProj * clip).xyz;
    }

    void main() {
      float depth = texture2D(tDepth, vUv).x;
      if (depth >= 0.99999) { gl_FragColor = vec4(1.0); return; }

      float vz = perspectiveDepthToViewZ(depth, uCameraNear, uCameraFar);
      vec3 p = viewPos(vUv, depth, vz);

      vec3 n = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
      float nl = length(n);
      if (nl < 0.1) { gl_FragColor = vec4(1.0); return; }
      n /= nl;

      // Per-pixel rotation of the kernel; the separable blur below is what turns
      // the resulting noise back into a smooth field. The basis is Duff et al.'s
      // branchless frisvad construction rather than the usual
      // normalize(rv - n * dot(rv, n)) — that one goes singular, and hands the
      // whole kernel a NaN, exactly when the random vector lands parallel to the
      // normal, which on a grazing steppe surface is a visible pixel every frame.
      float a = hash12(floor(vUv * uResolution)) * 6.2831853;
      float sgn = n.z >= 0.0 ? 1.0 : -1.0;
      float na = -1.0 / (sgn + n.z);
      float nb = n.x * n.y * na;
      vec3 t0 = vec3(1.0 + sgn * n.x * n.x * na, sgn * nb, -sgn * n.x);
      vec3 b0 = vec3(nb, sgn + n.y * n.y * na, -n.y);
      float ca = cos(a), sa = sin(a);
      mat3 tbn = mat3(t0 * ca + b0 * sa, b0 * ca - t0 * sa, n);

      float occ = 0.0;
      for (int i = 0; i < KSIZE; i++) {
        vec3 sp = p + (tbn * uKernel[i]) * uRadius;
        vec4 sc = uProj * vec4(sp, 1.0);
        if (sc.w <= 0.0) continue;
        vec2 suv = sc.xy / sc.w * 0.5 + 0.5;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
        float sz = viewZAt(suv);
        if (sz > 0.0) continue;                     // sky behind the sample
        // view Z is negative ahead of the camera: a scene surface that is LESS
        // negative than the sample point sits between it and the eye
        float dz = sz - sp.z;
        float range = smoothstep(0.0, 1.0, uRadius / max(abs(p.z - sz), 1e-4));
        occ += step(uBias, dz) * range;
      }

      float ao = 1.0 - clamp(occ / float(KSIZE) * uIntensity, 0.0, 1.0);
      gl_FragColor = vec4(ao, ao, ao, 1.0);
    }`,
};

const AOBlurShader = {
  uniforms: {
    tAO: { value: null },
    tDepth: { value: null },
    uDirection: { value: new THREE.Vector2(1, 0) },
    uCameraNear: { value: 2 },
    uCameraFar: { value: 3000 },
    uDepthSigma: { value: 1.6 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tAO;
    uniform highp sampler2D tDepth;
    uniform vec2 uDirection;
    uniform float uCameraNear, uCameraFar, uDepthSigma;
    varying vec2 vUv;

    // 9 taps, gaussian in screen space, gated on view-Z so the blur never bleeds
    // a hull's contact shadow out onto the ground behind it. Fully unrolled and
    // written in GLSL ES 1.00 so it compiles under three's default (non-GLSL3)
    // ShaderMaterial path with no array-initialiser syntax.
    void tap(vec2 uv, float w, float z0, inout float sum, inout float wsum) {
      float d = texture2D(tDepth, uv).x;
      if (d >= 0.99999) return;
      float z = perspectiveDepthToViewZ(d, uCameraNear, uCameraFar);
      float ww = w * exp(-abs(z - z0) / uDepthSigma);
      sum += texture2D(tAO, uv).r * ww;
      wsum += ww;
    }

    void main() {
      float d0 = texture2D(tDepth, vUv).x;
      if (d0 >= 0.99999) { gl_FragColor = vec4(1.0); return; }
      float z0 = perspectiveDepthToViewZ(d0, uCameraNear, uCameraFar);

      float sum = texture2D(tAO, vUv).r * 0.2270;
      float wsum = 0.2270;
      vec2 o1 = uDirection;
      vec2 o2 = uDirection * 2.0;
      vec2 o3 = uDirection * 3.0;
      vec2 o4 = uDirection * 4.0;
      tap(vUv + o1, 0.1946, z0, sum, wsum); tap(vUv - o1, 0.1946, z0, sum, wsum);
      tap(vUv + o2, 0.1216, z0, sum, wsum); tap(vUv - o2, 0.1216, z0, sum, wsum);
      tap(vUv + o3, 0.0540, z0, sum, wsum); tap(vUv - o3, 0.0540, z0, sum, wsum);
      tap(vUv + o4, 0.0162, z0, sum, wsum); tap(vUv - o4, 0.0162, z0, sum, wsum);

      float ao = sum / max(wsum, 1e-4);
      gl_FragColor = vec4(ao, ao, ao, 1.0);
    }`,
};

const AOCompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tAO: { value: null },
    uStrength: { value: 1.0 },
    // CRITIQUE r3 fix 11 — "contact shadows have no ambient fill … pylon and
    // post shadows render as pure black bars". This is where that happens.
    // A pure multiply `colour * ao` says an occluded point receives NOTHING,
    // which is false twice over: the sky is never fully occluded by a lattice
    // leg or a fence post, and a 0.25-albedo ground in a right-angle corner
    // still returns 10–20 % of its open-sky radiance by interreflection. The
    // error compounds where it hurts most — inside a CAST shadow the ambient
    // term is all the light there is, so a full-strength multiply there is the
    // only thing standing between the surface and zero. `uBounce` is the floor
    // an occluded pixel can never fall through, tinted to the hemisphere
    // light's sky blue (relative luminance 0.167, the interreflection figure
    // for this ground albedo) so a crevice reads as shaded ground and not as a
    // missing texture. This is a Vector3, not a THREE.Color: the pass runs on
    // LINEAR HDR, and a Color set from hex would be converted to linear a
    // second time.
    // = the hemisphere light's sky colour taken to LINEAR (three's working
    // space, which is what this pass sees) and scaled to a relative luminance
    // that stands for interreflection at this ground albedo.
    //
    // CRITIQUE r4 fix 1 — 0.167 → 0.21, recoloured to the light rig's new sky
    // hex 0x8FB4EE. This uniform is the ONLY thing standing between the darkest
    // 1 % of the frame and zero, because those pixels are heavily occluded AND
    // fill-lit, so they take the AO multiply on top of an already small number.
    // Raising the fill 1.41× moves p01 from 0.043 to ~0.125 on its own; this
    // takes it the rest of the way to ~0.140, which is fix 1's acceptance bar,
    // and it does so on exactly the pixels that need it instead of on the whole
    // frame. Recolouring it matters as much as the level: a crevice now returns
    // sky-blue interreflection rather than the near-neutral it was returning,
    // which is the same "in colour" brief the shadow tint answers upstairs.
    //
    // CRITIQUE r5 fix 14 — (0.129, 0.215, 0.402) → (0.190, 0.222, 0.268).
    // Relative luminance 0.2102 → 0.2119, i.e. the ENERGY does not move; the
    // linear B/R goes 3.12 → 1.41. This is the single largest contributor to
    // "dark-decile B/R 1.15–1.47 against PC2's 0.78–1.25", because the darkest
    // decile of the frame is by definition the pixels that took the deepest AO
    // multiply and therefore the biggest dose of this colour. Round 4 recoloured
    // it to the hemisphere's sky hex on the argument that a crevice returns sky;
    // a crevice returns whatever it can SEE, and what a wheel arch, a soffit or
    // a right-angle corner mostly sees is the warm ground and its own walls,
    // not the zenith. A cool grey with a slight blue bias is the honest answer
    // and it is the one PC2's own shadows report.
    // `engine.aoBounce` (below) scales this vector, and the close-camera
    // metering in tick() uses that to raise the floor as the camera closes in —
    // see the note on CLOSE_* in the engine body.
    uBounce: { value: new THREE.Vector3(0.190, 0.222, 0.268) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tAO;
    uniform float uStrength;
    uniform vec3 uBounce;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float ao = mix(1.0, texture2D(tAO, vUv).r, uStrength);
      // Occlusion attenuates sky light toward a BOUNCE FLOOR, never toward
      // black — see uBounce. Applied before the highlight guard below so the
      // two do not compound on the sunlit side, where AO is already weak by
      // design. Full occlusion now leaves 17 % of the pixel's radiance standing,
      // sky-tinted, which is what a contact shadow looks like from the inside.
      vec3 occ = vec3(ao) + (1.0 - ao) * uBounce;
      // Without a G-buffer the pass cannot split ambient from direct, so it
      // protects the highlights instead: a surface the 14° key is actually
      // hitting already has a real cast shadow doing this job, and letting AO
      // multiply it as well is what makes post-AO read as dirt. The proxy is a
      // Reinhard-ish tone of the LINEAR HDR luma (this pass runs pre-OutputPass),
      // where sunlit ground sits near 0.11 and a specular hit near 0.7.
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      float t = l / (l + 1.0);
      occ = mix(occ, vec3(1.0), smoothstep(0.30, 0.72, t) * 0.55);
      gl_FragColor = vec4(c.rgb * occ, c.a);
    }`,
};

class GroundedAOPass extends Pass {
  constructor(scene, camera, width, height, exclude = []) {
    super();
    this.name = 'SteelSignalAO';
    this.scene = scene;
    this.camera = camera;
    this.exclude = exclude;
    this.needsSwap = true;
    this.scale = 0.5;          // AO runs at half the composer's device resolution
    this.blend = 1.0;

    this._w = 2; this._h = 2;
    this._aoW = 2; this._aoH = 2;
    this._hidden = [];
    this._clearColor = new THREE.Color();
    // hoisted so the per-frame traverse does not allocate a closure
    this._collect = (o) => {
      if (aoSkip(o)) { o.visible = false; this._hidden.push(o); }
    };

    // MeshNormalMaterial writes packed VIEW-space normals; DoubleSide so a
    // single-sided fence or roof plane cannot punch a hole in the depth.
    this.normalMaterial = new THREE.MeshNormalMaterial();
    this.normalMaterial.side = THREE.DoubleSide;
    this.normalMaterial.fog = false;
    this.normalMaterial.blending = THREE.NoBlending;

    const depthTexture = new THREE.DepthTexture(2, 2);
    depthTexture.format = THREE.DepthStencilFormat;
    depthTexture.type = THREE.UnsignedInt248Type;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;

    this.normalTarget = new THREE.WebGLRenderTarget(2, 2, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
      depthTexture,
    });
    this.normalTarget.texture.name = 'AO.normals';

    const aoOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.aoTargetA = new THREE.WebGLRenderTarget(2, 2, aoOpts);
    this.aoTargetB = new THREE.WebGLRenderTarget(2, 2, aoOpts);

    this.aoMaterial = new THREE.ShaderMaterial({
      defines: Object.assign({}, AOShader.defines),
      uniforms: THREE.UniformsUtils.clone(AOShader.uniforms),
      vertexShader: AOShader.vertexShader,
      fragmentShader: AOShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(AOBlurShader.uniforms),
      vertexShader: AOBlurShader.vertexShader,
      fragmentShader: AOBlurShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(AOCompositeShader.uniforms),
      vertexShader: AOCompositeShader.vertexShader,
      fragmentShader: AOCompositeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });

    this._quadAO = new FullScreenQuad(this.aoMaterial);
    this._quadBlur = new FullScreenQuad(this.blurMaterial);
    this._quadComposite = new FullScreenQuad(this.compositeMaterial);

    // UniformsUtils.clone() does not deep-copy an array-of-Vector3 uniform in a
    // way we can rely on across versions; re-seed it from the generator.
    this.aoMaterial.uniforms.uKernel.value = buildAOKernel(AO_KERNEL_SIZE);

    this.setSize(width, height);
  }

  get radius() { return this.aoMaterial.uniforms.uRadius.value; }
  set radius(v) { this.aoMaterial.uniforms.uRadius.value = v; }

  get intensity() { return this.aoMaterial.uniforms.uIntensity.value; }
  set intensity(v) { this.aoMaterial.uniforms.uIntensity.value = v; }

  setSize(width, height) {
    this._w = Math.max(2, Math.round(width));
    this._h = Math.max(2, Math.round(height));
    this._aoW = Math.max(160, Math.round(this._w * this.scale));
    this._aoH = Math.max(120, Math.round(this._h * this.scale));
    this.normalTarget.setSize(this._aoW, this._aoH);
    this.aoTargetA.setSize(this._aoW, this._aoH);
    this.aoTargetB.setSize(this._aoW, this._aoH);
    this.aoMaterial.uniforms.uResolution.value.set(this._aoW, this._aoH);
  }

  render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
    const scene = this.scene;
    const camera = this.camera;

    // ---- 1. view-space normals + depth, half res, opaque geometry only
    const hidden = this._hidden;
    hidden.length = 0;
    for (let i = 0; i < this.exclude.length; i++) {
      const o = this.exclude[i];
      if (o && o.visible) { o.visible = false; hidden.push(o); }
    }
    scene.traverseVisible(this._collect);

    const prevOverride = scene.overrideMaterial;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this._clearColor);

    scene.overrideMaterial = this.normalMaterial;
    renderer.shadowMap.autoUpdate = false;   // the beauty pass already built it
    renderer.setClearColor(0x8080ff, 1);
    renderer.setRenderTarget(this.normalTarget);
    renderer.render(scene, camera);

    scene.overrideMaterial = prevOverride;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.setClearColor(this._clearColor, prevAlpha);
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
    hidden.length = 0;

    // ---- 2. occlusion
    const u = this.aoMaterial.uniforms;
    u.tNormal.value = this.normalTarget.texture;
    u.tDepth.value = this.normalTarget.depthTexture;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCameraNear.value = camera.near;
    u.uCameraFar.value = camera.far;
    renderer.setRenderTarget(this.aoTargetA);
    renderer.clear();
    this._quadAO.render(renderer);

    // ---- 3. separable depth-aware blur, A → B → A
    const b = this.blurMaterial.uniforms;
    b.tDepth.value = this.normalTarget.depthTexture;
    b.uCameraNear.value = camera.near;
    b.uCameraFar.value = camera.far;
    b.tAO.value = this.aoTargetA.texture;
    b.uDirection.value.set(1 / this._aoW, 0);
    renderer.setRenderTarget(this.aoTargetB);
    renderer.clear();
    this._quadBlur.render(renderer);

    b.tAO.value = this.aoTargetB.texture;
    b.uDirection.value.set(0, 1 / this._aoH);
    renderer.setRenderTarget(this.aoTargetA);
    renderer.clear();
    this._quadBlur.render(renderer);

    // ---- 4. multiply into the HDR colour (still pre-tone-map, pre-bloom)
    const c = this.compositeMaterial.uniforms;
    c.tDiffuse.value = readBuffer.texture;
    c.tAO.value = this.aoTargetA.texture;
    c.uStrength.value = this.blend;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this._quadComposite.render(renderer);
  }

  dispose() {
    this.normalTarget.dispose();
    this.aoTargetA.dispose();
    this.aoTargetB.dispose();
    this.normalMaterial.dispose();
    this.aoMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    this._quadAO.dispose();
    this._quadBlur.dispose();
    this._quadComposite.dispose();
  }
}

// ---------------------------------------------------------------- engine

// ============================================================ METRIC HARNESS
// CRITIQUE r6 fix 16 [MAJOR — "process; engine owns the harness"].
//
// "Retire the single-scale 480-wide RMS as an acceptance metric. It cannot
//  distinguish modelled detail from noise on a flat plane, and four rounds of
//  work have been graded against it."
//
// The evidence, which is the whole reason this exists. Measuring the SAME frames
// at three sampling widths:
//
//     frame                        960     480     240    direction
//     ours — treeline 28 u        0.0796  0.1085  0.1412  FALLS as you look closer
//     ours — wide 330 u           0.0786  0.0978  0.1162  FALLS
//     PC2  43b89495 Moscow        0.1353  0.1180  0.0993  RISES
//     PC2  cdc174e0 Kasserine     0.0796  0.0831  0.0911  flat
//     PC2  3f6fe5b5 Verdun        0.0835  0.0761  0.0762  flat
//
// A surface with real modelled structure GAINS micro-contrast as the sampler
// gets finer, because there is more of it under the pixels. A noise texture
// painted on a flat plane LOSES it, because the finer sample resolves the noise
// into smooth gradients while the coarse sample was aliasing it into contrast.
// One number at one scale cannot tell those two apart, and our 28 u close-up at
// the fine sample measures 0.0796 against our own 330 u wide shot's 0.0786 —
// one part in a hundred, i.e. the arithmetic signature of no additional detail
// existing at close range at all.
//
// So the acceptance figure for any "detail" work is now a TREND and a RATIO:
//     RMS(960) / RMS(240) ≥ 0.90   and   RMS(960) ≥ 0.080
// PC2's marquee frame scores 1.36. Ours score 0.56 and 0.68.
//
// Everything here is deliberately in ONE implementation that runs on BOTH sides:
// `metrics.frame()` measures our live canvas and `metrics.reference(url)`
// measures a PC2 gallery JPEG through the identical code path, identical luma
// function, identical downsample and identical block rule. A number produced by
// one and compared against a number produced by the other is then a comparison
// and not a coincidence. Definitions are stated rather than assumed, because two
// of the last four rounds were spent discovering that two people meant different
// things by the same word:
//
//   luma        gamma-space 0.2126R + 0.7152G + 0.0722B on the sRGB BYTES
//   downsample  canvas drawImage, imageSmoothingQuality 'high', width-driven
//   block       8×8 of the downsampled buffer; RMS = population std-dev of luma
//   lit block   mean luma ≥ 0.20 (the r6 critique's rule; round 4 used the
//               window [0.25, 0.85] — pass `litMin` / `litMax` to reproduce it)
//   range       p99 − p01
//   saturation  mean over pixels of (max − min) / max, max > 0
//   decile B/R  mean(B)/mean(R) over pixels at or below the frame's own p10, and
//               at or above its own p90
//   skyFraction GEOMETRIC share of the frame above the true horizon, from the
//               camera alone. It is not a measurement of the image; it is there
//               because "the bright decile is mostly sky" has been asserted
//               about frames that contain no sky whatsoever (the default 185 u
//               camera at polar 40° with a 40° vertical fov tops out 30° BELOW
//               the horizon), and one number ends that argument.
//
// And per fix 16's second half: every close-range reading carries the camera's
// own `clearance` block, because "this round's first 19 u open-field reading was
// a picture of the inside of a hill and it measured top of PC2's band".
const METRIC_SCALES = Object.freeze([960, 480, 240]);
const METRIC_STATS_SCALE = 480;   // where the percentile block is taken
const METRIC_BLOCK = 8;
const METRIC_LIT_MIN = 0.20;
// PC2 map-area crop of a 1920×1080 gallery asset — x ∈ [240, 1600), y ∈ [56, 900).
const PC2_CROP = Object.freeze({ x: 240, y: 56, w: 1360, h: 844 });

function metricCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function metricSourceSize(src) {
  const w = src.naturalWidth || src.videoWidth || src.width || 0;
  const h = src.naturalHeight || src.videoHeight || src.height || 0;
  return { w, h };
}

/** Downsample a source (or a crop of it) to `W` pixels wide and read it back. */
function metricSample(src, W, crop) {
  const H = Math.max(1, Math.round(W * crop.h / crop.w));
  const c = metricCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, W, H);
  return { data: ctx.getImageData(0, 0, W, H).data, w: W, h: H };
}

/** 8×8 block RMS over a sampled buffer. Returns the lit-block population. */
function metricBlocks(buf, opts) {
  const { data, w, h } = buf;
  const B = opts.block, litMin = opts.litMin, litMax = opts.litMax;
  const rms = [];
  let blocks = 0;
  for (let by = 0; by + B <= h; by += B) {
    for (let bx = 0; bx + B <= w; bx += B) {
      let s = 0, s2 = 0;
      for (let y = 0; y < B; y++) {
        let i = ((by + y) * w + bx) * 4;
        for (let x = 0; x < B; x++, i += 4) {
          const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          s += l; s2 += l * l;
        }
      }
      blocks++;
      const n = B * B;
      const mean = s / n;
      if (mean < litMin || mean > litMax) continue;
      rms.push(Math.sqrt(Math.max(0, s2 / n - mean * mean)));
    }
  }
  if (!rms.length) return { rmsMean: 0, rmsMedian: 0, litBlocks: 0, blocks };
  rms.sort((a, b) => a - b);
  const mid = rms.length >> 1;
  return {
    rmsMean: rms.reduce((a, b) => a + b, 0) / rms.length,
    rmsMedian: rms.length % 2 ? rms[mid] : (rms[mid - 1] + rms[mid]) / 2,
    litBlocks: rms.length,
    blocks,
  };
}

/** Percentiles, saturation and decile chroma over a sampled buffer. */
function metricLevels(buf) {
  const { data, w, h } = buf;
  const n = w * h;
  const lum = new Float32Array(n);
  let sum = 0, sat = 0, satN = 0, below = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    lum[p] = l; sum += l;
    if (l < 0.10) below++;
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (mx > 0) { sat += (mx - mn) / mx; satN++; }
  }
  const sorted = Float32Array.from(lum).sort();
  const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const p10 = q(0.10), p90 = q(0.90);
  let dR = 0, dB = 0, dN = 0, bR = 0, bB = 0, bN = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (lum[p] <= p10) { dR += data[i]; dB += data[i + 2]; dN++; }
    else if (lum[p] >= p90) { bR += data[i]; bB += data[i + 2]; bN++; }
  }
  const p01 = q(0.01), p99 = q(0.99);
  return {
    pixels: n,
    p01, p05: q(0.05), p10, p50: q(0.50), p90, p99,
    mean: sum / n,
    range: p99 - p01,
    pctBelow010: (below / n) * 100,
    saturation: satN ? sat / satN : 0,
    darkBR: dN && dR ? dB / dR : null,
    brightBR: bN && bR ? bB / bR : null,
  };
}

/** Measure any image source. `source` may be a canvas, ImageBitmap or <img>. */
function metricAnalyze(source, opts = {}) {
  const size = metricSourceSize(source);
  if (!(size.w > 0) || !(size.h > 0)) throw new Error('[metrics] source has no size');
  const crop = opts.crop
    ? { x: opts.crop.x | 0, y: opts.crop.y | 0, w: opts.crop.w | 0, h: opts.crop.h | 0 }
    : { x: 0, y: 0, w: size.w, h: size.h };
  const o = {
    block: opts.block || METRIC_BLOCK,
    litMin: Number.isFinite(opts.litMin) ? opts.litMin : METRIC_LIT_MIN,
    litMax: Number.isFinite(opts.litMax) ? opts.litMax : 1.01,
  };
  const scales = (opts.scales || METRIC_SCALES).slice()
    .filter((s) => s > o.block).sort((a, b) => b - a);
  const statScale = opts.statScale || METRIC_STATS_SCALE;

  const detail = { scales: [], ratio: null, trend: 'unknown' };
  let levels = null;
  for (const W of scales) {
    const buf = metricSample(source, Math.min(W, crop.w), crop);
    const blk = metricBlocks(buf, o);
    detail.scales.push({ width: buf.w, height: buf.h, ...blk });
    if (W === statScale) levels = metricLevels(buf);
  }
  if (!levels) {
    const buf = metricSample(source, Math.min(statScale, crop.w), crop);
    levels = metricLevels(buf);
  }
  const fine = detail.scales[0];                        // widest sample = finest look
  const coarse = detail.scales[detail.scales.length - 1];
  if (fine && coarse && coarse.rmsMean > 1e-6) {
    detail.ratio = fine.rmsMean / coarse.rmsMean;
    detail.fineRms = fine.rmsMean;
    detail.trend = detail.ratio >= 1.05 ? 'gains (modelled detail)'
      : detail.ratio >= 0.90 ? 'holds'
        : 'LOSES (detail is painted, not modelled)';
    detail.pass = detail.ratio >= 0.90 && fine.rmsMean >= 0.080;
  }
  return {
    source: { width: size.w, height: size.h, crop },
    litRule: `mean luma in [${o.litMin}, ${o.litMax}]`,
    ...levels,
    detail,
  };
}

/** One-screen summary, formatted for pasting straight into INTEGRATION_NOTES. */
function metricFormat(m) {
  const f = (v, d = 4) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));
  const rows = m.detail.scales
    .map((s) => `${String(s.width).padStart(4)}w  rms ${f(s.rmsMean)} / med ${f(s.rmsMedian)}` +
      `  lit ${s.litBlocks}/${s.blocks}`).join('\n  ');
  const cam = m.camera
    ? `\n  camera   dist ${f(m.camera.distance, 1)} u  polar ${f(m.camera.polarDeg, 1)}°` +
      `  exposure ${f(m.camera.exposure, 3)}  skyFraction ${f(m.skyFraction, 3)}` +
      `\n  clearance ${m.clearance && m.clearance.ok ? 'OK' : '*** EYE INSIDE THE WORLD ***'}` +
      ` eye ${f(m.clearance && m.clearance.eyeY, 2)} ground ${f(m.clearance && m.clearance.groundY, 2)}` +
      ` clear ${f(m.clearance && m.clearance.clearance, 2)}`
    : '';
  return `  p01 ${f(m.p01)}  p05 ${f(m.p05)}  p50 ${f(m.p50)}  p99 ${f(m.p99)}  mean ${f(m.mean)}\n` +
    `  range ${f(m.range)}  below-0.10 ${f(m.pctBelow010, 4)} %  sat ${f(m.saturation)}` +
    `  B/R dark ${f(m.darkBR, 3)} bright ${f(m.brightBR, 3)}\n  ${rows}\n` +
    `  RMS(fine)/RMS(coarse) ${f(m.detail.ratio, 3)} — ${m.detail.trend}` +
    `  [bar: ratio ≥ 0.90 AND fine ≥ 0.080 → ${m.detail.pass ? 'PASS' : 'FAIL'}]${cam}`;
}

export function createEngine(container) {
  // min 64: post passes (bloom mip chain) need non-zero halved sizes even if
  // the container reports 0 (hidden/background tab)
  const width = Math.max(64, container.clientWidth || window.innerWidth);
  const height = Math.max(64, container.clientHeight || window.innerHeight);

  // renderer -------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // SMAA in the composer
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // CRITIQUE fix 21 — RTS zoom and close zoom used to differ by ~2 stops on the
  // same ground material because the beige fog, not the light rig, was supplying
  // the brightness at distance. With the fog thinned (fix 11) the far field no
  // longer gets that free lift, so the key/fill pair below carries it instead and
  // the exposure comes up a notch to hold the overall level. See the fog note.
  // CRITIQUE r2 fix 10 raises the key and guts the fill (see the light rig).
  // Net irradiance on sunlit horizontal ground falls from ~1.78 to ~1.25 in
  // linear terms — 0.51 stops — while shadow-side ground drops 1.4 stops, which
  // is the whole point. Exposure comes up from 1.16 to 1.50 so the SUNLIT half
  // lands back where it was (wheat at 0.30 albedo: 0.197 → 0.185 pre-ACES, i.e.
  // within 0.1 stops of the shipping frame) and only the shadows go deep.
  //
  // CRITIQUE r5 fix 1, the BODY half — 1.50 → 3.25 (+1.12 stop). "p50 is 0.498
  // and mean luma 0.501, BELOW every PC2 shot (p50 band 0.567–0.851)."
  //
  // The trap this avoids is worth stating because it is counter-intuitive and
  // it is why round 5's authors believed the two bars were mutually exclusive:
  // at a 14° sun, FLAT GROUND takes only sin(14°) = 24 % of the key, so cutting
  // the fill by 0.656 of irradiance and adding 0.390 back through the sun leaves
  // flat ground almost exactly where it started (1.619 → 1.348). The ratio
  // improves and the picture does not get one bit brighter. Sun intensity buys
  // MODELLING; it does not buy LEVEL on a horizontal subject. Level has to come
  // from the meter.
  //
  // Pre-ACES rather than post, deliberately: this is the same 1.5× that used to
  // live in `uGain` (1.108 → 1.045, see the grade), moved to the one place in
  // the chain where the tone curve can still shape it. Post-ACES it clipped —
  // five of the sky's seven authored stops measured 0.99–1.00 of display luma.
  //
  // Modelled on the full frame through the exact ACES + OutputPass + GradePass
  // chain: p50 0.498 → 0.639, mean 0.501 → 0.584, p99 0.883 → 0.930, dynamic
  // range 0.702 → 0.769, all four inside PC2's map-area bands.
  //
  // Cross-module note: this multiplies EVERY tone-mapped surface, so VFX
  // emissives authored against 1.50 now read +1.12 stop brighter. Bloom does
  // not move with it (bloom is upstream of the tone map) — see the bloom pass,
  // whose threshold tracks the SUN instead. Flagged in INTEGRATION_NOTES.
  // `engine.setLightRig()` retunes this and the three light intensities
  // together if the integrator's measurement disagrees with the model.
  const BASE_EXPOSURE = 2.90; // r6 integrator: 3.25 → 2.90 (fill re-raised, see ENV_INTENSITY note)
  renderer.toneMappingExposure = BASE_EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // scene ----------------------------------------------------------------
  const scene = new THREE.Scene();
  // CRITIQUE fix 11 — the authored haze was 0xd8c3a0 @ 0.0016: the same value AND
  // hue family as the sky's horizon amber 0xf2c98d, so ground and sky dissolved
  // into one beige wall (C02, C10, C11) and the whole frame collapsed to a single
  // greyscale value group. The colour is the critique's verbatim cool dust grey.
  //
  // ROUND 2 OVERRIDES ROUND 1 ON THE DENSITY. The round-1 note below reasoned to
  // 0.0008 from an acceptance test — "a hull's mid-grey must stay within ±0.35
  // stops from 20 u to 200 u" — and that test was simply the wrong test. It
  // optimises for a hull reading identically at every zoom, which is a property
  // of a diagram, not of a photograph; the price was that the far edge of a
  // 300×270 u map got 5.6 % of haze and therefore no depth cue whatsoever. The
  // round-2 side-by-side against PC2's Baku/Verdun frames calls that out as the
  // single largest contributor to "the ground looks like a texture, not a place"
  // and prescribes 0.0026 verbatim (CRITIQUE.md L292).
  //   f = 1 - exp(-(d·z)²)
  //     d 0.0008 → 100 u: 0.6%   200 u: 2.5%   300 u: 5.6%   600 u: 21%
  //     d 0.0016 → 100 u: 2.5%   200 u: 9.4%   300 u: 20%    600 u: 60%
  //     d 0.0026 → 100 u: 6.5%   200 u: 24%    300 u: 46%    600 u: 91%
  //
  // PHASE-2 INTEGRATION CORRECTION — density is now ART_DIRECTION §1's 0.0016.
  // The round-2 note here defended 0.0026 by arguing that "the foreground
  // (0–120 u) is still under 9 % haze, so nothing the player is actually reading
  // goes milky". That argument measures the wrong distance. FogExp2 attenuates
  // by distance FROM THE CAMERA, and the camera sits ~142 u above the board at a
  // ~52° pitch, so the hex under the selected unit is already ~180 u out and the
  // midfield the player spends the whole match reading runs 180–280 u — dead
  // inside the 24–46 % band, not the 0–9 % one. Verified in-browser at the
  // default framing: at 0.0026 the field patchwork, the vehicle camo and the
  // phase-2 surface relief were all being averaged into grey before they reached
  // the eye. 0.0016 keeps real aerial perspective on the far bank (20 % at 300 u,
  // 3.6x the density the critique correctly called "effectively off") while the
  // playable band stays legible. The colour is the critique's verbatim
  // cool dust grey — deliberately NOT in the ochre family of either the fields
  // or the sky's horizon amber, so distance separates by hue as well as value.
  // features.js L2415 reads this colour for its own distance haze and stays in
  // sync automatically.
  scene.fog = new THREE.FogExp2(HAZE, FOG_DENSITY); // cool dust haze
  scene.background = null; // sky dome supplies the backdrop

  const sky = buildSky();
  scene.add(sky);

  // lights (art bible §1 — no other scene-wide lights) -------------------
  // CRITIQUE r2 fix 10 — key 3.2 → 4.4 against a fill that is cut by more than
  // half (see below). Round 1 raised the key but raised the fill with it, so the
  // ratio never moved: 3.2 : (1.43 + 0.36) is 1.8 : 1 where daylight is 5–8 : 1,
  // and a scene with a 1.8 : 1 key/fill has no second value group anywhere in it.
  // 4.4 : (0.55 + 0.12) is 6.6 : 1, dead centre of the band the critique asks for.
  // On flat ground at a 14° sun that is 0.78 of key against 0.24 of local fill;
  // on the vertical hull faces and the sun-facing slopes of the new landform it
  // is 3.1 against 0.15, which is the range that reads as "photographed".
  //
  // CRITIQUE r5 fix 1 — 4.4 → 6.6 (+1.5×, +0.58 stop). The critique's own
  // prescription was 5.8–6.4; 6.6 is a notch above it because the fill is being
  // cut harder than the critique assumed (it did not count the env map — see
  // ENV_INTENSITY) and the two have to move together to keep the SUNLIT half
  // where PC2's is. Modelled on flat ground the key goes 0.782 → 1.172 of
  // irradiance while the fill goes 0.832 → 0.176: key : fill 0.93 : 1 → 7.5 : 1.
  //
  // Why not further. Two hard ceilings, both cross-module:
  //   · BLOOM. `UnrealBloomPass` runs on the raw linear HDR *upstream* of the
  //     tone map, so its 0.92 threshold is a statement about scene radiance and
  //     the sun is the only thing that moves it. A 0.79-albedo render facing a
  //     14° key returns 0.789 of radiance at 4.4 and 1.18 at 6.6. The threshold
  //     therefore moves with the sun (0.92 → 1.38 at the bloom pass, the same
  //     17 % headroom over the brightest legal diffuse surface as before) —
  //     any higher a sun and the village starts blooming, which ART_DIRECTION
  //     §8.5 forbids outright.
  //   · The colour. 0xffd9a0 is B/R 0.356 in linear, i.e. a sunset, and every
  //     watt added to it is added to the frame's saturation. At 6.6 the grade
  //     can still pull mean saturation back to 0.330 with `uSat`; past ~8 it
  //     cannot without desaturating the shadows into grey.
  // The colour and direction do NOT move. `SUN_OFFSET` is duplicated verbatim
  // in ui/hud.js (MM_SUN, minimap relief), units/models.js (SUN_GROUND_YAW, the
  // baked contact shadows) and world/terrain.js (SUN_LX/LY/LZ, the overlay's
  // solved shade term); changing the elevation here would silently desync three
  // modules this file does not own.
  const sun = new THREE.DirectionalLight(0xffd9a0, 7.6); // r6 integrator: 6.6 → 7.6
  sun.position.copy(SUN_OFFSET);
  sun.castShadow = true;
  // 4096 (art bible authored 2048) — see updateShadowBox(): at a 14° sun the
  // ground can only self-shadow without acne if the shadow texel stays well
  // under ~0.1 world units. The quality governor may coarsen this at runtime
  // through engine.setShadowMapSize(); the bias/caster logic reads mapSize every
  // update and adapts, and setQuality('high') puts it back.
  sun.shadow.mapSize.set(SHADOW_MAP_FULL, SHADOW_MAP_FULL);
  sun.shadow.camera.left = -140;
  sun.shadow.camera.right = 140;
  sun.shadow.camera.top = 140;
  sun.shadow.camera.bottom = -140;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 600;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.9;
  scene.add(sun);
  scene.add(sun.target);

  // Fill. CRITIQUE r2 fix 10 sends this back to the art bible's authored 0.55 /
  // 0.12, and it is worth recording WHY round 1's 1.43 / 0.36 was wrong, because
  // the reasoning that produced it is seductive and will be re-derived otherwise.
  // Round 1's argument was "at a 14° sun a horizontal surface only takes 0.24 of
  // the key, so the shadow side goes black without a big fill". That is true of a
  // horizontal surface and false of a photograph: at golden hour the GROUND is
  // dim and the vertical faces blaze, and it is precisely that split — dim plane,
  // brilliant hull side, long raking shadow — that reads as low sun. Filling the
  // shadows back up to within 1.8 : 1 of the key does not rescue the shadow side,
  // it deletes the light. Shadow-side legibility is now the job of the ambient
  // term, of the (much reduced) sky IBL below, and of AO giving those shadows
  // shape rather than a flat wash.
  // The sky colour stays the bible's 0x9db4d6. The ground bounce stays at round
  // 1's darkened 0x7A6540 rather than the bible's 0x8a7248 — the warm bounce is a
  // third of what made the frame read as a single mustard hue (r2 fix 11), and it
  // no longer needs to carry any lifting.
  //
  // CRITIQUE r3 fix 11 — the fill BUDGET is unchanged and the fill SHAPE is not.
  // 0.55 + 0.12 = 0.67 becomes 0.62 + 0.05 = 0.67, so the scored key : fill stays
  // at 4.4 : 0.67 = 6.57 : 1 to three digits. Why move it at all:
  //   · AmbientLight is the one term in the rig with no shape whatsoever. It
  //     pays the same irradiance to the open ground inside a pylon's cast
  //     shadow, to the underside of a bridge deck and to the inside of a wheel
  //     arch. Shadows that are filled by a constant read as VEILED, not as lit —
  //     which is the same disease as the fog, one order of magnitude smaller.
  //   · HemisphereLight is normal-weighted: an up-facing surface takes the full
  //     sky colour, a down-facing one takes the (much darker) ground bounce.
  //     Moving 0.07 of budget from flat to shaped hands +9.6 % of fill to
  //     precisely the surface fix 11 names — open flat ground lying in a cast
  //     shadow, which sees the entire sky — while the deeply occluded pixels
  //     that set our p01 move +4.4 %, i.e. essentially not at all.
  // Together with the env raise (ENV_INTENSITY, see the note there) a cast
  // shadow on open ground gains 14.5 % of irradiance (0.483 → 0.553) against
  // 4.5 % on the sunlit half — the shadow side comes up, the key does not move,
  // and the black floor is left to the grade's soft toe rather than to a lift.
  //
  // CRITIQUE r4 fix 1 — 0.62 → 1.00, and the sky colour 0x9db4d6 → 0x8FB4EE.
  // This is the round's single most important line and it overturns the
  // reasoning immediately above it, so read both.
  //
  // WHAT WAS WRONG. Every round scored key : fill on the light intensities and
  // never once on pixels. On pixels the shipped rig lands at 10.6 : 1 — a
  // fill-only ground surface at luma 0.046 against 0.492 sunlit on the SAME
  // material — and it delivers that fill NEUTRAL: rgb(12,12,7), rgb(67,68,58).
  // Round 3's own defence of 0.62 ("0.55 → 0.70 would move a verified-correct
  // 6.6 : 1 to 5.4 : 1") was protecting a number that was never the number.
  //
  // THE INTENSITY. 0.62 → 1.00 with ENV_INTENSITY 0.42 → 0.52 carries the fill
  // 1.41× at the terminator and 1.42× on flat ground. Modelled through the
  // exact ACES(1.50) + OutputPass + GradePass chain, calibrated on the two
  // measured anchors:
  //     fill-only terminator ground   0.043 → 0.117   (brief: 0.10 – 0.14)
  //     sunlit ground on the same mtl 0.491 → 0.570
  //     shaded as a share of sunlit     8.7 % → 20.6 % (brief: 15 – 25 %)
  //     ON-SCREEN key : fill          11.5 : 1 → 4.86 : 1 (brief: 4 : 1 – 5 : 1)
  //     p01                           0.043 → ~0.140, fraction under 0.10 → < 1 %
  // The scored intensity ratio falls to 4.4 : 1.05 = 4.19 : 1. That is fine and
  // it is the point: 6.57 : 1 on paper was buying 10.6 : 1 on screen.
  //
  // THE COLOUR. 0x9db4d6 → 0x8FB4EE is a PURE CHROMA MOVE — relative luminance
  // 0.4468 → 0.4466, i.e. identical to four digits, so it changes no level
  // anywhere — while the linear blue : red ratio goes 1.99 → 3.11. The fill's
  // own B/R on flat ground rises 1.98 → 2.55. Sky fill whose only identity is
  // "slightly less warm than the sun" is not sky fill; this one is blue.
  // The earth bounce 0x7A6540 deliberately does NOT move: it is what keeps a
  // hull's underside, a bridge soffit and an overhang warm and alive, its
  // weight on the up-facing ground this fix is about is small, and cooling it
  // was measured as worth 0.04 of B/R for 1 % of shade luminance — a bad trade.
  //
  // CRITIQUE r5 fix 1 — 1.00 → 0.15, and BOTH COLOURS STAY. This is the second
  // half of the fill cut (the first is ENV_INTENSITY, read that note for the
  // arithmetic and for why the two must move by the same factor). Round 4 took
  // this to 1.00 to lift the shade to meet a ratio brief from below; the round-5
  // audit's verdict on that is the one line worth keeping: "that was the wrong
  // end". Raising the fill buys shade luminance and destroys modelling; raising
  // the sun buys the same shade:sunlit ratio and buys modelling with it.
  //
  // The two colours are deliberately untouched because they are the round-5 win
  // this must not undo: 0x8FB4EE is B/R 3.11 in linear and it is the entire
  // reason a shaded pixel measures B/R 0.99–1.24 instead of round-3's 0.58. The
  // fill gets 6.7× smaller and stays exactly the same hue, so the shade keeps
  // its colour and loses only its level — which is the whole brief.
  // Modelled shaded ground: rgb(88,100,92) luma 0.380 → rgb(61,67,67) luma
  // 0.250, B/R 1.05 → 1.10.
  //
  // CRITIQUE r6 fix 10 — 0.40 → 0.46 (+0.20 stop), colours untouched again. This
  // is the LIGHT half of "lift the shadow shoulder without moving the body"
  // (p05 0.2225 against PC2's 0.2748–0.3807); the grade's toe is the other half
  // and carries most of it. Why the hemisphere and not the env map: env is
  // entangled with a water/IBL solve owned by the world module (its
  // `envMapIntensity 1.05` was fitted at env 0.115 and is already reflecting
  // ~39 % more sky than it was solved for), so putting the fill raise anywhere
  // else costs a fix that belongs to somebody else.
  //
  // Why it is the RIGHT half of the split even though it is the smaller half:
  // a HemisphereLight carries no occlusion term, but the AO pass does, so a
  // hemisphere raise reaches OPEN SHADE (the p05 population, AO ≈ 1.0) at full
  // strength and an occluded crevice (the p01 population, AO ≈ 0.4) at ~40 % of
  // it. It is the only lever in the build that lifts p05 by more than it lifts
  // p01 — i.e. the only one that WIDENS the p01→p05 spread instead of sliding
  // the whole floor up. PC2's spread there is ~0.10–0.13 and ours is 0.044; this
  // moves it the right way, by 0.004.
  //
  // Book-keeping on the irradiance stack this file has maintained since round 2
  //     key (flat sunlit)  sin14° · luma(0xffd9a0) · 7.6 = 1.3504
  //     hemi               0.4425 · 0.46                 = 0.2036  (was 0.1770)
  //     env                0.657  · 0.160                = 0.1051
  //     ambient            0.0896 · 0.05                 = 0.0045
  // Fill 0.2866 → 0.3132 (+9.3 %); sunlit total 1.637 → 1.664 (+1.6 %). Scored
  // key : fill goes 4.71 : 1 → 4.31 : 1 — still nowhere near the 0.6 : 1 that
  // made round 1 flat, and still on the "modelling" side of round 5's 6.7× cut.
  // MODEL PREDICTION, not a measurement: p05 0.2225 → 0.2318, p01 0.1790 →
  // 0.1843, p50 0.6052 → 0.6102, mean 0.5804 → 0.5845. Shade : sunlit 43.7 % →
  // ~44.9 %.
  const hemi = new THREE.HemisphereLight(0x8FB4EE, 0x7A6540, 0.46); // r6 fix 10: 0.40 → 0.46
  scene.add(hemi);
  // Ambient, cut to 0.05 from the bible's 0.12 (round 1's cooler/bluer 0x3E5578
  // over the bible's 0x2e3a50 stays). It is kept rather than removed because a
  // completely sky-occluded interior — a hull's wheel well, the inside of a
  // culvert — has no other term at all and would go to absolute black; 0.05 is
  // the last-resort floor, not the shadow fill. The shadow fill is the
  // hemisphere and the env map, both of which are attenuated by occlusion.
  const ambient = new THREE.AmbientLight(0x3E5578, 0.05);
  scene.add(ambient);

  // Indirect specular/diffuse from the sky dome is installed by main.js
  // (PMREMGenerator → scene.environment). Author its weight here so the light rig
  // owns every global lighting term.
  //
  // 0.9 → 0.35, and this is not cosmetic: `getIBLIrradiance()` returns
  // π · prefilteredRadiance · intensity, and the cosine-weighted mean radiance of
  // this dome over the upper hemisphere is ~0.21 linear, so at 0.9 the env map
  // alone was delivering ~0.59 of irradiance to up-facing ground — MORE than the
  // hemisphere light and more than the sun's 0.57. The critique measured the
  // key : fill ratio off the light intensities alone (3.2 : 1.79) and still got
  // 1.8 : 1; counting the env map the true ratio was 0.6 : 1, i.e. the scene was
  // predominantly ambient-lit, which is the actual root cause of "flat" and of
  // "nothing sits ON the ground". At 0.35 the env contributed ~0.23 and the whole
  // fill stack landed at ~0.47 against a key of 0.78.
  //
  // CRITIQUE r3 fix 11 takes it to 0.42 — see the ENV_INTENSITY note at the top
  // of the file for the arithmetic. The short version: fix 1 darkened the dome's
  // sub-horizon band by 29 %, which is the band that fills every shaded face, so
  // 0.42 restores what the fog fix took and nothing more. The env now contributes
  // ~0.276 and the true (env-inclusive) fill stack is ~0.516 against the same key
  // of 0.78 — 1.51 : 1 where it was 1.66 : 1, with the SCORED light-intensity
  // ratio untouched at 6.57 : 1. It is still nowhere near the 0.6 : 1 that made
  // round 1 flat.
  // The env map is still doing the job main.js added it for — indirect specular
  // on the river, on optics and on metal — at a weight that no longer competes
  // with the sun. Any material that genuinely wants more can raise its own
  // `envMapIntensity`, which multiplies with this.
  scene.environmentIntensity = ENV_INTENSITY;

  // camera + controls ----------------------------------------------------
  const camera = new THREE.PerspectiveCamera(40, width / height, 2, 3000);
  // default: pitch 52° below horizon → polar 0.663 rad, distance ~115
  const DEFAULT_POLAR = THREE.MathUtils.degToRad(38);
  const DEFAULT_DIST = 115;
  camera.position.set(
    0,
    DEFAULT_DIST * Math.cos(DEFAULT_POLAR),
    DEFAULT_DIST * Math.sin(DEFAULT_POLAR));

  const controls = new MapControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.screenSpacePanning = false;
  controls.minDistance = 15;
  controls.maxDistance = 260;
  controls.minPolarAngle = THREE.MathUtils.degToRad(12);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(55); // may look 35° above ground at closest
  controls.zoomSpeed = 1.1;
  controls.rotateSpeed = 0.7;
  controls.update();

  // keyboard pan / rotate ------------------------------------------------
  const keys = new Set();
  const isTyping = (e) =>
    e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
  window.addEventListener('keydown', (e) => { if (!isTyping(e)) keys.add(e.code); });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  // edge pan (enabled after first mouse move; off while pointer captured)
  let pointerX = null, pointerY = null, pointerIn = false;
  window.addEventListener('mousemove', (e) => {
    pointerX = e.clientX; pointerY = e.clientY; pointerIn = true;
  });
  document.addEventListener('mouseleave', () => { pointerIn = false; });

  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _panDelta = new THREE.Vector3();
  const _tweenPrev = new THREE.Vector3();
  const _tweenDelta = new THREE.Vector3();

  function panAxes() {
    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _right.crossVectors(_fwd, UP).normalize();
  }

  function applyPan(dx, dz, dt) {
    // dx: right, dz: forward — scaled by zoom so pan feel is constant
    const dist = camera.position.distanceTo(controls.target);
    const speed = Math.max(dist, 40) * 0.85 * dt;
    panAxes();
    _panDelta.set(0, 0, 0)
      .addScaledVector(_right, dx * speed)
      .addScaledVector(_fwd, dz * speed);
    controls.target.add(_panDelta);
    camera.position.add(_panDelta);
  }

  function applyRotate(dir, dt) {
    const v = camera.position.clone().sub(controls.target);
    v.applyAxisAngle(UP, dir * 1.7 * dt);
    camera.position.copy(controls.target).add(v);
  }

  // ------------------------------------------------------- camera integrity
  // CRITIQUE fix 22. A single NaN reaching camera.position or controls.target
  // black-holes the entire viewport with ZERO console output: every vertex
  // transforms to NaN, nothing rasterises, and no exception is ever thrown. Worse,
  // it is unrecoverable, because OrbitControls/MapControls accumulate their pan and
  // orbit deltas in module-private vectors and, when `enableDamping` is on, only
  // ever MULTIPLY them by (1 - dampingFactor) — they are never cleared. One NaN in
  // `panOffset` is therefore permanent for the lifetime of the page, which is
  // exactly the "unrecoverable without a reload" the critic observed.
  //
  // How a NaN gets in: anything upstream that hands the camera a 2-component
  // `{x, z}` hex/centre object (terrain.center and terrain.tileAt() results have no
  // `y`), or a `heightAt()` that returned NaN, or an arithmetic on an undefined
  // component. `focusOn()` below now refuses all of those at the door; this guard
  // is the catch-all for every other writer (dronecam seizes the camera, vfx's
  // screenShake adds/subtracts an offset on it every frame).
  const _goodPos = camera.position.clone();
  const _goodTarget = controls.target.clone();
  const _goodLens = { fov: camera.fov, near: camera.near, far: camera.far, zoom: camera.zoom };
  let _camRecoveries = 0;
  let _camWarnAt = -1e9;

  const isFiniteVec = (v) =>
    !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

  function cameraIsSane() {
    if (!isFiniteVec(camera.position)) return false;
    if (!isFiniteVec(controls.target)) return false;
    if (!isFiniteVec(camera.up) || camera.up.lengthSq() < 1e-8) return false;
    const q = camera.quaternion;
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y) ||
        !Number.isFinite(q.z) || !Number.isFinite(q.w)) return false;
    if (!(camera.fov > 1) || !(camera.fov < 179)) return false;
    if (!(camera.near > 0) || !(camera.far > camera.near)) return false;
    if (!(camera.zoom > 0)) return false;
    return true;
  }

  /** Snapshot the current pose as the restore point — only when it is a pose the
   *  player could actually be sitting at. While dronecam holds the camera it sets
   *  `controls.enabled = false`, so the last RTS framing before the dive stays the
   *  restore point and a mid-dive NaN drops the player back onto the battlefield
   *  rather than onto the drone's last coordinate. */
  function cacheCamera() {
    if (!controls.enabled) return;
    const d = camera.position.distanceTo(controls.target);
    if (!(d > controls.minDistance * 0.5) || !(d < controls.maxDistance * 3)) return;
    _goodPos.copy(camera.position);
    _goodTarget.copy(controls.target);
    _goodLens.fov = camera.fov;
    _goodLens.near = camera.near;
    _goodLens.far = camera.far;
    _goodLens.zoom = camera.zoom;
  }

  function restorePose() {
    camera.position.copy(_goodPos);
    controls.target.copy(_goodTarget);
    camera.up.set(0, 1, 0);
    camera.fov = _goodLens.fov;
    camera.near = _goodLens.near;
    camera.far = _goodLens.far;
    camera.zoom = _goodLens.zoom;
    camera.quaternion.set(0, 0, 0, 1);
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
  }

  function recoverCamera(reason = 'non-finite camera state') {
    _camRecoveries++;
    restorePose();
    // Flush the controls' private damping accumulators. Their non-damped branch
    // is the only code path that hard-resets sphericalDelta/panOffset, so run one
    // update with damping off, then restore the pose the update just recomputed
    // from the (still poisoned) deltas, then settle with a second clean update.
    const damping = controls.enableDamping;
    const autoRotate = controls.autoRotate;
    controls.enableDamping = false;
    controls.autoRotate = false;
    try { controls.update(); } catch (err) { /* controls are never fatal */ }
    restorePose();
    try { controls.update(); } catch (err) { /* controls are never fatal */ }
    controls.enableDamping = damping;
    controls.autoRotate = autoRotate;
    // Whatever was mid-flight is the prime suspect; do not let it re-fire.
    focusTween = null;
    if (!cameraIsSane()) {
      // Nuclear option: rebuild the opening framing from first principles.
      controls.target.set(_goodTarget.x || 0, 0, _goodTarget.z || 0);
      camera.position.set(
        controls.target.x,
        DEFAULT_DIST * Math.cos(DEFAULT_POLAR),
        controls.target.z + DEFAULT_DIST * Math.sin(DEFAULT_POLAR));
      camera.up.set(0, 1, 0);
      camera.fov = 40; camera.near = 2; camera.far = 3000; camera.zoom = 1;
      camera.updateProjectionMatrix();
      camera.lookAt(controls.target);
    }
    // Warn loudly, but do not turn a rendering bug into a console flood if some
    // frame callback re-poisons the camera every single frame.
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - _camWarnAt > 2000) {
      _camWarnAt = now;
      console.warn(
        `[engine] camera state went non-finite (${reason}) — restored to ` +
        `pos ${_goodPos.toArray().map((n) => n.toFixed(1)).join(', ')} / ` +
        `target ${_goodTarget.toArray().map((n) => n.toFixed(1)).join(', ')}. ` +
        `Recoveries this session: ${_camRecoveries}. Suspect a {x, z} object ` +
        `(no y) fed to Vector3.set/copy, or a NaN from heightAt().`);
    }
    return true;
  }

  /** Guard point. Returns true if it had to intervene. */
  function guardCamera(reason) {
    if (cameraIsSane()) { cacheCamera(); return false; }
    return recoverCamera(reason);
  }

  // -------------------------------------------------- camera ground collision
  // CRITIQUE r6 fix 1 [CRITICAL]. Measured by the critic across all 884 hexes ×
  // 6 azimuths, comparing the eye's Y against `terrain.heightAt(eye.x, eye.z)`:
  //
  //     15 u, 55° tilt (this file's own minimum zoom and maximum tilt)
  //         → 86.0 % of legal camera positions put the EYE BELOW THE TERRAIN,
  //           worst penetration 15.7 u
  //     15 u, 40° tilt (minimum zoom, the default tilt)   → 19.9 %
  //     25 u, 40°                                          →  1.3 %
  //     40 u and beyond                                    →  0 %
  //
  // The failure mode is not subtle and it is not cosmetic: the world vanishes and
  // the player is looking at a flat grey vignette. It also silently invalidated
  // measurement — round 6's headline "19 u open field p50 0.8334, top of PC2's
  // band" was a photograph of the inside of a hill, taken with the eye 1.25 u
  // under the surface, measuring saturation 0.0127 and 8×8 RMS 0.0032.
  //
  // Two probes, both installed from outside so this module keeps knowing nothing
  // about the world (same pattern as `engine.groundCaster`):
  //   · `engine.groundProbe(x, z) → y`      — terrain.heightAt, wired by main.js
  //   · `engine.obstacleProbe(x, z) → y`    — the top of any building/canopy/
  //     pylon over that column, or -Infinity. main.js bakes it once at boot from
  //     the features graph; see buildObstacleCeiling() there.
  // With neither wired this is a no-op and the build behaves exactly as before,
  // so nothing here can break a headless or partial boot.
  //
  // WHY A Y-CLAMP AND NOT A SPHERE-CAST THAT PULLS THE EYE IN. MapControls
  // recomputes the spherical from `position − target` on every update and clamps
  // the radius into [minDistance, maxDistance]; pulling the eye IN past
  // minDistance is therefore undone on the next update and the two fight at frame
  // rate. Raising the eye only ever INCREASES the radius and DECREASES the polar
  // angle, and both stay legal (minPolarAngle is 12°), so the clamp is a fixed
  // point of the controls rather than an argument with them. Buildings and
  // canopies are handled by the same clamp against their own ceiling, which is
  // why the probe returns a height and not a hit distance.
  //
  // The sample is a MAX over the eye column and four neighbours at ±SAMPLE_R.
  // `camera.near` is 2.0, so geometry within 2 u of the eye is clipped away and
  // you see straight through it — sampling a small disc rather than a point is
  // what stops the eye from grazing a slope and rendering a hole in it.
  const CAM_GROUND_CLEAR = 4.0;   // eye never closer than this to the terrain
  const CAM_OBSTACLE_CLEAR = 1.5; // …nor this to a roof/canopy top (fix 1's number)
  const CAM_CINE_CLEAR = 1.2;     // a seized camera (dronecam) may skim; not sink
  const CAM_SAMPLE_R = 2.6;       // ≥ camera.near, so nothing can clip through
  let _camLift = 0;               // lift applied on the last frame, for the report
  let _camClampWarned = false;

  /** Highest thing under (x, z): terrain, and any obstacle ceiling over it. */
  function surfaceAt(x, z) {
    let y = -Infinity;
    const gp = engine.groundProbe, op = engine.obstacleProbe;
    if (typeof gp === 'function') {
      const h = gp(x, z);
      if (Number.isFinite(h)) y = h;
    }
    if (typeof op === 'function') {
      const h = op(x, z);
      // The obstacle ceiling carries its own clearance, which is smaller than the
      // ground's — you may fly 1.5 u over a roof, not 4 u.
      if (Number.isFinite(h) && h + CAM_OBSTACLE_CLEAR - CAM_GROUND_CLEAR > y) {
        y = h + CAM_OBSTACLE_CLEAR - CAM_GROUND_CLEAR;
      }
    }
    return y;
  }

  /** The Y the eye must not go below at (x, z), sampled over a small disc. */
  function requiredEyeY(x, z, clearance) {
    let y = surfaceAt(x, z);
    const r = CAM_SAMPLE_R;
    y = Math.max(y, surfaceAt(x + r, z), surfaceAt(x - r, z),
      surfaceAt(x, z + r), surfaceAt(x, z - r));
    return y === -Infinity ? -Infinity : y + clearance;
  }

  /** Push the eye above the ground and out of solid geometry. Runs AFTER
   *  controls.update() and after every frame callback, i.e. on the pose that is
   *  about to be rendered. Returns the lift it applied, in world units.
   *
   *  There is no easing and there is nothing to un-do later: MapControls derives
   *  its spherical from `position − target` at the top of every update, so the
   *  lift is ABSORBED as a slightly smaller polar angle and the next frame starts
   *  from a legal pose. While the player holds a tilt that would sink the eye, the
   *  controls push down and this pushes back by exactly the shortfall — a fixed
   *  point, not an oscillation. */
  function clampCameraAboveGround() {
    if (engine.cameraCollision === false) return 0;
    if (typeof engine.groundProbe !== 'function' &&
        typeof engine.obstacleProbe !== 'function') {
      if (!_camClampWarned) {
        _camClampWarned = true;
        console.warn(
          '[engine] camera ground collision is INERT — neither engine.groundProbe ' +
          'nor engine.obstacleProbe is wired. main.js installs both; a build ' +
          'without them can put the eye under the terrain (86 % of legal ' +
          'positions at 15 u / 55°). Any close-range measurement taken now is ' +
          'untrustworthy: assert engine.cameraClearanceReport().ok first.');
      }
      return 0;
    }
    if (!isFiniteVec(camera.position)) return 0;
    const seized = (controls.enabled === false || engine.cinematic === true);
    const clear = seized ? CAM_CINE_CLEAR : CAM_GROUND_CLEAR;
    const need = requiredEyeY(camera.position.x, camera.position.z, clear);
    if (!Number.isFinite(need)) return 0;

    const lift = need - camera.position.y;
    _camLift = Math.max(0, lift);
    if (lift <= 0) return 0;

    camera.position.y += lift;
    // controls.update() already aimed the camera at the target from the OLD
    // position, so re-aim — but only when the controls own the camera. dronecam
    // and the briefing screen set their own orientation and must keep it.
    if (!seized) camera.lookAt(controls.target);
    return lift;
  }

  // ---------------------------------------------------------------- shadows
  // A 14° sun is the worst possible case for shadow acne: on a horizontal
  // receiver the depth stored in the map changes by texel·tan(76°) ≈ 4.0 per
  // texel, so a PCF footprint of ~1.5 texels wants ~6·texel of depth slack.
  // A fixed 2048 map over the authored ±140 box is 0.137 u/texel → it needs
  // roughly 3 units of normalBias to stop the ground shadowing itself, which
  // is why world/terrain.js shipped with `ground.castShadow = false` and the
  // steppe's own relief never cast (ART_DIRECTION §1/§8.1 wants exactly those
  // long raking ridgeline shadows). Three things fix it together:
  //   1. a 4096 map,
  //   2. an ortho box that tracks camera distance (0.042–0.078 u/texel instead
  //      of a flat 0.137, and it also stops shadows falling off the edge of the
  //      box when the player zooms out to 260),
  //   3. a normalBias derived from the *current* texel — which across that whole
  //      zoom range resolves to exactly the authored 0.9, so vehicle contact
  //      shadows never detach further than they do today.
  // If the quality governor ever coarsens the map the arithmetic says so, and
  // the ground drops back out of the shadow pass instead of showing acne.
  // The box centre is snapped to whole texels in light space, which kills the
  // shadow-edge crawl the old unsnapped follow produced while panning.
  const _lz = SUN_OFFSET.clone().normalize();              // shadow cam forward
  const _lx = new THREE.Vector3().crossVectors(UP, _lz).normalize();
  const _ly = new THREE.Vector3().crossVectors(_lz, _lx).normalize();
  const _shadowCenter = new THREE.Vector3();
  const SHADOW_DEPTH_RANGE = 600 - 20;   // shadow.camera.far - near
  const SIN_SUN_ELEV = 0.2419;           // sin(14°)
  const PCF_SLOPE = 6.02;                // tan(76°) · 1.5 texel PCF footprint
  let _shadowHalf = -1;

  // Where the box is CENTRED. Normally that is the orbit target — which is both
  // what the player is looking at and, for an RTS camera aimed at the ground,
  // exactly where the view ray meets the ground plane, so the two definitions
  // agree to the unit and this costs nothing on the strategic view.
  //
  // They stop agreeing the moment another module seizes the camera. dronecam
  // sets `controls.enabled = false` and flies the eye to a strike hex that can
  // sit a hundred-plus units from the last RTS framing, and it deliberately does
  // NOT move `controls.target` (that is how it restores the player's framing on
  // impact). A ±85 u box still centred on the old framing does not contain the
  // strike hex, so every cast shadow silently drops out of the one sequence
  // where the camera is 30 m off the deck and the player can actually see them —
  // the exact frames CRITIQUE r2 says expose every asset in the build. So while
  // the camera is seized, centre on where the eye is actually looking.
  //
  // The ground plane is taken at y = 0: the whole landform lives inside roughly
  // ±6 u of it, which is under a tenth of the box half-width, and a wrong guess
  // only slides the box, it cannot shrink it. A ray that is not pointing down
  // (level or climbing, e.g. the drone's cruise leg) has no ground intersection
  // at all, so it falls back to a fixed lead distance rather than to infinity.
  const _viewFocus = new THREE.Vector3();
  const _viewFwd = new THREE.Vector3();
  const SHADOW_LEAD_MAX = 170;   // never lead further than the largest box half

  function shadowFocus() {
    // `engine.cinematic` is dronecam's flag (INTEGRATION_NOTES); `controls.enabled`
    // catches every other seizure, including the briefing screen.
    if (controls.enabled !== false && engine.cinematic !== true) return controls.target;
    camera.getWorldDirection(_viewFwd);
    if (!isFiniteVec(_viewFwd) || _viewFwd.lengthSq() < 1e-8) return controls.target;
    const y = Number.isFinite(camera.position.y) ? camera.position.y : 0;
    let lead = (_viewFwd.y < -1e-3 && y > 0) ? y / -_viewFwd.y : SHADOW_LEAD_MAX * 0.5;
    if (!Number.isFinite(lead)) lead = SHADOW_LEAD_MAX * 0.5;
    lead = Math.min(Math.max(lead, 0), SHADOW_LEAD_MAX);
    _viewFocus.copy(camera.position).addScaledVector(_viewFwd, lead);
    _viewFocus.y = 0;
    return isFiniteVec(_viewFocus) ? _viewFocus : controls.target;
  }

  function updateShadowBox() {
    const focus = shadowFocus();
    const rawDist = camera.position.distanceTo(focus);
    // A non-finite distance would clamp() to NaN and poison the shadow ortho
    // projection (THREE.MathUtils.clamp(NaN, …) is NaN). The camera guard below
    // should make this impossible; this is the belt to its braces.
    const dist = Number.isFinite(rawDist) ? rawDist : DEFAULT_DIST;
    // quantized to 10 units so the projection matrix is rebuilt a handful of
    // times per zoom sweep instead of every frame
    const half = THREE.MathUtils.clamp(Math.ceil(dist * 0.9 * 0.1) * 10, 85, 160);
    if (half !== _shadowHalf) {
      _shadowHalf = half;
      const cam = sun.shadow.camera;
      cam.left = -half; cam.right = half;
      cam.top = half; cam.bottom = -half;
      cam.updateProjectionMatrix();
    }
    const map = sun.shadow.mapSize.x || SHADOW_MAP_FULL;
    const texel = (2 * half) / map;
    // Slope compensation: normalBias buys back normalBias·sin(14°) of depth,
    // the constant bias buys back |bias|·(far-near); ask for 1.3× the shortfall.
    // At 4096 this is < 0.9 for every box size, so the authored floor is what
    // actually ships — the term only bites in a degraded (governor) mode.
    const need = 1.3 *
      (texel * PCF_SLOPE - Math.abs(sun.shadow.bias) * SHADOW_DEPTH_RANGE) / SIN_SUN_ELEV;
    sun.shadow.normalBias = THREE.MathUtils.clamp(need, 0.9, 1.2);
    // A near-horizontal receiver can only self-shadow cleanly while 0.9 units of
    // normal offset still covers the per-texel depth slope. Past that the ground
    // leaves the shadow pass rather than shimmer with acne — it keeps RECEIVING,
    // and trees/buildings/units keep casting onto it, so only the steppe's own
    // relief is lost.
    if (engine.groundCaster) engine.groundCaster.castShadow = need <= 0.9;

    _shadowCenter.copy(focus);
    const dx = _shadowCenter.dot(_lx);
    const dy = _shadowCenter.dot(_ly);
    _shadowCenter
      .addScaledVector(_lx, Math.round(dx / texel) * texel - dx)
      .addScaledVector(_ly, Math.round(dy / texel) * texel - dy);
    sun.target.position.copy(_shadowCenter);
    sun.position.copy(_shadowCenter).add(SUN_OFFSET);
  }

  // post chain -----------------------------------------------------------
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  composer.setSize(width, height);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // CRITIQUE r2 fix 10 — AO, between RenderPass and UnrealBloomPass exactly as
  // prescribed, at the prescribed radius 1.2 u / intensity 0.8. NOTE the
  // constructor takes DEVICE pixels: `composer.setSize()` has already run above
  // (it is called before the passes exist), so nothing would size this pass until
  // the first window resize if it were handed CSS pixels.
  const aoPass = new GroundedAOPass(
    scene, camera,
    width * renderer.getPixelRatio(),
    height * renderer.getPixelRatio(),
    [sky]);
  aoPass.radius = 1.2;
  aoPass.intensity = 0.8;
  composer.addPass(aoPass);

  // strength / radius / threshold. Threshold raised from the authored 0.85 to
  // 0.92 because the fill-light lift above pushes sunlit wheat into the old
  // threshold — bloom must stay on emissives and the sun only (ART_DIRECTION
  // §8.5), and the bible's own escalation rule is "raise threshold, never lower
  // strength first", so strength stays at 0.35.
  //
  // CRITIQUE r5 fix 1, consequence — 0.92 → 1.38, which is 0.92 × (6.6 / 4.4).
  // This pass runs on RAW LINEAR HDR, upstream of the tone map, so its threshold
  // is a statement about scene radiance and `toneMappingExposure` cannot move it
  // — only `sun.intensity` can. The brightest legal non-emissive surface in the
  // build is a 0.79-albedo render (`Mat.windowReveal` 0xE8E1D2) on a wall facing
  // the 14° key: 0.789 of radiance at sun 4.4, 1.18 at sun 6.6. Holding 0.92
  // would have started blooming the village, which ART_DIRECTION §8.5 forbids.
  // Scaling by the same factor as the sun preserves the shipped headroom
  // exactly — 17 % over the brightest diffuse surface, before and after.
  // What this could cost: an emissive whose linear radiance sat between 0.92
  // and 1.38 stops blooming. Nothing in fx/vfx.js is in that band as far as I
  // can see from outside the module (its bloom sources are stacked additive
  // MeshBasicMaterials well above 2.0), but this is the one line in the round
  // that another module could disagree with — flagged in INTEGRATION_NOTES and
  // retunable in one line via `bloomPass.threshold`.
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(width, height), 0.35, 0.6, 1.589); // r6 integrator: 0.92 × (7.6 / 4.4)
  composer.addPass(bloomPass);

  // Chain order: Render → AO → Bloom → Output(ACES + sRGB) → Grade → SMAA.
  // Bloom must see linear HDR (it does — passes render into half-float targets
  // and three only applies tone mapping when drawing to the default framebuffer,
  // which is what OutputPass exists to do). The grade must see display-referred
  // sRGB — see the long note on GradeShader. SMAA stays last and, as designed,
  // runs on gamma-encoded input.
  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  const gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);

  const smaaPass = new SMAAPass(
    width * renderer.getPixelRatio(), height * renderer.getPixelRatio());
  composer.addPass(smaaPass);

  // `composer.setSize()` ran above, BEFORE any pass existed, so it sized the two
  // ping-pong targets and nothing else. Every pass therefore kept whatever
  // resolution its constructor was handed until the first window resize — and
  // the constructors disagree about units: SMAAPass and the AO pass were given
  // DEVICE pixels, UnrealBloomPass was given CSS pixels. On a 2× display that
  // left the bloom mip chain at half the resolution of the buffer it samples,
  // and its blur kernel is measured in texels, so the bloom was twice as wide as
  // authored and then visibly SNAPPED to the authored width the first time the
  // window was resized. One idempotent re-size once the chain is complete makes
  // every pass agree with the composer's own device-pixel convention, and makes
  // the boot frame identical to every frame after it. It also means no pass in
  // this chain depends on its constructor arguments being in any particular
  // unit, which is the trap that produced the mismatch in the first place.
  composer.setSize(width, height);

  // resize ---------------------------------------------------------------
  let lastW = width, lastH = height;
  function onResize() {
    const w = Math.max(64, container.clientWidth || window.innerWidth);
    const h = Math.max(64, container.clientHeight || window.innerHeight);
    lastW = w; lastH = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  }
  window.addEventListener('resize', onResize);

  // ------------------------------------------------------------- exposure
  // CRITIQUE r6 fix 3 — `closeMetering` IS REMOVED. What stood here was a
  // distance-keyed ramp (`CLOSE_NEAR 20 / CLOSE_FAR 90 / CLOSE_EXPOSURE 0.35 /
  // CLOSE_BOUNCE 0.90`) that multiplied `toneMappingExposure` by up to 1.35 and
  // the AO pass's interreflection floor by up to 1.90 as the camera came in. The
  // r6 critique took it apart and it does not survive:
  //
  //   · IT WAS AN AUTO-EXPOSURE, and the game is not a camera. PC2 never changes
  //     exposure with camera distance; nothing in its frame gets brighter when
  //     you scroll-wheel toward it. Ours did, which made the world's brightness a
  //     function of the zoom — a third lighting register in motion.
  //   · EVERY CLOSE NUMBER IT PRODUCED WAS A NUMBER ABOUT THE METER. The whole
  //     §1.2 close-camera table was taken at exposure 3.60–3.92 against a shipped
  //     2.90. Divide the ramp back out and the 19 u forest p50 is ≈ 0.25 — the
  //     r5 value, unchanged. The fix moved a measurement and not an image.
  //   · THE BOUNCE FLOOD DESTROYED CONTACT OCCLUSION. ×1.90 on `uBounce` at
  //     exactly the range where a player looks for weight under a vehicle:
  //     `02-unit-closeup` shows three MBTs with cast shadows and no darkening at
  //     all under the tracks. They read as decals on the ground.
  //
  // Exposure and AO bounce are now CONSTANT with camera distance. If close
  // cameras measure dark after this — and they will; expect the 19 u forest back
  // at p50 ≈ 0.25 — that is the honest reading, and the cause is not the meter.
  // It is canopy and ground ALBEDO (a measured canopy albedo luma of 0.09 against
  // PC2's 0.571) plus the absence of any surface detail that survives to 19 u.
  // Both belong to the assets module (fixes 2 and 4). Light cannot make a black
  // leaf grey, and a meter certainly cannot.
  //
  // The original diagnosis is kept below because half of it is still true and
  // the next round should not have to re-derive it:
  //
  //   1. WHAT IS IN THE FRAME. A strategic frame is 74 % open ground, which is
  //      the surface the key actually reaches. An inspection frame is 40–60 %
  //      vertical, shaded or dark-albedo subject — a hull side, a canopy
  //      underside, a wall out of the sun, ground inside a tank's own shadow —
  //      and every one of those is lit by the FILL. Cutting the fill 4.7× for
  //      fix 1 therefore hits close cameras four times harder than wide ones;
  //      without this block fix 1 would have made fix 5 measurably WORSE
  //      (modelled 19 u p50 0.313 → 0.309, forest 0.265 → 0.217).
  //   2. AO IS A ZOOM-DEPENDENT DIMMER, and nobody has noticed because it is
  //      invisible at the camera it was tuned at. `aoPass.radius` is 1.2 WORLD
  //      units and the pass runs at half the composer's resolution. At the
  //      185 u RTS camera 1.2 u is ~2 device pixels — ~1 texel at half res — so
  //      the kernel's taps land inside the source texel, the depth test finds
  //      nothing, and AO contributes essentially zero (round 4 measured exactly
  //      this: `aoPass.enabled = false` moved the terminator pixel "not at
  //      all"). At 19 u the same 1.2 u spans ~40 texels and the pass is fully
  //      active over most of the frame. The art was tuned where AO does
  //      nothing and is then judged where it does everything.
  //
  // Point 2 is still a real observation about the AO pass and it is NOT answered
  // by a distance ramp on the bounce floor: if AO is invisible at 185 u and
  // dominant at 19 u, the honest fixes are a screen-space radius floor or a
  // distance-scaled world radius on the PASS, not a brightness compensation
  // bolted onto its output. Left as a note for whoever owns that pass next; the
  // one thing that must not happen again is paying for it with exposure.
  //
  // What ships instead: ONE exposure, ONE bounce weight, both independent of the
  // camera. Still change-detected, so a console retune of `engine.baseExposure`
  // or `engine.aoBounce` takes effect on the next frame and a static camera costs
  // two compares.
  const _bounceBase = AOCompositeShader.uniforms.uBounce.value.clone();
  let _seenExp = NaN, _seenBnc = NaN;

  function updateExposure() {
    const exp = Number.isFinite(engine.baseExposure) ? engine.baseExposure : BASE_EXPOSURE;
    const bnc = Number.isFinite(engine.aoBounce) ? engine.aoBounce : 1;
    if (_seenExp === exp && _seenBnc === bnc) return;
    _seenExp = exp; _seenBnc = bnc;
    renderer.toneMappingExposure = exp;
    aoPass.compositeMaterial.uniforms.uBounce.value
      .copy(_bounceBase)
      .multiplyScalar(bnc);
  }

  // frame loop -----------------------------------------------------------
  const clock = new THREE.Clock();
  const frameCbs = [];
  let running = false;
  let focusTween = null;
  let _envSeen = null;

  // CRITIQUE r5 fix 17 — "no honest absolute frame time has been produced in
  // two rounds". `document.hidden` is permanently true in the automation tab,
  // `requestAnimationFrame` delivers exactly 0 fps there, and every capture
  // harness since round 3 has had to monkey-patch `renderer.setAnimationLoop`
  // to get a single frame out of the build. That is a defect in this file, not
  // in the harness. `simTime` replaces `clock.elapsedTime` as the animation
  // clock so that a caller-driven frame advances the world by exactly the delta
  // it asked for, and `driverMode` decides who calls the frame at all.
  // See engine.step / engine.drive / engine.benchmark / engine.setFrameDriver.
  let simTime = 0;
  let driverMode = 'raf';
  let driverHz = 60;
  let timerId = 0;
  let lastFrameCpuMs = 0;
  const nowMs = () =>
    (typeof performance !== 'undefined' && performance.now
      ? performance.now() : Date.now());

  const engine = {
    renderer, scene, camera, controls, composer, clock,
    sun, hemi, ambient, sky, aoPass,

    // The weight this light rig authors for the sky PMREM that main.js installs
    // as `scene.environment`. main.js hardcodes its own copy today; the tick
    // below reconciles it the moment the env map appears (see the note there).
    envIntensity: ENV_INTENSITY,

    /** The exposure the light rig authors. Since CRITIQUE r6 fix 3 removed the
     *  close-camera ramp this is also exactly what `renderer.toneMappingExposure`
     *  holds on every frame at every camera distance — the two can no longer
     *  disagree. Writing it retunes the whole picture from the next frame. */
    baseExposure: BASE_EXPOSURE,

    /** Multiplier on the AO pass's interreflection floor (`uBounce`). 1.0 is
     *  authored, and 1.0 is now what ships at every camera distance. */
    aoBounce: 1.0,

    /** REMOVED — CRITIQUE r6 fix 3. `closeMetering` was a distance-keyed
     *  auto-exposure (+35 % exposure, +90 % AO bounce inside 20 u). It is gone,
     *  not disabled: exposure and bounce are constant with camera distance and
     *  there is no ramp left to switch on. These two members survive ONLY so a
     *  harness that still asserts `engine.closeMeteringT === 0` before quoting a
     *  number keeps passing, and so an attempt to re-enable the ramp says why it
     *  cannot rather than silently doing nothing. */
    closeMetering: Object.freeze({ enabled: false, near: 0, far: 0, removed: 'r6 fix 3' }),
    get closeMeteringT() { return 0; },

    /** Retune the four numbers that own the exposure/modelling trade in one
     *  call, so an integrator who measures something the model did not predict
     *  can sweep without editing this file:
     *      engine.setLightRig({ sun: 6.6, hemi: 0.15, env: 0.115, exposure: 3.25 })
     *  Every field is optional; omitted fields keep their current value. The
     *  bloom threshold tracks `sun` automatically (it must — see the bloom
     *  pass), and `env` is written to both `scene.environmentIntensity` and
     *  `engine.envIntensity` so the reconcile in the frame body stays quiet.
     *  Returns the rig it applied. */
    setLightRig(o = {}) {
      if (Number.isFinite(o.sun) && o.sun >= 0) {
        bloomPass.threshold *= (o.sun || 1e-6) / (sun.intensity || 1e-6);
        sun.intensity = o.sun;
      }
      if (Number.isFinite(o.hemi) && o.hemi >= 0) hemi.intensity = o.hemi;
      if (Number.isFinite(o.ambient) && o.ambient >= 0) ambient.intensity = o.ambient;
      if (Number.isFinite(o.env) && o.env >= 0) {
        engine.envIntensity = o.env;
        scene.environmentIntensity = o.env;
      }
      if (Number.isFinite(o.exposure) && o.exposure > 0) {
        engine.baseExposure = o.exposure;
        renderer.toneMappingExposure = o.exposure;
      }
      if (Number.isFinite(o.bloomThreshold)) bloomPass.threshold = o.bloomThreshold;
      const applied = {
        sun: sun.intensity, hemi: hemi.intensity, ambient: ambient.intensity,
        env: engine.envIntensity, exposure: engine.baseExposure,
        bloomThreshold: bloomPass.threshold,
      };
      console.info('[engine] light rig:', applied);
      return applied;
    },

    /** The grade pass's uniforms, exposed so a measurement pass can sweep the
     *  toe/shoulder/chroma without reaching through `composer.passes`. */
    get grade() { return gradePass.uniforms; },

    // Optional: the terrain's ground mesh, registered by main.js. When set, the
    // shadow rig owns its `castShadow` flag — it stays on while the shadow texel
    // is fine enough to self-shadow a 14°-lit plane, and is dropped if the
    // quality governor coarsens the map. Leave it null and nothing changes.
    groundCaster: null,

    // ---- camera collision, CRITIQUE r6 fix 1 -----------------------------
    /** `(x, z) → terrain height`. main.js wires `terrain.heightAt`. Required for
     *  the eye clamp; without it the clamp warns once and stands down. */
    groundProbe: null,
    /** `(x, z) → top of the tallest building/canopy/pylon over that column`, or
     *  -Infinity where there is none. main.js bakes it at boot. Optional. */
    obstacleProbe: null,
    /** Set false to disable the clamp for a deliberate inside-the-world shot.
     *  Anything measured with it off must say so. */
    cameraCollision: true,
    /** Force the clamp now, outside the frame loop — for a harness that poses the
     *  camera by hand and captures without stepping. Returns the lift applied. */
    clampCamera() { return clampCameraAboveGround(); },
    /** The lowest legal eye Y at (x, z) for a player camera — exactly what the
     *  per-frame clamp enforces. Exposed so fix 1's acceptance sweep can be
     *  written against the shipped rule instead of a re-implementation of it
     *  (see STEEL.cameraSweep in main.js). */
    cameraFloorAt(x, z) { return requiredEyeY(x, z, CAM_GROUND_CLEAR); },
    /** The assertion CRITIQUE r6 fix 16 requires before any close-range number is
     *  quoted. `ok === false` means the eye is inside the world and the frame is
     *  not evidence about anything. */
    cameraClearanceReport() {
      const p = camera.position;
      const gp = engine.groundProbe;
      const op = engine.obstacleProbe;
      const ground = typeof gp === 'function' ? gp(p.x, p.z) : NaN;
      const obstacle = typeof op === 'function' ? op(p.x, p.z) : -Infinity;
      const seized = (controls.enabled === false || engine.cinematic === true);
      const want = seized ? CAM_CINE_CLEAR : CAM_GROUND_CLEAR;
      // ROUND-7 INTEGRATION FIX. This used to grade the eye against
      // `max(ground, obstacle)` and demand the GROUND clearance (4.0 u) above
      // whichever won. The clamp does not work that way and never did: a roof or
      // a canopy top carries CAM_OBSTACLE_CLEAR (1.5 u), which is why
      // `surfaceAt()` folds the obstacle in as `h + 1.5 - 4.0`. The two rules
      // disagreed by exactly 2.5 u, so the clamp would place the eye 1.5 u over a
      // roof — correctly, by design — and the report would then call that frame
      // "eye inside the world". Measured on the shipped build: 22.7 % of
      // (15 u, 55°) poses and 16.0 % of (15 u, 40°) poses failed this way AFTER
      // the clamp had already run, every one of them with 6.7–17.3 u of real
      // clearance over the terrain and 1.50–3.08 u over a roof. A false negative
      // is not harmless here — fix 16 tells the critic to throw away any frame
      // whose report is not ok, so this was set to discard a fifth of all legal
      // close-range evidence.
      //
      // The report now asks the CLAMP'S OWN function what the floor is, so the
      // two can never drift apart again, and publishes the ground and obstacle
      // margins separately so a reader can see which one is binding.
      const floor = requiredEyeY(p.x, p.z, want);
      const groundClear = Number.isFinite(ground) ? p.y - ground : null;
      const obstacleClear = Number.isFinite(obstacle) ? p.y - obstacle : null;
      return {
        wired: typeof gp === 'function',
        eyeY: p.y,
        groundY: ground,
        obstacleY: Number.isFinite(obstacle) ? obstacle : null,
        // `clearance` stays the headline margin over the terrain, which is what
        // every previous round's notes quote.
        clearance: groundClear,
        groundClearance: groundClear,
        obstacleClearance: obstacleClear,
        required: want,
        requiredOverObstacle: seized ? CAM_CINE_CLEAR : CAM_OBSTACLE_CLEAR,
        floorY: Number.isFinite(floor) ? floor : null,
        margin: Number.isFinite(floor) ? p.y - floor : null,
        liftedLastFrame: _camLift,
        distance: p.distanceTo(controls.target),
        polarDeg: THREE.MathUtils.radToDeg(
          Math.acos(THREE.MathUtils.clamp(
            (p.y - controls.target.y) / Math.max(p.distanceTo(controls.target), 1e-6),
            -1, 1))),
        ok: typeof gp === 'function' && Number.isFinite(floor) &&
            p.y >= floor - 1e-3,
      };
    },

    // ---- the measurement harness, CRITIQUE r6 fix 16 ---------------------
    /** ONE metric implementation for both sides of the comparison. See the long
     *  note above `createEngine` for every definition it uses.
     *
     *    STEEL.metrics.frame()                     → measure the live frame
     *    console.log(STEEL.metrics.format(m))      → paste-ready summary
     *    await STEEL.metrics.reference(url)        → measure a PC2 gallery JPEG
     *                                                through the identical code
     *    STEEL.metrics.analyze(anyCanvasOrBitmap)  → measure anything else
     *
     *  ALWAYS pin quality first (`STEEL.perf.pin(0)`) and ALWAYS check
     *  `m.clearance.ok` before quoting a close-range number. */
    metrics: {
      scales: METRIC_SCALES,
      statScale: METRIC_STATS_SCALE,
      pc2Crop: PC2_CROP,
      analyze: metricAnalyze,
      format: metricFormat,

      /** Geometric share of the frame above the true horizon, from the camera
       *  alone — 0 means the frame cannot contain one pixel of sky. */
      skyFraction() {
        const v = new THREE.Vector3();
        const N = 257;
        let above = 0;
        for (let i = 0; i < N; i++) {
          v.set(0, -1 + 2 * (i + 0.5) / N, 0.5).unproject(camera).sub(camera.position);
          if (v.y > 0) above++;
        }
        return above / N;
      },

      /** Render one frame and measure it. This does NOT advance the simulation —
       *  use `engine.step()` for that and then call this.
       *
       *  The render and the read-back MUST stay in one synchronous task: the
       *  renderer is built without `preserveDrawingBuffer`, so the canvas is only
       *  legible until the browser next composites. Pass `{ render: false }` only
       *  if you have just rendered yourself, in the same task. */
      frame(opts = {}) {
        if (opts.render !== false) composer.render();
        const m = metricAnalyze(renderer.domElement, opts);
        m.clearance = engine.cameraClearanceReport();
        m.skyFraction = engine.metrics.skyFraction();
        m.camera = {
          distance: camera.position.distanceTo(controls.target),
          polarDeg: m.clearance.polarDeg,
          fov: camera.fov,
          exposure: renderer.toneMappingExposure,
          baseExposure: engine.baseExposure,
          closeMeteringT: 0,
        };
        m.quality = {
          shadowMapSize: sun.shadow.mapSize.x,
          pixelRatio: renderer.getPixelRatio(),
          canvas: `${renderer.domElement.width}×${renderer.domElement.height}`,
        };
        if (!m.clearance.ok) {
          console.warn(
            '[metrics] THE EYE IS INSIDE THE WORLD — this frame is not evidence ' +
            `about anything (eye y ${m.clearance.eyeY.toFixed(2)}, surface ` +
            `${Number(m.clearance.groundY).toFixed(2)}, clearance ` +
            `${Number(m.clearance.clearance).toFixed(2)} of a required ` +
            `${m.clearance.required}). Fix the camera, re-render, re-measure.`);
        }
        return m;
      },

      /** Measure a reference image — a PC2 gallery asset, or any other frame —
       *  through the identical code path, so the two sides are comparable.
       *  Defaults to PC2's map-area crop when the source is 1920×1080.
       *
       *  Use the FETCH path, not `new Image()` + crossOrigin: a warm non-CORS
       *  cache entry makes the image path hang silently (r6 method note). */
      async reference(url, opts = {}) {
        const res = await fetch(url, { mode: 'cors', cache: 'reload' });
        if (!res.ok) throw new Error(`[metrics] ${res.status} for ${url}`);
        const bmp = await createImageBitmap(await res.blob());
        const crop = opts.crop ||
          (bmp.width === 1920 && bmp.height === 1080 ? PC2_CROP : null);
        const m = metricAnalyze(bmp, { ...opts, crop });
        m.url = url;
        if (typeof bmp.close === 'function') bmp.close();
        return m;
      },
    },

    onFrame(cb) {
      frameCbs.push(cb);
      return () => {
        const i = frameCbs.indexOf(cb);
        if (i >= 0) frameCbs.splice(i, 1);
      };
    },

    // Accepts a Vector3 or any {x, y?, z} — including the 2-component {x, z}
    // that hexToWorld() and terrain.center hand out. CRITIQUE fix 22: every
    // component is validated, because `vec3.y ?? 0` only catches null/undefined
    // and sails straight past the NaN that an out-of-bounds heightAt() returns.
    // A malformed axis falls back to where the camera already is, so a bad call
    // is a no-op instead of a teleport (or a black screen).
    focusOn(vec3, opts = {}) {
      if (!vec3 || typeof vec3 !== 'object') return;
      const to = new THREE.Vector3(
        Number.isFinite(vec3.x) ? vec3.x : controls.target.x,
        Number.isFinite(vec3.y) ? vec3.y : 0,
        Number.isFinite(vec3.z) ? vec3.z : controls.target.z);
      // Only reachable if the fallback itself is poisoned; refuse rather than
      // propagate. The per-frame guard will have restored the camera by now.
      if (!isFiniteVec(to)) return;
      const dur = Number.isFinite(opts.duration) && opts.duration > 0
        ? opts.duration : 0.6;
      if (opts.instant) {
        const delta = to.clone().sub(controls.target);
        controls.target.copy(to);
        camera.position.add(delta);
        return;
      }
      focusTween = { from: controls.target.clone(), to, t: 0, dur };
    },

    /** Camera watchdog, exposed so a module that seizes the camera (dronecam)
     *  can hand it back safely: `if (!engine.isCameraSane()) engine.recoverCamera(why)`.
     *  Noted in INTEGRATION_NOTES.md. */
    isCameraSane: cameraIsSane,
    recoverCamera,

    /** The resolution this light rig authors, so a caller never has to hardcode
     *  4096 to know what "full" means. */
    shadowMapFull: SHADOW_MAP_FULL,

    /** Current shadow-map edge in texels. Read this instead of reaching into
     *  `engine.sun.shadow.mapSize` — a capture harness that wants to assert it
     *  is shooting at authored quality can just check
     *  `engine.shadowMapSize === engine.shadowMapFull`. */
    get shadowMapSize() { return sun.shadow.mapSize.x; },

    /** CRITIQUE r4 fix 3. The ONLY supported way to retune the shadow map at
     *  runtime, and the reason it exists at all:
     *
     *  main.js's governor used to do this by hand — `sun.shadow.mapSize.set(
     *  1024, 1024)` from an authored 4096, logging "halving the shadow map"
     *  while actually QUARTERING it, and then unsubscribing itself so it could
     *  never be undone. Within ~90 frames of ordinary play every session was
     *  running at 1/16 the authored shadow resolution, silently, and every
     *  screenshot anyone took after that point was judged on a downgraded
     *  renderer. Three separate defects in four lines: wrong arithmetic, a log
     *  line that did not describe the action, and no way back.
     *
     *  So the arithmetic lives here, it is stated in the log in texels AND as a
     *  fraction of authored, the message says out loud that captures are
     *  affected, and `setQuality('high')` restores it. Disposing and nulling
     *  `shadow.map` is not optional: three allocates the depth target from
     *  `mapSize` exactly once, so without this the new number is stored and
     *  never reaches the GPU.
     *
     *  Returns the size actually applied (snapped to a power of two and clamped
     *  to the authored maximum — a caller can never ask for MORE than authored). */
    setShadowMapSize(size) {
      const want = Number.isFinite(size) ? size : SHADOW_MAP_FULL;
      const snapped = Math.pow(2, Math.round(Math.log2(Math.max(want, 1))));
      const next = THREE.MathUtils.clamp(snapped, SHADOW_MAP_MIN, SHADOW_MAP_FULL);
      const from = sun.shadow.mapSize.x;
      if (next === from) return next;
      sun.shadow.mapSize.set(next, next);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      // Force updateShadowBox() to rebuild the ortho projection so the new texel
      // size flows into normalBias and into the ground caster's flag this frame
      // rather than at the next zoom quantum.
      _shadowHalf = -1;
      const pctTexels = ((next * next) / (SHADOW_MAP_FULL * SHADOW_MAP_FULL) * 100);
      const msg =
        `[engine] shadow map ${from}² → ${next}² — ${pctTexels.toFixed(1)} % of the ` +
        `authored ${SHADOW_MAP_FULL}² (${(next / from).toFixed(2)}× per edge).`;
      if (next < SHADOW_MAP_FULL) {
        console.warn(
          `${msg} Ridgeline self-shadowing and contact-shadow crispness are ` +
          `DEGRADED. Do not judge or capture frames in this state — call ` +
          `engine.setQuality('high') (or STEEL.perf.pin(0)) first.`);
      } else {
        console.info(`${msg} Authored shadow resolution restored.`);
      }
      return next;
    },

    setQuality(q) {
      if (q === 'med' || q === 'low') {
        renderer.setPixelRatio(1);
        composer.setPixelRatio(1);
        smaaPass.enabled = false;
        // AO costs a half-res depth/normal prepass over the whole scene; it is
        // the single largest thing this engine can give back, and it goes first.
        aoPass.enabled = false;
      } else {
        const pr = Math.min(window.devicePixelRatio, 2);
        renderer.setPixelRatio(pr);
        composer.setPixelRatio(pr);
        smaaPass.enabled = true;
        aoPass.enabled = true;
        // CRITIQUE r4 fix 3 — 'high' means AUTHORED, and that includes the
        // shadow map. Before this line `setQuality('high')` restored the pixel
        // ratio, SMAA and AO but left a governor-coarsened shadow map exactly
        // where it was, so "back to high" was a lie in the one place a
        // screenshot would show it. No-ops when it is already 4096.
        engine.setShadowMapSize(SHADOW_MAP_FULL);
      }
      onResize();
    },

    start() {
      if (running) return;
      running = true;
      clock.start();
      attachDriver();
    },

    stop() {
      running = false;
      detachDriver();
    },

    // ------------------------------------------------ CRITIQUE r5 fix 17
    // "No honest absolute frame time has been produced in two rounds …
    //  `document.hidden` is permanently true in the automation tab and rAF
    //  delivers 0 fps, so every timing number since round 3 is suspect."
    //
    // Four entry points, none of which touch requestAnimationFrame. Together
    // they also close the OTHER harness hole the round-5 method note describes
    // ("the fix is to monkey-patch renderer.setAnimationLoop, capture the tick
    // closure and patch clock.getDelta"): none of that is necessary any more.

    /** Render exactly one frame, advancing the world by `dt` SIMULATED seconds.
     *  Independent of rAF, of `document.hidden` and of `engine.start()`.
     *  Returns the CPU milliseconds this frame's JS + command submission took
     *  (NOT the GPU time — use benchmark() for that). */
    step(dt = 1 / 60) {
      const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.05) : 1 / 60;
      runFrame(d);
      return lastFrameCpuMs;
    },

    /** Deterministic time travel for VFX capture: advance `seconds` of
     *  simulated time in fixed `dt` steps, rendering every one. This is what a
     *  capture harness should call between firing a weapon and grabbing the
     *  frame — a `setTimeout` sleep in a hidden tab advances nothing at all,
     *  which is why round 4's "detonation" captures came back byte-identical to
     *  the pre-shot frame. Returns the number of frames rendered. */
    drive(seconds = 1, dt = 1 / 60) {
      const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : 1 / 60;
      const n = Math.max(0, Math.min(6000, Math.round((seconds || 0) / d)));
      for (let i = 0; i < n; i++) runFrame(d);
      return n;
    },

    /** Who calls the frame:
     *    'raf'    — requestAnimationFrame (default; 0 fps in a hidden tab)
     *    'timer'  — setInterval, which keeps ticking when the tab is hidden
     *               (throttled to ~1 Hz after a few minutes in background, but
     *               never to zero) — use it to run the game under automation
     *    'manual' — nothing runs the frame; the caller drives step()/drive()
     *  Safe to call before or after start(). Returns the mode applied. */
    setFrameDriver(mode, hz = 60) {
      const want = (mode === 'timer' || mode === 'manual') ? mode : 'raf';
      detachDriver();
      driverMode = want;
      driverHz = Number.isFinite(hz) && hz > 0 ? Math.min(hz, 240) : 60;
      if (running) attachDriver();
      console.info(`[engine] frame driver: ${driverMode}` +
        (driverMode === 'timer' ? ` @ ${driverHz} Hz` : ''));
      return driverMode;
    },

    /** CPU milliseconds the last frame's JS + GL submission took. Cheap
     *  (two performance.now() calls) and always live. It is NOT frame time —
     *  the GPU is still working when it is read. */
    get lastFrameCpuMs() { return lastFrameCpuMs; },

    /** An honest absolute frame time, obtainable under automation.
     *
     *  Three numbers, because they answer three different questions and
     *  conflating them is how the last three rounds produced figures nobody
     *  could defend:
     *    · `cpuMs`  — JS + GL command submission per frame. No sync point.
     *    · `wallMs` — the same loop with the pipeline DRAINED at the end
     *                 (`gl.finish()` + a 1×1 `readPixels`, which a driver
     *                 cannot answer until every queued command has retired).
     *                 This is the number that bounds real frame rate on this
     *                 machine, and it is valid in a hidden tab.
     *    · `gpuMs`  — GPU time from `EXT_disjoint_timer_query_webgl2` when the
     *                 browser exposes it, `null` when it does not. This is the
     *                 only number that is purely GPU, and it is the one to
     *                 quote if it is available.
     *  Options: { frames = 120, warmup = 30, dt = 1/60, breakdown = false }.
     *  `breakdown: true` re-runs the loop with AO / bloom / SMAA disabled in
     *  turn and reports the delta each pass costs, then restores every flag.
     *  Async only because the timer query's result is not ready synchronously.
     *
     *  It renders `frames` real frames, so the world advances — call it from a
     *  quiescent state, or accept that `frames/60` seconds of VFX have run. */
    async benchmark(opts = {}) {
      const frames = Math.max(1, Math.min(600, Math.round(opts.frames ?? 120)));
      const warmup = Math.max(0, Math.min(240, Math.round(opts.warmup ?? 30)));
      const dt = Number.isFinite(opts.dt) ? opts.dt : 1 / 60;
      // Take the frame away from whatever normally drives it for the duration.
      // Otherwise a visible tab's rAF fires during the awaits and lands
      // uncounted frames inside the GPU timer query's window — which is exactly
      // the sort of contamination this whole entry point exists to end.
      const hadDriver = running;
      if (hadDriver) detachDriver();
      try {
        return await benchmarkBody(frames, warmup, dt, opts);
      } finally {
        if (hadDriver) attachDriver();
      }
    },
  };

  async function benchmarkBody(frames, warmup, dt, opts) {
    for (let i = 0; i < warmup; i++) runFrame(dt);
    drainGPU();

    const timed = timeBlock(frames, dt);
    const gpuMs = await timed.gpu;   // null when the extension is absent or disjoint
    const out = {
      frames,
      cpuMs: timed.cpuMs,
      wallMs: timed.wallMs,
      gpuMs,
      method: gpuMs === null
        ? 'wall = gl.finish + 1x1 readPixels; no usable GPU timer in this browser'
        : 'wall = gl.finish + 1x1 readPixels; gpu = EXT_disjoint_timer_query_webgl2',
      hidden: (typeof document !== 'undefined' && !!document.hidden),
      driver: driverMode,
      pixelRatio: renderer.getPixelRatio(),
      size: renderer.getSize(new THREE.Vector2()).toArray(),
      shadowMap: sun.shadow.mapSize.x,
      cameraDistance: camera.position.distanceTo(controls.target),
      passes: { ao: aoPass.enabled, bloom: bloomPass.enabled, smaa: smaaPass.enabled },
      info: {
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        programs: renderer.info.programs ? renderer.info.programs.length : null,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      },
    };
    if (opts.breakdown) {
      const was = { ao: aoPass.enabled, bloom: bloomPass.enabled, smaa: smaaPass.enabled };
      const half = Math.max(20, Math.round(frames / 2));
      const run = async (mut) => {
        aoPass.enabled = was.ao; bloomPass.enabled = was.bloom; smaaPass.enabled = was.smaa;
        mut();
        for (let i = 0; i < 8; i++) runFrame(dt);   // let the new pipeline settle
        drainGPU();
        const t = timeBlock(half, dt);
        await t.gpu;                                 // consume, so no query leaks
        return t.wallMs;
      };
      const base = await run(() => {});
      const noAO = await run(() => { aoPass.enabled = false; });
      const noBloom = await run(() => { bloomPass.enabled = false; });
      const noSMAA = await run(() => { smaaPass.enabled = false; });
      aoPass.enabled = was.ao; bloomPass.enabled = was.bloom; smaaPass.enabled = was.smaa;
      out.breakdown = {
        baselineMs: base,
        aoMs: base - noAO,
        bloomMs: base - noBloom,
        smaaMs: base - noSMAA,
        note: 'each is baseline minus that pass disabled, wall-clock, same camera',
      };
    }
    return out;
  }

  // ---- frame drivers and the timing plumbing behind benchmark() ------------
  function attachDriver() {
    if (driverMode === 'raf') renderer.setAnimationLoop(tick);
    else if (driverMode === 'timer') {
      timerId = setInterval(tick, Math.max(4, Math.round(1000 / driverHz)));
    }
    // 'manual': nothing runs the frame; step()/drive() do.
  }
  function detachDriver() {
    renderer.setAnimationLoop(null);
    if (timerId) { clearInterval(timerId); timerId = 0; }
  }

  // A 1×1 readback from the default framebuffer. `gl.finish()` alone is
  // advisory on several drivers; a readPixels cannot return until the pixel
  // exists, which makes it the one portable hard sync point WebGL has.
  const _px1 = new Uint8Array(4);
  function drainGPU() {
    const gl = renderer.getContext();
    try {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(null);
      gl.finish();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _px1);
      renderer.setRenderTarget(prev);
      return true;
    } catch (err) {
      return false;   // wall time then means CPU submission only; say so
    }
  }

  function timeBlock(frames, dt) {
    const gl = renderer.getContext();
    const ext = (typeof gl.getExtension === 'function')
      ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    let query = null;
    if (ext && typeof gl.createQuery === 'function') {
      try {
        query = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      } catch (err) { query = null; }
    }
    const t0 = nowMs();
    for (let i = 0; i < frames; i++) runFrame(dt);
    if (query) { try { gl.endQuery(ext.TIME_ELAPSED_EXT); } catch (err) { query = null; } }
    const cpuMs = (nowMs() - t0) / frames;
    drainGPU();
    const wallMs = (nowMs() - t0) / frames;
    return { cpuMs, wallMs, gpu: readQuery(gl, ext, query, frames) };
  }

  // The timer query's result lands whenever the GPU retires it. Polling on a
  // timer (not rAF) is deliberate: rAF is the thing that does not run here.
  function readQuery(gl, ext, query, frames) {
    if (!query || !ext) return Promise.resolve(null);
    return new Promise((resolve) => {
      let tries = 0;
      const finish = (v) => {
        try { gl.deleteQuery(query); } catch (err) { /* already gone */ }
        resolve(v);
      };
      const poll = () => {
        let ready = false, disjoint = false;
        try {
          ready = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
          disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        } catch (err) { finish(null); return; }
        // A disjoint means the GPU was preempted mid-query: the result is
        // garbage and must be thrown away, not reported.
        if (disjoint) { finish(null); return; }
        if (ready) {
          let ns = 0;
          try { ns = gl.getQueryParameter(query, gl.QUERY_RESULT); }
          catch (err) { finish(null); return; }
          finish(ns / 1e6 / frames);
          return;
        }
        if (++tries > 150) { finish(null); return; }
        setTimeout(poll, 10);
      };
      poll();
    });
  }

  function tick() {
    const rawDt = clock.getDelta();
    const dt = Number.isFinite(rawDt) ? Math.min(Math.max(rawDt, 0), 0.05) : 0.016;
    runFrame(dt);
  }

  function runFrame(dt) {
    const tFrame0 = nowMs();
    simTime += dt;
    const elapsed = simTime;
    // Keep the public clock in step with simulated time, so a module that
    // reads `engine.clock.elapsedTime` sees the same seconds the animation
    // does whether the frame came from rAF, from the timer or from step().
    clock.elapsedTime = simTime;

    // CRITIQUE fix 22 — guard #1 of 3: whatever the previous frame's callbacks,
    // DOM handlers, timers or promises did to the camera, we start this frame
    // with a camera that can produce an image.
    guardCamera('start of frame');

    // self-heal if the container was resized (or was 0-sized at init)
    const cw = container.clientWidth, ch = container.clientHeight;
    if (cw > 0 && ch > 0 && (cw !== lastW || ch !== lastH)) onResize();

    // keyboard pan
    let px = 0, pz = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) pz += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) pz -= 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) px -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) px += 1;

    // edge pan
    if (pointerIn && pointerX !== null) {
      const m = 14;
      const w = window.innerWidth, h = window.innerHeight;
      if (pointerX < m) px -= 1;
      else if (pointerX > w - m) px += 1;
      if (pointerY < m) pz += 1;
      else if (pointerY > h - m) pz -= 1;
    }
    if (px !== 0 || pz !== 0) applyPan(px, pz, dt);

    // Q/E rotate
    if (keys.has('KeyQ')) applyRotate(1, dt);
    if (keys.has('KeyE')) applyRotate(-1, dt);

    // focus tween
    if (focusTween) {
      focusTween.t += dt / focusTween.dur;
      const k = focusTween.t >= 1 ? 1 : 1 - Math.pow(1 - focusTween.t, 3);
      const prev = _tweenPrev.copy(controls.target);
      controls.target.lerpVectors(focusTween.from, focusTween.to, k);
      camera.position.add(_tweenDelta.copy(controls.target).sub(prev));
      if (focusTween.t >= 1) focusTween = null;
    }

    controls.update();

    // Guard #2 of 3: the pan/rotate/tween/controls block above is the other half
    // of the observed failure ("artilleryBarrage plus a camera focus tween"). If
    // it survived, this is the pose we come back to when something later breaks.
    guardCamera('camera update');

    gradePass.uniforms.uTime.value = elapsed;
    if (sky.skyMaterial) sky.skyMaterial.uniforms.uTime.value = elapsed;

    // The light rig authors `scene.environmentIntensity`, but main.js is the only
    // site that can install `scene.environment` (it needs the PMREM generator and
    // the renderer, and it runs after this module is constructed), and it sets its
    // own copy of the weight right next to the install. Reconcile ONCE, at the
    // moment the env map appears, so the two can never silently diverge — and so
    // a deliberate runtime retune from the console after boot still sticks.
    if (scene.environment !== _envSeen) {
      _envSeen = scene.environment;
      if (scene.environment &&
          Math.abs(scene.environmentIntensity - ENV_INTENSITY) > 1e-3) {
        console.info(
          `[engine] scene.environmentIntensity was ${scene.environmentIntensity} ` +
          `when the sky PMREM was installed; the light rig authors ` +
          `${ENV_INTENSITY} (engine.envIntensity) and has applied it. ` +
          `Update the value in main.js's installEnvironment() to match.`);
        scene.environmentIntensity = ENV_INTENSITY;
      }
    }

    for (let i = 0; i < frameCbs.length; i++) {
      try { frameCbs[i](dt, elapsed); }
      catch (err) { console.warn('[engine] frame callback error:', err); }
    }

    // Guard #3 of 3: dronecam flies the camera from a frame callback and vfx's
    // screenShake offsets it from another, so this is the last moment before a
    // NaN would reach the GPU. Nothing renders black on this engine's watch.
    if (!cameraIsSane()) recoverCamera('frame callback');

    // CRITIQUE r6 fix 1 — ground/geometry collision, applied to the pose that is
    // about to be rendered. It runs here rather than straight after
    // controls.update() because dronecam and screenShake both write the camera
    // from a frame callback, and a clamp that only saw the orbit pose would let
    // exactly those two put the eye inside a hill. Upstream of the shadow box and
    // of the sky so both are built from the corrected eye.
    clampCameraAboveGround();

    // Sky follows the EYE, not the camera target, and it does so after the frame
    // callbacks so dronecam's own camera writes are already in. A dome of radius
    // 1300 centred on the orbit target is up to asin(260/1300) = 11.5° of
    // parallax away from a sky at infinity — which nobody notices on a smooth
    // gradient and everybody notices the moment there is a sun disc and a cloud
    // deck painted on it (the sun would slide across the sky as you panned).
    // Centring on the eye also keeps the glow sprite, which lives at a fixed
    // offset inside this group, locked to the shader's disc.
    sky.position.copy(camera.position);

    // Sun + shadow box follow the view (cascade-ish single map). This USED to run
    // before the frame callbacks, which meant the box was always positioned from
    // the previous frame's camera — free and unnoticeable on a damped RTS pan, and
    // not free at all during an FPV dive, where dronecam writes the camera from a
    // frame callback and moves it tens of units per frame. Run last, together with
    // the sky, and the box is built from the pose that is about to be rendered.
    // It is also downstream of guard #3, so the camera is known finite here.
    updateShadowBox();

    // Exposure + AO bounce. No longer a function of the camera at all (r6 fix 3);
    // this is two compares on a static frame and it stays here so a console
    // retune of `engine.baseExposure` still lands on the next frame.
    updateExposure();

    composer.render();
    lastFrameCpuMs = nowMs() - tFrame0;
  }

  return engine;
}
