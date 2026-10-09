# Tests

```bash
npm install          # once — puppeteer-core, drives your installed Google Chrome
npm test             # unit + corpus + real voice (Node only)
npm run test:e2e     # Chrome: UI flows + full audio pipeline
npm run test:all     # everything
```

| Suite | File | What it covers | Needs |
|---|---|---|---|
| Unit | `unit.test.mjs` | FFT, feature extraction (16/48 kHz, chunking), calibration (finds 3 reps, rejects silence / a single rep, isn't split by mid-mantra pauses), live counting on synthetic "syllables": varied tempo, back-to-back, pauses inside, partials, a different word, noise, sensitivity, profile versioning; whole sessions of continuous legato chanting, fading/speeding up, a fan switching on | Node |
| Corpus | `corpus.test.mjs` | Same engine on real phonetics via macOS `say` (Lekha/Hindi, Rishi/Indian English, Samantha): tempo 140–230 wpm, gaps, mid-mantra pauses, fan noise, "Om"/"Om Namah" partials, other speech, halves interleaved with full reps, teaching in a noisy room, the Hare Krishna maha-mantra | macOS (skipped elsewhere) |
| E2E UI | `e2e.mjs ui` | Beads, +1/−1, reset confirmation, settings (mala size, theme), mantra picker, custom mantra, persistence across reload, no overflow on 320 px phones, no page errors | Chrome |
| E2E audio | `e2e.mjs audio` | Teach (auto-finishes after 3 reps) → count 6 reps → partials/other talk ignored → pause ignores chanting → resume → reload keeps the learned voice | Chrome + macOS `say` |
| Real voice | `real-voice.test.mjs` | Your own recordings in `samples/` (git-ignored): teach → live session must count every full repetition (±1), and streams made of only the first or second half of each of your repetitions must count 0 — at every sensitivity | `samples/jap-*.wav` (skipped otherwise) |

Synthesized clips are cached in `tests/.cache/` (git-ignored).

To add your voice: Settings ▸ Show detection details → teach → chant ~10 reps →
Settings ▸ Save recordings for troubleshooting, then copy `jap-teach.wav`,
`jap-live.wav`, `jap-debug.json` into `samples/`. `node tests/real-voice.mjs`
prints the per-sensitivity breakdown, `node tests/real-voice.mjs --sessions`
simulates long sessions built from your repetitions, and `node tests/replay.mjs
samples/jap-teach.wav samples/jap-live.wav` replays the session event by event.

## How the audio E2E drives the app

`AudioEngine.__test.simulate(sampleRate)` replaces only the microphone; PCM pushed
with `AudioEngine.__test.push()` flows through the production feature extractor,
VAD, calibration, matcher and UI. Chrome's `--use-file-for-fake-audio-capture`
yields digital silence in current builds, so it can't carry a chant. (It did catch
a real bug: a dead mic used to look like voice in the teach screen.)

## Testing with your own voice

Serve `app/` (`python3 -m http.server -d app 8000`), open it on your phone over
https or on `localhost`, teach the mantra, and enable **Settings ▸ Show detection
details**: every match shows its score against the threshold, and borderline or
missed repetitions say why. "Hear what I learned" on the teach result plays back
the most typical of your taught repetitions (the template is an average of them).
