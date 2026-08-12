// STEEL SIGNAL — fx/dronecam.js
// The money shot: seized camera flies a wobbling bezier from the launch team
// up over the battlefield and into a terminal dive on the target, behind a DOM
// FPV overlay (static noise, telemetry, crosshair, REC). Impact = white flash
// -> cut to full static "SIGNAL LOST" -> restore the RTS camera (pre-aimed at
// the target so the caller's explosion is in frame). ~4-5 s, Esc skips.
// Contract: export function playFPVDive(engine, fromUnit, targetPos, onImpact).
// Returns a Promise that resolves when the sequence fully ends (extra, noted
// in INTEGRATION_NOTES.md).
//
// Round-4 pass (critique fixes 6 and 17):
//   * `engine.cinematic = true` for the whole dive. It is the single switch the
//     rest of the build reads to take the tactical map off the screen —
//     fx/markers.js drops unit counters, ground rings and the selection ring,
//     fx/vfx.js drops the hex grid, the highlight field, its perimeter stroke,
//     the suppression rings and the damage-float layer. `body.fpv-active` is
//     also set HERE rather than left to ui/hud.js's MutationObserver, so the
//     HUD panels and the world place labels (HLYBOKE / ROAD BRIDGE / SOKIL)
//     are gone on the same frame the feed opens instead of one mutation later.
//   * The static is analogue, not a mosaic. It was an 8-screen-pixel cell
//     stretched over the frame, which reads as a corrupted JPEG; it is now a
//     ~2 px grain with per-line DC drift and interlace, horizontal tear bands
//     re-rolled every 0.12 s, and one soft band rolling down the frame at
//     ~40 px/s. Glitch spikes are shorter and stronger (0.03 s at 0.45).

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

let active = false;
let dom = null;        // built overlay element refs
let audioShared = null; // lazy shared AudioContext wrapper
let noiseTile = null;  // one-time fine-grain noise source (see buildNoiseTile)

// ---------------------------------------------------------------- overlay DOM

const FPV_CSS = `
#fpv-overlay .fpv-wrap {
  position: absolute; inset: 0; overflow: hidden;
  font-family: 'IBM Plex Mono', monospace; color: #E8EAE6;
}
#fpv-overlay .fpv-noise {
  position: absolute; inset: 0; width: 100%; height: 100%;
  opacity: 0.08; image-rendering: pixelated;
}
#fpv-overlay .fpv-vig {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at center, transparent 52%, rgba(0,0,0,0.4) 100%);
}
#fpv-overlay .fpv-corner {
  position: absolute; width: 54px; height: 54px;
  border: 1.5px solid rgba(232,234,230,0.75);
}
#fpv-overlay .fpv-corner.tl { top: 26px; left: 30px; border-right: none; border-bottom: none; }
#fpv-overlay .fpv-corner.tr { top: 26px; right: 30px; border-left: none; border-bottom: none; }
#fpv-overlay .fpv-corner.bl { bottom: 26px; left: 30px; border-right: none; border-top: none; }
#fpv-overlay .fpv-corner.br { bottom: 26px; right: 30px; border-left: none; border-top: none; }
#fpv-overlay .fpv-ch {
  position: absolute; left: 50%; top: 50%; width: 54px; height: 54px;
  transform: translate(-50%, -50%);
}
#fpv-overlay .fpv-ch::before {
  content: ''; position: absolute; left: -28px; right: -28px; top: 50%;
  height: 1.5px; margin-top: -0.75px; background: rgba(232,234,230,0.9);
}
#fpv-overlay .fpv-ch::after {
  content: ''; position: absolute; top: -28px; bottom: -28px; left: 50%;
  width: 1.5px; margin-left: -0.75px; background: rgba(232,234,230,0.9);
}
#fpv-overlay .fpv-ch-ring {
  position: absolute; inset: 0; border: 1.5px solid rgba(232,234,230,0.85);
  border-radius: 50%;
}
#fpv-overlay .fpv-rec {
  position: absolute; top: 34px; left: 96px; font-size: 14px;
  letter-spacing: 0.14em; display: flex; align-items: center; gap: 9px;
}
#fpv-overlay .fpv-dot {
  width: 10px; height: 10px; border-radius: 50%; background: #FF3B30;
  box-shadow: 0 0 8px rgba(255,59,48,0.8);
  animation: ssFpvBlink 1s steps(1) infinite;
}
@keyframes ssFpvBlink { 50% { opacity: 0.12; } }
#fpv-overlay .fpv-tr {
  position: absolute; top: 34px; right: 96px; text-align: right;
  font-size: 13px; line-height: 1.75; letter-spacing: 0.1em;
}
#fpv-overlay .fpv-bl {
  position: absolute; bottom: 34px; left: 96px;
  font-size: 13px; line-height: 1.75; letter-spacing: 0.1em;
}
#fpv-overlay .fpv-br {
  position: absolute; bottom: 34px; right: 96px; text-align: right;
  font-size: 13px; line-height: 1.75; letter-spacing: 0.14em;
}
#fpv-overlay .fpv-skip {
  position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%);
  font-size: 11px; letter-spacing: 0.22em; color: rgba(232,234,230,0.55);
}
#fpv-overlay .fpv-lost {
  position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; font-size: 34px; letter-spacing: 0.32em;
  padding-left: 0.32em; color: #FFFFFF; opacity: 0;
  text-shadow: 0 0 22px rgba(255,255,255,0.55);
}
#fpv-overlay .fpv-flash {
  position: absolute; inset: 0; background: #fff; opacity: 0;
}
`;

