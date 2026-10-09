/**
 * Regression tests on synthesized speech (macOS `say`): real phonetics,
 * three voices (Hindi "Lekha", Indian-English "Rishi", US "Samantha"),
 * varied tempo, gaps, mid-mantra pauses, partial chants, other speech and
 * background noise — run through the exact DSP code the browser uses.
 *
 * Skipped automatically where `say` is unavailable (Linux CI).
 * Run: npm run test:corpus      (first run synthesizes clips into tests/.cache)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { clip, compose, rng, haveSay, teachLikeApp, VOICES, LONG, SR } from "./lib/corpus.mjs";
const require = createRequire(import.meta.url);
const D = require("../app/js/dsp.js");

const skip = !haveSay() && "macOS `say` not available";

function learn(v, rates = [170, 165, 175], opts = {}) {
  // the app's teach flow: get-ready silence, then one repetition at a time
  const parts = [{ gap: 1.5 }];
  for (const r of rates) parts.push({ pcm: clip(v.voice, v.mantra, r), gain: opts.gain ?? 1 }, { gap: 1.5 });
  const r = teachLikeApp(D, compose(parts, { noise: opts.noise ?? 0.002, hum: opts.hum ?? 0, seed: 1 }));
  assert.ok(r.ok, `teach failed: ${r.reason} (captured ${r.captured})`);
  assert.equal(r.captured, 3, "each repetition recorded separately");
  assert.equal(r.profile.selfTest, r.profile.nReps, "its own repetitions count");
  return r.profile;
}
function count(profile, parts, opts = {}) {
  const lc = D.LiveCounter(JSON.parse(JSON.stringify(profile)));
  let n = 0;
  const pcm = compose([{ gap: 0.8 }, ...parts, { gap: 1.2 }], { noise: opts.noise ?? 0.002, hum: opts.hum ?? 0, seed: opts.seed ?? 9 });
  for (const f of D.extractAll(pcm, SR)) n += lc.feed(f).counts;
  return n;
}
const reps = (n, mk) => Array.from({ length: n }, (_, i) => mk(i)).flat();

for (const [name, v] of Object.entries(VOICES)) {
  test(`[${name}] corpus`, { skip }, async (t) => {
    const P = learn(v);
    const R = rng(3);
    const rate = () => 150 + Math.round(R() * 50);

    await t.test("calibration learns one whole repetition", () => {
      assert.equal(P.nReps, 3);
      assert.ok(P.repSec > 0.6, `repSec=${P.repSec}`);
    });
    await t.test("10 reps, varied tempo (150–200 wpm) and gaps", () => {
      assert.equal(count(P, reps(10, () => [{ pcm: clip(v.voice, v.mantra, rate()) }, { gap: 0.3 + R() * 1.2 }])), 10);
    });
    await t.test("12 reps speeding up as the mala goes on (140 → 230 wpm)", () => {
      assert.equal(count(P, reps(12, (i) => [{ pcm: clip(v.voice, v.mantra, 140 + i * 8) }, { gap: 0.25 + R() * 0.5 }])), 12);
    });
    await t.test("10 reps back-to-back, no pause", () => {
      assert.equal(count(P, reps(10, () => [{ pcm: clip(v.voice, v.mantra, rate()) }, { gap: 0.05 }])), 10);
    });
    await t.test("8 reps with a pause inside the mantra", () => {
      assert.equal(count(P, reps(8, () => [{ pcm: clip(v.voice, v.pause, rate()) }, { gap: 0.6 + R() * 0.6 }])), 8);
    });
    await t.test("10 softer reps with fan noise (~25 dB SNR)", () => {
      assert.equal(count(P, reps(10, () => [{ pcm: clip(v.voice, v.mantra, rate()), gain: 0.5 }, { gap: 0.5 + R() }]), { noise: 0.004, hum: 0.002, seed: 5 }), 10);
    });
    await t.test("partials ('Om', 'Om Namah') never count", () => {
      assert.equal(count(P, reps(10, (i) => [{ pcm: clip(v.voice, i % 2 ? v.om : v.half, rate()) }, { gap: 0.6 + R() * 0.6 }])), 0);
    });
    await t.test("other speech never counts", () => {
      assert.equal(count(P, reps(6, () => [{ pcm: clip(v.voice, v.other, rate()) }, { gap: 0.8 }])), 0);
    });
    await t.test("full reps interleaved with halves: only full reps count", () => {
      assert.equal(count(P, reps(6, () => [{ pcm: clip(v.voice, v.mantra, rate()) }, { gap: 0.7 }, { pcm: clip(v.voice, v.half, rate()) }, { gap: 0.7 }])), 6);
    });
    await t.test("loud fan (~12 dB SNR): never over-counts", () => {
      const n = count(P, reps(10, () => [{ pcm: clip(v.voice, v.mantra, rate()), gain: 0.3 }, { gap: 0.5 + R() }]), { noise: 0.01, hum: 0.005, seed: 5 });
      assert.ok(n <= 10, `got ${n}`);
      assert.equal(count(P, reps(10, () => [{ pcm: clip(v.voice, v.half, rate()), gain: 0.3 }, { gap: 0.5 + R() }]), { noise: 0.01, hum: 0.005, seed: 6 }), 0);
    });
    await t.test("taught in the noisy room → counts in the noisy room", () => {
      const PN = learn(v, [170, 160, 180], { gain: 0.3, noise: 0.01, hum: 0.005 });
      const n = count(PN, reps(10, () => [{ pcm: clip(v.voice, v.mantra, rate()), gain: 0.3 }, { gap: 0.5 + R() }]), { noise: 0.01, hum: 0.005, seed: 5 });
      assert.ok(n >= 7 && n <= 10, `got ${n}`);
    });
  });
}

test("[maha-mantra] long mantra whose halves end alike is learned whole", { skip }, () => {
  const v = LONG.rishi;
  const P = learn(v, [170, 160, 180]);
  assert.ok(P.repSec > 4, `template must be the full ~16-word mantra (repSec=${P.repSec})`);
  const R = rng(5);
  assert.equal(count(P, reps(6, () => [{ pcm: clip(v.voice, v.mantra, 150 + Math.round(R() * 50)) }, { gap: 0.2 + R() }])), 6);
});

test("[Om Gam Ganapataye Namah] Hindi voice", { skip }, () => {
  const v = LONG.lekha;
  const P = learn(v);
  const R = rng(5);
  assert.equal(count(P, reps(6, () => [{ pcm: clip(v.voice, v.mantra, 150 + Math.round(R() * 50)) }, { gap: 0.2 + R() }])), 6);
  assert.equal(count(P, reps(6, () => [{ pcm: clip(v.voice, v.half, 150 + Math.round(R() * 50)) }, { gap: 0.6 + R() }])), 0);
});
