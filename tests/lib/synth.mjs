/**
 * Synthetic chanting for tests (no TTS needed).
 * legato(): a sustained, hummed chant — syllables glide into each other and
 * loudness only dips (never silent), like a real voice chanting japa. TTS
 * voices pause cleanly between words, which hid bugs that only show up with
 * continuous chanting.
 */
export const SR = 16000;
let seed = 3;
export function reseed(s) { seed = s >>> 0; }
export const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const SYL = { A: [700, 1200], B: [300, 2300], C: [450, 900], D: [600, 1800] };

export function legato(seq = "ABCD", rate = 1, { dip = 0.35, amp = 0.15, f0 = 130 } = {}) {
  const sd = 0.3 / rate, n = Math.round(seq.length * sd * SR), out = new Float32Array(n);
  const ph = new Float64Array(40);
  for (let i = 0; i < n; i++) {
    const t = i / SR, pos = t / sd, k = Math.min(seq.length - 1, Math.floor(pos)), fr = pos - k;
    const nk = Math.min(seq.length - 1, k + 1), w = fr > 0.8 ? (fr - 0.8) / 0.2 : 0;
    const f1 = SYL[seq[k]][0] * (1 - w) + SYL[seq[nk]][0] * w, f2 = SYL[seq[k]][1] * (1 - w) + SYL[seq[nk]][1] * w;
    const env = dip + (1 - dip) * Math.sin(Math.PI * fr) ** 0.5;
    let s = 0;
    for (let h = 1; h * f0 < 4000; h++) {
      const f = h * f0; ph[h] += 2 * Math.PI * f / SR;
      s += (Math.exp(-((f - f1) ** 2) / 28800) + 0.6 * Math.exp(-((f - f2) ** 2) / 80000) + 0.02) * Math.sin(ph[h]);
    }
    out[i] = s * env * amp * Math.min(1, t / 0.05, (n / SR - t) / 0.05);
  }
  return out;
}
export const silence = (s) => new Float32Array(Math.round(s * SR));
export function concat(arrs) {
  const o = new Float32Array(arrs.reduce((x, y) => x + y.length, 0));
  let p = 0; for (const x of arrs) { o.set(x, p); p += x.length; }
  return o;
}
export function addNoise(x, r) { const y = new Float32Array(x); for (let i = 0; i < y.length; i++) y[i] += (rnd() * 2 - 1) * r * 1.73; return y; }
/** Teach recording like the app: get-ready silence, then reps separated by 1.5 s. */
export function teachRec(reps) {
  const parts = [silence(1.5)], at = []; let t = 1.5;
  for (const x of reps) { at.push({ t0: t - 0.15, t1: t + x.length / SR + 0.15 }); parts.push(x, silence(1.5)); t += x.length / SR + 1.5; }
  return { pcm: concat(parts), reps: at };
}