function ensureDom() {
  if (dom && dom.root.isConnected) return dom;

  let rootEl = document.getElementById('fpv-overlay');
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = 'fpv-overlay';
    rootEl.className = 'hidden';
    rootEl.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;';
    document.body.appendChild(rootEl);
  }
  if (!document.getElementById('ss-fpv-style')) {
    const st = document.createElement('style');
    st.id = 'ss-fpv-style';
    st.textContent = FPV_CSS;
    document.head.appendChild(st);
  }

  rootEl.innerHTML = `
<div class="fpv-wrap">
  <canvas class="fpv-noise" width="720" height="450"></canvas>
  <div class="fpv-vig"></div>
  <div class="fpv-corner tl"></div><div class="fpv-corner tr"></div>
  <div class="fpv-corner bl"></div><div class="fpv-corner br"></div>
  <div class="fpv-ch"><div class="fpv-ch-ring"></div></div>
  <div class="fpv-rec"><span class="fpv-dot"></span>REC <span class="fpv-timer">00:00</span></div>
  <div class="fpv-tr">
    <div>BAT <span class="fpv-bat">87</span>%</div>
    <div>RSSI <span class="fpv-rssi">-48</span> dBm</div>
    <div>CH 5.8G R3</div>
  </div>
  <div class="fpv-bl">
    <div>ALT <span class="fpv-alt">000</span> M</div>
    <div>SPD <span class="fpv-spd">000</span> KM/H</div>
  </div>
  <div class="fpv-br">ARMED &middot; <span class="fpv-mode">CRUISE</span></div>
  <div class="fpv-skip">ESC — ABORT FEED</div>
  <div class="fpv-lost">SIGNAL LOST</div>
  <div class="fpv-flash"></div>
</div>`;

  const q = (sel) => rootEl.querySelector(sel);
  const noise = q('.fpv-noise');
  dom = {
    root: rootEl,
    noise,
    nctx: noise.getContext('2d'),
    nw: noise.width,
    nh: noise.height,
    pattern: null,
    tears: [],
    tearAt: -1,
    flash: q('.fpv-flash'),
    lost: q('.fpv-lost'),
    timer: q('.fpv-timer'),
    bat: q('.fpv-bat'),
    rssi: q('.fpv-rssi'),
    alt: q('.fpv-alt'),
    spd: q('.fpv-spd'),
    mode: q('.fpv-mode'),
  };
  return dom;
}

