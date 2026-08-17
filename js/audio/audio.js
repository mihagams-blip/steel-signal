// STEEL SIGNAL — audio/audio.js
// Full WebAudio procedural SFX + ambience. Everything except the music bed is
// synthesized (filtered noise, oscillators, waveshaping) at call time from a
// couple of cached noise buffers.
//
// Contract (ARCHITECTURE.md):
//   export const Audio = { init(), sfx(name, opts), setAmbience(on) }
// Extra exports (noted in INTEGRATION_NOTES.md):
//   export function wireAudio(Game) — subscribes every sfx to the canonical
//   Game events; main.js calls it once after Game.init. Idempotent.
//
// OWNER-FEEDBACK ROUND additions:
//   · MUSIC BED — audio/theme.m4a, looped. The ONE sanctioned audio asset
//     (alongside art/units/*.png); everything else here is still procedural.
//     If the file 404s or will not decode the game runs silently: no throw.
//   · MIXER — separate music / SFX levels, each independently mutable, plus a
//     master mute. Persisted in localStorage. ui/hud.js draws the control and
//     owns the [K] hotkey; this module owns the gain graph and the storage.
//   · MOVEMENT VOICES — a looping, positional, per-unit-class engine/step
//     sound that starts when a unit STARTS moving and stops when it arrives.
//     See `_installMoveHook` for why this wraps `Game.moveUnit` instead of
//     listening to `unitMoved` (which fires only on arrival).
//
// init() must be called from a user gesture (main.js wires pointerdown).
// Every public entry point is safe to call before init — it just no-ops.

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

// --- mixer persistence -----------------------------------------------------
// One key, one JSON blob, versioned so a future shape change cannot resurrect
// a stale record as garbage levels. Storage may throw (private mode, disabled
// cookies, file:// in some browsers) — every access is wrapped.

const MIX_KEY = 'steelsignal.mix.v1';
const MIX_DEFAULT = Object.freeze({
  music: 0.55,        // 0..1 slider position, NOT gain (see gainFor)
  sfx: 1.0,
  musicMuted: false,
  sfxMuted: false,
  muted: false,       // master
});

// Slider position → linear gain. Squaring is the cheap perceptual curve: it
// makes the bottom half of the travel useful instead of "already silent".
function gainFor(v) {
  const x = Math.min(1, Math.max(0, Number(v) || 0));
  return x * x;
}

const MUSIC_TRIM = 0.8;   // the track is a full mix; it sits under the guns
const MUSIC_DUCK = 0.5;   // −6.0 dB while the FPV feed is up

function loadMix() {
  const mix = { ...MIX_DEFAULT };
  try {
    const raw = window.localStorage?.getItem(MIX_KEY);
    if (!raw) return mix;
    const got = JSON.parse(raw);
    if (got && typeof got === 'object') {
      if (Number.isFinite(got.music)) mix.music = Math.min(1, Math.max(0, got.music));
      if (Number.isFinite(got.sfx)) mix.sfx = Math.min(1, Math.max(0, got.sfx));
      mix.musicMuted = !!got.musicMuted;
      mix.sfxMuted = !!got.sfxMuted;
      mix.muted = !!got.muted;
    }
  } catch (_) { /* unreadable storage is not an error, it is a default */ }
  return mix;
}

function saveMix(mix) {
  try { window.localStorage?.setItem(MIX_KEY, JSON.stringify(mix)); }
  catch (_) { /* quota / private mode — the session still works */ }
}

// --- movement-sound classification ----------------------------------------
// Sound follows the CHASSIS, not the weapon: everything that rolls on the same
// running gear shares a voice, and the fallbacks below mean a unit type this
// module has never met still gets a sensible engine instead of silence.

const MOVE_CLASS_BY_TYPE = {
  infantry: 'foot',
  atgm_team: 'foot',
  mbt: 'tracked_heavy',
  ifv: 'tracked_light',
  apc: 'tracked_light',
  truck: 'wheeled',
  ew: 'wheeled',
  supply: 'wheeled',
  spg: 'chassis_heavy',
  mlrs: 'chassis_heavy',
  aa: 'chassis_heavy',
  sam: 'chassis_heavy',
  fpv_drone: 'drone',
  loiter_munition: 'drone',
  recon_drone: 'drone',
  helo: 'rotor',
};

const MOVE_CLASS_BY_UNITCLASS = {
  armor: 'tracked_heavy',
  mech: 'tracked_light',
  artillery: 'chassis_heavy',
  aa: 'chassis_heavy',
  support: 'wheeled',
  infantry: 'foot',
  drone: 'drone',
  air: 'rotor',
  rotary: 'rotor',
  helicopter: 'rotor',
};

function moveClassOf(unit) {
  const id = String(unit?.typeId ?? unit?.type?.id ?? '').toLowerCase();
  if (MOVE_CLASS_BY_TYPE[id]) return MOVE_CLASS_BY_TYPE[id];
  // Name-shaped fallbacks, so a unit added after this file was written still
  // sounds right. Order matters: 'helo' before the generic air/drone tests.
  if (/hel[io]|rotor|hind|apache/.test(id)) return 'rotor';
  if (/drone|uav|loiter|fpv/.test(id)) return 'drone';
  if (/sam|shorad|missile_bat|aa/.test(id)) return 'chassis_heavy';
  if (/truck|supply|jammer|ew/.test(id)) return 'wheeled';
  if (/inf|team|squad|atgm/.test(id)) return 'foot';
  if (/tank|mbt/.test(id)) return 'tracked_heavy';
  const cls = String(unit?.type?.class ?? '').toLowerCase();
  if (MOVE_CLASS_BY_UNITCLASS[cls]) return MOVE_CLASS_BY_UNITCLASS[cls];
  return 'wheeled';
}

// Stable per-unit detune so two tanks in a column are not phase-identical.
// Hash, not Math.random: the same unit always sounds like itself.
function unitJitter(unit) {
  const s = String(unit?.id ?? unit?.typeId ?? 'x');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000; // 0..1
}

const MAX_MOVE_VOICES = 3;   // a column is a column, not a wall of engines

let _noiseBuf = null;      // 2 s white noise, shared by everything
let _crackleBuf = null;    // sparse impulse crackle for explosion tails

function makeNoiseBuffer(ctx) {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function makeCrackleBuffer(ctx) {
  const len = Math.floor(ctx.sampleRate * 1.5);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let i = 0;
  while (i < len) {
    // sparse decaying pops — reads as burning debris
    const burst = 4 + Math.floor(Math.random() * 30);
    const amp = Math.random() * (1 - i / len);
    for (let j = 0; j < burst && i < len; j++, i++) {
      d[i] = (Math.random() * 2 - 1) * amp * (1 - j / burst);
    }
    i += Math.floor(Math.random() * ctx.sampleRate * 0.02);
  }
  return buf;
}

// soft-clip curve for beefy explosions/cannon
function makeSoftClipCurve(amount = 2.5) {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(amount * x);
  }
  return curve;
}

function rand(a, b) { return a + Math.random() * (b - a); }

// ---------------------------------------------------------------------------
// the singleton
// ---------------------------------------------------------------------------

