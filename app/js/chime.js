/* ============================================================
   chime.js — synthesized sounds (no audio files) + haptics
     ring()  temple bell when a mala completes
     bead()  soft wooden "bead" click on every count
   ============================================================ */
window.Chime = (function () {
  let ctx = null;

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { try { ctx = new AC(); } catch (e) { ctx = null; } }
    }
    if (ctx && ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }

  function play(data) {
    const c = ensureCtx();
    if (!c) return;
    const buf = c.createBuffer(1, data.length, c.sampleRate);
    buf.getChannelData(0).set(data);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start();
  }

  /** Temple bell: inharmonic partials with staggered decays. */
  function ring(durationSec = 4.5, volume = 0.5) {
    const c = ensureCtx();
    if (!c) return;
    const sr = c.sampleRate;
    const n = Math.floor(sr * durationSec);
    const partials = [
      [1.000, 1.00, durationSec],
      [2.002, 0.55, durationSec * 0.72],
      [2.494, 0.34, durationSec * 0.60],
      [3.004, 0.22, durationSec * 0.50],
      [4.126, 0.13, durationSec * 0.42],
      [5.512, 0.06, durationSec * 0.34]
    ];
    const base = 392.0;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let s = 0;
      for (const p of partials) s += Math.sin(2 * Math.PI * base * p[0] * t) * p[1] * Math.exp(-t / p[2]);
      data[i] = s * Math.min(1, t / 0.008) * volume * 0.16;
    }
    play(data);
  }

  /** Short, warm wooden click — like a rudraksha bead passing the thumb. */
  function bead(volume = 0.35) {
    const c = ensureCtx();
    if (!c) return;
    const sr = c.sampleRate;
    const n = Math.floor(sr * 0.06);
    const data = new Float32Array(n);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4;     // soft noise "knock"
      const body = Math.sin(2 * Math.PI * 520 * t) * 0.6 + Math.sin(2 * Math.PI * 1180 * t) * 0.25;
      data[i] = (body + lp * 0.5) * Math.exp(-t / 0.012) * volume;
    }
    play(data);
  }

  /** Haptic vibration (Android Chrome). Pattern: ms numbers. */
  function vibrate(pattern = [30]) {
    try { if (navigator.vibrate) return navigator.vibrate(pattern); } catch (e) {}
    return false;
  }

  /** Call inside a user gesture so later sounds are allowed to play. */
  function unlock() { ensureCtx(); }

  return { ring, bead, vibrate, unlock };
})();