// ---------------------------------------------------------------- static
//
// CRITIQUE fix 17. Generating a fresh full-frame random buffer at ~2 px cell is
// 300k+ Math.random() calls per redraw — 15-20 ms on a mid Mac, i.e. a visible
// hitch three times a second in the middle of the money shot. Instead the grain
// is baked ONCE into a 512² tile (xorshift32, ~2 ms, at the first dive) and
// every redraw is a handful of pattern fills at a random offset. That buys the
// fine cell size for free and leaves the frame budget for the tear bands and
// the roll, which are what actually make it read as analogue video.
const NOISE_TILE = 512;

// The buffer is sized to HALF the viewport, so one noise cell lands on ~2 CSS
// pixels under `image-rendering: pixelated` (critique fix 17: it was a fixed
// 240 px across a 1440 px frame — a 6-8 px mosaic that reads as JPEG
// corruption, not as RF interference). Re-solved on every dive, because the
// window can be resized between them.
function fitNoise(d) {
  const w = Math.round(Math.min(860, Math.max(320, (window.innerWidth || 1280) * 0.5)));
  const h = Math.round(Math.min(560, Math.max(200, (window.innerHeight || 800) * 0.5)));
  if (d.noise.width !== w || d.noise.height !== h) {
    d.noise.width = w;                 // resizing also resets the 2D context
    d.noise.height = h;
    d.pattern = null;
  }
  d.nw = d.noise.width;
  d.nh = d.noise.height;
}

function buildNoiseTile() {
  if (noiseTile) return noiseTile;
  const c = document.createElement('canvas');
  c.width = c.height = NOISE_TILE;
  const g = c.getContext('2d');
  const img = g.createImageData(NOISE_TILE, NOISE_TILE);
  const u32 = new Uint32Array(img.data.buffer);
  let s = 0x9E3779B9 >>> 0;
  for (let y = 0; y < NOISE_TILE; y++) {
    // Per-line DC drift + interlace. Real analogue noise is scanned: every line
    // carries its own bias and alternate lines sit slightly darker, which is
    // what keeps it from reading as a uniform sandpaper field.
    const drift = Math.sin(y * 0.37) * 12 + Math.sin(y * 0.041) * 9;
    const inter = (y & 1) ? -9 : 0;
    const bias = 118 + drift + inter;
    for (let x = 0; x < NOISE_TILE; x++) {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      let v = bias + ((s & 0xFF) - 128) * 0.86;
      v = v < 0 ? 0 : (v > 255 ? 255 : v | 0);
      u32[y * NOISE_TILE + x] = (255 << 24) | (v << 16) | (v << 8) | v;
    }
  }
  g.putImageData(img, 0, 0);
  noiseTile = c;
  return c;
}

const TEAR_MIN = 3;
const TEAR_MAX = 6;
const TEAR_PERIOD = 0.12;     // seconds between re-rolls
const ROLL_SPEED = 20;        // buffer px/s ≈ 40 screen px/s at the 2× stretch

function rollTears(d, glitch) {
  const n = TEAR_MIN + ((Math.random() * (TEAR_MAX - TEAR_MIN + 1)) | 0);
  d.tears.length = 0;
  for (let i = 0; i < n; i++) {
    const amp = glitch ? 9 + Math.random() * 22 : 2 + Math.random() * 7;
    d.tears.push({
      y: Math.random() * d.nh,
      h: 2 + Math.random() * 11,
      dx: (Math.random() < 0.5 ? -1 : 1) * amp,
    });
  }
}