export const Audio = {
  ctx: null,
  master: null,       // master gain → compressor → destination
  sfxBus: null,       // per-category buses hang off sfxGroup
  ambBus: null,
  sfxGroup: null,     // SFX + ambience level (the "SFX" fader)
  musicBus: null,     // music level (the "MUSIC" fader)
  musicDuck: null,    // FPV-dive ducking, independent of the fader
  _comp: null,
  _clipCurve: null,
  _ambience: false,   // desired state (may be set before init)
  _ambNodes: null,    // live ambience node handles
  _rumbleTimer: 0,
  _last: Object.create(null), // per-name throttle timestamps

  // mixer — read from storage at module load so hud.js can paint the control
  // with the player's saved choice before any gesture has happened.
  _mix: loadMix(),
  _mixListeners: new Set(),
  _ducked: false,

  // music
  _musicBuf: null,
  _musicSrc: null,
  _musicEl: null,
  _musicState: 'idle',   // 'idle' | 'loading' | 'playing' | 'failed'

  // movement voices
  _moveVoices: new Set(),

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      // main.js arms init() on BOTH the first pointerdown and the first
      // keydown, so a music start that lost a race with the autoplay policy
      // gets exactly one more chance. Bounded: two gestures, two attempts.
      if (this._musicState === 'failed') {
        this._musicState = 'idle';
        this._loadMusic();
      }
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const ctx = this.ctx;

      this._comp = ctx.createDynamicsCompressor();
      this._comp.threshold.value = -18;
      this._comp.knee.value = 24;
      this._comp.ratio.value = 6;
      this._comp.attack.value = 0.003;
      this._comp.release.value = 0.25;
      this._comp.connect(ctx.destination);

      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this._comp);

      // MIXER GRAPH
      //   sfxBus ┐
      //          ├→ sfxGroup ─┐
      //   ambBus ┘            ├→ master → comp → destination
      //   musicBus → musicDuck┘
      // sfxBus/ambBus keep their existing meanings (per-effect level and the
      // ambience fade) so nothing above this line had to change; the player's
      // SFX fader lives on the new group node underneath them.
      this.sfxGroup = ctx.createGain();
      this.sfxGroup.gain.value = 1.0;
      this.sfxGroup.connect(this.master);

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = 1.0;
      this.sfxBus.connect(this.sfxGroup);

      this.ambBus = ctx.createGain();
      this.ambBus.gain.value = 0.0; // faded in by setAmbience
      this.ambBus.connect(this.sfxGroup);

      this.musicDuck = ctx.createGain();
      this.musicDuck.gain.value = this._ducked ? MUSIC_DUCK : 1.0;
      this.musicDuck.connect(this.master);

      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = 0.0001;   // applyMix ramps it to the real level
      this.musicBus.connect(this.musicDuck);

      _noiseBuf = makeNoiseBuffer(ctx);
      _crackleBuf = makeCrackleBuffer(ctx);
      this._clipCurve = makeSoftClipCurve(2.5);

      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      ctx.addEventListener?.('statechange', () => {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      });

      // Apply the persisted mixer BEFORE anything can make a sound, so a
      // player who muted last session never hears a frame of audio.
      this._applyMix(0);

      if (this._ambience) this._startAmbience();

      // The music bed. Gesture-gated by construction: nothing here runs until
      // init(), and init() is only ever called from a pointer/key event.
      this._loadMusic();

      // Fallback self-wiring: main.js gestures Audio.init() but (as shipped)
      // never calls wireAudio(Game). window.STEEL.Game is the contracted debug
      // handle main.js keeps — wire through it if the integrator hasn't.
      // wireAudio is idempotent, so an explicit main.js call stays safe.
      if (!_wired && typeof window !== 'undefined' && window.STEEL?.Game) {
        wireAudio(window.STEEL.Game);
      }
    } catch (err) {
      console.warn('[audio] init failed:', err);
      this.ctx = null;
    }
  },

  // -------------------------------------------------------------------------
  // low-level voices (all return nothing or a stop-handle; all no-op pre-init)
  // -------------------------------------------------------------------------

  _now() { return this.ctx.currentTime; },

  // filtered noise burst. opts: dur, gain, type ('lowpass'|'bandpass'|'highpass'),
  // freq, freqEnd, Q, attack, rate, clip, when, out
  _noise(o = {}) {
    const ctx = this.ctx;
    const t0 = (o.when ?? this._now());
    const dur = o.dur ?? 0.3;
    const src = ctx.createBufferSource();
    src.buffer = _noiseBuf;
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1;

    const filt = ctx.createBiquadFilter();
    filt.type = o.type ?? 'lowpass';
    filt.frequency.setValueAtTime(o.freq ?? 800, t0);
    if (o.freqEnd != null) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t0 + dur);
    }
    filt.Q.value = o.Q ?? 0.8;

    const g = ctx.createGain();
    const peak = o.gain ?? 0.3;
    const atk = o.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filt);
    let tail = filt;
    if (o.clip) {
      const ws = ctx.createWaveShaper();
      ws.curve = this._clipCurve;
      filt.connect(ws);
      tail = ws;
    }
    tail.connect(g);
    g.connect(o.out ?? this.sfxBus);
    src.start(t0, rand(0, 1.5)); // random loop offset — de-correlates repeated bursts
    src.stop(t0 + dur + 0.05);
    return { src, g, filt };
  },

  // oscillator voice. opts: type, freq, freqEnd, dur, gain, attack, when, out, detune
  _tone(o = {}) {
    const ctx = this.ctx;
    const t0 = (o.when ?? this._now());
    const dur = o.dur ?? 0.3;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq ?? 440, t0);
    if (o.freqEnd != null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t0 + dur);
    }
    if (o.detune) osc.detune.value = o.detune;

    const g = ctx.createGain();
    const peak = o.gain ?? 0.2;
    const atk = o.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g);
    g.connect(o.out ?? this.sfxBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    return { osc, g };
  },

  // -------------------------------------------------------------------------
  // named effects
  // -------------------------------------------------------------------------

  // main gun: sharp crack + filtered boom + sub thump
  _cannon(o = {}) {
    const v = o.vol ?? 1;
    // muzzle crack
    this._noise({ dur: 0.06, type: 'highpass', freq: 1800, gain: 0.5 * v, attack: 0.001 });
    // body boom
    this._noise({ dur: 0.5, type: 'lowpass', freq: 900, freqEnd: 90, gain: 0.65 * v, attack: 0.002, clip: true });
    // sub thump
    this._tone({ type: 'sine', freq: 62, freqEnd: 28, dur: 0.45, gain: 0.55 * v, attack: 0.002 });
  },

  // machine gun / autocannon rattle
  _mg(o = {}) {
    const shots = o.shots ?? (6 + Math.floor(Math.random() * 5));
    const rate = o.rate ?? 0.085; // s between shots
    const t0 = this._now();
    for (let i = 0; i < shots; i++) {
      const w = t0 + i * rate * rand(0.92, 1.08);
      this._noise({ when: w, dur: 0.05, type: 'bandpass', freq: rand(750, 1050), Q: 1.2, gain: 0.28, attack: 0.001 });
      this._tone({ when: w, type: 'triangle', freq: 140, freqEnd: 70, dur: 0.05, gain: 0.12, attack: 0.001 });
    }
  },

  // ATGM / rocket motor whoosh
  _missile() {
    this._noise({ dur: 0.7, type: 'bandpass', freq: 400, freqEnd: 1400, Q: 1.5, gain: 0.3, attack: 0.05 });
    this._noise({ dur: 0.7, type: 'lowpass', freq: 300, gain: 0.2, attack: 0.03 });
  },

  // artillery leaving the tube: distant hollow thump
  _artyFire() {
    this._noise({ dur: 0.35, type: 'lowpass', freq: 380, freqEnd: 70, gain: 0.4, attack: 0.004, clip: true });
    this._tone({ type: 'sine', freq: 70, freqEnd: 34, dur: 0.4, gain: 0.3 });
  },

  // MLRS ripple — several staggered thumps + rocket hiss
  _mlrs() {
    const t0 = this._now();
    for (let i = 0; i < 4; i++) {
      const w = t0 + i * 0.16;
      this._noise({ when: w, dur: 0.3, type: 'lowpass', freq: 420, freqEnd: 80, gain: 0.3, attack: 0.004 });
      this._noise({ when: w, dur: 0.5, type: 'bandpass', freq: 900, freqEnd: 2200, Q: 1.2, gain: 0.14, attack: 0.02 });
    }
  },

  // incoming shell whistle (descending) — schedule impact separately
  _whistle(o = {}) {
    const dur = o.dur ?? 1.1;
    const ctx = this.ctx;
    const t0 = this._now();
    const v = this._tone({ type: 'sine', freq: 2100, freqEnd: 420, dur, gain: 0.12, attack: 0.15 });
    // vibrato — sells the "incoming" wobble
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 55;
    lfo.connect(lfoG);
    lfoG.connect(v.osc.frequency);
    lfo.start(t0);
    lfo.stop(t0 + dur);
  },

  // layered explosion; size 0.6 (grenade) … 1.6 (fuel depot)
  _explosion(o = {}) {
    const s = o.size ?? 1;
    // initial crack
    this._noise({ dur: 0.05, type: 'highpass', freq: 2500, gain: 0.4 * s, attack: 0.001 });
    // main blast
    this._noise({ dur: 0.9 * s, type: 'lowpass', freq: 1200, freqEnd: 60, gain: 0.7 * Math.min(s, 1.2), attack: 0.002, clip: true });
    // sub punch
    this._tone({ type: 'sine', freq: 55, freqEnd: 24, dur: 0.7 * s, gain: 0.6 * Math.min(s, 1.2), attack: 0.002 });
    // debris crackle tail
    const ctx = this.ctx;
    const t0 = this._now();
    const src = ctx.createBufferSource();
    src.buffer = _crackleBuf;
    src.playbackRate.value = rand(0.85, 1.1);
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 2400;
    filt.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.16 * s), t0 + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.3 * s);
    src.connect(filt); filt.connect(g); g.connect(this.sfxBus);
    src.start(t0 + 0.1);
    src.stop(t0 + 1.4 * s);
  },

  // FPV quad motor whine with terminal pitch ramp. Returns a stop-handle for
  // dronecam.js: { stop() }. opts: dur (default 4.5), ramp (final pitch mult)
  _fpvWhine(o = {}) {
    const ctx = this.ctx;
    const dur = o.dur ?? 4.5;
    const t0 = this._now();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.4);
    g.gain.setValueAtTime(0.14, t0 + dur - 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(1600, t0);
    filt.frequency.exponentialRampToValueAtTime(4200, t0 + dur);
    filt.connect(g);
    g.connect(this.sfxBus);

    const base = o.freq ?? 210;
    const ramp = o.ramp ?? 2.6;
    const oscs = [];
    for (const [mult, det, type] of [[1, 0, 'sawtooth'], [1, 9, 'sawtooth'], [2.01, -6, 'square']]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.detune.value = det;
      osc.frequency.setValueAtTime(base * mult, t0);
      // slow spool-up then terminal-dive scream
      osc.frequency.linearRampToValueAtTime(base * mult * 1.25, t0 + dur * 0.55);
      osc.frequency.exponentialRampToValueAtTime(base * mult * ramp, t0 + dur);
      osc.connect(filt);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
      oscs.push(osc);
    }
    // prop flutter
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 13;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.03;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    lfo.start(t0); lfo.stop(t0 + dur);

    return {
      stop: () => {
        try {
          const t = ctx.currentTime;
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(g.gain.value, t);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
          for (const osc of oscs) osc.stop(t + 0.1);
          lfo.stop(t + 0.1);
        } catch (_) { /* already stopped */ }
      },
    };
  },

  // radio squelch chirp — turn changes, orders acknowledged
  _squelch(o = {}) {
    const t0 = this._now();
    this._noise({ dur: 0.09, type: 'bandpass', freq: 1500, Q: 2.5, gain: 0.14, attack: 0.002 });
    this._tone({ when: t0 + 0.07, type: 'square', freq: o.freq ?? 1180, dur: 0.06, gain: 0.05, attack: 0.004 });
    this._noise({ when: t0 + 0.13, dur: 0.05, type: 'bandpass', freq: 1900, Q: 3, gain: 0.08, attack: 0.002 });
  },

  // short UI click
  _tick(o = {}) {
    this._noise({ dur: 0.03, type: 'bandpass', freq: o.freq ?? 2100, Q: 4, gain: o.gain ?? 0.09, attack: 0.001 });
  },

  _uiConfirm() {
    const t0 = this._now();
    this._tone({ when: t0, type: 'triangle', freq: 660, dur: 0.08, gain: 0.08 });
    this._tone({ when: t0 + 0.09, type: 'triangle', freq: 990, dur: 0.12, gain: 0.08 });
  },

  _uiError() {
    this._tone({ type: 'square', freq: 220, freqEnd: 160, dur: 0.16, gain: 0.07 });
  },

  // brief diesel grumble for vehicle movement
  _engine(o = {}) {
    const dur = o.dur ?? 0.9;
    const ctx = this.ctx;
    const t0 = this._now();
    const v = this._tone({ type: 'sawtooth', freq: o.freq ?? 68, dur, gain: 0.12, attack: 0.12 });
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 24;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 9;
    lfo.connect(lfoG); lfoG.connect(v.osc.frequency);
    lfo.start(t0); lfo.stop(t0 + dur);
    this._noise({ dur, type: 'lowpass', freq: 240, gain: 0.07, attack: 0.15 });
  },

  // infantry footsteps
  _footsteps() {
    const t0 = this._now();
    for (let i = 0; i < 5; i++) {
      this._noise({ when: t0 + i * 0.17 * rand(0.9, 1.1), dur: 0.045, type: 'lowpass', freq: 320, gain: 0.1, attack: 0.002 });
    }
  },

  // small recon-drone prop buzz
  _reconBuzz(o = {}) {
    const dur = o.dur ?? 0.8;
    this._tone({ type: 'sawtooth', freq: 165, dur, gain: 0.05, attack: 0.1 });
    this._tone({ type: 'sawtooth', freq: 168, detune: 7, dur, gain: 0.05, attack: 0.1 });
  },

  // AA burst: fast autocannon + rocket whoosh
  _aaIntercept() {
    this._mg({ shots: 8, rate: 0.055 });
    const t0 = this._now();
    this._noise({ when: t0 + 0.15, dur: 0.5, type: 'bandpass', freq: 600, freqEnd: 2400, Q: 1.4, gain: 0.2, attack: 0.03 });
  },

  // EW jam — modem-like warble (drone aborted / jammed)
  _jam() {
    const t0 = this._now();
    for (let i = 0; i < 6; i++) {
      this._tone({ when: t0 + i * 0.05, type: 'square', freq: rand(700, 2100), dur: 0.045, gain: 0.045 });
    }
    this._noise({ dur: 0.35, type: 'bandpass', freq: 1300, Q: 1.2, gain: 0.06, attack: 0.02 });
  },

  // victory / defeat stings
  _sting(win) {
    const t0 = this._now();
    const seq = win ? [392, 523, 659, 784] : [330, 311, 262, 196];
    seq.forEach((f, i) => {
      this._tone({ when: t0 + i * 0.17, type: 'triangle', freq: f, dur: win ? 0.5 : 0.6, gain: 0.1, attack: 0.01 });
      this._tone({ when: t0 + i * 0.17, type: 'sine', freq: f / 2, dur: win ? 0.5 : 0.6, gain: 0.07, attack: 0.01 });
    });
  },

  // -------------------------------------------------------------------------
  // MIXER — separate music / SFX levels, each mutable, plus a master mute.
  // Every setter is safe before init(): the value is stored and applied the
  // moment the context exists.
  // -------------------------------------------------------------------------

  /** Snapshot of the mixer. Mutating the result does nothing — call setMix. */
  getMix() { return { ...this._mix }; },

  /**
   * Patch the mixer. Accepts any subset of
   *   { music, sfx, musicMuted, sfxMuted, muted }
   * Persists to localStorage and notifies onMixChange subscribers.
   */
  setMix(patch = {}) {
    const m = this._mix;
    if (Number.isFinite(patch.music)) m.music = Math.min(1, Math.max(0, patch.music));
    if (Number.isFinite(patch.sfx)) m.sfx = Math.min(1, Math.max(0, patch.sfx));
    if (patch.musicMuted !== undefined) m.musicMuted = !!patch.musicMuted;
    if (patch.sfxMuted !== undefined) m.sfxMuted = !!patch.sfxMuted;
    if (patch.muted !== undefined) m.muted = !!patch.muted;
    // Dragging a fader off zero is an unmute request — anything else is a UI
    // that lies to the player ("I turned it up and it stayed silent").
    if (Number.isFinite(patch.music) && m.music > 0 && patch.musicMuted === undefined) {
      m.musicMuted = false;
    }
    if (Number.isFinite(patch.sfx) && m.sfx > 0 && patch.sfxMuted === undefined) {
      m.sfxMuted = false;
    }
    saveMix(m);
    this._applyMix();
    for (const fn of this._mixListeners) { try { fn(this.getMix()); } catch (_) {} }
    return this.getMix();
  },

  /** Master mute toggle — the [K] hotkey and the panel's big switch. */
  toggleMute() { return this.setMix({ muted: !this._mix.muted }); },

  /** Subscribe to mixer changes. Returns an unsubscribe function. */
  onMixChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this._mixListeners.add(fn);
    return () => this._mixListeners.delete(fn);
  },

  _applyMix(ramp = 0.04) {
    if (!this.ctx) return;
    const m = this._mix;
    const t = this._now();
    const set = (param, value) => {
      try {
        param.cancelScheduledValues(t);
        if (ramp > 0) param.setTargetAtTime(value, t, ramp);
        else param.setValueAtTime(value, t);
      } catch (_) { try { param.value = value; } catch (__) {} }
    };
    const musicOn = !m.muted && !m.musicMuted;
    const sfxOn = !m.muted && !m.sfxMuted;
    set(this.musicBus.gain, musicOn ? gainFor(m.music) * MUSIC_TRIM : 0.0);
    set(this.sfxGroup.gain, sfxOn ? gainFor(m.sfx) : 0.0);
  },

  /**
   * Duck the music while something else needs the stage — the FPV dronecam
   * dive. −6 dB down fast, back up slowly. Independent of the music fader, so
   * it can never fight the player's own setting or leave it stuck low.
   */
  duckMusic(on) {
    on = !!on;
    if (on === this._ducked) return;
    this._ducked = on;
    if (!this.musicDuck) return;
    try {
      const t = this._now();
      this.musicDuck.gain.cancelScheduledValues(t);
      this.musicDuck.gain.setTargetAtTime(on ? MUSIC_DUCK : 1.0, t, on ? 0.07 : 0.22);
    } catch (_) { /* never fatal */ }
  },

  // -------------------------------------------------------------------------
  // MUSIC BED — audio/theme.m4a, looped.
  // Decoded into an AudioBuffer first (gapless loop), with an <audio> element
  // as the fallback for browsers that will not decode AAC through WebAudio.
  // Every failure path ends in silence, never in a throw.
  // -------------------------------------------------------------------------

  get musicUrl() {
    // Resolved against THIS module, not the document: the game is served both
    // from a repo root and from a GitHub Pages sub-path, and a bare relative
    // URL would break under one of them.
    try { return new URL('../../audio/theme.m4a', import.meta.url).href; }
    catch (_) { return 'audio/theme.m4a'; }
  },

  _loadMusic() {
    if (!this.ctx) return;
    if (this._musicState === 'loading' || this._musicState === 'playing') return;
    if (this._musicState === 'failed') return;
    if (this._musicBuf) { this._startMusic(); return; }   // already decoded
    this._musicState = 'loading';
    const url = this.musicUrl;

    const decode = (arrayBuf) => new Promise((resolve, reject) => {
      let settled = false;
      let ret;
      try {
        // Safari <14.1 only has the callback form and returns undefined.
        ret = this.ctx.decodeAudioData(
          arrayBuf,
          (buf) => { if (!settled) { settled = true; resolve(buf); } },
          (err) => { if (!settled) { settled = true; reject(err || new Error('decode failed')); } });
      } catch (err) { reject(err); return; }
      if (ret && typeof ret.then === 'function') {
        ret.then((buf) => { if (!settled) { settled = true; resolve(buf); } },
          (err) => { if (!settled) { settled = true; reject(err); } });
      }
    });

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        this._musicBuf = await decode(ab);
        this._musicState = 'idle';
        this._startMusic();
      } catch (err) {
        console.warn('[audio] music buffer path failed, falling back to <audio>:', err);
        this._musicState = 'idle';
        this._startMusicElement(url);
      }
    })();
  },

  _startMusic() {
    if (!this.ctx || !this._musicBuf || this._musicSrc) return;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this._musicBuf;
      src.loop = true;
      src.connect(this.musicBus);
      src.start(this._now());
      this._musicSrc = src;
      this._musicState = 'playing';
    } catch (err) {
      console.warn('[audio] music start failed:', err);
      this._musicState = 'failed';
    }
  },

  _startMusicElement(url) {
    try {
      const el = document.createElement('audio');
      el.src = url;
      el.loop = true;
      el.preload = 'auto';
      el.addEventListener('error', () => {
        console.warn('[audio] music file unavailable — running silent');
        this._musicState = 'failed';
      });
      const node = this.ctx.createMediaElementSource(el);
      node.connect(this.musicBus);
      this._musicEl = el;
      this._musicState = 'playing';
      const p = el.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          // Autoplay policy said no despite the gesture, or the file is not
          // decodable here. Mark it failed so a later gesture can retry, and
          // leave the rest of the game exactly as it was: silent, not broken.
          console.warn('[audio] music playback blocked:', err);
          this._musicState = 'failed';
        });
      }
    } catch (err) {
      console.warn('[audio] music unavailable — running silent:', err);
      this._musicState = 'failed';
    }
  },

  // -------------------------------------------------------------------------
  // MOVEMENT VOICES — one looping, positional sound per moving unit, keyed on
  // chassis class. Starts when the unit starts moving, stops when it arrives.
  // -------------------------------------------------------------------------

  // Repeating pulse scheduler: `fire(t)` is called with WebAudio timestamps a
  // quarter-second ahead of the clock, so the rhythm is sample-accurate even
  // when the main thread is busy drawing hexes. Returns a cancel function.
  _pulseTrain(fire, intervalFn) {
    const ctx = this.ctx;
    let next = ctx.currentTime + 0.01;
    let stopped = false;
    const tick = () => {
      if (stopped || !this.ctx) return;
      const horizon = this.ctx.currentTime + 0.3;
      let guard = 0;
      while (next < horizon && guard++ < 32) {
        try { fire(next, guard); } catch (_) { /* one bad pulse is not fatal */ }
        next += Math.max(0.02, intervalFn());
      }
    };
    tick();
    const id = setInterval(tick, 100);
    return () => { stopped = true; clearInterval(id); };
  },

  // A continuous looped-noise bed. Returns the source so the voice can stop it.
  _noiseBed(out, o = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = _noiseBuf;
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1;
    const filt = ctx.createBiquadFilter();
    filt.type = o.type ?? 'lowpass';
    filt.frequency.value = o.freq ?? 300;
    filt.Q.value = o.Q ?? 0.6;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 0.05;
    src.connect(filt); filt.connect(g); g.connect(out);
    src.start(this._now(), rand(0, 1.5));
    return { src, g, filt };
  },

  /**
   * Start a movement voice for `unit`. Returns a handle with `.stop()`, or
   * null (no context, muted-out, over the voice cap, or the unit is not on
   * screen — you do not hear an enemy you cannot see).
   */
  startMoveVoice(unit) {
    if (!this.ctx || this.ctx.state === 'closed') return null;
    if (this._moveVoices.size >= MAX_MOVE_VOICES) return null;
    // Fog: fog.js drives `mesh.visible` for RED units. An unseen column moves
    // silently, which is also why the instant (perHex = 0) walk never blips.
    const mesh = unit?.mesh || null;
    if (mesh && mesh.visible === false) return null;

    const ctx = this.ctx;
    let voice = null;
    // Declared out here so a failure half-way through the build can still tear
    // down whatever it already started — a stranded oscillator is inaudible
    // but it is a leak, and it never stops.
    const nodes = [];   // oscillators / buffer sources to stop on teardown
    const timers = [];  // pulse-train cancels
    try {
      const cls = moveClassOf(unit);
      const jit = unitJitter(unit);

      // envelope → distance/trim → pan → sfxBus
      const envG = ctx.createGain();
      envG.gain.value = 0.0001;
      const distG = ctx.createGain();
      distG.gain.value = 1;
      envG.connect(distG);
      let panner = null;
      if (typeof ctx.createStereoPanner === 'function') {
        panner = ctx.createStereoPanner();
        distG.connect(panner);
        panner.connect(this.sfxBus);
      } else {
        distG.connect(this.sfxBus);
      }

      const built = this._buildMoveVoice(cls, envG, jit, nodes, timers);
      const trim = built.trim;

      const t0 = this._now();
      envG.gain.setValueAtTime(0.0001, t0);
      envG.gain.exponentialRampToValueAtTime(1, t0 + (built.attack ?? 0.16));

      voice = {
        cls, unit, trim, envG, distG, panner, nodes, timers,
        posTimer: 0, stopped: false,
        stop: () => this._stopMoveVoice(voice),
      };

      // Positional update: pan from the camera's right axis, gain from range.
      const follow = () => this._placeVoice(voice);
      follow();
      voice.posTimer = setInterval(follow, 140);

      this._moveVoices.add(voice);
      return voice;
    } catch (err) {
      console.warn('[audio] move voice failed:', err);
      if (voice) {
        try { this._stopMoveVoice(voice); } catch (_) {}
      } else {
        for (const cancel of timers) { try { cancel(); } catch (_) {} }
        for (const n of nodes) { try { n.stop(); } catch (_) {} }
      }
      return null;
    }
  },

  stopMoveVoice(voice) { this._stopMoveVoice(voice); },

  _stopMoveVoice(voice) {
    if (!voice || voice.stopped) return;
    voice.stopped = true;
    this._moveVoices.delete(voice);
    clearInterval(voice.posTimer);
    for (const cancel of voice.timers) { try { cancel(); } catch (_) {} }
    if (!this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      const g = voice.envG.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(0.0001, g.value || 0.0001), t);
      g.exponentialRampToValueAtTime(0.0001, t + 0.20);
      for (const n of voice.nodes) { try { n.stop(t + 0.28); } catch (_) {} }
    } catch (_) { /* already gone */ }
  },

  /** Stop everything that is currently rolling (turn change, game over). */
  stopAllMoveVoices() {
    for (const v of [...this._moveVoices]) this._stopMoveVoice(v);
  },

  // Pan + distance attenuation from the live camera. No three.js import: the
  // camera's inverse world matrix is read straight off `.elements`.
  _placeVoice(voice) {
    if (!voice || voice.stopped || !this.ctx) return;
    const mesh = voice.unit?.mesh;
    let pan = 0;
    let att = 1;
    try {
      if (mesh && mesh.visible === false) {
        // walked into the fog mid-move: fade out rather than cut
        att = 0.0;
      } else if (mesh) {
        const cam = (typeof window !== 'undefined' && window.STEEL?.engine?.camera) || null;
        const p = mesh.position;
        if (cam && cam.matrixWorldInverse) {
          const e = cam.matrixWorldInverse.elements;
          const cx = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
          const cy = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
          const cz = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
          const depth = Math.max(8, Math.abs(cz));
          pan = Math.max(-0.85, Math.min(0.85, (cx / depth) * 1.15));
          const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
          // gentle roll-off: a unit at the far edge of an RTS-zoom frame is
          // audible but clearly distant; nothing ever drops to true silence.
          att = 0.28 + 0.72 / (1 + (d / 150) * (d / 150));
        }
      }
    } catch (_) { /* camera not ready — centre, full level */ }
    try {
      const t = this.ctx.currentTime;
      voice.distG.gain.setTargetAtTime(voice.trim * att, t, 0.09);
      if (voice.panner) voice.panner.pan.setTargetAtTime(pan, t, 0.09);
    } catch (_) {}
  },

  // The synth definitions. Each returns { trim, attack } and pushes its
  // stoppable nodes / pulse trains onto the arrays it is handed.
  _buildMoveVoice(cls, out, jit, nodes, timers) {
    const ctx = this.ctx;
    const t0 = this._now();

    // helper: a continuous oscillator into `dest`
    const osc = (type, freq, gain, dest, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g); g.connect(dest);
      o.start(t0);
      nodes.push(o);
      return { osc: o, g };
    };
    // helper: an LFO writing into an AudioParam
    const lfo = (freq, depth, param) => {
      const o = ctx.createOscillator();
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = depth;
      o.connect(g); g.connect(param);
      o.start(t0);
      nodes.push(o);
      return o;
    };

    switch (cls) {

      // --- boots on the ground ------------------------------------------
      // Footfall (soft low thud) + kit rattle (webbing, magazines, a rifle
      // sling against a plate carrier). Alternating feet, human irregularity.
      case 'foot': {
        let step = 0;
        timers.push(this._pulseTrain((t) => {
          const strong = (step++ % 2) === 0;
          const amp = strong ? 0.16 : 0.125;
          this._noise({
            when: t, dur: 0.055, type: 'lowpass',
            freq: strong ? 300 : 265, gain: amp, attack: 0.004, out,
          });
          this._noise({
            when: t + 0.018, dur: 0.06, type: 'bandpass',
            freq: rand(2800, 3600), Q: 2.4, gain: 0.045, attack: 0.005, out,
          });
        }, () => 0.255 * rand(0.9, 1.12)));
        return { trim: 0.85, attack: 0.06 };
      }

      // --- MBT: deep diesel + track clatter -------------------------------
      case 'tracked_heavy': {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 230;
        lp.Q.value = 0.9;
        const chug = ctx.createGain();
        chug.gain.value = 0.55;             // firing-order pulse rides on this
        lp.connect(chug); chug.connect(out);
        const f = 32 + jit * 3;
        osc('sawtooth', f, 0.5, lp);
        osc('sawtooth', f * 2.01, 0.22, lp, -7);
        osc('sine', f * 0.5, 0.30, lp);      // the sub you feel, not hear
        lfo(10.4 + jit * 0.8, 0.4, chug.gain);
        const bed = this._noiseBed(out, { type: 'lowpass', freq: 135, gain: 0.075 });
        nodes.push(bed.src);
        timers.push(this._pulseTrain((t) => {
          this._noise({
            when: t, dur: 0.038, type: 'bandpass',
            freq: rand(1900, 3000), Q: 5.5, gain: rand(0.022, 0.05),
            attack: 0.001, out,
          });
        }, () => 0.068 * rand(0.85, 1.15)));
        return { trim: 0.92, attack: 0.22 };
      }

      // --- IFV / APC: the same running gear, lighter and busier -----------
      case 'tracked_light': {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 420;
        lp.Q.value = 0.8;
        const chug = ctx.createGain();
        chug.gain.value = 0.6;
        lp.connect(chug); chug.connect(out);
        const f = 52 + jit * 5;
        osc('sawtooth', f, 0.4, lp);
        osc('sawtooth', f * 2, 0.16, lp, 9);
        lfo(14 + jit, 0.3, chug.gain);
        const bed = this._noiseBed(out, { type: 'lowpass', freq: 260, gain: 0.045 });
        nodes.push(bed.src);
        timers.push(this._pulseTrain((t) => {
          this._noise({
            when: t, dur: 0.028, type: 'bandpass',
            freq: rand(3000, 4400), Q: 6, gain: rand(0.014, 0.032),
            attack: 0.001, out,
          });
        }, () => 0.052 * rand(0.85, 1.15)));
        return { trim: 0.72, attack: 0.18 };
      }

      // --- truck / jammer / supply: a road vehicle, not a tracked one -----
      // No clatter at all — that is the whole tell. Tyre roar plus a lazy rev
      // wobble reads as "engine hum" the way the owner described it.
      case 'wheeled': {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 780;
        lp.Q.value = 1.1;
        lp.connect(out);
        const f = 88 + jit * 12;
        const base = osc('sawtooth', f, 0.30, lp);
        osc('sawtooth', f * 2, 0.10, lp, 6);
        osc('square', f * 0.5, 0.10, lp);
        lfo(0.33, 11, base.osc.frequency);   // gear-change wander
        lfo(7.5, 4, base.osc.frequency);     // idle roughness
        const bed = this._noiseBed(out, { type: 'bandpass', freq: 720, Q: 0.55, gain: 0.055 });
        nodes.push(bed.src);
        return { trim: 0.66, attack: 0.20 };
      }

      // --- SPG / MLRS / SHORAD / SAM: heavy chassis, hydraulics -----------
      // Deliberately NOT the MBT voice: less sub, slower clatter, and a
      // turret/erector hydraulic whine on top that the tank does not have.
      case 'chassis_heavy': {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 320;
        lp.Q.value = 0.8;
        const chug = ctx.createGain();
        chug.gain.value = 0.6;
        lp.connect(chug); chug.connect(out);
        const f = 44 + jit * 4;
        osc('sawtooth', f, 0.42, lp);
        osc('square', f * 2, 0.14, lp, -5);
        lfo(8 + jit * 0.6, 0.28, chug.gain);
        const bed = this._noiseBed(out, { type: 'lowpass', freq: 190, gain: 0.05 });
        nodes.push(bed.src);
        // hydraulic / gearbox whine
        const wl = ctx.createBiquadFilter();
        wl.type = 'bandpass';
        wl.frequency.value = 470;
        wl.Q.value = 3.2;
        wl.connect(out);
        const whine = osc('triangle', 430 + jit * 40, 0.055, wl);
        lfo(0.7, 9, whine.osc.frequency);
        timers.push(this._pulseTrain((t) => {
          this._noise({
            when: t, dur: 0.05, type: 'bandpass',
            freq: rand(1150, 1750), Q: 4, gain: rand(0.02, 0.042),
            attack: 0.002, out,
          });
        }, () => 0.098 * rand(0.85, 1.15)));
        return { trim: 0.80, attack: 0.22 };
      }

      // --- quadcopters -----------------------------------------------------
      case 'drone': {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2400;
        lp.Q.value = 0.7;
        const flut = ctx.createGain();
        flut.gain.value = 0.8;
        lp.connect(flut); flut.connect(out);
        const f = 166 + jit * 12;
        osc('sawtooth', f, 0.10, lp);
        osc('sawtooth', f * 1.02, 0.10, lp, 8);
        osc('square', f * 2, 0.04, lp, -4);
        lfo(12.5 + jit * 2, 0.22, flut.gain);
        return { trim: 0.55, attack: 0.14 };
      }

      // --- HELICOPTER: the most distinctive sound in the game --------------
      // Three layers, all locked to one blade-passage rate:
      //   1. blade slap  — the low WHOP-whop the airframe is known by
      //   2. rotor wash  — broadband noise amplitude-modulated at the same rate
      //   3. turbine     — a steady high whine, plus a tail-rotor buzz
      case 'rotor': {
        const BLADE = 0.108 + jit * 0.006;   // ≈ 9 Hz blade passage
        let beat = 0;
        timers.push(this._pulseTrain((t) => {
          // every fourth blade lands harder — that is the "whop-whop-WHOP"
          const emph = (beat++ % 4) === 0 ? 1.45 : ((beat % 2) === 0 ? 1.0 : 0.82);
          this._noise({
            when: t, dur: 0.085, type: 'lowpass',
            freq: 165, gain: 0.30 * emph, attack: 0.007, out,
          });
          this._tone({
            when: t, type: 'sine', freq: 98, freqEnd: 48,
            dur: 0.10, gain: 0.24 * emph, attack: 0.005, out,
          });
          this._noise({
            when: t + 0.012, dur: 0.05, type: 'bandpass',
            freq: 900, Q: 1.1, gain: 0.05 * emph, attack: 0.004, out,
          });
        }, () => BLADE));

        // rotor wash, chopped at the blade rate so it breathes with the slap
        const washG = ctx.createGain();
        washG.gain.value = 0.55;
        washG.connect(out);
        const wash = this._noiseBed(washG, { type: 'bandpass', freq: 1050, Q: 0.5, gain: 0.085 });
        nodes.push(wash.src);
        lfo(1 / BLADE, 0.42, washG.gain);

        // turbine — steady, bright, sits above the whole mix
        const tb = ctx.createBiquadFilter();
        tb.type = 'bandpass';
        tb.frequency.value = 1500;
        tb.Q.value = 1.3;
        tb.connect(out);
        const turb = osc('sawtooth', 605 + jit * 30, 0.055, tb);
        osc('sawtooth', 1215 + jit * 60, 0.028, tb, 6);
        lfo(0.28, 7, turb.osc.frequency);

        // tail rotor — a fast dry buzz well above the main blade rate
        const tl = ctx.createBiquadFilter();
        tl.type = 'lowpass';
        tl.frequency.value = 520;
        const tailG = ctx.createGain();
        tailG.gain.value = 0.5;
        tl.connect(tailG); tailG.connect(out);
        osc('sawtooth', 92 + jit * 6, 0.09, tl);
        lfo(23, 0.35, tailG.gain);

        // Short attack on purpose: state.js flies air units at 240 ms/hex
        // (FLY_MS_PER_HEX), so a one-hex hop is over before a 300 ms spool-up
        // would have reached full level.
        return { trim: 0.95, attack: 0.16 };
      }

      default:
        return this._buildMoveVoice('wheeled', out, jit, nodes, timers);
    }
  },

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  // sfx(name, opts) — fire-and-forget; 'fpv_whine' returns a {stop()} handle.
  sfx(name, opts = {}) {
    if (!this.ctx || this.ctx.state === 'closed') return;
    if (this.ctx.state === 'suspended') { this.ctx.resume().catch(() => {}); }

    // per-name throttle so event storms don't stack into noise
    const throttle = {
      ui_tick: 45, select: 90, move: 350, mg: 250, cannon: 90,
      explosion: 60, radio: 200,
    }[name] ?? 30;
    const now = performance.now();
    if (this._last[name] && now - this._last[name] < throttle) return;
    this._last[name] = now;

    try {
      switch (name) {
        case 'cannon':        this._cannon(opts); break;
        case 'mg':            this._mg(opts); break;
        case 'missile':       this._missile(opts); break;
        case 'arty_fire':     this._artyFire(opts); break;
        case 'mlrs_fire':     this._mlrs(opts); break;
        case 'arty_whistle':  this._whistle(opts); break;
        case 'explosion':     this._explosion(opts); break;
        case 'explosion_big': this._explosion({ size: 1.5, ...opts }); break;
        case 'fpv_whine':     return this._fpvWhine(opts);
        case 'recon_buzz':    this._reconBuzz(opts); break;
        case 'aa_intercept':  this._aaIntercept(opts); break;
        case 'ew_jam':        this._jam(opts); break;
        case 'move':          this._engine(opts); break;
        case 'footsteps':     this._footsteps(opts); break;
        case 'radio':         this._squelch(opts); break;
        case 'select':        this._tick({ freq: 1500, gain: 0.1 }); break;
        case 'deselect':      this._tick({ freq: 900, gain: 0.06 }); break;
        case 'ui_tick':       this._tick(opts); break;
        case 'ui_confirm':    this._uiConfirm(opts); break;
        case 'ui_error':      this._uiError(opts); break;
        case 'victory':       this._sting(true); break;
        case 'defeat':        this._sting(false); break;
        default: break; // unknown names stay silent, never throw
      }
    } catch (err) {
      console.warn(`[audio] sfx '${name}' failed:`, err);
    }
    return undefined;
  },

  // -------------------------------------------------------------------------
  // ambience: wind loop + random distant rumble
  // -------------------------------------------------------------------------

  setAmbience(on) {
    this._ambience = !!on;
    if (!this.ctx) return; // will start on init if requested
    if (on) this._startAmbience();
    else this._stopAmbience();
  },

  _startAmbience() {
    if (this._ambNodes) {
      // already running — just fade the bus back up
      const t = this._now();
      this.ambBus.gain.cancelScheduledValues(t);
      this.ambBus.gain.setTargetAtTime(1.0, t, 1.2);
      return;
    }
    const ctx = this.ctx;
    const t0 = this._now();

    // wind: looped noise → lowpass, cutoff + gain both slowly wandering
    const src = ctx.createBufferSource();
    src.buffer = _noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 420;
    filt.Q.value = 0.4;
    const windG = ctx.createGain();
    windG.gain.value = 0.05;

    const lfo1 = ctx.createOscillator(); // gust swell
    lfo1.frequency.value = 0.07;
    const lfo1G = ctx.createGain();
    lfo1G.gain.value = 0.028;
    lfo1.connect(lfo1G); lfo1G.connect(windG.gain);

    const lfo2 = ctx.createOscillator(); // timbre drift
    lfo2.frequency.value = 0.045;
    const lfo2G = ctx.createGain();
    lfo2G.gain.value = 160;
    lfo2.connect(lfo2G); lfo2G.connect(filt.frequency);

    src.connect(filt); filt.connect(windG); windG.connect(this.ambBus);
    src.start(t0); lfo1.start(t0); lfo2.start(t0);

    // faint high whistle layer
    const src2 = ctx.createBufferSource();
    src2.buffer = _noiseBuf;
    src2.loop = true;
    src2.playbackRate.value = 0.7;
    const filt2 = ctx.createBiquadFilter();
    filt2.type = 'bandpass';
    filt2.frequency.value = 900;
    filt2.Q.value = 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.012;
    src2.connect(filt2); filt2.connect(g2); g2.connect(this.ambBus);
    src2.start(t0);

    this._ambNodes = { src, src2, lfo1, lfo2 };

    // fade bus in
    this.ambBus.gain.cancelScheduledValues(t0);
    this.ambBus.gain.setValueAtTime(0.0001, t0);
    this.ambBus.gain.setTargetAtTime(1.0, t0, 1.5);

    // distant front-line rumble, every 7–18 s
    const scheduleRumble = () => {
      if (!this._ambience || !this.ctx) return;
      this._rumbleTimer = setTimeout(() => {
        if (this._ambience && this.ctx && this.ctx.state === 'running') {
          try {
            this._noise({
              dur: rand(1.2, 2.2), type: 'lowpass',
              freq: rand(90, 160), freqEnd: 40,
              gain: rand(0.05, 0.12), attack: rand(0.15, 0.4),
              out: this.ambBus,
            });
            if (Math.random() < 0.35) {
              this._tone({ type: 'sine', freq: 44, freqEnd: 26, dur: 1.4, gain: 0.06, attack: 0.3, out: this.ambBus });
            }
          } catch (_) { /* ignore */ }
        }
        scheduleRumble();
      }, rand(7000, 18000));
    };
    scheduleRumble();
  },

  _stopAmbience() {
    clearTimeout(this._rumbleTimer);
    if (!this.ctx) { this._ambNodes = null; return; }
    const t = this._now();
    this.ambBus.gain.cancelScheduledValues(t);
    this.ambBus.gain.setTargetAtTime(0.0001, t, 0.6);
    const nodes = this._ambNodes;
    this._ambNodes = null;
    if (nodes) {
      setTimeout(() => {
        try {
          nodes.src.stop(); nodes.src2.stop();
          nodes.lfo1.stop(); nodes.lfo2.stop();
        } catch (_) { /* already stopped */ }
      }, 2500);
    }
  },
};

