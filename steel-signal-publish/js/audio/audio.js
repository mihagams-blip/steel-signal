// STEEL SIGNAL — audio/audio.js
// Full WebAudio procedural SFX + ambience. Zero asset files: everything is
// synthesized (filtered noise, oscillators, waveshaping) at call time from a
// couple of cached noise buffers.
//
// Contract (ARCHITECTURE.md):
//   export const Audio = { init(), sfx(name, opts), setAmbience(on) }
// Extra export (noted in INTEGRATION_NOTES.md):
//   export function wireAudio(Game) — subscribes every sfx to the canonical
//   Game events; main.js calls it once after Game.init. Idempotent.
//
// init() must be called from a user gesture (main.js wires pointerdown).
// Every public entry point is safe to call before init — it just no-ops.

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

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
  sfxBus: null,       // per-category buses hang off master
  ambBus: null,
  _comp: null,
  _clipCurve: null,
  _ambience: false,   // desired state (may be set before init)
  _ambNodes: null,    // live ambience node handles
  _rumbleTimer: 0,
  _last: Object.create(null), // per-name throttle timestamps

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
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

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = 1.0;
      this.sfxBus.connect(this.master);

      this.ambBus = ctx.createGain();
      this.ambBus.gain.value = 0.0; // faded in by setAmbience
      this.ambBus.connect(this.master);

      _noiseBuf = makeNoiseBuffer(ctx);
      _crackleBuf = makeCrackleBuffer(ctx);
      this._clipCurve = makeSoftClipCurve(2.5);

      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      ctx.addEventListener?.('statechange', () => {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      });

      if (this._ambience) this._startAmbience();

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

const VEHICLE_CLASSES = new Set(['mbt', 'ifv', 'apc', 'spg', 'mlrs', 'aa', 'ew', 'truck']);

function attackerType(payload) {
  return payload?.attacker?.typeId ?? payload?.attacker?.type?.id
      ?? payload?.unit?.typeId ?? payload?.typeId ?? null;
}

export function wireAudio(Game) {
  if (_wired || !Game?.on) return;
  _wired = true;

  Game.on('select', () => Audio.sfx('select'));
  Game.on('deselect', () => Audio.sfx('deselect'));

  Game.on('unitMoved', (unit) => {
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

  Game.on('gameOver', (result) => {
    Audio.setAmbience(false);
    const won = result?.victory ?? result?.won
      ?? (typeof result === 'string' && result.includes('vict'));
    Audio.sfx(won ? 'victory' : 'defeat');
  });

  // NOTE: 'log' → ui_tick is wired in main.js already; not duplicated here.

  // ambience starts once audio exists (init is gesture-gated)
  Audio.setAmbience(true);
}