// `t` is the feed clock in seconds; `glitch` widens the tears for a spike.
function drawNoise(t, glitch) {
  const d = dom;
  if (!d || !d.nctx) return;
  const g = d.nctx;
  const W = d.nw, H = d.nh;
  const now = Number.isFinite(t) ? t : 0;

  if (!d.pattern) {
    try { d.pattern = g.createPattern(buildNoiseTile(), 'repeat'); }
    catch (err) { d.pattern = null; }
  }
  if (!d.pattern) {                       // no pattern support — flat grey field
    g.fillStyle = '#6E6E6E';
    g.fillRect(0, 0, W, H);
    return;
  }
  if (d.tearAt < 0 || now - d.tearAt > TEAR_PERIOD || glitch) {
    d.tearAt = now;
    rollTears(d, glitch);
  }

  const ox = (Math.random() * NOISE_TILE) | 0;
  const oy = (Math.random() * NOISE_TILE) | 0;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = d.pattern;

  // base field
  g.save();
  g.translate(-ox, -oy);
  g.fillRect(ox, oy, W, H);
  g.restore();

  // horizontal tear bands: the same field, shifted sideways, clipped to a row
  for (let i = 0; i < d.tears.length; i++) {
    const b = d.tears[i];
    g.save();
    g.beginPath();
    g.rect(0, b.y, W, b.h);
    g.clip();
    g.translate(-ox + b.dx, -oy);
    g.fillRect(ox - b.dx, oy, W, H);
    g.restore();
  }

  // one soft band rolling down the frame — the vertical hold never quite locks
  const period = H + 60;
  const ry = ((now * ROLL_SPEED) % period) - 60;
  const grad = g.createLinearGradient(0, ry, 0, ry + 60);
  grad.addColorStop(0.0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.30)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.30)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = grad;
  g.fillRect(0, ry, W, 60);
  // a hard dark line at the leading edge of the band — the retrace
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = 'rgba(0,0,0,0.34)';
  g.fillRect(0, ry + 57, W, 3);
  g.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------- audio

function ensureAudio() {
  if (audioShared) return audioShared;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioShared = { ctx: new Ctx() };
  } catch (err) {
    audioShared = null;
  }
  return audioShared;
}

function startWhine(dur) {
  try {
    const A = ensureAudio();
    if (!A) return null;
    const ctx = A.ctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.05, t0 + 0.6);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(750, t0);
    filt.frequency.exponentialRampToValueAtTime(2600, t0 + dur);
    filt.connect(gain);
    gain.connect(ctx.destination);
    const oscs = [];
    for (const det of [0, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(150 + det, t0);
      o.frequency.exponentialRampToValueAtTime(680 + det * 3, t0 + dur);
      o.connect(filt);
      o.start(t0);
      oscs.push(o);
    }
    return { ctx, gain, oscs };
  } catch (err) {
    return null;
  }
}

function stopWhine(w, impact) {
  if (!w) return;
  try {
    const t = w.ctx.currentTime;
    w.gain.gain.cancelScheduledValues(t);
    w.gain.gain.setValueAtTime(Math.max(0.0001, w.gain.gain.value || 0.02), t);
    w.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    for (const o of w.oscs) o.stop(t + 0.12);
    if (impact) {
      const ctx = w.ctx;
      // static burst
      const len = Math.floor(ctx.sampleRate * 0.45);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22, t);
      src.connect(g);
      g.connect(ctx.destination);
      src.start(t);
      // sub thump
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(75, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.3);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.25, t);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g2);
      g2.connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.4);
    }
  } catch (err) { /* audio failure is never fatal */ }
}

// ---------------------------------------------------------------- helpers

function toTarget(targetPos) {
  const v = new THREE.Vector3();
  if (!targetPos) return v;
  if (targetPos.isVector3) return v.copy(targetPos);
  return v.set(targetPos.x ?? 0, targetPos.y ?? 0, targetPos.z ?? 0);
}

function launchPos(fromUnit, tgt) {
  const v = new THREE.Vector3();
  const mesh = fromUnit?.mesh?.isObject3D ? fromUnit.mesh
    : (fromUnit?.isObject3D ? fromUnit : null);
  if (mesh) {
    try {
      const box = new THREE.Box3().setFromObject(mesh);
      if (!box.isEmpty() && Number.isFinite(box.max.y)) {
        box.getCenter(v);
        v.y = box.max.y + 2;
        return v;
      }
    } catch (err) { /* fall through */ }
    mesh.getWorldPosition(v);
    v.y += 8;
    return v;
  }
  return v.set(tgt.x - 42, tgt.y + 22, tgt.z + 18);
}

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(Math.max(0, Math.round(n))).padStart(3, '0');

