/**
 * Replay real recordings (from Settings ▸ Save recordings for troubleshooting)
 * through the engine exactly as the app would:
 *   node tests/replay.mjs samples/jap-teach.wav samples/jap-live.wav [sensitivity]
 */
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const D = require("../app/js/dsp.js");

export function readWav(file) {
  const b = fs.readFileSync(file);
  let o = 12, sr = 0;
  while (o < b.length - 8) {
    const id = b.toString("ascii", o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === "fmt ") sr = b.readUInt32LE(o + 12);
    if (id === "data") {
      const n = size / 2, x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
      return { x, sr };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

/** The teach screen's capture (app/js/audio.js calFrame). */
export function teach(frames) {
  const vad = D.RoughVad(), reps = [];
  let cur = null, lastVoice = 0;
  for (const f of frames) {
    const v = vad.feed(f);
    if (v.speech) { if (!cur) cur = { t0: f.t, voice: 0 }; cur.voice += D.HOP_S; lastVoice = f.t; }
    if (cur && !v.speech && f.t - lastVoice >= 1.2) {
      if (cur.voice >= 0.5) reps.push({ t0: Math.max(0, cur.t0 - 0.15), t1: lastVoice + 0.15 });
      cur = null;
    }
    if (reps.length >= 3) break;
  }
  return { reps, result: D.learnMantra(frames, { reps }) };
}

export function live(profile, frames, sens = 1) {
  const lc = D.LiveCounter(profile, { sensitivity: sens });
  let n = 0; const log = [];
  for (const f of frames) {
    const r = lc.feed(f); n += r.counts;
    for (const e of r.events) log.push(`${e.type}${r.counts && e.type === "count" ? "" : ""}:${isFinite(e.score) ? e.score.toFixed(2) : "–"}${e.peak != null && isFinite(e.peak) ? "/pk" + e.peak.toFixed(2) : ""}@${f.t.toFixed(1)}`);
  }
  return { n, log };
}

if ((process.argv[1] || "").endsWith("replay.mjs")) {
  const [tw, lw, s] = process.argv.slice(2);
  const T = readWav(tw), L = readWav(lw);
  const tf = D.extractAll(T.x, T.sr);
  const { reps, result } = teach(tf);
  console.log("teach reps:", reps.map((r) => `${r.t0.toFixed(2)}–${r.t1.toFixed(2)}`).join("  "));
  if (!result.ok) { console.log("teach failed:", result.reason); process.exit(1); }
  const P = result.profile;
  console.log(`profile: accept=${P.accept.toFixed(2)} soft=${P.softAccept.toFixed(2)} peak=${P.peakAccept.toFixed(2)} selfMax=${P.selfMax.toFixed(2)} imp=${P.impostor.toFixed(2)} repSec=${P.repSec.toFixed(2)} M=${P.template.length} selfTest=${P.selfTest} dropped=${result.dropped}`);
  const r = live(P, D.extractAll(L.x, L.sr), Number(s || 1));
  console.log(`live: ${r.n} counted (${(L.x.length / L.sr).toFixed(1)} s)`);
  console.log(r.log.join("  "));
}
