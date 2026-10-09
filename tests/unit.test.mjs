/**
 * Unit tests for the DSP engine (app/js/dsp.js) on synthetic signals —
 * runs anywhere with plain Node (no browser, no TTS).
 *
 * The "mantra" here is a sequence of three vowel-like syllables built from
 * harmonic tones with different formant peaks, so it has real spectral
 * structure for MFCC + DTW to work on.
 *
 * Run: npm run test:unit
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const D = require("../app/js/dsp.js");

const SR = 16000;

/* ---------- synthetic speech-ish audio ---------- */
let seed = 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

/** A vowel-like syllable: harmonics of f0 shaped by two formant peaks. */
function syllable(f1, f2, dur, f0 = 140, amp = 0.2) {
  const n = Math.round(dur * SR), out = new Float32Array(n);
  for (let h = 1; h * f0 < 4000; h++) {
    const f = h * f0;
    const g = Math.exp(-((f - f1) ** 2) / (2 * 120 ** 2)) + 0.6 * Math.exp(-((f - f2) ** 2) / (2 * 200 ** 2)) + 0.02;
    const ph = rnd() * 6.28;
    for (let i = 0; i < n; i++) out[i] += g * Math.sin(2 * Math.PI * f * i / SR + ph);
  }
  // attack/decay envelope
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out[i] *= amp * Math.min(1, t * 8) * Math.min(1, (1 - t) * 6);
  }
  return out;
}
const SYL = { A: [700, 1200], B: [300, 2300], C: [450, 900], D: [600, 1800] };
function word(seq, rate = 1, f0 = 140, amp = 0.2) {
  const parts = seq.split("").map((k) => syllable(SYL[k][0], SYL[k][1], 0.26 / rate, f0, amp));
  return concat(parts.flatMap((p, i) => i ? [silence(0.03 / rate), p] : [p]));
}
const silence = (s) => new Float32Array(Math.round(s * SR));
function concat(arrs) {
  const n = arrs.reduce((a, b) => a + b.length, 0), out = new Float32Array(n);
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function addNoise(x, rms) {
  const y = new Float32Array(x);
  for (let i = 0; i < y.length; i++) y[i] += (rnd() * 2 - 1) * rms * 1.73;
  return y;
}

const MANTRA = "ABCD";  // 4 syllables
function calibrationAudio() {
  return addNoise(concat([silence(0.8), word(MANTRA, 1), silence(0.7), word(MANTRA, 0.95), silence(0.8),
    word(MANTRA, 1.05), silence(1.2)]), 0.001);
}
function countIn(profile, pcm) {
  const lc = D.LiveCounter(JSON.parse(JSON.stringify(profile)));
  let n = 0;
  for (const f of D.extractAll(pcm, SR)) n += lc.feed(f).counts;
  return n;
}

let PROFILE = null;
function profile() {
  if (!PROFILE) {
    const r = D.learnMantra(D.extractAll(calibrationAudio(), SR));
    assert.ok(r.ok, "calibration should succeed: " + r.reason);
    PROFILE = r.profile;
  }
  return PROFILE;
}

/* ---------- FFT / features ---------- */
test("fft matches a naive DFT", () => {
  const n = 64, re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1);
  const x = Array.from(re);
  D.fft(re, im);
  for (const k of [0, 3, 11, 31]) {
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) { a += x[i] * Math.cos(2 * Math.PI * k * i / n); b -= x[i] * Math.sin(2 * Math.PI * k * i / n); }
    assert.ok(Math.abs(a - re[k]) < 1e-3 && Math.abs(b - im[k]) < 1e-3, `bin ${k}`);
  }
});

