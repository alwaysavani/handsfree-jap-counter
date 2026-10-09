/**
 * Synthetic chant corpus for offline engine tests (macOS `say`).
 *
 * Clips are synthesized once and cached in tests/.cache/. Sequences are
 * composed in JS with random gaps, tempo variation (different `say` rates),
 * mid-mantra pauses, gain changes and background noise, then fed to the
 * exact same DSP code the browser runs (app/js/dsp.js).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.join(here, "..", ".cache");
export const SR = 16000;

export function haveSay() {
  try { execFileSync("which", ["say"], { stdio: "ignore" }); return true; } catch { return false; }
}

function readWav(file) {
  const b = fs.readFileSync(file);
  let o = 12;
  while (o < b.length - 8) {
    const id = b.toString("ascii", o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === "data") {
      const n = size / 2, out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
      return out;
    }
    o += 8 + size + (size & 1);
  }
  throw new Error("no data chunk in " + file);
}

/** Synthesize (cached) and return trimmed PCM at 16 kHz. */
export function clip(voice, text, rate = 170) {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = crypto.createHash("sha1").update(`${voice}|${text}|${rate}`).digest("hex");
  const file = path.join(CACHE, key + ".wav");
  if (!fs.existsSync(file)) {
    execFileSync("say", ["-v", voice, "-r", String(rate), "-o", file,
      "--file-format=WAVE", `--data-format=LEI16@${SR}`, text]);
  }
  const x = readWav(file);
  // trim leading/trailing digital silence
  let a = 0, b = x.length;
  while (a < b && Math.abs(x[a]) < 0.003) a++;
  while (b > a && Math.abs(x[b - 1]) < 0.003) b--;
  return x.slice(a, b);
}

/** Deterministic PRNG. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Compose a recording. parts: [{pcm, gain?} | {gap: seconds}]
 * opts: { noise: rms of white-ish noise, hum: rms of 100 Hz hum, seed }
 */
export function compose(parts, opts = {}) {
  let n = 0;
  for (const p of parts) n += p.pcm ? p.pcm.length : Math.round(p.gap * SR);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    if (p.pcm) { const g = p.gain ?? 1; for (let i = 0; i < p.pcm.length; i++) out[o + i] = p.pcm[i] * g; o += p.pcm.length; }
    else o += Math.round(p.gap * SR);
  }
  const r = rng(opts.seed ?? 7);
  if (opts.noise) {
    // pinkish noise: one-pole low-passed white noise
    let lp = 0;
    for (let i = 0; i < n; i++) { lp = lp * 0.7 + (r() * 2 - 1) * 0.3; out[i] += lp * opts.noise * 3; }
  }
  if (opts.hum) for (let i = 0; i < n; i++) out[i] += Math.sin(2 * Math.PI * 100 * i / SR) * opts.hum * 1.41;
  return out;
}

export const VOICES = {
  lekha: { voice: "Lekha", mantra: "ॐ नमः शिवाय", om: "ॐ", half: "ॐ नमः", other: "आज मौसम बहुत अच्छा है", pause: "ॐ नमः [[slnc 450]] शिवाय" },
  rishi: { voice: "Rishi", mantra: "Om Namah Shivaaya", om: "Om", half: "Om Namah", other: "Please pass me the water bottle", pause: "Om Namah [[slnc 450]] Shivaaya" },
  samantha: { voice: "Samantha", mantra: "Om Namah Shivaaya", om: "Om", half: "Om Namah", other: "What time is dinner tonight", pause: "Om Namah [[slnc 450]] Shivaaya" }
};

export const LONG = {
  rishi: { voice: "Rishi", mantra: "Hare Krishna Hare Krishna, Krishna Krishna Hare Hare. Hare Rama Hare Rama, Rama Rama Hare Hare.",
    half: "Hare Krishna Hare Krishna, Krishna Krishna Hare Hare." },
  lekha: { voice: "Lekha", mantra: "ॐ गं गणपतये नमः", half: "ॐ गं" }
};

/**
 * The teach screen's capture logic (app/js/audio.js calFrame): repetitions are
 * recorded one at a time, each ended by 1.2 s of silence. Returns learnMantra's
 * result for a recording, exactly as the app would compute it.
 */
export function teachLikeApp(D, pcm) {
  const frames = D.extractAll(pcm, SR), vad = D.RoughVad(), reps = [];
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
  return Object.assign(D.learnMantra(frames, { reps }), { captured: reps.length });
}
