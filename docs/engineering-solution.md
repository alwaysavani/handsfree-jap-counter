# Engineering solution: counting mantra repetitions from audio

This document explains how Jap Counter turns microphone audio into a count of
mantra repetitions, why it is built this way, how it was evaluated, and what it
still gets wrong. The implementation lives in `app/js/dsp.js` (signal processing,
runs unchanged in the browser and in Node) and `app/js/audio.js` (microphone and
session control).

## 1. The problem

A person chants a mantra over and over — often 108 times — and wants an exact
count without touching the phone. The app must:

- **count every complete repetition, exactly once**, whether the chanter pauses
  between repetitions or runs them together, speeds up, slows down or gets softer;
- **never count partial repetitions** ("Om Namah" of "Om Namah Shivaya"), coughs,
  or other speech;
- work for **any mantra in any language**, including long ones (the Gayatri
  mantra, the 16-word Hare Krishna maha-mantra);
- run **entirely on the device** (privacy, offline use, zero server cost), on
  ordinary phones, in a browser.

Under-counting and over-counting are both failures, but they are not symmetric:
a user can add a missed bead with +1, while a counter that over-counts can't be
trusted at all. Where the two conflict, the design prefers to miss.

## 2. Approaches that don't work

| Approach | Why it fails here |
| --- | --- |
| Speech recognition (Web Speech API, cloud ASR) | Needs a network on most browsers, sends audio off the device, isn't trained on chanted Sanskrit, and returns text with unpredictable timing. |
| Loudness bursts ("a burst followed by silence = 1") | People pause *inside* mantras and run repetitions together; any noise counts. This was the original implementation and is what produced half-mantra counts. |
| Fixed silence thresholds to split repetitions | A breath inside a mantra and a pause between repetitions overlap in length. |
| Keyword spotting with a trained model | Every user's mantra is different; there's no training data, and shipping a model per mantra isn't feasible. |

The approach used instead is **query-by-example matching**: the user teaches the
mantra by example, and live audio is searched for complete occurrences of that
example.

## 3. Pipeline

```
microphone (raw: echo cancellation, noise suppression, AGC all OFF)
   │  AudioWorklet (ScriptProcessor fallback) → main thread, ~1024-sample chunks
   ▼
FeatureExtractor      32 ms Hamming window, 20 ms hop, pre-emphasis, FFT
   │                  → 26 mel bands (90–4200 Hz) + frame energy (dB)
   ▼
Normalizer            noise floor + voice-activity detection (VAD)
   │                  spectral noise subtraction → MFCC c1–c12
   │                  cepstral mean normalization, loudness contour
   │                  only voiced frames continue (+160 ms hangover)
   ▼
MantraMatcher         streaming subsequence DTW against the learned template
   │                  → candidate matches with score, "worst stretch", span
   ▼
LiveCounter           acceptance rules, borderline confirmation, rhythm
   ▼
count += n
```

### 3.1 Capture

The browser's own voice processing is switched off
(`echoCancellation`, `noiseSuppression`, `autoGainControl: false`). Noise
suppression treats a sustained "Ommm" as stationary noise and fades it out, and
automatic gain control changes the level after teaching; both caused real
repetitions to go uncounted. The engine does its own noise handling instead.

### 3.2 Features

Each 20 ms frame becomes a 13-dimensional vector:

- **12 MFCCs** (c1–c12, from a 26-band mel filterbank). c0 (overall loudness) is
  excluded so distance from the microphone doesn't matter. Each coefficient is
  mean-normalized (cepstral mean normalization, adapting slowly during a session)
  and scaled by its spread in the taught repetitions.
- **A loudness contour**: energy above the noise floor relative to the chanter's
  voice level, weighted ×2. It captures syllable rhythm, which partial mantras and
  other speech don't share.

Before the MFCCs are computed, the current noise spectrum is subtracted from each
band (over-subtraction ×1.6, floor 0.08 × noise).

### 3.3 Voice activity and the noise floor

A frame is voice when its energy is more than 9 dB above the noise floor (and
stays voice until it falls below 5 dB above it), and above an absolute minimum of
−82 dBFS, so a muted or dead microphone never looks like voice.

The noise floor is the subtle part. Three failure modes were found and fixed:

1. **Rising into the voice.** A floor that follows the quietest recent frames
   rises into a continuous, hummed chant, which has no true silences. After a few
   seconds the chant itself was treated as noise and counting stopped. The floor
   may now rise only when the quiet part of the last 6 s is extremely flat (under
   1.5 dB spread between the 5th and 20th percentile — fans and air conditioners
   measure ~0.5 dB, a held chant 2.4–4 dB, a real quiet room 4–6 dB), or, if the
   whole window is steady, by at most 8 dB above the room level measured while
   teaching.