test("feature extractor: 50 frames/s, stable across chunk sizes", () => {
  const x = word(MANTRA);
  const whole = D.extractAll(x, SR);
  assert.ok(Math.abs(whole.length - x.length / SR / 0.02) < 3, `frames=${whole.length}`);
  const fx = D.FeatureExtractor(SR);
  const parts = [];
  for (let i = 0; i < x.length; i += 333) for (const f of fx.push(x.subarray(i, i + 333))) parts.push(f);
  assert.equal(parts.length, whole.length);
  for (const i of [5, 20, whole.length - 3]) {
    assert.ok(Math.abs(parts[i].db - whole[i].db) < 1e-4);
    assert.ok(Math.abs(parts[i].t - whole[i].t) < 1e-9);
  }
});

test("feature extractor works at 48 kHz too (browser rate)", () => {
  const sr = 48000, n = sr, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.1 * Math.sin(2 * Math.PI * 300 * i / sr);
  const f = D.extractAll(x, sr);
  assert.ok(Math.abs(f.length - 50) <= 2);
  assert.ok(f[10].db > -30 && f[10].db < -15);
});

/* ---------- calibration ---------- */
test("learnMantra: finds the 3 repetitions and builds a full-length template", () => {
  const r = D.learnMantra(D.extractAll(calibrationAudio(), SR));
  assert.ok(r.ok, r.reason);
  assert.equal(r.profile.nReps, 3);
  // template covers one whole repetition (~1.1 s of voice), not a fragment
  assert.ok(r.profile.repSec > 0.8 && r.profile.repSec < 1.5, `repSec=${r.profile.repSec}`);
  assert.ok(r.profile.accept > 0.2 && r.profile.accept < 0.8, `accept=${r.profile.accept}`);
  assert.ok(D.profileOk(r.profile));
  // stored profile is plain JSON
  assert.deepEqual(JSON.parse(JSON.stringify(r.profile)).template.length, r.profile.template.length);
});

test("learnMantra: silence → no_voice (fail closed)", () => {
  const r = D.learnMantra(D.extractAll(addNoise(silence(5), 0.002), SR));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_voice");
});

test("learnMantra: a single repetition is not enough", () => {
  const r = D.learnMantra(D.extractAll(addNoise(concat([silence(1), word(MANTRA), silence(1.5)]), 0.001), SR));
  assert.equal(r.ok, false);
});

test("learnMantra: mid-mantra pauses don't split the template", () => {
  const rep = (rate) => concat([word("AB", rate), silence(0.45), word("CD", rate)]);
  const pcm = addNoise(concat([silence(0.8), rep(1), silence(0.9), rep(0.95), silence(0.9), rep(1.05), silence(1.2)]), 0.001);
  const r = D.learnMantra(D.extractAll(pcm, SR));
  assert.ok(r.ok, r.reason);
  assert.equal(r.profile.nReps, 3, "3 repetitions, not 6 halves");
  assert.ok(r.profile.repSec > 0.8, `template must be the whole mantra (repSec=${r.profile.repSec})`);
});

/* ---------- live counting ---------- */
test("counts every full repetition (varied tempo and gaps)", () => {
  const parts = [silence(0.6)];
  const rates = [1, 0.9, 1.1, 1.2, 0.85, 1, 1.05, 0.95];
  for (const r of rates) parts.push(word(MANTRA, r), silence(0.25 + rnd() * 0.9));
  assert.equal(countIn(profile(), addNoise(concat(parts), 0.001)), rates.length);
});

test("back-to-back repetitions with no pause still count separately", () => {
  const parts = [silence(0.6)];
  for (let i = 0; i < 6; i++) parts.push(word(MANTRA, 1));
  parts.push(silence(1));
  assert.equal(countIn(profile(), addNoise(concat(parts), 0.001)), 6);
});

test("a pause inside the mantra does not create extra counts", () => {
  const parts = [silence(0.6)];
  for (let i = 0; i < 5; i++) parts.push(word("AB"), silence(0.5), word("CD"), silence(0.9));
  assert.equal(countIn(profile(), addNoise(concat(parts), 0.001)), 5);
});