// ---------------------------------------------------------------------------
// Game-event wiring — main.js calls wireAudio(Game) once after Game.init.
// Defensive about payload shape: every field access is optional-chained so
// this works against both the seed stubs and the real state/combat modules.
// ---------------------------------------------------------------------------

let _wired = false;
let _moveHooked = false;   // true once the start-of-move hook is installed

const VEHICLE_CLASSES = new Set(['mbt', 'ifv', 'apc', 'spg', 'mlrs', 'aa', 'ew', 'truck']);

function attackerType(payload) {
  return payload?.attacker?.typeId ?? payload?.attacker?.type?.id
      ?? payload?.unit?.typeId ?? payload?.typeId ?? null;
}

/**
 * START-OF-MOVE HOOK.
 *
 * state.js emits `unitMoved` only AFTER the walk completes (state.js:580), and
 * publishes no start event — so a movement sound driven off the event bus plays
 * once the vehicle has already parked. A looping engine needs both edges.
 *
 * `Game.moveUnit` gives both, precisely, without touching state.js:
 *   · it sets `this._moving = true` SYNCHRONOUSLY, after the order has been
 *     validated and the path resolved, and before the first `await tween` —
 *     so "did this call flip _moving?" is an exact, refusal-proof start signal;
 *   · the promise it returns resolves when the last hex is walked — the exact
 *     end signal, for refusals, aborts and completed moves alike.
 *
 * The preferred long-term contract is written up in INTEGRATION_NOTES.md
 * ("audio: start-of-move event"): a `unitMoveStarted` emit alongside the
 * `this._moving = true` line would let this wrapper be deleted. Until then the
 * wrapper is deliberately transparent — same `this`, same arguments, same
 * returned promise — and it never swallows an error.
 */