2. **Ratcheting down.** Following individual quiet frames dragged the floor ~10 dB
   below the real room level within a minute. Room sound then counted as voice,
   the voice model adapted to it, and counting stalled mid-session. The floor now
   drops only to the 5th percentile of the last 6 s.
3. **Digital silence.** Some devices briefly output exact zeros; the floor never
   follows those.

### 3.4 Pauses

Only voiced frames are matched — how long someone pauses, between or inside
repetitions, has no effect on matching. Two refinements keep this safe:

- **Hangover:** the first 160 ms of a gap is still matched as quiet sound, so a
  voice detector that flickers for a frame inside a word doesn't delete part of
  the mantra.
- **Boundary pauses:** a pause longer than any pause inside the taught mantra
  (longest inner pause + 0.35 s, clamped to 0.6–1.0 s) ends all alignments in
  progress. Without this, two half-mantras separated by a breath could join into
  one "full" repetition.

## 4. Teaching (calibration)

The teach screen records **three repetitions one at a time**: a 1.2 s "get ready"
period measures the room, then each repetition ends after 1.2 s of silence
(blips with less than 0.5 s of voice are ignored). Recording each repetition
separately gives exact boundaries. An earlier version guessed the repetitions in
a free-form recording and learned a two-to-four-mantra-long template whenever
the user chanted more than three times.

`learnMantra()` then:

1. measures the room (noise level and spectrum) and voice statistics;
2. converts the recording with the same `Normalizer` used live;
3. **drops a repetition that doesn't resemble the others** (very different length
   or DTW distance), as long as at least two remain;
4. picks the medoid repetition and **averages the similar ones into the template
   with DTW barycenter averaging (DBA)**. Averaging cancels each repetition's
   individual wobble; on a real voice it lowered live match scores from
   0.60–0.86 to 0.55–0.75;
5. sets thresholds:
   - `accept` (average match cost) = clamp(typical self-score + 0.65 × partial
     score, 0.42, 0.78), and at least 1.1 × the worst self-score (≤ 0.8). The
     "partial score" comes from matching slices of the template against itself;
   - `softAccept` ≈ 1.18 × accept (≤ 0.86) for borderline repetitions;
   - the worst-stretch limit is fixed at 1.0 (section 5.2);
   - the boundary pause (section 3.4);
6. **self-tests**: the live counter is run over the teaching recording. If not
   every taught repetition counts, only `accept` is relaxed, in small steps, up
   to 0.85. The worst-stretch limit is never relaxed here, because doing so after
   a noisy teach let half-mantras through.

The stored profile holds numbers only (the template, thresholds and statistics),
never audio. It is versioned; a format change discards old profiles and asks the
user to teach again.

## 5. Matching

### 5.1 Streaming subsequence DTW

`MantraMatcher` runs a SPRING-style subsequence dynamic time warping on every
incoming frame. A match must consume the **whole template, in order**, starting
anywhere in the stream:

- symmetric step pattern with local length normalization; the score is the mean
  per-step cost (0 = identical);
- slope limits: the live audio may be up to ~5× slower or ~3× faster locally
  (held vowels, rushed syllables);
- span limits: a match must cover at least 62% of a repetition's length at the
  **current pace** (the minimum follows the median length of recent counted
  repetitions), and at most 2.5×.

Cost: O(template length) per 20 ms frame. Measured on a laptop, a whole session
(features + matching) runs at well under 1% of real time; it hasn't been profiled
on low-end phones yet.

### 5.2 The "worst stretch" — detecting partial repetitions

The average cost alone can't separate "a full repetition that is a little off
everywhere" from "a partial repetition that matches perfectly until the missing
words". So each alignment also carries a running average of local cost (over
~12% of the template) and its maximum — the **worst stretch**, computed over the
middle 80% of the template (soft onsets and tails are excluded) and only on steps
that advance through the template.

| Measured on a real voice | average cost | worst stretch |
| --- | --- | --- |
| full repetitions | 0.55 – 0.75 | 0.67 – 0.90 |
| half-mantras | 0.77 – 0.95 | ≥ 0.99 |

A match counts outright only if its worst stretch is ≤ 1.0. **Lenient sensitivity
never relaxes this limit** — it is the guard against partial mantras.

### 5.3 Committing matches

Candidate matches are collected while the alignment is still running, and one is
committed when no better overlapping alignment can still appear:

- a clean candidate always beats a borderline one for the same repetition;
- a candidate isn't committed while an unfinished alignment of the same
  repetition is doing clearly better (this is what keeps mantras whose halves end
  alike — "…Hare Hare / …Hare Hare" — from being cut in half);
- a new match that doesn't overlap the pending one commits the pending one first;
- every alignment overlapping a committed match is discarded, so each stretch of
  audio is counted at most once;
- a pause commits immediately; a borderline candidate waits a little longer for a
  clean alignment.

## 6. Decision layer (`LiveCounter`)