test("partial repetitions never count (the half-mantra bug)", () => {
  const parts = [silence(0.6)];
  for (let i = 0; i < 4; i++) parts.push(word("AB"), silence(0.8), word("A"), silence(0.8), word("ABC"), silence(0.8));
  assert.equal(countIn(profile(), addNoise(concat(parts), 0.001)), 0);
});

test("full reps interleaved with partials: only the full reps count", () => {
  const parts = [silence(0.6)];
  for (let i = 0; i < 5; i++) parts.push(word(MANTRA), silence(0.7), word("AB"), silence(0.7));
  assert.equal(countIn(profile(), addNoise(concat(parts), 0.001)), 5);
});

test("a different 'word' with the same rhythm and loudness doesn't count", () => {
  const parts = [silence(0.6)];
  for (let i = 0; i < 5; i++) parts.push(word("DCBA"), silence(0.8));
  assert.equal(countIn(profile(), addNoise(concat(parts), 0.001)), 0);
});

test("quieter chanting with background noise still counts", () => {
  const parts = [silence(0.8)];
  for (let i = 0; i < 6; i++) parts.push(word(MANTRA, 1, 140, 0.08), silence(0.8));
  assert.equal(countIn(profile(), addNoise(concat(parts), 0.004)), 6);
});

test("steady noise alone (fan/AC) never counts", () => {
  assert.equal(countIn(profile(), addNoise(silence(20), 0.02)), 0);
});

test("sensitivity: strict is never more permissive than lenient", () => {
  const p = profile();
  const strict = D.LiveCounter(p, { sensitivity: 0.92 }), lenient = D.LiveCounter(p, { sensitivity: 1.15 });
  assert.ok(strict.accept < lenient.accept);
  assert.ok(lenient.accept < p.impostor, "lenient stays below the partial-repetition level");
});

test("profileOk rejects old/foreign profiles", () => {
  assert.equal(D.profileOk(null), false);
  assert.equal(D.profileOk({ noiseFloor: 0.01, threshold: 0.02, mode: "keyword" }), false);
  assert.equal(D.profileOk(Object.assign({}, profile(), { v: 1 })), false);
});

/* ---------- teach: repetitions recorded one at a time ---------- */
function teachRecording(words, gap = 1.4) {
  const parts = [silence(1.5)], reps = [];
  let t = 1.5;
  for (const w of words) {
    const x = typeof w === "string" ? word(w, 1) : w;
    reps.push({ t0: t - 0.15, t1: t + x.length / SR + 0.15 });
    parts.push(x, silence(gap));
    t += x.length / SR + gap;
  }
  return { pcm: addNoise(concat(parts), 0.001), reps };
}

test("explicit reps: learns exactly the repetitions recorded", () => {
  const { pcm, reps } = teachRecording([word(MANTRA, 1), word(MANTRA, 0.9), word(MANTRA, 1.1)]);
  const r = D.learnMantra(D.extractAll(pcm, SR), { reps });
  assert.ok(r.ok, r.reason);
  assert.equal(r.profile.nReps, 3);
  assert.ok(r.profile.repSec > 0.8 && r.profile.repSec < 1.5, `repSec=${r.profile.repSec}`);
  assert.equal(r.profile.selfTest, 3, "its own repetitions must all count");
});

test("explicit reps: one cut-short repetition is dropped, not learned", () => {
  const { pcm, reps } = teachRecording([word(MANTRA), word("AB"), word(MANTRA, 0.95), word(MANTRA, 1.05)]);
  const r = D.learnMantra(D.extractAll(pcm, SR), { reps });
  assert.ok(r.ok, r.reason);
  assert.equal(r.dropped, 1);
  assert.ok(r.profile.repSec > 0.8, `template is the full mantra (repSec=${r.profile.repSec})`);
});

test("explicit reps: a learned profile counts live chanting", () => {
  const { pcm, reps } = teachRecording([word(MANTRA), word(MANTRA, 0.92), word(MANTRA, 1.08)]);
  const r = D.learnMantra(D.extractAll(pcm, SR), { reps });
  const parts = [silence(0.6)];
  for (let i = 0; i < 7; i++) parts.push(word(MANTRA, 0.9 + rnd() * 0.25), silence(0.3 + rnd()));
  assert.equal(countIn(r.profile, addNoise(concat(parts), 0.001)), 7);
});