function installMoveHook(Game) {
  if (_moveHooked) return;
  if (typeof Game?.moveUnit !== 'function') return;
  const orig = Game.moveUnit;
  Game.moveUnit = function patchedMoveUnit(unit, order) {
    const wasMoving = !!this._moving;
    const p = orig.apply(this, arguments);   // a throw is state.js's business
    // The flag flipped on THIS call ⇒ the order was accepted and the walk is
    // under way. Anything else (refused order, a move already in flight) makes
    // no sound at all.
    let voice = null;
    if (!wasMoving && this._moving) {
      try { voice = Audio.startMoveVoice(unit); } catch (_) { voice = null; }
    }
    if (voice) {
      const end = () => { try { Audio.stopMoveVoice(voice); } catch (_) {} };
      if (p && typeof p.then === 'function') p.then(end, end);
      else end();
    }
    return p;
  };
  _moveHooked = true;
}

export function wireAudio(Game) {
  if (_wired || !Game?.on) return;
  _wired = true;

  installMoveHook(Game);

  Game.on('select', () => Audio.sfx('select'));
  Game.on('deselect', () => Audio.sfx('deselect'));

  Game.on('unitMoved', (unit) => {
    // With the start-of-move hook installed the looping voice has already
    // covered the whole walk — firing a one-shot here would double the sound
    // on arrival. This branch is the fallback for a Game without moveUnit.
    if (_moveHooked) return;
    const t = unit?.typeId ?? unit?.unit?.typeId;
    if (t === 'infantry' || t === 'atgm_team') Audio.sfx('footsteps');
    else if (t === 'recon_drone' || t === 'fpv_drone' || t === 'loiter_munition') Audio.sfx('recon_buzz');
    else if (VEHICLE_CLASSES.has(t)) Audio.sfx('move');
    else Audio.sfx('move');
  });

  Game.on('unitAttacked', (payload) => {
    const t = attackerType(payload);
    switch (t) {
      case 'mbt':
        Audio.sfx('cannon'); break;
      case 'ifv': case 'aa':
        Audio.sfx('mg', { shots: 8, rate: 0.07 }); break;
      case 'apc': case 'infantry':
        Audio.sfx('mg'); break;
      case 'atgm_team':
        Audio.sfx('missile');
        setTimeout(() => Audio.sfx('explosion', { size: 0.8 }), 650);
        break;
      case 'spg':
        Audio.sfx('arty_fire');
        setTimeout(() => Audio.sfx('arty_whistle'), 400);
        setTimeout(() => Audio.sfx('explosion'), 1500);
        break;
      case 'mlrs':
        Audio.sfx('mlrs_fire');
        setTimeout(() => Audio.sfx('explosion'), 1400);
        setTimeout(() => Audio.sfx('explosion', { size: 0.8 }), 1650);
        break;
      case 'fpv_drone':
        // dronecam drives the whine itself; this is the terminal hit
        Audio.sfx('explosion');
        break;
      case 'loiter_munition':
        Audio.sfx('recon_buzz', { dur: 1.2 });
        setTimeout(() => Audio.sfx('explosion_big'), 900);
        break;
      // OWNER-FEEDBACK ROUND — the two new air-war units. Additive: if the
      // units module names them differently these fall through to the default
      // and the game still makes a sound.
      case 'helo':
        Audio.sfx('mg', { shots: 12, rate: 0.045 });   // chin gun burst
        setTimeout(() => Audio.sfx('missile'), 160);   // rocket pod
        setTimeout(() => Audio.sfx('explosion', { size: 0.9 }), 820);
        break;
      case 'sam':
        Audio.sfx('missile');
        setTimeout(() => Audio.sfx('explosion', { size: 0.8 }), 950);
        break;
      default:
        Audio.sfx('mg'); break;
    }
    // jammed / intercepted flags from combat.js reports, if present
    if (payload?.report?.jammed || payload?.jammed) Audio.sfx('ew_jam');
    if (payload?.report?.intercepted || payload?.intercepted) Audio.sfx('aa_intercept');
  });

  Game.on('unitKilled', () => Audio.sfx('explosion_big'));
  Game.on('infraDestroyed', () => {
    Audio.sfx('explosion_big');
    setTimeout(() => Audio.sfx('explosion', { size: 0.9 }), 350);
  });

  Game.on('turnStarted', (info) => {
    Audio.sfx('radio', { freq: info?.side === 'red' ? 880 : 1180 });
  });
  Game.on('turnEnded', () => Audio.sfx('ui_confirm'));

  Game.on('objectiveTaken', () => {
    Audio.sfx('ui_confirm');
    Audio.sfx('radio');
  });

  Game.on('resourcesChanged', () => Audio.sfx('ui_tick', { freq: 2600, gain: 0.05 }));

  // A unit destroyed mid-walk never resolves a normal arrival, and a finished
  // phase must not leave an engine idling under the next one.
  Game.on('turnEnded', () => Audio.stopAllMoveVoices());

  Game.on('gameOver', (result) => {
    Audio.stopAllMoveVoices();
    Audio.setAmbience(false);
    const won = result?.victory ?? result?.won
      ?? (typeof result === 'string' && result.includes('vict'));
    Audio.sfx(won ? 'victory' : 'defeat');
  });

  // NOTE: 'log' → ui_tick is wired in main.js already; not duplicated here.

  // ambience starts once audio exists (init is gesture-gated)
  Audio.setAmbience(true);
}
