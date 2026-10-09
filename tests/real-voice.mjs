/**
 * Real-voice evaluation from recordings saved with "Save recordings for
 * troubleshooting" (samples/ is git-ignored — it's your voice).
 *   node tests/real-voice.mjs [samples-dir]
 * Builds three live streams from your own chanting:
 *   • the live session as recorded           → should count every repetition
 *   • only the FIRST half of each repetition  → should count 0
 *   • only the SECOND half of each repetition → should count 0
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { readWav, teach } from "./replay.mjs";
const require = createRequire(import.meta.url);
const D = require("../app/js/dsp.js");

export function evaluate(dir) {
  const T = readWav(path.join(dir, "jap-teach.wav")), L = readWav(path.join(dir, "jap-live.wav"));
  const { result } = teach(D.extractAll(T.x, T.sr));
  if (!result.ok) return { error: result.reason };
  const P = result.profile, sr = L.sr;
  const lf = D.extractAll(L.x, sr);
  // the repetitions in the live recording: voiced runs split by >= 0.6 s quiet
  const reps = []; let cur = null, last = -9;
  for (const f of lf) if (f.db > -42) { if (!cur || f.t - last > 0.6) { cur = { t0: f.t, t1: f.t }; reps.push(cur); } cur.t1 = f.t; last = f.t; }
  const full = reps.filter((r) => r.t1 - r.t0 > 0.6);
  // split point = the deepest dip between the two loudest stretches of the rep
  // (smoothed over 100 ms), searched between 30% and 70% of its LOUD part
  const mid = (r) => {
    const fr = lf.filter((f) => f.t >= r.t0 && f.t <= r.t1);
    const loud = fr.filter((f) => f.db > -35);
    const a = loud.length ? loud[0].t : r.t0, b = loud.length ? loud[loud.length - 1].t : r.t1;
    let best = null;
    for (let i = 2; i < fr.length - 2; i++) {
      const t = fr[i].t;
      if (t < a + 0.3 * (b - a) || t > a + 0.7 * (b - a)) continue;
      const v = (fr[i - 2].db + fr[i - 1].db + fr[i].db + fr[i + 1].db + fr[i + 2].db) / 5;
      if (!best || v < best.v) best = { v, t };
    }
    return best ? best.t : (r.t0 + r.t1) / 2;
  };
  const cut = (a, b) => L.x.slice(Math.max(0, Math.floor(a * sr)), Math.floor(b * sr));
  const gap = new Float32Array(Math.round(1.2 * sr));
  const stream = (parts) => { const arr = [gap]; for (const p of parts) arr.push(p, gap); const o = new Float32Array(arr.reduce((x, y) => x + y.length, 0)); let q = 0; for (const a of arr) { o.set(a, q); q += a.length; } return o; };
  const count = (pcm, sens) => {
    const lc = D.LiveCounter(JSON.parse(JSON.stringify(P)), { sensitivity: sens }); let n = 0; const sc = [];
    const x = new Float32Array(pcm.length + Math.round(1.5 * sr)); x.set(pcm);   // the app keeps listening after the last rep
    for (const f of D.extractAll(x, sr)) { const r = lc.feed(f); n += r.counts; for (const e of r.events) if (e.type !== "miss" || isFinite(e.score)) sc.push(`${e.type[0]}${isFinite(e.score) ? e.score.toFixed(2) : "–"}/${e.peak != null && isFinite(e.peak) ? e.peak.toFixed(2) : "–"}${e.span ? "/" + (e.span / P.template.length).toFixed(2) : ""}`); }
    return { n, sc };
  };
  const halves1 = stream(full.map((r) => cut(r.t0 - 0.1, mid(r))));
  const halves2 = stream(full.map((r) => cut(mid(r), r.t1 + 0.15)));
  const out = { profile: P, dropped: result.dropped, expected: full.length, rows: [] };
  for (const s of [0.92, 1, 1.15]) {
    const a = count(L.x, s);
    const h1 = count(halves1, s), h2 = count(halves2, s);
    out.rows.push({ sens: s, live: a.n, scores: a.sc, first: h1.n, second: h2.n, h1: h1.sc, h2: h2.sc });
  }
  return out;
}

if ((process.argv[1] || "").endsWith("real-voice.mjs") && !process.argv.includes("--sessions")) {
  const dir = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null) || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "samples");
  if (!fs.existsSync(path.join(dir, "jap-teach.wav"))) { console.log("no recordings in", dir); process.exit(0); }
  const r = evaluate(dir);
  if (r.error) { console.log("teach failed:", r.error); process.exit(1); }
  const P = r.profile;
  console.log(`template: ${P.template.length} frames · accept ${P.accept.toFixed(2)} · dropped ${r.dropped} · live reps in recording: ${r.expected}`);
  for (const x of r.rows) {
    console.log(`sens ${x.sens}: live ${x.live}/${r.expected}  first-halves ${x.first}  second-halves ${x.second}`);
    if (process.env.V) console.log("   live  ", x.scores.join(" "), "\n   half1 ", x.h1.join(" "), "\n   half2 ", x.h2.join(" "));
  }
}

/**
 * Long simulated sessions built from YOUR recorded repetitions: random order,
 * pauses, gradual fading, ±6% tempo (resampling), optional fan noise and
 * half-mantras sprinkled in. Returns [{ name, expected, got }].
 */