test("free-form teach with many repetitions never learns a multi-mantra template", () => {
  // the reported bug: chanting 6× made the template ~3 mantras long → nothing counted
  const parts = [silence(1)];
  for (let i = 0; i < 6; i++) parts.push(word(MANTRA, 0.9 + rnd() * 0.2), silence(0.5 + rnd() * 0.6));
  const { pcm, reps } = (() => {
    const reps = []; let t = 0; const out = [];
    for (const p of parts) { if (p.length > SR * 0.4 && p.some((v) => v !== 0)) reps.push({ t0: t - 0.15, t1: t + p.length / SR + 0.15 }); out.push(p); t += p.length / SR; }
    return { pcm: addNoise(concat(out), 0.001), reps };
  })();
  const r = D.learnMantra(D.extractAll(pcm, SR), { reps });
  assert.ok(r.ok, r.reason);
  assert.ok(r.profile.repSec < 1.5, `repSec=${r.profile.repSec}`);
});

/* ---------- sustained (legato) chanting over a whole session ---------- */
import * as Syn from "./lib/synth.mjs";
let LEG = null;
function legProfile() {
  if (!LEG) {
    Syn.reseed(11);
    const { pcm, reps } = Syn.teachRec([Syn.legato("ABCD", 1), Syn.legato("ABCD", 0.95), Syn.legato("ABCD", 1.05)]);
    const r = D.learnMantra(D.extractAll(Syn.addNoise(pcm, 0.001), SR), { reps });
    assert.ok(r.ok, r.reason);
    LEG = r.profile;
  }
  return LEG;
}

test("continuous legato chanting keeps counting for a whole session (the 'stops after 2' bug)", () => {
  Syn.reseed(5);
  const parts = [Syn.silence(0.5)];
  for (let i = 0; i < 40; i++) parts.push(Syn.legato("ABCD", 0.9 + Syn.rnd() * 0.25));
  parts.push(Syn.silence(1.5));
  assert.equal(countIn(legProfile(), Syn.addNoise(Syn.concat(parts), 0.001)), 40);
});

test("session that gets softer and faster still counts every repetition", () => {
  Syn.reseed(6);
  const parts = [Syn.silence(0.5)];
  for (let i = 0; i < 24; i++) parts.push(Syn.legato("ABCD", 0.95 + i * 0.012, { amp: 0.15 * Math.pow(0.95, i) }), Syn.silence(Syn.rnd() < 0.3 ? 0.4 : 0));
  parts.push(Syn.silence(1.5));
  assert.equal(countIn(legProfile(), Syn.addNoise(Syn.concat(parts), 0.001)), 24);
});

test("a fan switching on mid-session doesn't stop counting", () => {
  Syn.reseed(7);
  const a = [Syn.silence(0.5)], b = [];
  for (let i = 0; i < 8; i++) a.push(Syn.legato("ABCD", 1), Syn.silence(0.5));
  for (let i = 0; i < 8; i++) b.push(Syn.legato("ABCD", 1), Syn.silence(0.5));
  b.push(Syn.silence(1.5));
  const pcm = Syn.concat([Syn.addNoise(Syn.concat(a), 0.001), Syn.addNoise(Syn.concat(b), 0.004)]);
  assert.equal(countIn(legProfile(), pcm), 16);
});

test("legato partials still don't count", () => {
  Syn.reseed(8);
  const parts = [Syn.silence(0.5)];
  for (let i = 0; i < 6; i++) parts.push(Syn.legato(i % 2 ? "AB" : "ABC", 1), Syn.silence(0.8));
  assert.equal(countIn(legProfile(), Syn.addNoise(Syn.concat(parts), 0.001)), 0);
});
