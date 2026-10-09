/**
 * Regression test on a REAL voice — runs only when samples/ holds recordings
 * saved with Settings ▸ "Save recordings for troubleshooting" (git-ignored).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "./real-voice.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "samples");
const skip = !fs.existsSync(path.join(dir, "jap-teach.wav")) && "no samples/ recordings";

test("real voice: counts full repetitions, never half-mantras", { skip }, () => {
  const r = evaluate(dir);
  assert.ok(!r.error, "teach failed: " + r.error);
  const bal = r.rows.find((x) => x.sens === 1);
  assert.ok(bal.live >= r.expected - 1 && bal.live <= r.expected, `balanced: ${bal.live}/${r.expected}`);
  for (const x of r.rows) {
    assert.ok(x.live <= r.expected, `sens ${x.sens} over-counted ${x.live}/${r.expected}`);
    assert.equal(x.first, 0, `sens ${x.sens}: first halves counted`);
    assert.equal(x.second, 0, `sens ${x.sens}: second halves counted`);
  }
});