export function sessions(dir, sens = 1, teachFan = 0) {
  const T = readWav(path.join(dir, "jap-teach.wav")), L = readWav(path.join(dir, "jap-live.wav"));
  if (teachFan) { let sd = 99, lp = 0; const r = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; }; T.x = T.x.map((v) => { lp = lp * 0.97 + (r() * 2 - 1) * 1.73 * 0.03; return v + lp * teachFan * 8; }); }
  const { result } = teach(D.extractAll(T.x, T.sr));
  if (!result.ok) return [];
  const P = JSON.parse(JSON.stringify(result.profile)), sr = L.sr;
  const lf = D.extractAll(L.x, sr);
  const runs = []; let cur = null, last = -9;
  for (const f of lf) if (f.db > -42) { if (!cur || f.t - last > 0.6) { cur = { t0: f.t, t1: f.t }; runs.push(cur); } cur.t1 = f.t; last = f.t; }
  const reps = runs.filter((r) => r.t1 - r.t0 > 0.6).map((r) => L.x.slice(Math.floor((r.t0 - 0.12) * sr), Math.floor((r.t1 + 0.15) * sr)));
  const halves = runs.filter((r) => r.t1 - r.t0 > 0.6).map((r) => L.x.slice(Math.floor((r.t0 - 0.12) * sr), Math.floor((r.t0 + (r.t1 - r.t0) * 0.42) * sr)));
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const stretch = (x, f) => { const n = Math.floor(x.length / f), y = new Float32Array(n); for (let i = 0; i < n; i++) { const p = i * f, a = Math.floor(p), b = Math.min(x.length - 1, a + 1); y[i] = x[a] * (1 - (p - a)) + x[b] * (p - a); } return y; };
  // room tone: the quiet stretches of your own recording, looped for gaps
  const quiet = []; { let q = []; for (const f of lf) { if (f.db < -50) q.push(f); else { if (q.length > 20) quiet.push(L.x.slice(Math.floor(q[2].t * sr), Math.floor(q[q.length - 3].t * sr))); q = []; } } }
  const tone = new Float32Array(sr * 4); { let o = 0, k = 0; while (o < tone.length && quiet.length) { const q = quiet[k++ % quiet.length]; tone.set(q.subarray(0, Math.min(q.length, tone.length - o)), o); o += q.length; } }
  const room = (sec) => { const n = Math.round(sec * sr), y = new Float32Array(n), off = Math.floor(rnd() * tone.length); for (let i = 0; i < n; i++) y[i] = tone[(i + off) % tone.length]; return y; };
  function build({ n, gap, fade = 1, halvesEvery = 0, fan = 0, hiss = false }) {
    const parts = [room(0.8)]; let expected = 0; const truth = [];
    for (let i = 0; i < n; i++) {
      const g = 1 - (1 - fade) * (i / n);
      const r = stretch(reps[Math.floor(rnd() * reps.length)], 0.94 + rnd() * 0.12).map((v) => v * g);
      const at = parts.reduce((x, y) => x + y.length, 0) / sr;
      truth.push({ t0: at, t1: at + r.length / sr, kind: "F" });
      parts.push(r, room(gap())); expected++;
      if (halvesEvery && i % halvesEvery === halvesEvery - 1) {
        const h = halves[Math.floor(rnd() * halves.length)].map((v) => v * g);
        const at2 = parts.reduce((x, y) => x + y.length, 0) / sr;
        truth.push({ t0: at2, t1: at2 + h.length / sr, kind: "H" });
        parts.push(h, room(1.3 + rnd() * 0.4));
      }
    }
    parts.push(room(1.5));
    const x = new Float32Array(parts.reduce((a, b) => a + b.length, 0)); let o = 0; for (const p of parts) { x.set(p, o); o += p.length; }
    // fan: low-frequency-heavy (pink-ish) noise like a ceiling fan, or flat hiss
    if (fan) { let lp = 0; for (let i = 0; i < x.length; i++) { const w = (rnd() * 2 - 1) * 1.73; if (hiss) x[i] += w * fan; else { lp = lp * 0.97 + w * 0.03; x[i] += lp * fan * 8; } } }
    const lc = D.LiveCounter(P, { sensitivity: sens }); let got = 0; const log = [];
    for (const f of D.extractAll(x, sr)) {
      const r = lc.feed(f); got += r.counts;
      if (process.env.V) for (const e of r.events) log.push(`${(truth.find((u) => f.t >= u.t1 - 0.3 && f.t <= u.t1 + 1.2) || { kind: "?" }).kind}:${e.type[0]}${e.rhythm ? "R" : ""}${isFinite(e.score) ? e.score.toFixed(2) : "–"}/${e.peak != null && isFinite(e.peak) ? e.peak.toFixed(2) : "–"}@${f.t.toFixed(0)}`);
      if (process.env.V && Math.round(f.t * 50) % 500 === 0) { const st = lc.normState(); log.push(`[t${f.t.toFixed(0)} floor ${st.noiseDb.toFixed(0)} voice ${st.voiceDb.toFixed(0)}]`); }
    }
    if (process.env.V) console.log(log.join(" "));
    return { expected, got };
  }
  return [
    ["60 reps, natural pauses 0.4–1.6 s", { n: 60, gap: () => 0.4 + rnd() * 1.2 }],
    ["60 reps, short pauses 0.05–0.4 s", { n: 60, gap: () => 0.05 + rnd() * 0.35 }],
    ["60 reps, fading to half volume", { n: 60, gap: () => 0.4 + rnd() * 1.0, fade: 0.5 }],
    ["40 reps + a half-mantra every 4th", { n: 40, gap: () => 1.2 + rnd() * 0.4, halvesEvery: 4 }],
    ["40 reps with a ceiling fan", { n: 40, gap: () => 0.4 + rnd() * 1.0, fan: 0.003 }],
    ["40 reps with loud flat hiss", { n: 40, gap: () => 0.4 + rnd() * 1.0, fan: 0.003, hiss: true }]
  ].map(([name, o]) => Object.assign({ name }, build(o)));
}

if ((process.argv[1] || "").endsWith("real-voice.mjs") && process.argv.includes("--sessions")) {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "samples");
  const tf = process.argv.includes("--teach-fan") ? 0.003 : 0;
  for (const s of [1, 0.92, 1.15]) for (const r of sessions(dir, s, tf)) console.log(`sens ${s}  ${r.got === r.expected ? "✔" : "✘"} ${r.name}: ${r.got}/${r.expected}`);
}