const nowMs = () =>
  (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const finite3 = (v) =>
  !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
// Fallback RTS framing (38° polar, 118 u) for the case where the pre-dive offset
// is unusable — see restoreCamera().
const FALLBACK_OFFSET = new THREE.Vector3(
  0,
  118 * Math.cos(THREE.MathUtils.degToRad(38)),
  118 * Math.sin(THREE.MathUtils.degToRad(38)));

// ---------------------------------------------------------------- the dive

export function playFPVDive(engine, fromUnit, targetPos, onImpact) {
  const impactCb = typeof onImpact === 'function' ? onImpact : () => {};
  if (!engine || !engine.camera || typeof engine.onFrame !== 'function' || active) {
    impactCb();
    return Promise.resolve();
  }
  active = true;

  return new Promise((resolve) => {
    const camera = engine.camera;
    const controls = engine.controls ?? null;

    const tgt = toTarget(targetPos);
    const start = launchPos(fromUnit, tgt);

    // saved RTS state — restore is PRE-AIMED at the target (same offset, new focus)
    const savedOffset = controls && controls.target
      ? camera.position.clone().sub(controls.target)
      : null;
    const savedPos = camera.position.clone();
    const savedQuat = camera.quaternion.clone();
    const fov0 = camera.fov;
    const near0 = camera.near;
    if (controls) controls.enabled = false;
    camera.near = 0.5;

    // flight path: pop up from the launch team, cruise, terminal dive
    let dirH = new THREE.Vector3(tgt.x - start.x, 0, tgt.z - start.z);
    const distH = Math.max(dirH.length(), 10);
    dirH = dirH.lengthSq() > 1e-4 ? dirH.normalize() : new THREE.Vector3(1, 0, 0);
    const p0 = start.clone().add(new THREE.Vector3(0, 6, 0));
    // Integration fix: the old apex (start + 0.25·distH forward, +26 up) made the
    // opening tangent ~72–85° nose-up, so the seized camera stared at empty sky
    // for the whole climb. Flatter apex, pushed further downrange, keeps the
    // ground and the target in frame from the first second of the feed.
    const p1 = start.clone()
      .addScaledVector(dirH, distH * 0.42)
      .add(new THREE.Vector3(0, 13 + distH * 0.05, 0));
    const p2 = tgt.clone()
      .addScaledVector(dirH, -distH * 0.28)
      .add(new THREE.Vector3(0, 20 + distH * 0.10, 0));
    const p3 = tgt.clone().add(new THREE.Vector3(0, 0.8, 0));
    const curve = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
    const DUR = THREE.MathUtils.clamp(3.8 + distH / 60, 4.0, 5.0);

    const d = ensureDom();
    fitNoise(d);
    d.root.classList.remove('hidden');
    d.root.style.opacity = '1';
    d.root.style.transition = '';
    d.flash.style.transition = 'none';
    d.flash.style.opacity = '0';
    d.lost.style.opacity = '0';
    d.noise.style.opacity = '0.08';
    d.mode.textContent = 'CRUISE';
    d.tearAt = -1;
    drawNoise(0, false);

    // CRITIQUE fix 6 — the feed owns the screen from this line. `cinematic` is
    // read every frame by fx/markers.js (counters, ground rings, selection
    // ring) and fx/vfx.js (hex grid, highlight field, perimeter stroke,
    // suppression rings, damage floats); `body.fpv-active` is the CSS gate for
    // #hud-root, the action bar, the tooltip and #ss-worldlabels. ui/hud.js
    // mirrors that class from a MutationObserver on this overlay, but setting
    // it here means the map furniture is gone on the SAME frame the feed opens
    // rather than one mutation callback later. It is set LAST in the setup
    // block on purpose: if any of the overlay construction above throws, the
    // dive never starts and the tactical layer is never taken away.
    engine.cinematic = true;
    try { document.body.classList.add('fpv-active'); }
    catch (err) { /* no document — nothing to suppress */ }

    const whine = startWhine(DUR);

    // scratch
    const _pos = new THREE.Vector3();
    const _tan = new THREE.Vector3();
    const _right = new THREE.Vector3();
    const _upv = new THREE.Vector3();
    const _look = new THREE.Vector3();
    const _prev = start.clone();
    const _tgtLook = tgt.clone().add(new THREE.Vector3(0, 0.6, 0));

    let tFly = 0;
    // The feed clock keeps running after impact (the flight clock does not), and
    // the static's tear roll and vertical hold are driven off it.
    let tFeed = 0;
    let noiseAcc = 1;
    let glitchUntil = -1;
    let phase = 'fly';
    let impacted = false;
    let finished = false;
    let doneCalled = false;
    let restored = false;
    const timers = [];
    let watchdog = 0;

    function fireImpactCallback() {
      if (doneCalled) return;
      doneCalled = true;
      try { impactCb(); }
      catch (err) { console.warn('[dronecam] onImpact error:', err); }
    }

    // CRITIQUE fix 22 — the restore is the single most dangerous moment in this
    // module: it is reachable from the frame loop (terminal impact), from a DOM
    // key handler (Esc), and from a wall-clock watchdog, and it hands a camera it
    // did not build back to MapControls. If ANY component of that camera is
    // non-finite the viewport goes permanently black with no console error, so
    // every input is validated and the whole thing runs exactly once.
    function restoreCamera() {
      if (restored) return;
      restored = true;
      // The RTS camera is back, so the RTS layer is legal again — and the
      // player cannot see it yet either way, because impact() has just put the
      // static to full opacity over the whole frame. Clearing the flag here
      // rather than at finishAll() means counters, rings and the grid are
      // already in place as the static fades off the restored view, instead of
      // popping in a beat later. `body.fpv-active` stays until the overlay is
      // actually gone — that one is the HUD's blackout, not the map's.
      engine.cinematic = false;
      camera.fov = (Number.isFinite(fov0) && fov0 > 1 && fov0 < 179) ? fov0 : 40;
      camera.near = (Number.isFinite(near0) && near0 > 0) ? near0 : 2;
      camera.updateProjectionMatrix();

      // The pre-dive offset is what pre-aims the restored camera at the target so
      // the caller's explosion lands in frame. Reject it if it is NaN or a
      // degenerate length (a zero offset makes OrbitControls' spherical radius 0).
      let offset = FALLBACK_OFFSET;
      if (finite3(savedOffset)) {
        const len = savedOffset.length();
        if (len > 8 && len < 400) offset = savedOffset;
      }
      const aim = finite3(tgt) ? tgt : (finite3(savedPos) ? savedPos : null);

      if (controls && controls.target && aim) {
        controls.target.set(aim.x, 0, aim.z);
        camera.position.copy(controls.target).add(offset);
        camera.up.set(0, 1, 0);
        camera.lookAt(controls.target);
        controls.enabled = true;
        if (typeof controls.update === 'function') controls.update();
      } else {
        if (finite3(savedPos)) camera.position.copy(savedPos);
        if (savedQuat && Number.isFinite(savedQuat.w)) camera.quaternion.copy(savedQuat);
        // The original code left `controls.enabled` false on this branch, which
        // silently killed pan/zoom/rotate for the rest of the match.
        if (controls) controls.enabled = true;
      }

      // Last line of defence. engine.js caches the last known-good RTS pose every
      // frame and can rebuild it — including flushing MapControls' private damping
      // accumulators, which are never cleared once a NaN gets into them.
      try {
        if (typeof engine.isCameraSane === 'function' && !engine.isCameraSane() &&
            typeof engine.recoverCamera === 'function') {
          engine.recoverCamera('dronecam restore');
        }
      } catch (err) { console.warn('[dronecam] camera recovery failed:', err); }
    }

    function finishAll() {
      if (finished) return;
      finished = true;
      for (const id of timers) clearTimeout(id);
      if (watchdog) { clearInterval(watchdog); watchdog = 0; }
      offFrame();
      window.removeEventListener('keydown', onKey);
      // Belt and braces: every exit path already runs restoreCamera(), but the
      // cinematic flag must NEVER survive this function — a stuck flag means a
      // battlefield with no counters, no rings and no grid for the rest of the
      // match, with nothing on screen to explain it.
      engine.cinematic = false;
      try { document.body.classList.remove('fpv-active'); }
      catch (err) { /* no document — nothing to restore */ }
      d.root.classList.add('hidden');
      d.root.style.opacity = '';
      d.root.style.transition = '';
      d.flash.style.opacity = '0';
      d.lost.style.opacity = '0';
      d.noise.style.opacity = '0.08';
      if (!impacted) {
        try { restoreCamera(); }
        catch (err) { console.warn('[dronecam] camera restore error:', err); }
        fireImpactCallback();
      }
      active = false;
      resolve();
    }

    function impact() {
      if (impacted) return;
      impacted = true;
      phase = 'post';
      try { restoreCamera(); }
      catch (err) { console.warn('[dronecam] camera restore error:', err); }
      stopWhine(whine, true);
      d.flash.style.transition = 'none';
      d.flash.style.opacity = '1';
      d.noise.style.opacity = '1';
      drawNoise(tFeed, true);
      fireImpactCallback();
      timers.push(setTimeout(() => {
        d.flash.style.transition = 'opacity 140ms linear';
        d.flash.style.opacity = '0';
        d.lost.style.opacity = '1';
      }, 90));
      timers.push(setTimeout(() => {
        d.root.style.transition = 'opacity 260ms ease';
        d.root.style.opacity = '0';
      }, 680));
      timers.push(setTimeout(finishAll, 980));
    }

    function onKey(e) {
      if (e.key === 'Escape') impact();
    }
    window.addEventListener('keydown', onKey);

    // CRITIQUE fix 22 — the old net was a single wall-clock `setTimeout` at
    // DUR + 4 s. The flight advances on FRAMES, and a throttled or backgrounded
    // tab delivers rAF at a few Hz or not at all, so in exactly that case the
    // timeout fired *mid-flight*: the RTS camera was restored while the frame
    // callback was still writing drone positions into it, and control was handed
    // back half-seized. The net now watches the FRAME clock. It intervenes only
    // when frames have genuinely stopped arriving (nothing will ever finish the
    // dive, so the game would otherwise stall waiting on this promise) or when an
    // absolute ceiling is reached.
    const tStart = nowMs();
    const STALL_MS = 1500;      // no frames for this long ⇒ the loop is not running
    const HARD_CAP_MS = 30000;  // never hold the game hostage
    let lastFrameAt = tStart;
    watchdog = setInterval(() => {
      if (impacted || finished) { clearInterval(watchdog); watchdog = 0; return; }
      const t = nowMs();
      if (t - lastFrameAt > STALL_MS || t - tStart > HARD_CAP_MS) {
        clearInterval(watchdog); watchdog = 0;
        impact();
      }
    }, 250);

    const offFrame = engine.onFrame((dt) => {
      try {
        lastFrameAt = nowMs();
        tFeed += dt;
        // `restored` is belt-and-braces next to the phase check: once the camera
        // has been handed back to MapControls this callback must never write to
        // it again, whatever route triggered the hand-back.
        if (phase === 'post' || restored) {
          noiseAcc += dt;
          // full-static lost-signal frames: fastest cadence, hardest tears
          if (noiseAcc > 0.035) { noiseAcc = 0; drawNoise(tFeed, true); }
          return;
        }
        tFly += dt;
        const t = Math.min(1, tFly / DUR);
        const e = 1 - Math.cos(t * Math.PI / 2); // slow climb, accelerating dive

        curve.getPoint(e, _pos);
        curve.getTangent(e, _tan);
        if (_tan.lengthSq() < 1e-6) _tan.set(0, -1, 0);
        _tan.normalize();

        // wobble grows toward terminal
        const w = 0.18 + t * t * 0.9;
        _right.crossVectors(_tan, UP);
        if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
        _right.normalize();
        _upv.crossVectors(_right, _tan).normalize();
        const ox = Math.sin(tFly * 9.3) * 0.22 * w + Math.sin(tFly * 23.7) * 0.07 * w;
        const oy = Math.cos(tFly * 7.1) * 0.16 * w;
        _pos.addScaledVector(_right, ox).addScaledVector(_upv, oy);

        // Never write a non-finite pose into the camera — a degenerate launch
        // point or target would otherwise black out the viewport for the rest of
        // the match. Cut to impact instead; the player sees the flash, the
        // caller's onImpact still fires, and the RTS camera comes back clean.
        if (!finite3(_pos)) {
          console.warn('[dronecam] flight path went non-finite — cutting to impact.');
          impact();
          return;
        }
        camera.position.copy(_pos);
        // Integration fix: the original blend (0.55→0.95) meant the camera stared
        // straight along the near-vertical climb tangent for the first two thirds
        // of the flight — i.e. four seconds of empty sky on the headline shot.
        // The operator now holds a partial fix on the aimpoint from frame one and
        // settles fully onto it well before the terminal dive.
        const lookBlend = 0.42 + 0.58 * THREE.MathUtils.smoothstep(t, 0.0, 0.45);
        _look.copy(_pos).addScaledVector(_tan, 12).lerp(_tgtLook, lookBlend);
        camera.lookAt(_look);
        camera.rotateZ(Math.sin(tFly * 6.2) * 0.05 * (0.4 + t) - ox * 0.35);
        camera.fov = 66 + 14 * t; // slight punch-in toward the target
        camera.updateProjectionMatrix();

        // ---- overlay telemetry
        const spd = dt > 0 ? (_pos.distanceTo(_prev) / dt) * 3.6 : 0;
        _prev.copy(_pos);
        d.timer.textContent =
          `${pad2((tFly / 60) | 0)}:${pad2((tFly | 0) % 60)}`;
        d.bat.textContent = String(Math.max(4, Math.round(87 - tFly * 3.5)));
        d.rssi.textContent = String(Math.round(
          -48 - t * 22 + Math.sin(tFly * 17) * 3));
        d.alt.textContent = pad3(Math.max(0, camera.position.y) * 2.5);
        d.spd.textContent = pad3(Math.min(999, spd * 1.6));
        if (t > 0.62 && d.mode.textContent !== 'TERMINAL') {
          d.mode.textContent = 'TERMINAL';
        }

        // Static: baseline 8 %, worsening near the ground, with short hard
        // spikes (critique fix 17 — 0.03 s at 0.45 instead of 0.06 s at 0.24;
        // a long soft spike reads as a dirty screen, a short hard one reads as
        // the link dropping a frame). Redrawn at ~25 Hz so the tear bands and
        // the vertical roll actually move.
        noiseAcc += dt;
        const wasGlitch = glitchUntil >= 0;
        if (!wasGlitch && Math.random() < dt * 1.6) {
          glitchUntil = tFly + 0.03;
          noiseAcc = 1;                       // repaint immediately, with tears
        }
        if (wasGlitch && tFly > glitchUntil) {
          glitchUntil = -1;
          noiseAcc = 1;                       // and repaint clean on the way out
        }
        if (noiseAcc > 0.04) {
          noiseAcc = 0;
          drawNoise(tFeed, glitchUntil >= 0);
        }
        d.noise.style.opacity = glitchUntil >= 0
          ? '0.45'
          : String((0.08 + t * 0.06).toFixed(3));

        if (t >= 1) impact();
      } catch (err) {
        console.warn('[dronecam] frame error:', err);
        impact();
      }
    });
  });
}
