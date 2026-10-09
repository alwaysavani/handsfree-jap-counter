# Jap Counter — hands-free mantra counting

**Try it: https://jap.handsfree-jap.workers.dev**

A web app that counts your mantra repetitions (*japa*) by listening, so your hands
stay free for the diya, flowers or mala during pooja and meditation.

- **Teach once, then just chant.** Chant your mantra three times to teach it; from
  then on every complete repetition adds one bead to the on-screen mala.
- **Only complete repetitions count.** Half a mantra, a cough, or someone talking
  in the room doesn't.
- **Private by design.** All audio is processed on the device, in the browser.
  Nothing is recorded, uploaded or sent anywhere; there is no server, account or
  tracking.
- **Works offline** and installs to the home screen as a Progressive Web App (PWA).
- No build step, no frameworks, no runtime dependencies — plain HTML, CSS and
  JavaScript (~200 KB).

## Features

- Mala ring with 108 beads (or 21 / 54), large count readable from across a room,
  guru bead, voice-level glow and a progress arc that follows each repetition
- Mala sizes 21 · 54 · 108 · 1008 · unlimited; bell + vibration when complete
- Preset mantras plus your own; each mantra remembers its own learned voice
- Detection sensitivity (Strict / Balanced / Lenient) and an optional
  "detection details" readout explaining why a repetition did or didn't count
- Manual +1 / −1, reset with confirmation, daily streak, screen kept awake while
  chanting, auto-pause after 2 minutes of silence
- Shareable completion card (Web Share / WhatsApp / download)
- Five colour themes

## How it works (short version)

1. **Teach.** The app records three repetitions one at a time, aligns them with
   dynamic time warping (DTW) and averages them into a template of your voice
   (MFCC features, 50 frames per second). Thresholds are set from how your own
   repetitions compare to each other and then self-tested on the recording.
2. **Listen.** Live audio goes through a noise-tracking voice detector; only the
   *sounds* of the mantra are matched — pauses are ignored, and a long pause marks
   the end of a repetition.
3. **Count.** A streaming subsequence-DTW matcher looks for complete, in-order
   matches of the whole template. A match counts only if it is close overall,
   has no badly-matched stretch (the signature of missing words), and is as long
   as a real repetition. Once your rhythm is known, near-misses that land on the
   beat are counted too.

The full design, the problems it solves and how it was evaluated are in
[`docs/engineering-solution.md`](docs/engineering-solution.md).

## Run locally

The microphone only works in a *secure context*: `https://` or `http://localhost`
(not `file://`).

```bash
cd app
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works (for example `npx serve app`).

## Tests

```bash
npm install          # once: puppeteer-core (drives your installed Google Chrome)
npm test             # engine tests in Node: synthetic signals + synthesized speech
npm run test:e2e     # real Chrome, headless: UI flows + the full audio pipeline
npm run test:all     # everything
```

- **Unit** (`tests/unit.test.mjs`) — DSP on synthetic syllables; runs anywhere.
- **Corpus** (`tests/corpus.test.mjs`) — synthesized speech via macOS `say` in
  Hindi, Indian English and US English voices: tempo changes, pauses inside the
  mantra, partial mantras, other speech, background noise. Skipped where `say`
  isn't available.
- **End-to-end** (`tests/e2e.mjs`) — Chrome via `puppeteer-core`; set `CHROME=` to
  your Chrome binary if it isn't in the default macOS location.
- **Real voice** (`tests/real-voice.test.mjs`) — runs on your own recordings if you
  put them in `samples/` (git-ignored). See [`tests/README.md`](tests/README.md).

## Deploy

`app/` is the complete site; any static host that serves HTTPS works. The hosted
version runs on Cloudflare Workers static assets (configured in `wrangler.jsonc`):

```bash
npx wrangler login     # once
npx wrangler deploy    # uploads app/
```

`app/_headers` sets the security and caching headers on hosts that support that
file (Cloudflare, Netlify). The service worker (`app/sw.js`) fetches
network-first, so a new deploy reaches users on their next visit; bump its
`CACHE` name when you change the list of files it pre-caches.

## Browser support

Recent versions of Chrome, Edge, Firefox and Safari on desktop and mobile. Keeping
the screen awake needs iOS 16.4 or later; vibration is not available on iOS.

## Project layout

```
app/                    the deployable site (no build step)
  index.html            counter, bottom sheets (teach, mantra, settings, done)
  css/styles.css        themed UI (CSS custom properties)
  js/dsp.js             signal processing: features, voice detection, teaching, matching
  js/audio.js           microphone capture, teach/count sessions
  js/pcm-worklet.js     AudioWorklet forwarding raw microphone audio
  js/app.js             UI controller
  js/storage.js         settings, learned voices, streaks, session (localStorage)
  js/themes.js          colour themes
  js/chime.js           synthesized bead click, bell, haptics
  js/share.js           completion card
  js/miccheck.js        diagnostics shown after a microphone failure
  sw.js, manifest.json  offline support and installability
  _headers              security / caching headers for the host
docs/
  engineering-solution.md   how counting works, why, and how it was evaluated
  PRD.md                    the original product brief (partly superseded)
tests/                  unit, corpus, end-to-end and real-voice tests
scripts/generate_icons.py   regenerates the app icons (Python standard library only)
ROADMAP.md              known limitations and planned work
wrangler.jsonc          Cloudflare deployment config (serves app/)
```

## Privacy

- Audio is processed in memory on the device and discarded. Only numbers — the
  learned feature template, settings, counts and streaks — are saved, in the
  browser's `localStorage`.
- The only network requests are for the app's own files and Google Fonts (and
  WhatsApp, only if you tap "Share on WhatsApp").
- "Save recordings for troubleshooting" (Settings, when detection details are on)
  downloads your last teach recording and up to a minute of chanting **to your own
  device**; nothing is uploaded.

## Contributing

Issues and pull requests are welcome. For changes to counting, please include
evidence — the corpus and real-voice tests in `tests/` exist so that improvements
for one voice or room don't silently break another. Planned work is listed in
[`ROADMAP.md`](ROADMAP.md).

## License

No open-source license is granted for this code; all rights are reserved. You're
welcome to read it and to use the hosted app.