| Situation | Result |
| --- | --- |
| average cost ≤ accept and worst stretch ≤ 1.0 | **count** |
| borderline (slightly over either limit), ≥ 80% of a repetition long | **held** |
| held, then a clear repetition arrives within ~2.6 periods | both count (if the held one's worst stretch was clean) |
| two clean held repetitions in a row, at chanting rhythm | both count |
| an utterance with no count, ≥ 3 repetitions already counted, starting 0.7–1.4 periods after the last one, 0.8–1.25× the recent length, clean worst stretch, reasonable score | **count (rhythm)** |
| anything else | nothing; the details readout shows the closest score |

Sensitivity multiplies `accept` (Strict 0.92, Balanced 1, Lenient 1.15), always
capped below the partial-repetition level.

## 7. Evaluation

Counting was measured, not eyeballed. Every result below comes from running the
exact production code (`dsp.js`) in Node.

**Test suites** (`npm test`, `npm run test:e2e`):

- 25 unit tests on synthetic syllables (FFT, features at 16/48 kHz, teaching,
  pauses, partials, noise, continuous legato chanting for 40 repetitions, a fan
  switching on mid-session);
- 38 corpus tests on synthesized speech (macOS `say`: Hindi, Indian-English and
  US-English voices) — tempo 140–230 wpm, back-to-back repetitions, pauses inside
  the mantra, "Om" and "Om Namah" partials, other sentences, noise, teaching in a
  noisy room, the Hare Krishna maha-mantra;
- end-to-end tests in headless Chrome driving the real UI and pipeline;
- a real-voice test that runs when recordings are present in `samples/`.

**Real voice.** A real user's teach recording plus a 40-second live session
(12 repetitions of "Om Namah Shivaya"):

| | Strict | Balanced | Lenient |
| --- | --- | --- | --- |
| live repetitions counted | 12 / 12 | 12 / 12 | 12 / 12 |
| first halves counted (12 cut from the session) | 0 | 0 | 0 |
| second halves counted | 0 | 0 | 0 |

**Simulated long sessions from the same voice** (repetitions shuffled, ±6% speed,
the room's own background sound in the pauses; Balanced):

| Session | Counted |
| --- | --- |
| 60 repetitions, natural pauses 0.4–1.6 s | 59 / 60 |
| 60 repetitions, short pauses 0.05–0.4 s | 59 / 60 |
| 60 repetitions fading to half volume | 59 / 60 |
| 40 repetitions + a half-mantra after every 4th | 35 / 40, no half counted |
| 40 repetitions with ceiling-fan noise (taught without it) | 24 / 40 |

These sessions are built from one 40-second recording of one person, so they
show robustness trends, not general accuracy.

## 8. Known limitations

- **Accuracy has been validated on one real voice.** Synthetic and TTS voices are
  far more consistent than people.
- **Loud steady noise** (a fan or AC louder than ~25 dB below the voice) causes
  missed repetitions, because a repetition heard through noise and a clean
  partial look alike to the worst-stretch check. Teaching in the same conditions
  helps somewhat. It never causes over-counting.
- **Repetitions right next to a half-mantra** are sometimes missed.
- **Mantras whose halves differ by a single word** (maha-mantra "Hare Krishna…" vs
  "Hare Rama…"): chanting the same half twice can look like one full repetition.
- The first repetition of a session can't use rhythm (no history yet), so a
  borderline first repetition may be missed.

## 9. Lessons from development

- **Measure with real audio early.** Most of the decisive bugs (the noise floor
  rising into a hummed chant, template edges full of breath, the ratcheting floor)
  were invisible with synthetic voices and obvious within minutes of replaying one
  real recording.
- **Every adaptive threshold needs a ceiling.** Self-tests, noisy teaching and
  "Lenient" each loosened a limit until half-mantras counted.
- **Serialize exactly as production does.** `Infinity` in a profile became `null`
  in `localStorage` JSON, which set a threshold to 0 and silently disabled
  counting; tests now round-trip profiles through JSON.
- **Cache-first service workers pin users to old code.** The service worker is
  network-first and the `_headers` file stops long-lived caching of code.
- **A simulation can lie.** One stress test filled pauses with digital silence and
  another scrambled the room tone per sample; both produced alarming but fake
  failures until the inputs matched reality.

## 10. Tuning and debugging

- **Settings ▸ Show detection details** shows each match's score against its
  threshold, and why borderline or missed repetitions didn't count.
- **Settings ▸ Save recordings for troubleshooting** downloads the last teach
  recording, up to a minute of chanting and the match log, to the user's own
  device.
- `node tests/replay.mjs samples/jap-teach.wav samples/jap-live.wav` replays a
  session event by event; `node tests/real-voice.mjs [--sessions]` evaluates
  partial-mantra rejection and simulated long sessions.

The main constants are at the top of `app/js/dsp.js`; threshold formulas are in
`learnMantra()` and `LiveCounter()`.
